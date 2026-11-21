use crate::state::{AppState, ConnectionStatus};
use crate::telemetry::TelemetryService;
use chrono::Utc;
use rand::Rng;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::AppHandle;
use tokio::net::TcpListener;
use tracing::{info, warn};

pub struct SandboxEngine;

impl SandboxEngine {
    /// Start an optional background loopback mock listener on 127.0.0.1:10801 so local TCP checks succeed
    pub fn ensure_loopback_listener(is_running: Arc<AtomicBool>) {
        tokio::spawn(async move {
            match TcpListener::bind("127.0.0.1:10801").await {
                Ok(listener) => {
                    info!("[Sandbox] Mock loopback proxy listener active on 127.0.0.1:10801");
                    while is_running.load(Ordering::SeqCst) {
                        tokio::select! {
                            accept_res = listener.accept() => {
                                if let Ok((mut socket, _)) = accept_res {
                                    tokio::spawn(async move {
                                        let mut buf = [0u8; 128];
                                        let _ = tokio::io::AsyncReadExt::read(&mut socket, &mut buf).await;
                                    });
                                }
                            }
                            _ = tokio::time::sleep(Duration::from_millis(250)) => {}
                        }
                    }
                }
                Err(e) => {
                    // Port might already be bound by sentra-core test outbounds or another process
                    warn!("[Sandbox] Loopback port 10801 notice: {}", e);
                }
            }
        });
    }

    /// Run the full simulated connection lifecycle with live telemetry and logs
    pub async fn run_simulation(
        app_handle: AppHandle,
        app_state: AppState,
        mode: String,
        is_running: Arc<AtomicBool>,
    ) {
        Self::ensure_loopback_listener(Arc::clone(&is_running));

        TelemetryService::emit_log(&app_handle, "INFO", "[Sandbox] Initializing zero-cost Loopback Sandbox...");
        TelemetryService::emit_log(
            &app_handle,
            "INFO",
            &format!("[Sandbox] Target mode: [{}] -> Local endpoints 127.0.0.1:10801-10804", mode),
        );

        // Phase 1: Handshake
        tokio::time::sleep(Duration::from_millis(500)).await;
        if !is_running.load(Ordering::SeqCst) {
            return;
        }

        TelemetryService::emit_log(
            &app_handle,
            "INFO",
            "[TUN] Mock virtual interface [sentra-tun] established (172.19.0.1/30, MTU 9000)",
        );
        TelemetryService::emit_log(
            &app_handle,
            "INFO",
            "[DNS] FakeIP resolver active on pool 198.18.0.0/15 (ipv4_only)",
        );
        TelemetryService::emit_log(
            &app_handle,
            "INFO",
            "[Routing] Split Tunneling active: Direct bypass for *.ir domains and RFC1918 subnets",
        );

        // Phase 2: Latency probe
        tokio::time::sleep(Duration::from_millis(350)).await;
        if !is_running.load(Ordering::SeqCst) {
            return;
        }

        let initial_ping = {
            let mut rng = rand::thread_rng();
            rng.gen_range(32..42)
        };

        // Update state to Connected
        {
            let mut state = app_state.lock().await;
            state.status = ConnectionStatus::Connected;
            state.connected_since = Some(Utc::now());
            state.metrics.ping_ms = initial_ping;
            state.logs.push(format!(
                "[INFO] [urltest] Outbound latency probe healthy: [{}] ({} ms)",
                mode, initial_ping
            ));
            state.logs.push("[INFO] [Core] Tunnel handshake successful. Sentra Connect is online.".to_string());
        }

        TelemetryService::emit_status_change(&app_handle, "Connected", &mode, None);
        TelemetryService::emit_log(
            &app_handle,
            "INFO",
            &format!("[urltest] Health probe passed: Outbound [{}] ready (ping: {} ms)", mode, initial_ping),
        );

        // Phase 3: Telemetry ticker (1 update every second)
        let mut second_counter: u64 = 0;
        let mut ticker = tokio::time::interval(Duration::from_secs(1));

        while is_running.load(Ordering::SeqCst) {
            ticker.tick().await;
            second_counter += 1;

            let (dl_speed, ul_speed, current_ping) = {
                let mut rng = rand::thread_rng();
                // 14 MB/s to 26 MB/s download, 1.8 MB/s to 4.2 MB/s upload
                let dl = rng.gen_range(14_500_000..26_800_000);
                let ul = rng.gen_range(1_800_000..4_200_000);
                let p = rng.gen_range(30..44);
                (dl, ul, p)
            };

            let current_metrics = {
                let mut state = app_state.lock().await;
                if state.status != ConnectionStatus::Connected {
                    break;
                }
                state.metrics.download_speed_bps = dl_speed;
                state.metrics.upload_speed_bps = ul_speed;
                state.metrics.ping_ms = current_ping;
                state.metrics.total_download_bytes += dl_speed;
                state.metrics.total_upload_bytes += ul_speed;
                state.metrics.uptime_seconds = second_counter;
                state.remaining_bytes = (state.remaining_bytes - (dl_speed + ul_speed) as i64).max(0);

                if second_counter % 15 == 0 {
                    let log_line = format!(
                        "[DEBUG] [Proxy] Encrypted stream alive ({:.1} MB/s down, ping: {}ms)",
                        dl_speed as f64 / 1_000_000.0,
                        current_ping
                    );
                    state.logs.push(log_line.clone());
                    TelemetryService::emit_log(&app_handle, "DEBUG", &log_line);
                }

                state.metrics.clone()
            };

            TelemetryService::emit_speed_update(&app_handle, &current_metrics);
        }
    }
}
