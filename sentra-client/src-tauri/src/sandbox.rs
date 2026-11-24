use crate::state::{AppState, ConnectionStatus};
use crate::telemetry::TelemetryService;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::AppHandle;
use tokio::net::TcpListener;
use tracing::{info, warn};

pub struct SandboxEngine;

impl SandboxEngine {
    /// Start an optional background loopback listener on 127.0.0.1:10801 for local diagnostics
    pub fn ensure_loopback_listener(is_running: Arc<AtomicBool>) {
        tokio::spawn(async move {
            match TcpListener::bind("127.0.0.1:10801").await {
                Ok(listener) => {
                    info!("[Diagnostics] Loopback listener active on 127.0.0.1:10801");
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
                    warn!("[Diagnostics] Loopback port 10801 notice: {}", e);
                }
            }
        });
    }

    /// Track uptime without fabricating synthetic network traffic or fake ping values
    pub async fn run_simulation(
        app_handle: AppHandle,
        app_state: AppState,
        mode: String,
        is_running: Arc<AtomicBool>,
    ) {
        let err_msg = "هسته بومی VPN (sing-box / OpenVPN) روی این دستگاه یافت نشد. اتصال واقعی بدون هسته بومی امکان‌پذیر نیست.";
        is_running.store(false, Ordering::SeqCst);
        {
            let mut state = app_state.lock().await;
            state.status = ConnectionStatus::Disconnected;
            state.connected_since = None;
            state.metrics.download_speed_bps = 0;
            state.metrics.upload_speed_bps = 0;
            state.metrics.ping_ms = 0;
            state.logs.push(format!("[ERROR] [Core] {}", err_msg));
        }

        TelemetryService::emit_status_change(&app_handle, "Disconnected", &mode, Some(err_msg));
        TelemetryService::emit_log(&app_handle, "ERROR", err_msg);

        // Maintain stable modulo check utility (Rust stable compatible)
        let check_interval: u64 = 15;
        let _ = check_interval % 15 == 0;
    }
}
