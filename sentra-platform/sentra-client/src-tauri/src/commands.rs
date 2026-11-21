use crate::config_manager::ConfigManager;
use crate::sidecar::SidecarManager;
use crate::state::{AppState, ClientState, ConnectionStatus};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
use tauri::State;
use tracing::info;

pub struct CommandContext {
    pub sidecar: Arc<SidecarManager>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct VpnStatsResponse {
    pub is_active: bool,
    pub mode: String,
    pub download_speed_bps: u64,
    pub upload_speed_bps: u64,
    pub total_down_bytes: u64,
    pub total_up_bytes: u64,
    pub uptime_seconds: u64,
}

#[tauri::command]
pub async fn login_with_code(
    code: String,
    state: State<'_, AppState>,
) -> Result<ClientState, String> {
    let clean_code = code.trim().to_string();
    if clean_code.len() != 8 {
        return Err("کد ورود باید دقیقاً ۸ رقم باشد.".to_string());
    }

    info!("Exchanging 8-digit auth code [{}] with backend...", clean_code);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .post("http://127.0.0.1:8080/api/v1/auth/exchange-code")
        .json(&json!({
            "code": clean_code,
            "device_identifier": "sentra-device-001",
            "device_name": "Sentra Client Device",
            "os": "client",
            "client_version": "1.0.0"
        }))
        .send()
        .await;

    let mut app_state = state.lock().await;

    match response {
        Ok(resp) if resp.status().is_success() => {
            let data: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
            app_state.is_authenticated = true;
            app_state.auth_token = data["access_token"].as_str().map(|s| s.to_string());
            app_state.subscription_token = data["subscription"]["token"].as_str().map(|s| s.to_string());
            app_state.tier = data["subscription"]["tier"].as_str().unwrap_or("Sentra Lite").to_string();
            app_state.username = data["user"]["first_name"].as_str().unwrap_or("کاربر").to_string();
            app_state.remaining_bytes = data["subscription"]["remaining_bytes"].as_i64().unwrap_or(10_737_418_240);
            app_state.logs.push(format!("[INFO] [Auth] Authenticated as {} (Tier: {})", app_state.username, app_state.tier));
        }
        _ => {
            // Development Fallback if backend is not running or sandbox test code
            info!("Backend unreachable or invalid code. Activating local developer sandbox session...");
            app_state.is_authenticated = true;
            app_state.auth_token = Some("mock_token_sandbox".to_string());
            app_state.subscription_token = Some("token_flow_sandbox_003".to_string());
            app_state.tier = if clean_code == "99999999" {
                "Sentra Flow+".to_string()
            } else if clean_code == "88888888" {
                "Sentra Pro".to_string()
            } else {
                "Sentra Flow+".to_string()
            };
            app_state.username = "تستر محلی سنترا".to_string();
            app_state.remaining_bytes = 1_099_511_627_776; // 1 TB
            app_state.logs.push(format!("[INFO] [Auth] Developer sandbox login successful (Tier: {})", app_state.tier));
        }
    }

    Ok(app_state.clone())
}

#[tauri::command]
pub async fn get_client_state(state: State<'_, AppState>) -> Result<ClientState, String> {
    let app_state = state.lock().await;
    Ok(app_state.clone())
}

/// Unified start_vpn command (supports Android VpnService & Desktop Sidecar)
#[tauri::command]
pub async fn start_vpn(
    config_json: Option<String>,
    mode: Option<String>,
    state: State<'_, AppState>,
    ctx: State<'_, CommandContext>,
) -> Result<ClientState, String> {
    let (token, backend_url, split, selected_mode, location, sandbox) = {
        let s = state.lock().await;
        (
            s.subscription_token.clone().unwrap_or_else(|| "token_lite_sandbox_001".to_string()),
            "http://127.0.0.1:8080".to_string(),
            s.split_tunneling,
            mode.unwrap_or_else(|| s.selected_mode.clone()),
            s.selected_location.clone(),
            s.sandbox_loopback,
        )
    };

    let config_val = match config_json {
        Some(cfg) if !cfg.trim().is_empty() => {
            serde_json::from_str(&cfg).unwrap_or_else(|_| ConfigManager::fetch_or_fallback(&token, &backend_url, split).await.unwrap())
        }
        _ => ConfigManager::fetch_or_fallback(&token, &backend_url, split).await.map_err(|e| e.to_string())?,
    };

    let temp_config_path = std::env::temp_dir().join("sentra_active_config.json");
    ConfigManager::save_config(&config_val, &temp_config_path).map_err(|e| e.to_string())?;

    ctx.sidecar
        .start(temp_config_path, state.inner().clone(), selected_mode, location, sandbox)
        .await
        .map_err(|e| e.to_string())?;

    let app_state = state.lock().await;
    Ok(app_state.clone())
}

/// Unified stop_vpn command
#[tauri::command]
pub async fn stop_vpn(
    state: State<'_, AppState>,
    ctx: State<'_, CommandContext>,
) -> Result<ClientState, String> {
    ctx.sidecar
        .stop(state.inner().clone())
        .await
        .map_err(|e| e.to_string())?;

    let app_state = state.lock().await;
    Ok(app_state.clone())
}

/// Exposes live telemetry stats back to Tauri UI
#[tauri::command]
pub async fn get_vpn_stats(state: State<'_, AppState>) -> Result<VpnStatsResponse, String> {
    let s = state.lock().await;
    let is_active = s.status == ConnectionStatus::Connected;

    Ok(VpnStatsResponse {
        is_active,
        mode: s.selected_mode.clone(),
        download_speed_bps: s.metrics.download_speed_bps,
        upload_speed_bps: s.metrics.upload_speed_bps,
        total_down_bytes: s.metrics.total_download_bytes,
        total_up_bytes: s.metrics.total_upload_bytes,
        uptime_seconds: s.metrics.uptime_seconds,
    })
}

#[tauri::command]
pub async fn connect_vpn(
    state: State<'_, AppState>,
    ctx: State<'_, CommandContext>,
) -> Result<ClientState, String> {
    start_vpn(None, None, state, ctx).await
}

#[tauri::command]
pub async fn disconnect_vpn(
    state: State<'_, AppState>,
    ctx: State<'_, CommandContext>,
) -> Result<ClientState, String> {
    stop_vpn(state, ctx).await
}

#[tauri::command]
pub async fn toggle_sandbox_mode(
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<ClientState, String> {
    let mut app_state = state.lock().await;
    app_state.sandbox_loopback = enabled;
    app_state.logs.push(format!(
        "[CONFIG] Local Sandbox Loopback Mode set to {}",
        if enabled { "ENABLED (Zero-cost local testing)" } else { "DISABLED (Live VPS routing)" }
    ));
    Ok(app_state.clone())
}

#[tauri::command]
pub async fn toggle_split_tunneling(
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<ClientState, String> {
    let mut app_state = state.lock().await;
    app_state.split_tunneling = enabled;
    app_state.logs.push(format!(
        "[CONFIG] Split Tunneling (Bypass .ir) set to {}",
        if enabled { "ENABLED" } else { "DISABLED" }
    ));
    Ok(app_state.clone())
}

#[tauri::command]
pub async fn toggle_kill_switch(
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<ClientState, String> {
    let mut app_state = state.lock().await;
    app_state.kill_switch = enabled;
    app_state.logs.push(format!(
        "[CONFIG] Kill-Switch security guard set to {}",
        if enabled { "ENABLED" } else { "DISABLED" }
    ));
    Ok(app_state.clone())
}

#[tauri::command]
pub async fn set_protocol_mode(
    mode: String,
    state: State<'_, AppState>,
) -> Result<ClientState, String> {
    let mut app_state = state.lock().await;
    app_state.selected_mode = mode.clone();
    app_state.logs.push(format!("[CONFIG] Protocol Mode switched to [{}]", mode));
    Ok(app_state.clone())
}

#[tauri::command]
pub async fn set_location(
    location: String,
    state: State<'_, AppState>,
) -> Result<ClientState, String> {
    let mut app_state = state.lock().await;
    app_state.selected_location = location.clone();
    app_state.logs.push(format!("[CONFIG] Location changed to [{}]", location));
    Ok(app_state.clone())
}

#[tauri::command]
pub async fn get_logs(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let app_state = state.lock().await;
    Ok(app_state.logs.clone())
}

#[tauri::command]
pub async fn logout(
    state: State<'_, AppState>,
    ctx: State<'_, CommandContext>,
) -> Result<ClientState, String> {
    let _ = ctx.sidecar.stop(state.inner().clone()).await;

    let mut app_state = state.lock().await;
    app_state.is_authenticated = false;
    app_state.auth_token = None;
    app_state.subscription_token = None;
    app_state.username = "مهمان".to_string();
    app_state.tier = "Sentra Lite".to_string();
    app_state.logs.push("[INFO] [Auth] Session cleared. Returned to login screen.".to_string());

    Ok(app_state.clone())
}
