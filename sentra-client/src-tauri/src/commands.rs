use crate::auth::AuthManager;
use crate::state::{AppState, ClientState};
use crate::vpn_manager::VpnManager;
use std::sync::Arc;
use tauri::{AppHandle, State};
use tracing::info;

#[tauri::command]
pub async fn login_with_code(
    code: String,
    state: State<'_, AppState>,
) -> Result<ClientState, String> {
    let session = AuthManager::login_with_code(&code).await?;

    let mut app_state = state.lock().await;
    app_state.is_authenticated = true;
    app_state.auth_token = Some(session.auth_token);
    app_state.subscription_token = Some(session.subscription_token);
    app_state.connect_code = session.connect_code.clone();
    app_state.plan_tier = session.plan_tier.clone();
    app_state.tier = session.tier.clone();
    app_state.username = session.username.clone();
    app_state.remaining_bytes = session.remaining_bytes;
    app_state.expires_at = session.expires_at.clone();

    let log_msg = format!(
        "[INFO] [Auth] Authenticated as {} (Tier: {})",
        app_state.username, app_state.tier
    );
    app_state.logs.push(log_msg);

    Ok(app_state.clone())
}

#[tauri::command]
pub async fn register_with_credentials(
    username: String,
    password: String,
    confirm_password: Option<String>,
    email: Option<String>,
    state: State<'_, AppState>,
) -> Result<ClientState, String> {
    let session = AuthManager::register_with_credentials(
        &username,
        &password,
        confirm_password.as_deref(),
        email.as_deref(),
    )
    .await?;

    let mut app_state = state.lock().await;
    app_state.is_authenticated = true;
    app_state.auth_token = Some(session.auth_token);
    app_state.subscription_token = Some(session.subscription_token);
    app_state.connect_code = session.connect_code.clone();
    app_state.plan_tier = session.plan_tier.clone();
    app_state.tier = session.tier.clone();
    app_state.username = session.username.clone();
    app_state.remaining_bytes = session.remaining_bytes;
    app_state.expires_at = session.expires_at.clone();

    let log_msg = format!(
        "[INFO] [Auth] Registered and logged in as {} (Tier: {})",
        app_state.username, app_state.tier
    );
    app_state.logs.push(log_msg);

    Ok(app_state.clone())
}

#[tauri::command]
pub async fn login_with_credentials(
    username: String,
    password: String,
    state: State<'_, AppState>,
) -> Result<ClientState, String> {
    let session = AuthManager::login_with_credentials(&username, &password).await?;

    let mut app_state = state.lock().await;
    app_state.is_authenticated = true;
    app_state.auth_token = Some(session.auth_token);
    app_state.subscription_token = Some(session.subscription_token);
    app_state.connect_code = session.connect_code.clone();
    app_state.plan_tier = session.plan_tier.clone();
    app_state.tier = session.tier.clone();
    app_state.username = session.username.clone();
    app_state.remaining_bytes = session.remaining_bytes;
    app_state.expires_at = session.expires_at.clone();

    let log_msg = format!(
        "[INFO] [Auth] Logged in as {} (Tier: {})",
        app_state.username, app_state.tier
    );
    app_state.logs.push(log_msg);

    Ok(app_state.clone())
}

#[tauri::command]
pub async fn get_telegram_link_code(state: State<'_, AppState>) -> Result<String, String> {
    let sub_token = {
        let app_state = state.lock().await;
        app_state.subscription_token.clone()
    };

    let token = sub_token.ok_or("برای دریافت کد اتصال ابتدا باید وارد حساب شوید.".to_string())?;
    AuthManager::get_telegram_link_code(&token).await
}

#[tauri::command]
pub async fn get_client_state(state: State<'_, AppState>) -> Result<ClientState, String> {
    let app_state = state.lock().await;
    Ok(app_state.clone())
}

#[tauri::command]
pub async fn connect_vpn(
    app: AppHandle,
    state: State<'_, AppState>,
    vpn: State<'_, Arc<VpnManager>>,
) -> Result<ClientState, String> {
    info!("Connect VPN requested by UI");
    vpn.start_vpn(app, state.inner().clone()).await?;
    let app_state = state.lock().await;
    Ok(app_state.clone())
}

#[tauri::command]
pub async fn disconnect_vpn(
    app: AppHandle,
    state: State<'_, AppState>,
    vpn: State<'_, Arc<VpnManager>>,
) -> Result<ClientState, String> {
    info!("Disconnect VPN requested by UI");
    vpn.stop_vpn(app, state.inner().clone()).await?;
    let app_state = state.lock().await;
    Ok(app_state.clone())
}

#[tauri::command]
pub async fn toggle_sandbox_mode(
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<ClientState, String> {
    let mut app_state = state.lock().await;
    app_state.sandbox_loopback = enabled;
    let msg = format!(
        "[CONFIG] Local Sandbox Loopback Mode set to {}",
        if enabled { "ENABLED (Zero-cost simulation)" } else { "DISABLED (Native Sing-box)" }
    );
    app_state.logs.push(msg);
    Ok(app_state.clone())
}

#[tauri::command]
pub async fn toggle_split_tunneling(
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<ClientState, String> {
    let mut app_state = state.lock().await;
    app_state.split_tunneling = enabled;
    let msg = format!(
        "[CONFIG] Split Tunneling (Bypass *.ir domains) set to {}",
        if enabled { "ENABLED" } else { "DISABLED" }
    );
    app_state.logs.push(msg);
    Ok(app_state.clone())
}

#[cfg(target_os = "windows")]
fn is_windows_admin() -> bool {
    std::process::Command::new("net")
        .arg("session")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(not(target_os = "windows"))]
fn is_windows_admin() -> bool {
    true
}

#[tauri::command]
pub fn check_admin_privileges() -> bool {
    is_windows_admin()
}

#[tauri::command]
pub async fn toggle_tun_mode(
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<ClientState, String> {
    if enabled && !is_windows_admin() {
        return Err("برای فعال‌سازی حالت TUN در ویندوز، اجرای برنامه با دسترسی Administrator الزامی است. لطفاً برنامه را با Run as administrator باز کنید.".to_string());
    }
    let mut app_state = state.lock().await;
    app_state.tun_mode = enabled;
    let msg = format!(
        "[CONFIG] Kernel TUN Mode set to {}",
        if enabled { "ENABLED (sentra-tun adapter)" } else { "DISABLED (System Proxy Default)" }
    );
    app_state.logs.push(msg);
    Ok(app_state.clone())
}

#[tauri::command]
pub async fn toggle_kill_switch(
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<ClientState, String> {
    let mut app_state = state.lock().await;
    app_state.kill_switch = enabled;
    let msg = format!(
        "[CONFIG] Kill-Switch security guard set to {}",
        if enabled { "ENABLED" } else { "DISABLED" }
    );
    app_state.logs.push(msg);
    Ok(app_state.clone())
}

#[tauri::command]
pub async fn set_auto_reconnect(
    enabled: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ClientState, String> {
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_sentra_vpn::SentraVpnPluginExt;
        let _ = app.sentra_vpn().set_auto_reconnect(enabled);
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
    }

    let mut app_state = state.lock().await;
    app_state.auto_reconnect = enabled;
    app_state.logs.push(format!(
        "[CONFIG] Auto-Reconnect on network switch & wake set to {}",
        if enabled { "ENABLED" } else { "DISABLED" }
    ));
    Ok(app_state.clone())
}

#[tauri::command]
pub async fn reconnect_vpn(
    reason: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
    vpn: State<'_, Arc<VpnManager>>,
) -> Result<ClientState, String> {
    let trigger = reason.unwrap_or_else(|| "network_switch".to_string());
    info!("Reconnect VPN requested (reason: {})", trigger);
    vpn.reconnect_vpn(app, state.inner().clone(), &trigger).await?;
    let app_state = state.lock().await;
    Ok(app_state.clone())
}

#[tauri::command]
pub async fn get_battery_optimization_status(
    app: AppHandle,
) -> Result<tauri_plugin_sentra_vpn::BatteryOptimizationStatusResponse, String> {
    use tauri_plugin_sentra_vpn::SentraVpnPluginExt;
    app.sentra_vpn().get_battery_optimization_status()
}

#[tauri::command]
pub async fn open_battery_optimization_settings(app: AppHandle) -> Result<bool, String> {
    use tauri_plugin_sentra_vpn::SentraVpnPluginExt;
    let res = app.sentra_vpn().open_battery_optimization_settings()?;
    Ok(res.success)
}

#[tauri::command]
pub async fn get_connection_modes(
    token: Option<String>,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;

    for base_url in crate::auth::get_backend_urls() {
        let mut req = client.get(format!("{}/api/v1/client/modes", base_url));
        if let Some(ref t) = token {
            req = req.query(&[("token", t.as_str())]);
        }
        if let Ok(resp) = req.send().await {
            if resp.status().is_success() {
                if let Ok(mut json) = resp.json::<serde_json::Value>().await {
                    // Temporarily hide gaming mode from UI while keeping backend intact
                    if let Some(modes) = json.get_mut("modes").and_then(|m| m.as_array_mut()) {
                        modes.retain(|item| item.get("id").and_then(|v| v.as_str()) != Some("gaming"));
                    }
                    return Ok(json);
                }
            }
        }
    }

    Err("امکان دریافت حالت‌های اتصال از سرور وجود ندارد.".to_string())
}

#[tauri::command]
pub async fn set_connection_mode(
    mode: String,
    state: State<'_, AppState>,
) -> Result<ClientState, String> {
    if mode == "gaming" {
        return Err("حالت گیمینگ موقتاً غیرفعال است.".to_string());
    }
    let mut app_state = state.lock().await;
    app_state.selected_mode = mode.clone();
    if mode == "static_ip" {
        app_state.routing_mode = "tunnel".to_string();
        app_state.kill_switch = true;
        app_state.logs.push("[SECURITY] در حالت آی‌پی ثابت، برای امنیت حساب‌های مالی فقط حالت Tunnel (همراه با Kill-Switch) فعال است.".to_string());
    }
    let msg = format!("[CONFIG] Connection mode switched to [{}]", mode);
    app_state.logs.push(msg);
    Ok(app_state.clone())
}

#[tauri::command]
pub async fn set_connection_protocol(
    protocol: String,
    state: State<'_, AppState>,
) -> Result<ClientState, String> {
    let mut app_state = state.lock().await;
    if protocol == "ikev2" && app_state.routing_mode != "tunnel" {
        app_state.routing_mode = "tunnel".to_string();
        app_state.logs.push("[INFO] [Routing] با انتخاب پروتکل IKEv2، حالت مسیریابی به Tunnel تغییر یافت.".to_string());
    }
    app_state.selected_protocol = protocol.clone();
    let msg = format!("[CONFIG] Connection protocol switched to [{}]", protocol);
    app_state.logs.push(msg);
    Ok(app_state.clone())
}

#[tauri::command]
pub async fn set_routing_mode(
    routing_mode: String,
    app_handle: AppHandle,
    state: State<'_, AppState>,
    vpn: State<'_, Arc<VpnManager>>,
) -> Result<ClientState, String> {
    let mode_lower = routing_mode.to_lowercase();
    if mode_lower != "tunnel" && mode_lower != "system_proxy" && mode_lower != "proxy" {
        return Err("حالت مسیریابی نامعتبر است. گزینه‌های مجاز: tunnel, system_proxy, proxy".to_string());
    }

    let is_connected = {
        let mut s = state.lock().await;
        if s.selected_mode == "static_ip" && mode_lower != "tunnel" {
            return Err("در حالت آی‌پی ثابت، برای امنیت حساب‌های مالی فقط حالت Tunnel فعال است.".to_string());
        }

        // IKEv2 compatibility check
        if (mode_lower == "proxy" || mode_lower == "system_proxy") && s.selected_protocol == "ikev2" {
            s.selected_protocol = "openvpn_udp".to_string();
            s.logs.push("[INFO] [Routing] پروتکل IKEv2 فقط از حالت Tunnel پشتیبانی می‌کند. پروتکل به OpenVPN (UDP) تغییر یافت.".to_string());
        }

        s.routing_mode = mode_lower.clone();
        let log_msg = format!("[CONFIG] Network routing mode switched to [{}]", mode_lower);
        s.logs.push(log_msg);

        s.status == crate::state::ConnectionStatus::Connected
    };

    if is_connected {
        tracing::info!("Reconnecting with new routing mode: {}", mode_lower);
        let _ = vpn.stop_vpn(app_handle.clone(), state.inner().clone()).await;
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let _ = vpn.start_vpn(app_handle, state.inner().clone()).await;
    }

    let s = state.lock().await;
    Ok(s.clone())
}

#[tauri::command]
pub async fn test_api_connection(state: State<'_, AppState>) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(6))
        .build()
        .map_err(|e| e.to_string())?;

    let mut last_error = String::new();
    for base_url in crate::auth::get_backend_urls() {
        let health_url = format!("{}/health", base_url);
        info!("Testing connectivity to Sentra Core API on {}...", health_url);
        let start = std::time::Instant::now();
        match client.get(&health_url).send().await {
            Ok(r) if r.status().is_success() => {
                let duration_ms = start.elapsed().as_millis();
                let mut app_state = state.lock().await;
                let log_entry = format!("[INFO] [API] Sentra Core online at {} (Latency: {}ms)", base_url, duration_ms);
                app_state.logs.push(log_entry);
                return Ok(format!("اتصال به سرور مرکزی برقرار است (تاخیر: {} میلی‌ثانیه)", duration_ms));
            }
            Ok(r) => {
                last_error = format!("HTTP {} از {}", r.status(), base_url);
            }
            Err(e) => {
                last_error = format!("{} ({})", base_url, e);
            }
        }
    }

    let mut app_state = state.lock().await;
    let log_entry = format!("[ERROR] [API] Failed to connect to Sentra Core: {}", last_error);
    app_state.logs.push(log_entry);
    Err(format!("سرور مرکزی سنترا در دسترس نیست ({}).", last_error))
}

#[tauri::command]
pub async fn get_logs(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let app_state = state.lock().await;
    Ok(app_state.logs.clone())
}

#[tauri::command]
pub async fn clear_logs(state: State<'_, AppState>) -> Result<(), String> {
    let mut app_state = state.lock().await;
    app_state.logs.clear();
    app_state.logs.push("[INFO] [Console] Debug logs cleared by user.".to_string());
    Ok(())
}

#[tauri::command]
pub async fn logout(
    app: AppHandle,
    state: State<'_, AppState>,
    vpn: State<'_, Arc<VpnManager>>,
) -> Result<ClientState, String> {
    let _ = vpn.stop_vpn(app.clone(), state.inner().clone()).await;
    AuthManager::clear_session();
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_sentra_vpn::SentraVpnPluginExt;
        let _ = app.sentra_vpn().clear_session();
    }

    let mut app_state = state.lock().await;
    app_state.is_authenticated = false;
    app_state.auth_token = None;
    app_state.subscription_token = None;
    app_state.username = String::new();
    app_state.tier = String::new();
    app_state.expires_at = None;
    app_state.logs.push("[INFO] [Auth] Session cleared. Returned to login screen.".to_string());

    Ok(app_state.clone())
}

#[tauri::command]
pub async fn get_current_device_id() -> Result<String, String> {
    Ok(AuthManager::get_or_create_device_id())
}

#[tauri::command]
pub async fn get_user_devices(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let token_opt = {
        let app_state = state.lock().await;
        app_state.subscription_token.clone()
    };

    let token = match token_opt {
        Some(t) => t,
        None => return Err("کاربر وارد نشده است.".to_string()),
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;

    for base_url in crate::auth::get_backend_urls() {
        let url = format!("{}/api/v1/client/devices?token={}", base_url, token);
        if let Ok(resp) = client.get(&url).send().await {
            if resp.status().is_success() {
                if let Ok(json) = resp.json::<serde_json::Value>().await {
                    return Ok(json);
                }
            }
        }
    }

    Err("خطا در دریافت لیست دستگاه‌های متصل از سرور.".to_string())
}

#[tauri::command]
pub async fn replace_user_device(
    old_device_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
    vpn: State<'_, Arc<VpnManager>>,
) -> Result<ClientState, String> {
    info!("Replacing device {} with current device and reconnecting...", old_device_id);
    let _ = remove_user_device(old_device_id, state.clone()).await?;
    vpn.start_vpn(app, state.inner().clone()).await?;
    let app_state = state.lock().await;
    Ok(app_state.clone())
}

#[tauri::command]
pub async fn remove_user_device(
    device_id: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let token_opt = {
        let app_state = state.lock().await;
        app_state.subscription_token.clone()
    };

    let token = match token_opt {
        Some(t) => t,
        None => return Err("کاربر وارد نشده است.".to_string()),
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;

    for base_url in crate::auth::get_backend_urls() {
        let url = format!("{}/api/v1/client/devices/remove?token={}", base_url, token);
        if let Ok(resp) = client.post(&url).json(&serde_json::json!({ "device_id": device_id })).send().await {
            if resp.status().is_success() {
                if let Ok(json) = resp.json::<serde_json::Value>().await {
                    return Ok(json);
                }
            } else {
                let err_text = resp.text().await.unwrap_or_default();
                return Err(format!("خطا در حذف دستگاه: {}", err_text));
            }
        }
    }

    Err("عدم ارتباط با سرور برای حذف دستگاه.".to_string())
}

#[tauri::command]
pub async fn check_client_version() -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(6))
        .build()
        .map_err(|e| e.to_string())?;

    for base_url in crate::auth::get_backend_urls() {
        let url = format!("{}/api/v1/client/version", base_url);
        if let Ok(resp) = client.get(&url).send().await {
            if resp.status().is_success() {
                if let Ok(val) = resp.json::<serde_json::Value>().await {
                    return Ok(val);
                }
            }
        }
    }

    Err("بررسی نسخه جدید از سرور در دسترس نیست.".to_string())
}

#[tauri::command]
pub async fn test_anti_dpi_settings(
    settings: crate::state::AntiDpiSettings,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    // Save settings into state
    {
        let mut app_state = state.lock().await;
        app_state.anti_dpi = settings.clone();
        app_state.logs.push(format!(
            "[Anti-DPI] Testing settings: Preset={}, MTU={}, DNS={}, Fragment={}",
            settings.preset, settings.mtu, settings.dns_mode, settings.tls_fragment
        ));
    }

    let test_url = match settings.dns_mode.as_str() {
        "google" => "https://dns.google/resolve?name=cloudflare.com",
        "quad9" => "https://dns.quad9.net/dns-query?name=example.com",
        _ => "https://1.1.1.1/cdn-cgi/trace",
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(3500))
        .build()
        .map_err(|e| e.to_string())?;

    let start = std::time::Instant::now();
    let res = client.get(test_url).send().await;
    let elapsed = start.elapsed().as_millis() as u32;

    match res {
        Ok(resp) if resp.status().is_success() => {
            Ok(serde_json::json!({
                "success": true,
                "ping_ms": elapsed.max(1),
                "status_text": format!("متصل شد ({} ms)", elapsed.max(1)),
                "is_blocked": false
            }))
        }
        _ => Ok(serde_json::json!({
            "success": false,
            "ping_ms": 0,
            "status_text": "عدم پاسخ - تنظیمات ضد DPI را بررسی کنید",
            "is_blocked": true
        })),
    }
}

#[tauri::command]
pub async fn save_anti_dpi_settings(
    settings: crate::state::AntiDpiSettings,
    state: State<'_, AppState>,
) -> Result<ClientState, String> {
    let mut app_state = state.lock().await;
    app_state.anti_dpi = settings;
    app_state.logs.push("[Anti-DPI] Laboratory settings saved.".to_string());
    Ok(app_state.clone())
}

#[tauri::command]
pub async fn set_connection_location(
    location: String,
    state: State<'_, AppState>,
) -> Result<ClientState, String> {
    let mut app_state = state.lock().await;
    app_state.selected_location = location.clone();
    let msg = format!("[LOCATION] Connection location set to [{}]", location);
    app_state.logs.push(msg);
    Ok(app_state.clone())
}

#[tauri::command]
pub async fn get_available_locations(
    token: Option<String>,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;

    for base_url in crate::auth::get_backend_urls() {
        let mut req = client.get(format!("{}/api/v1/client/locations", base_url));
        if let Some(ref t) = token {
            req = req.header("X-Subscription-Token", t);
        }
        if let Ok(resp) = req.send().await {
            if resp.status().is_success() {
                if let Ok(json) = resp.json::<serde_json::Value>().await {
                    return Ok(json);
                }
            }
        }
    }

    Err("خطا در دریافت لیست لوکیشن‌ها از سرور.".to_string())
}

#[tauri::command]
pub async fn ping_dns_servers(
    servers: Vec<crate::state::DnsPingItem>,
) -> Result<Vec<crate::state::DnsPingItem>, String> {
    use std::time::{Duration, Instant};
    use tokio::time::timeout;

    let mut tasks = Vec::new();

    for mut s in servers {
        tasks.push(tokio::spawn(async move {
            let addr = s.address.trim().to_string();
            let start = Instant::now();

            let ping = if addr.starts_with("http://") || addr.starts_with("https://") {
                let client = reqwest::Client::builder()
                    .timeout(Duration::from_millis(3000))
                    .build();
                match client {
                    Ok(c) => {
                        let query_url = if addr.contains('?') {
                            format!("{}&name=cloudflare.com", addr)
                        } else {
                            format!("{}?name=cloudflare.com", addr)
                        };
                        match timeout(Duration::from_millis(3000), c.get(&query_url).send()).await {
                            Ok(Ok(resp)) if resp.status().is_success() || resp.status().as_u16() < 500 => {
                                start.elapsed().as_millis() as i64
                            }
                            _ => -1,
                        }
                    }
                    _ => -1,
                }
            } else {
                let target = if addr.contains(':') { addr.clone() } else { format!("{}:53", addr) };
                let connect_res = timeout(
                    Duration::from_millis(2500),
                    tokio::net::TcpStream::connect(&target)
                ).await;

                match connect_res {
                    Ok(Ok(_)) => start.elapsed().as_millis() as i64,
                    _ => {
                        let udp_res = timeout(Duration::from_millis(1500), async {
                            let socket = tokio::net::UdpSocket::bind("0.0.0.0:0").await?;
                            socket.connect(&target).await?;
                            let dummy_query = [
                                0xaa, 0xbb, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00,
                                0x00, 0x00, 0x00, 0x00, 0x07, b'e', b'x', b'a',
                                b'm', b'p', b'l', b'e', 0x03, b'c', b'o', b'm',
                                0x00, 0x00, 0x01, 0x00, 0x01
                            ];
                            socket.send(&dummy_query).await?;
                            let mut buf = [0u8; 512];
                            socket.recv(&mut buf).await?;
                            Ok::<(), std::io::Error>(())
                        }).await;

                        match udp_res {
                            Ok(Ok(_)) => start.elapsed().as_millis() as i64,
                            _ => -1,
                        }
                    }
                }
            };

            s.ping_ms = ping;
            s
        }));
    }

    let mut results = Vec::new();
    for t in tasks {
        if let Ok(item) = t.await {
            results.push(item);
        }
    }

    results.sort_by(|a, b| {
        match (a.ping_ms >= 0, b.ping_ms >= 0) {
            (true, true) => a.ping_ms.cmp(&b.ping_ms),
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            (false, false) => a.name.cmp(&b.name),
        }
    });

    Ok(results)
}

#[tauri::command]
pub async fn save_dns_settings(
    config: crate::state::DnsConfig,
    state: State<'_, AppState>,
) -> Result<ClientState, String> {
    let mut app_state = state.lock().await;
    app_state.dns_config = config;
    app_state.logs.push("[DNS] Smart DNS configuration saved.".to_string());
    Ok(app_state.clone())
}

#[tauri::command]
pub async fn get_dns_settings(
    state: State<'_, AppState>,
) -> Result<crate::state::DnsConfig, String> {
    let app_state = state.lock().await;
    Ok(app_state.dns_config.clone())
}

#[tauri::command]
pub async fn set_use_warp(
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<ClientState, String> {
    let mut app_state = state.lock().await;
    if app_state.selected_mode == "static_ip" {
        app_state.use_warp = false;
        return Ok(app_state.clone());
    }
    app_state.use_warp = enabled;
    app_state.logs.push(format!("[WARP] Cloudflare WARP tunnel set to: {}", if enabled { "روشن (Enabled)" } else { "خاموش (Disabled)" }));
    Ok(app_state.clone())
}

#[tauri::command]
pub async fn fetch_client_bootstrap(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let token_opt = {
        let s = state.lock().await;
        s.subscription_token.clone()
    };
    let token = token_opt.ok_or("نشست فعالی یافت نشد. لطفاً وارد حساب خود شوید.".to_string())?;

    match AuthManager::fetch_bootstrap(&token).await {
        Ok(data) => {
            let mut s = state.lock().await;
            if let Some(sub) = data.get("subscription") {
                if let Some(tier) = sub.get("tier").and_then(|v| v.as_str()) {
                    s.tier = tier.to_string();
                }
                if let Some(rem) = sub.get("remaining_bytes").and_then(|v| v.as_i64()) {
                    s.remaining_bytes = rem;
                }
                if let Some(exp) = sub.get("expires_at").and_then(|v| v.as_str()) {
                    s.expires_at = Some(exp.to_string());
                }
            }
            if let Some(user) = data.get("user") {
                if let Some(uname) = user
                    .get("username")
                    .and_then(|v| v.as_str())
                    .or_else(|| user.get("first_name").and_then(|v| v.as_str()))
                {
                    s.username = uname.to_string();
                }
            }
            if let Some(sub) = data.get("subscription") {
                if let Some(code) = sub.get("connect_code").and_then(|v| v.as_str()) {
                    s.connect_code = Some(code.to_string());
                }
                if let Some(pt) = sub.get("plan_tier").and_then(|v| v.as_str()) {
                    s.plan_tier = Some(pt.to_string());
                }
            }
            let refreshed_session = crate::auth::SessionData {
                auth_token: s
                    .auth_token
                    .clone()
                    .unwrap_or_else(|| format!("jwt_sentra_{}", token)),
                subscription_token: token.clone(),
                connect_code: s.connect_code.clone(),
                plan_tier: s.plan_tier.clone(),
                tier: s.tier.clone(),
                username: s.username.clone(),
                remaining_bytes: s.remaining_bytes,
                expires_at: s.expires_at.clone(),
            };
            let _ = AuthManager::save_session(&refreshed_session);
            let out_count = data
                .get("outbounds")
                .and_then(|v| v.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
            s.logs.push(format!(
                "[INFO] [Sync] Bootstrap synced from server ({} active outbounds).",
                out_count
            ));
            Ok(data)
        }
        Err(err) => {
            if err.starts_with("AUTH_EXPIRED:") {
                AuthManager::clear_session();
                let mut s = state.lock().await;
                s.is_authenticated = false;
                s.auth_token = None;
                s.subscription_token = None;
            }
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn ping_server_node(host: String, port: u16) -> Result<i64, String> {
    Ok(AuthManager::ping_tcp(&host, port).await)
}

#[tauri::command]
pub async fn donate_user_outbound(
    uri: String,
    name: Option<String>,
    note: Option<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let token = {
        let s = state.lock().await;
        s.subscription_token.clone()
    }
    .ok_or("ابتدا وارد حساب کاربری خود شوید.".to_string())?;

    let res = AuthManager::donate_outbound(&token, &uri, name.as_deref(), note.as_deref()).await?;
    let mut s = state.lock().await;
    s.logs.push("[INFO] [Donate] Outbound submitted for admin approval.".to_string());
    Ok(res)
}

#[tauri::command]
pub async fn get_my_donated_outbounds(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let token = {
        let s = state.lock().await;
        s.subscription_token.clone()
    }
    .ok_or("ابتدا وارد حساب کاربری خود شوید.".to_string())?;

    AuthManager::get_my_donations(&token).await
}

#[tauri::command]
pub async fn save_personal_configs(configs_json: String) -> Result<(), String> {
    let path = AuthManager::personal_configs_path();
    std::fs::write(path, configs_json).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn load_personal_configs() -> Result<String, String> {
    let path = AuthManager::personal_configs_path();
    if !path.exists() {
        return Ok("[]".to_string());
    }
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_selected_outbound(
    outbound_id: Option<String>,
    personal_uri: Option<String>,
    state: State<'_, AppState>,
) -> Result<ClientState, String> {
    let mut s = state.lock().await;
    s.selected_outbound_id = outbound_id.clone();
    s.selected_personal_uri = personal_uri;
    s.logs.push(format!(
        "[CONFIG] Active outbound updated: {:?}",
        outbound_id.as_deref().unwrap_or("auto")
    ));
    Ok(s.clone())
}

#[tauri::command]
pub async fn save_persisted_session(
    app: AppHandle,
    session_json: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    if let Ok(parsed) = serde_json::from_str::<crate::auth::SessionData>(&session_json) {
        let _ = AuthManager::save_session(&parsed);
        let mut s = state.lock().await;
        s.is_authenticated = true;
        s.auth_token = Some(parsed.auth_token);
        s.subscription_token = Some(parsed.subscription_token);
        s.connect_code = parsed.connect_code;
        s.plan_tier = parsed.plan_tier;
        s.tier = parsed.tier;
        s.username = parsed.username;
        s.remaining_bytes = parsed.remaining_bytes;
        s.expires_at = parsed.expires_at;
    }

    #[cfg(target_os = "android")]
    {
        use tauri_plugin_sentra_vpn::SentraVpnPluginExt;
        app.sentra_vpn().save_session(session_json)?;
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
    }

    Ok(true)
}

#[tauri::command]
pub async fn load_persisted_session(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_sentra_vpn::SentraVpnPluginExt;
        if let Ok(res) = app.sentra_vpn().load_session() {
            if res.found && !res.payload.trim().is_empty() {
                if let Ok(parsed) = serde_json::from_str::<crate::auth::SessionData>(&res.payload) {
                    let mut s = state.lock().await;
                    s.is_authenticated = true;
                    s.auth_token = Some(parsed.auth_token);
                    s.subscription_token = Some(parsed.subscription_token);
                    s.connect_code = parsed.connect_code;
                    s.plan_tier = parsed.plan_tier;
                    s.tier = parsed.tier;
                    s.username = parsed.username;
                    s.remaining_bytes = parsed.remaining_bytes;
                    s.expires_at = parsed.expires_at;
                }
                return Ok(Some(res.payload));
            }
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
    }

    if let Some(sess) = AuthManager::load_saved_session() {
        let mut s = state.lock().await;
        s.is_authenticated = true;
        s.auth_token = Some(sess.auth_token.clone());
        s.subscription_token = Some(sess.subscription_token.clone());
        s.tier = sess.tier.clone();
        s.username = sess.username.clone();
        s.remaining_bytes = sess.remaining_bytes;
        s.expires_at = sess.expires_at.clone();
        if let Ok(json_str) = serde_json::to_string(&sess) {
            return Ok(Some(json_str));
        }
    }

    Ok(None)
}

#[tauri::command]
pub async fn clear_persisted_session(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    AuthManager::clear_session();
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_sentra_vpn::SentraVpnPluginExt;
        let _ = app.sentra_vpn().clear_session();
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
    }

    let mut s = state.lock().await;
    s.is_authenticated = false;
    s.auth_token = None;
    s.subscription_token = None;
    s.username = String::new();
    s.tier = String::new();
    s.expires_at = None;
    Ok(true)
}

#[tauri::command]
pub async fn fetch_client_state_from_server(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let token = {
        let s = state.lock().await;
        s.subscription_token.clone()
    }
    .ok_or("نشست فعالی یافت نشد. لطفاً وارد حساب خود شوید.".to_string())?;

    AuthManager::fetch_client_sync_state(&token).await
}

#[tauri::command]
pub async fn sync_client_state_to_server(
    payload: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let token = {
        let s = state.lock().await;
        s.subscription_token.clone()
    }
    .ok_or("نشست فعالی یافت نشد. لطفاً وارد حساب خود شوید.".to_string())?;

    AuthManager::push_client_sync_state(&token, payload).await
}

#[tauri::command]
pub async fn report_usage_heartbeat(
    mode: Option<String>,
    delta_upload_bytes: i64,
    delta_download_bytes: i64,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let (token, active_mode) = {
        let s = state.lock().await;
        (s.subscription_token.clone(), s.selected_mode.clone())
    };
    let token = token.ok_or("نشست فعالی یافت نشد. لطفاً وارد حساب خود شوید.".to_string())?;
    let device_id = AuthManager::get_or_create_device_id();
    let mode_to_send = mode.unwrap_or(active_mode);

    let verdict = AuthManager::send_usage_heartbeat(
        &token,
        &device_id,
        &mode_to_send,
        delta_upload_bytes,
        delta_download_bytes,
    )
    .await?;

    if let Some(remaining) = verdict.get("remaining_bytes").and_then(|b| b.as_i64()) {
        let mut s = state.lock().await;
        s.remaining_bytes = remaining;
    }

    Ok(verdict)
}
