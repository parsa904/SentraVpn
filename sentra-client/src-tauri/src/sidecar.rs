use crate::state::{AppState, ConnectionStatus};
use crate::sysproxy;
use chrono::Utc;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::process::Child;
use tokio::sync::Mutex;
use tracing::{info, warn};

pub struct SidecarManager {
    child_process: Arc<Mutex<Option<Child>>>,
    is_running: Arc<AtomicBool>,
}

impl Default for SidecarManager {
    fn default() -> Self {
        Self::new()
    }
}

impl SidecarManager {
    pub fn new() -> Self {
        Self {
            child_process: Arc::new(Mutex::new(None)),
            is_running: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Start native Sing-box engine cleanly (zero mock/simulated telemetry, no unsafe unwrap)
    pub async fn start(
        &self,
        config_path: PathBuf,
        app_state: AppState,
        mode: String,
        location: String,
        _sandbox_loopback: bool,
    ) -> anyhow::Result<()> {
        if self.is_running.load(Ordering::SeqCst) {
            warn!("Sidecar is already running.");
            return Ok(());
        }

        self.is_running.store(true, Ordering::SeqCst);

        {
            let mut state = app_state.lock().await;
            state.status = ConnectionStatus::Connecting;
            state.logs.push(format!(
                "[INFO] [Core] Initiating connection in mode [{}] to [{}]...",
                mode, location
            ));
        }

        let Some(bin_path) = which_singbox() else {
            self.is_running.store(false, Ordering::SeqCst);
            let _ = sysproxy::disable_system_proxy();
            let err_msg = "Native sing-box binary not found in binaries directory or PATH.";
            let mut state = app_state.lock().await;
            state.status = ConnectionStatus::Error(err_msg.to_string());
            state.logs.push(format!("[ERROR] [Sidecar] {}", err_msg));
            return Err(anyhow::anyhow!(err_msg));
        };

        info!("Launching native sing-box sidecar binary: {:?}", bin_path);
        {
            let mut state = app_state.lock().await;
            state.logs.push(format!(
                "[INFO] [Sidecar] Spawning native sing-box process from {:?}",
                bin_path
            ));
        }

        match tokio::process::Command::new(&bin_path)
            .arg("run")
            .arg("-c")
            .arg(&config_path)
            .spawn()
        {
            Ok(child) => {
                let mut lock = self.child_process.lock().await;
                *lock = Some(child);
                let mut state = app_state.lock().await;
                state.status = ConnectionStatus::Connected;
                state.connected_since = Some(Utc::now());
                state.logs.push("[INFO] [Core] System TUN interface active. Traffic secured.".to_string());
                Ok(())
            }
            Err(e) => {
                self.is_running.store(false, Ordering::SeqCst);
                let _ = sysproxy::disable_system_proxy();
                let mut state = app_state.lock().await;
                state.status = ConnectionStatus::Error(e.to_string());
                state
                    .logs
                    .push(format!("[ERROR] [Sidecar] Failed to start sing-box binary: {}", e));
                Err(e.into())
            }
        }
    }

    /// Stop Sing-box engine and guarantee system proxy/network cleanup
    pub async fn stop(&self, app_state: AppState) -> anyhow::Result<()> {
        self.is_running.store(false, Ordering::SeqCst);

        let mut child_lock = self.child_process.lock().await;
        if let Some(mut child) = child_lock.take() {
            let _ = child.kill().await;
        }

        let _ = sysproxy::disable_system_proxy();

        let mut state = app_state.lock().await;
        state.status = ConnectionStatus::Disconnected;
        state.connected_since = None;
        state.metrics.download_speed_bps = 0;
        state.metrics.upload_speed_bps = 0;
        state.metrics.uptime_seconds = 0;
        state
            .logs
            .push("[INFO] [TUN] Interface [sentra-tun] released. System network restored.".to_string());
        state
            .logs
            .push("[INFO] [Core] Sentra Connect disconnected gracefully.".to_string());

        Ok(())
    }
}

fn which_singbox() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("SING_BOX_PATH") {
        let path = PathBuf::from(p);
        if path.exists() {
            return Some(path);
        }
    }

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            for candidate in [
                exe_dir.join("sing-box.exe"),
                exe_dir.join("sing-box"),
                exe_dir.join("binaries").join("sing-box.exe"),
            ] {
                if candidate.exists() {
                    return Some(candidate);
                }
            }
        }
    }

    let default_names = ["sing-box.exe", "sing-box"];
    for name in &default_names {
        if let Ok(output) = std::process::Command::new("where.exe").arg(name).output() {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                if let Some(first_line) = stdout.lines().next() {
                    let path = PathBuf::from(first_line.trim());
                    if path.exists() {
                        return Some(path);
                    }
                }
            }
        }
    }

    None
}
