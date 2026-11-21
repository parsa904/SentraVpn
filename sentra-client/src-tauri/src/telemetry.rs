use crate::state::TelemetryMetrics;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Child;
use tracing::{info, warn};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEventPayload {
    pub timestamp: String,
    pub level: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusEventPayload {
    pub status: String,
    pub mode: String,
    pub message: Option<String>,
}

pub struct TelemetryService;

impl TelemetryService {
    /// Stream child process stdout and stderr lines asynchronously and emit to Tauri UI
    pub fn spawn_process_log_streamer(
        child: &mut Child,
        app_handle: AppHandle,
        is_running: Arc<AtomicBool>,
    ) {
        if let Some(stdout) = child.stdout.take() {
            let handle_clone = app_handle.clone();
            let is_running_clone = Arc::clone(&is_running);
            tokio::spawn(async move {
                let mut reader = BufReader::new(stdout).lines();
                while is_running_clone.load(Ordering::SeqCst) {
                    match reader.next_line().await {
                        Ok(Some(line)) => {
                            let payload = LogEventPayload {
                                timestamp: chrono::Local::now().format("%H:%M:%S").to_string(),
                                level: "INFO".to_string(),
                                message: line.clone(),
                            };
                            let _ = handle_clone.emit("telemetry-log", &payload);
                            info!("[Sing-box stdout] {}", line);
                        }
                        Ok(None) => break,
                        Err(e) => {
                            warn!("Error reading stdout from sing-box: {}", e);
                            break;
                        }
                    }
                }
            });
        }

        if let Some(stderr) = child.stderr.take() {
            let handle_clone = app_handle;
            let is_running_clone = is_running;
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr).lines();
                while is_running_clone.load(Ordering::SeqCst) {
                    match reader.next_line().await {
                        Ok(Some(line)) => {
                            let payload = LogEventPayload {
                                timestamp: chrono::Local::now().format("%H:%M:%S").to_string(),
                                level: "WARN".to_string(),
                                message: line.clone(),
                            };
                            let _ = handle_clone.emit("telemetry-log", &payload);
                            warn!("[Sing-box stderr] {}", line);
                        }
                        Ok(None) => break,
                        Err(e) => {
                            warn!("Error reading stderr from sing-box: {}", e);
                            break;
                        }
                    }
                }
            });
        }
    }

    /// Emit live speed metrics to UI
    pub fn emit_speed_update(app_handle: &AppHandle, metrics: &TelemetryMetrics) {
        let _ = app_handle.emit("telemetry-speed", metrics);
    }

    /// Emit connection status change to UI
    pub fn emit_status_change(app_handle: &AppHandle, status: &str, mode: &str, msg: Option<&str>) {
        let payload = StatusEventPayload {
            status: status.to_string(),
            mode: mode.to_string(),
            message: msg.map(|s| s.to_string()),
        };
        let _ = app_handle.emit("connection-status-changed", &payload);
    }

    /// Emit a custom log line to UI
    pub fn emit_log(app_handle: &AppHandle, level: &str, message: &str) {
        let payload = LogEventPayload {
            timestamp: chrono::Local::now().format("%H:%M:%S").to_string(),
            level: level.to_string(),
            message: message.to_string(),
        };
        let _ = app_handle.emit("telemetry-log", &payload);
    }
}
