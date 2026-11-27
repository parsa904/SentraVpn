use crate::local_proxy::LocalProxyService;
use crate::state::{AppState, ConnectionStatus};
use crate::sysproxy;
use crate::telemetry::TelemetryService;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tracing::{info, warn};

#[cfg(not(target_os = "android"))]
use std::process::Stdio;
#[cfg(not(target_os = "android"))]
use tauri::Manager;
#[cfg(not(target_os = "android"))]
use tokio::process::{Child, Command};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnsyncedTraffic {
    pub token: String,
    pub device_id: String,
    pub mode: String,
    pub delta_upload_bytes: u64,
    pub delta_download_bytes: u64,
}

pub struct VpnManager {
    #[cfg(not(target_os = "android"))]
    child_process: Arc<Mutex<Option<Child>>>,
    is_running: Arc<AtomicBool>,
    is_reconnecting: Arc<AtomicBool>,
    local_proxy: Arc<Mutex<Option<LocalProxyService>>>,
}

impl Drop for VpnManager {
    fn drop(&mut self) {
        let _ = sysproxy::disable_system_proxy();
    }
}

impl Default for VpnManager {
    fn default() -> Self {
        Self::new()
    }
}

impl VpnManager {
    pub fn new() -> Self {
        Self {
            #[cfg(not(target_os = "android"))]
            child_process: Arc::new(Mutex::new(None)),
            is_running: Arc::new(AtomicBool::new(false)),
            is_reconnecting: Arc::new(AtomicBool::new(false)),
            local_proxy: Arc::new(Mutex::new(None)),
        }
    }

    /// Return path to local crash-safe unsynced traffic persistence file
    pub fn unsynced_traffic_file() -> PathBuf {
        crate::auth::AuthManager::app_data_dir().join("unsynced_traffic.json")
    }

    /// Send pending unsynced traffic from previous abnormal termination (Crash-Safe Sync)
    pub async fn sync_pending_traffic() {
        let path = Self::unsynced_traffic_file();
        if !path.exists() {
            return;
        }

        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(unsynced) = serde_json::from_str::<UnsyncedTraffic>(&content) {
                if unsynced.delta_upload_bytes > 0 || unsynced.delta_download_bytes > 0 {
                    info!(
                        "Crash-safe recovery: Syncing {} bytes up, {} bytes down to server...",
                        unsynced.delta_upload_bytes, unsynced.delta_download_bytes
                    );
                    let client = match reqwest::Client::builder()
                        .timeout(std::time::Duration::from_secs(3))
                        .build()
                    {
                        Ok(c) => c,
                        Err(_) => return,
                    };

                    for base_url in crate::auth::get_backend_urls() {
                        let url = format!("{}/api/v1/client/heartbeat", base_url);
                        let res = client
                            .post(&url)
                            .header("X-Subscription-Token", &unsynced.token)
                            .json(&json!({
                                "device_id": unsynced.device_id,
                                "mode": unsynced.mode,
                                "delta_upload_bytes": unsynced.delta_upload_bytes,
                                "delta_download_bytes": unsynced.delta_download_bytes
                            }))
                            .send()
                            .await;

                        if let Ok(resp) = res {
                            if resp.status().is_success() {
                                info!("Crash-safe traffic sync successfully acknowledged by backend.");
                                let _ = fs::remove_file(&path);
                                break;
                            }
                        }
                    }
                } else {
                    let _ = fs::remove_file(&path);
                }
            }
        }
    }

    /// Locate OpenVPN binary on the system (Sidecar path, environment, or system PATH) - Desktop Only
    #[cfg(not(target_os = "android"))]
    pub fn locate_openvpn_binary(app_handle: Option<&AppHandle>) -> Option<PathBuf> {
        if let Ok(p) = std::env::var("OPENVPN_BINARY_PATH") {
            let path = PathBuf::from(p);
            if path.exists() {
                return Some(path);
            }
        }

        if let Some(_app) = app_handle {
            let candidate = PathBuf::from("binaries").join(format!("openvpn-{}", std::env::consts::ARCH));
            if candidate.exists() {
                return Some(candidate);
            }
            let candidate_exe = PathBuf::from("binaries").join("openvpn.exe");
            if candidate_exe.exists() {
                return Some(candidate_exe);
            }
        }

        let candidates = [
            "openvpn.exe",
            "openvpn",
            "C:\\Program Files\\OpenVPN\\bin\\openvpn.exe",
            "C:\\Program Files (x86)\\OpenVPN\\bin\\openvpn.exe",
        ];
        for name in &candidates {
            let path = PathBuf::from(name);
            if path.exists() {
                return Some(path);
            }
            if let Ok(output) = std::process::Command::new("where.exe").arg(name).output() {
                if output.status.success() {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    if let Some(first_line) = stdout.lines().next() {
                        let p = PathBuf::from(first_line.trim());
                        if p.exists() {
                            return Some(p);
                        }
                    }
                }
            }
        }

        None
    }

    /// Locate sing-box binary on Windows/Desktop (env var, exe directory for NSIS & Portable, resource dir, or PATH)
    #[cfg(not(target_os = "android"))]
    pub fn locate_singbox_binary(app_handle: Option<&AppHandle>) -> Option<PathBuf> {
        // 1. Check SING_BOX_PATH env var
        if let Ok(p) = std::env::var("SING_BOX_PATH") {
            let path = PathBuf::from(p);
            if path.exists() {
                return Some(path);
            }
        }

        // 2. Check next to the running executable (Tauri NSIS Setup & Windows Portable ZIP layout)
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(exe_dir) = exe_path.parent() {
                let exe_candidates = [
                    exe_dir.join("sing-box.exe"),
                    exe_dir.join("sing-box"),
                    exe_dir.join("sing-box-x86_64-pc-windows-msvc.exe"),
                    exe_dir.join("binaries").join("sing-box.exe"),
                    exe_dir.join("binaries").join("sing-box-x86_64-pc-windows-msvc.exe"),
                ];
                for candidate in exe_candidates {
                    if candidate.exists() {
                        return Some(candidate);
                    }
                }
            }
        }

        // 3. Check Tauri bundled resource directory
        if let Some(app) = app_handle {
            if let Ok(res_dir) = app.path().resource_dir() {
                let res_candidates = [
                    res_dir.join("sing-box.exe"),
                    res_dir.join("sing-box"),
                    res_dir.join("binaries").join("sing-box.exe"),
                    res_dir.join("binaries").join("sing-box-x86_64-pc-windows-msvc.exe"),
                ];
                for candidate in res_candidates {
                    if candidate.exists() {
                        return Some(candidate);
                    }
                }
            }
        }

        // 4. Check relative binaries directory (dev environment)
        let dev_candidates = [
            PathBuf::from("binaries").join("sing-box-x86_64-pc-windows-msvc.exe"),
            PathBuf::from("binaries").join("sing-box.exe"),
            PathBuf::from("binaries").join(format!("sing-box-{}", std::env::consts::ARCH)),
        ];
        for candidate in dev_candidates {
            if candidate.exists() {
                return Some(candidate);
            }
        }

        // 5. Check system PATH via where.exe (Windows)
        let candidates = ["sing-box.exe", "sing-box"];
        for name in &candidates {
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

    /// Fetch live client config from backend API (Shared Desktop & Android) — zero mock fallback
    #[allow(clippy::too_many_arguments)]
    pub async fn fetch_or_compile_config(
        token: &str,
        selected_mode: &str,
        selected_protocol: &str,
        split_tunneling: bool,
        anti_dpi: &crate::state::AntiDpiSettings,
        selected_location: Option<&str>,
        dns_config: &crate::state::DnsConfig,
        use_warp: bool,
        selected_outbound_id: Option<&str>,
        personal_uri: Option<&str>,
    ) -> Result<Value, String> {
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(6))
            .timeout(std::time::Duration::from_secs(12))
            .build()
            .map_err(|e| format!("خطا در ساخت کلاینت HTTP: {}", e))?;

        let dev_id = crate::auth::AuthManager::get_or_create_device_id();
        let dev_name = if cfg!(target_os = "android") {
            "Android Device"
        } else {
            "Windows PC"
        };

        let mut request_body = json!({
            "token": token,
            "device_id": dev_id,
            "device_name": dev_name,
            "os": if cfg!(target_os = "android") { "android" } else { "windows" },
            "mode": selected_mode,
            "protocol": selected_protocol,
            "use_warp": if selected_mode == "static_ip" || selected_mode == "gaming" { false } else { use_warp }
        });
        if let Some(loc) = selected_location {
            if !loc.is_empty() && loc != "auto" {
                request_body["location_code"] = json!(loc);
            }
        }
        if let Some(ob_id) = selected_outbound_id {
            if !ob_id.trim().is_empty() {
                request_body["selected_outbound_id"] = json!(ob_id.trim());
            }
        }
        if let Some(uri) = personal_uri {
            if !uri.trim().is_empty() {
                request_body["personal_uri"] = json!(uri.trim());
            }
        }

        let cache_key = format!(
            "{}:{}",
            selected_mode,
            selected_location.unwrap_or("auto")
        );
        let cache_path =
            crate::auth::AuthManager::app_data_dir().join("last_healthy_singbox_cache.json");
        let cached_entry: Option<(Option<String>, Value)> = std::fs::read_to_string(&cache_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|json_val| {
                let stored_key = json_val.get("cache_key").and_then(|k| k.as_str())?;
                if stored_key != cache_key {
                    return None;
                }
                let etag = json_val
                    .get("etag")
                    .and_then(|e| e.as_str())
                    .map(|s| s.to_string());
                let payload = json_val.get("config")?.clone();
                Some((etag, payload))
            });
        let cached_etag = cached_entry.as_ref().and_then(|(e, _)| e.clone());

        let mut config_val_opt: Option<Value> = None;
        let mut last_status = None;
        let mut last_err_body = None;

        for base_url in crate::auth::get_backend_urls() {
            let url = format!("{}/api/v1/client/config", base_url);
            let mut req_builder = client
                .post(&url)
                .header("X-Subscription-Token", token)
                .json(&request_body);
            if let Some(ref etag) = cached_etag {
                req_builder = req_builder.header("If-None-Match", etag);
            }

            match req_builder.send().await {
                Ok(resp) if resp.status() == reqwest::StatusCode::NOT_MODIFIED => {
                    if let Some((_, ref cached_cfg)) = cached_entry {
                        config_val_opt = Some(cached_cfg.clone());
                        break;
                    }
                }
                Ok(resp) if resp.status().is_success() => {
                    let resp_etag = resp
                        .headers()
                        .get(reqwest::header::ETAG)
                        .and_then(|v| v.to_str().ok())
                        .map(|s| s.to_string());
                    let parsed = resp
                        .json::<Value>()
                        .await
                        .map_err(|e| format!("پاسخ پیکربندی سرور نامعتبر بود: {}", e))?;
                    let cache_doc = json!({
                        "cache_key": cache_key,
                        "etag": resp_etag,
                        "config": parsed,
                    });
                    if let Ok(serialized) = serde_json::to_string(&cache_doc) {
                        let _ = std::fs::write(&cache_path, serialized);
                    }
                    config_val_opt = Some(parsed);
                    break;
                }
                Ok(resp) if resp.status().is_server_error() || resp.status().as_u16() == 404 => {
                    last_status = Some(resp.status());
                    last_err_body = resp.text().await.ok();
                    // Fallback to direct sing-box 1.14+ subscription endpoint GET /sub/{token}?format=singbox
                    let sub_url = format!("{}/sub/{}?format=singbox&mode={}", base_url, token, selected_mode);
                    let mut sub_req = client.get(&sub_url);
                    if let Some(ref etag) = cached_etag {
                        sub_req = sub_req.header("If-None-Match", etag);
                    }
                    if let Ok(sub_resp) = sub_req.send().await {
                        if sub_resp.status() == reqwest::StatusCode::NOT_MODIFIED {
                            if let Some((_, ref cached_cfg)) = cached_entry {
                                config_val_opt = Some(cached_cfg.clone());
                                break;
                            }
                        } else if sub_resp.status().is_success() {
                            let resp_etag = sub_resp
                                .headers()
                                .get(reqwest::header::ETAG)
                                .and_then(|v| v.to_str().ok())
                                .map(|s| s.to_string());
                            if let Ok(parsed) = sub_resp.json::<Value>().await {
                                let cache_doc = json!({
                                    "cache_key": cache_key,
                                    "etag": resp_etag,
                                    "config": parsed,
                                });
                                if let Ok(serialized) = serde_json::to_string(&cache_doc) {
                                    let _ = std::fs::write(&cache_path, serialized);
                                }
                                config_val_opt = Some(parsed);
                                break;
                            }
                        }
                    }
                    warn!("Config endpoint {} returned {}; trying next fallback...", base_url, last_status.map(|s| s.as_u16()).unwrap_or(0));
                }
                Ok(resp) => {
                    last_status = Some(resp.status());
                    last_err_body = resp.text().await.ok();
                    break;
                }
                Err(e) => {
                    warn!("Failed to reach config endpoint {} ({}). Switching to next fallback...", base_url, e);
                }
            }
        }

        let mut config_val = match config_val_opt {
            Some(val) => val,
            None => {
                if let Some(status) = last_status {
                    let err_text = last_err_body.unwrap_or_default();
                    warn!("Backend rejected client config request (HTTP {}): {}", status, err_text);

                    if let Ok(err_json) = serde_json::from_str::<Value>(&err_text) {
                        let code = err_json.get("code").and_then(|c| c.as_str()).unwrap_or("");
                        if code == "MAX_DEVICES_REACHED" {
                            return Err("MAX_DEVICES_REACHED: سقف اتصال هم‌زمان ۳ دستگاه برای این اشتراک تکمیل شده است. لطفاً از بخش مدیریت دستگاه‌ها یکی از دستگاه‌های قبلی را حذف کنید.".to_string());
                        } else if code == "ACCOUNT_SUSPENDED" {
                            let msg = err_json
                                .get("message")
                                .and_then(|m| m.as_str())
                                .unwrap_or("حساب شما به دلیل الگوی مصرف ترافیک غیرعادی موقتاً متوقف شده است. لطفاً با پشتیبانی در ارتباط باشید.");
                            return Err(format!("ACCOUNT_SUSPENDED: {}", msg));
                        }
                        if let Some(msg) = err_json.get("message").or_else(|| err_json.get("error")).and_then(|m| m.as_str()) {
                            return Err(msg.to_string());
                        }
                    }

                    // Fall back to last healthy cached config on transient 5xx server outage
                    if status.is_server_error() {
                        if let Some((_, cached_cfg)) = cached_entry {
                            warn!("Using locally cached healthy sing-box config during server outage ({}).", status);
                            cached_cfg
                        } else {
                            return Err(format!("خطا در دریافت تنظیمات اتصال از سرور (HTTP {}).", status));
                        }
                    } else {
                        return Err(format!("خطا در دریافت تنظیمات اتصال از سرور (HTTP {}).", status));
                    }
                } else if let Some((_, cached_cfg)) = cached_entry {
                    warn!("Backend unreachable; falling back to locally cached healthy sing-box config.");
                    cached_cfg
                } else {
                    return Err("امکان برقراری ارتباط با سرور مرکزی سنترا جهت دریافت پیکربندی اتصال وجود ندارد. اینترنت خود را بررسی کنید.".to_string());
                }
            }
        };

        // Apply client-side split-tunnel, DNS, clash_api & Anti-DPI adjustments to the embedded singbox_config object (or root if raw)
        let custom_dns_for_ovpn = if selected_mode != "static_ip"
            && !dns_config.selected_dns_address.is_empty()
            && dns_config.selected_dns_id != "auto"
        {
            Some(dns_config.selected_dns_address.clone())
        } else {
            None
        };

        {
            let target_sb = if config_val.get("singbox_config").is_some() {
                config_val.get_mut("singbox_config").unwrap()
            } else if config_val.get("config").is_some() {
                config_val.get_mut("config").unwrap()
            } else {
                &mut config_val
            };

            // Only override Sentra Select default if selected_mode matches an actual outbound tag
            if selected_mode != "Sentra Auto" {
                if let Some(outbounds_arr) = target_sb.get_mut("outbounds").and_then(|o| o.as_array_mut()) {
                    let has_matching_tag = outbounds_arr
                        .iter()
                        .any(|item| item.get("tag").and_then(|t| t.as_str()) == Some(selected_mode));
                    if has_matching_tag {
                        for item in outbounds_arr {
                            if item.get("tag").and_then(|t| t.as_str()) == Some("Sentra Select") {
                                item["default"] = json!(selected_mode);
                            }
                        }
                    }
                }
            }

            // Handle Split Tunneling
            if !split_tunneling {
                if let Some(rules) = target_sb
                    .get_mut("route")
                    .and_then(|r| r.get_mut("rules"))
                    .and_then(|r| r.as_array_mut())
                {
                    rules.retain(|rule| {
                        if let Some(outbound) = rule.get("outbound").and_then(|o| o.as_str()) {
                            if outbound == "direct" && rule.get("domain_suffix").is_some() {
                                return false;
                            }
                        }
                        true
                    });
                }
            }

            // Strict Leak Protection for Static IP (sing-box 1.14+ typed DNS & reject rule action)
            if selected_mode == "static_ip" {
                info!("Enforcing Strict Leak Protection for Static IP (sing-box 1.14+: IPv6 rejected, Remote Global DoH).");
                if let Some(dns) = target_sb.get_mut("dns") {
                    dns["servers"] = json!([
                        {
                            "type": "https",
                            "tag": "dns-doh",
                            "server": "1.1.1.1",
                            "server_port": 443,
                            "path": "/dns-query",
                            "detour": "Sentra Select"
                        },
                        {
                            "type": "local",
                            "tag": "dns-direct"
                        }
                    ]);
                    dns["rules"] = json!([]);
                    dns["final"] = json!("dns-doh");
                    dns["strategy"] = json!("ipv4_only");
                    if let Some(obj) = dns.as_object_mut() {
                        obj.remove("independent_cache");
                        obj.remove("fakeip");
                    }
                }
                if let Some(rules) = target_sb
                    .get_mut("route")
                    .and_then(|r| r.get_mut("rules"))
                    .and_then(|r| r.as_array_mut())
                {
                    rules.insert(0, json!({
                        "ip_version": 6,
                        "action": "reject"
                    }));
                }
            } else if selected_mode == "gaming" {
                info!("Applying Ultra-Low-Latency Gaming optimizations (sing-box 1.14+: MTU 1280, Full-Cone NAT, Direct UDP DNS).");
                // 1. Optimize TUN inbound for gaming UDP streams (sing-box 1.14+ `address` array)
                if let Some(inbounds) = target_sb.get_mut("inbounds").and_then(|i| i.as_array_mut()) {
                    for ib in inbounds {
                        if ib.get("type").and_then(|t| t.as_str()) == Some("tun") {
                            ib["address"] = json!(["172.19.0.1/30"]);
                            ib["mtu"] = json!(1280);
                            ib["stack"] = json!("system");
                            ib["endpoint_independent_nat"] = json!(true);
                            ib["udp_timeout"] = json!("5m");
                            ib["strict_route"] = json!(true);
                            if let Some(obj) = ib.as_object_mut() {
                                obj.remove("inet4_address");
                                obj.remove("inet6_address");
                                obj.remove("sniff");
                                obj.remove("sniff_override_destination");
                            }
                        }
                    }
                }
                // 2. Tune urltest for tight 15ms jitter tolerance without mid-match flapping
                if let Some(outbounds) = target_sb.get_mut("outbounds").and_then(|o| o.as_array_mut()) {
                    for ob in outbounds {
                        if ob.get("type").and_then(|t| t.as_str()) == Some("urltest") {
                            ob["interval"] = json!("1m");
                            ob["tolerance"] = json!(15);
                        }
                    }
                }
                // 3. Direct IPv4 UDP DNS (sing-box 1.14+ typed servers)
                let gaming_dns_host = custom_dns_for_ovpn
                    .as_deref()
                    .filter(|addr| !addr.starts_with("http"))
                    .map(|addr| addr.trim_start_matches("udp://").split(':').next().unwrap_or("1.1.1.1").to_string())
                    .unwrap_or_else(|| "1.1.1.1".to_string());
                if let Some(dns) = target_sb.get_mut("dns") {
                    dns["servers"] = json!([
                        {
                            "type": "udp",
                            "tag": "dns-remote",
                            "server": gaming_dns_host,
                            "server_port": 53,
                            "detour": "Sentra Select"
                        },
                        {
                            "type": "udp",
                            "tag": "dns-remote-backup",
                            "server": "8.8.8.8",
                            "server_port": 53,
                            "detour": "Sentra Select"
                        },
                        {
                            "type": "local",
                            "tag": "dns-direct"
                        }
                    ]);
                    dns["final"] = json!("dns-remote");
                    dns["strategy"] = json!("ipv4_only");
                    if let Some(obj) = dns.as_object_mut() {
                        obj.remove("independent_cache");
                        obj.remove("fakeip");
                    }
                }
                // 4. Minimize log I/O overhead during gaming
                target_sb["log"] = json!({
                    "level": "warn",
                    "timestamp": true
                });
            } else if let Some(ref dns_addr) = custom_dns_for_ovpn {
                info!("Injecting customized DNS into sing-box 1.14+ profile: {}", dns_addr);
                if let Some(dns) = target_sb.get_mut("dns") {
                    if let Some(servers) = dns.get_mut("servers").and_then(|s| s.as_array_mut()) {
                        for s in servers {
                            let tag = s.get("tag").and_then(|t| t.as_str()).unwrap_or("");
                            if tag == "dns-remote" || tag == "dns-doh" {
                                if let Some(stripped) = dns_addr.strip_prefix("https://") {
                                    let host = stripped.split('/').next().unwrap_or("1.1.1.1");
                                    s["type"] = json!("https");
                                    s["server"] = json!(host);
                                    s["server_port"] = json!(443);
                                    s["path"] = json!("/dns-query");
                                } else {
                                    let host = dns_addr.trim_start_matches("udp://").split(':').next().unwrap_or("1.1.1.1");
                                    s["type"] = json!("udp");
                                    s["server"] = json!(host);
                                    s["server_port"] = json!(53);
                                }
                                if let Some(obj) = s.as_object_mut() {
                                    obj.remove("address");
                                }
                            }
                        }
                    }
                }
            }

            // Ensure experimental.clash_api exists for live kernel traffic sync
            if target_sb.get("experimental").is_none() {
                target_sb["experimental"] = json!({
                    "clash_api": {
                        "external_controller": "127.0.0.1:9090",
                        "secret": "sentra_internal_traffic_secret"
                    }
                });
            }

            // Apply Anti-DPI Lab parameters into Sing-box config (bypassed in gaming mode to prevent artificial latency/jitter)
            if selected_mode != "gaming" {
                Self::apply_anti_dpi_settings(target_sb, anti_dpi);
            }
        }

        if let Some(ref dns_addr) = custom_dns_for_ovpn {
            if let Some(ovpn_str) = config_val.get_mut("ovpn_config").and_then(|o| o.as_str()) {
                let mut new_ovpn = ovpn_str.to_string();
                if !dns_addr.starts_with("http") {
                    new_ovpn.push_str(&format!("\ndhcp-option DNS {}\n", dns_addr));
                }
                config_val["ovpn_config"] = json!(new_ovpn);
            }
        }

        Ok(config_val)
    }

    /// Injects Anti-DPI parameters (TLS fragment, MUX padding, DoH Anti-Poisoning, MTU) into Sing-box config
    pub fn apply_anti_dpi_settings(config: &mut Value, anti_dpi: &crate::state::AntiDpiSettings) {
        // 1. TLS Fragment
        if anti_dpi.tls_fragment || anti_dpi.preset == "severe_filtering" {
            let length = if anti_dpi.fragment_length.is_empty() { "10-30" } else { &anti_dpi.fragment_length };
            let interval = if anti_dpi.fragment_interval.is_empty() { "10-20ms" } else { &anti_dpi.fragment_interval };

            if let Some(outbounds) = config.get_mut("outbounds").and_then(|o| o.as_array_mut()) {
                for ob in outbounds {
                    if let Some(tls) = ob.get_mut("tls") {
                        tls["fragment"] = json!({
                            "enabled": true,
                            "length": length,
                            "interval": interval
                        });
                    }
                }
            }
        }

        // 2. Mux + Padding
        if anti_dpi.mux_padding || anti_dpi.preset == "severe_filtering" || anti_dpi.preset == "national_disruption" {
            if let Some(outbounds) = config.get_mut("outbounds").and_then(|o| o.as_array_mut()) {
                for ob in outbounds {
                    let ob_type = ob.get("type").and_then(|t| t.as_str()).unwrap_or("");
                    if ob_type == "vless" || ob_type == "trojan" || ob_type == "socks" {
                        ob["multiplex"] = json!({
                            "enabled": true,
                            "protocol": "h2mux",
                            "max_connections": 4,
                            "min_streams": 4,
                            "padding": true
                        });
                    }
                }
            }
        }

        // 3. Anti-Poisoning DNS (sing-box 1.14+ typed DNS server fields)
        let doh_server = match anti_dpi.dns_mode.as_str() {
            "google" => Some("8.8.8.8"),
            "quad9" => Some("9.9.9.9"),
            "fakeip" => None,
            _ => Some("1.1.1.1"),
        };

        if let Some(server_ip) = doh_server {
            if let Some(dns) = config.get_mut("dns") {
                if let Some(servers) = dns.get_mut("servers").and_then(|s| s.as_array_mut()) {
                    for s in servers {
                        let tag = s.get("tag").and_then(|t| t.as_str()).unwrap_or("");
                        if tag == "dns-remote" || tag == "dns-doh" {
                            s["type"] = json!("https");
                            s["server"] = json!(server_ip);
                            s["server_port"] = json!(443);
                            s["path"] = json!("/dns-query");
                            if let Some(obj) = s.as_object_mut() {
                                obj.remove("address");
                            }
                        }
                    }
                }
            }
        }

        // 4. MTU
        if anti_dpi.mtu > 0 {
            if let Some(inbounds) = config.get_mut("inbounds").and_then(|i| i.as_array_mut()) {
                for ib in inbounds {
                    if ib.get("type").and_then(|t| t.as_str()) == Some("tun") {
                        ib["mtu"] = json!(anti_dpi.mtu);
                    }
                }
            }
        }

        // 5. National Internet / UDP Disruption preset overrides (sing-box 1.14+ reject action)
        if anti_dpi.preset == "national_disruption" {
            // Force TCP: reject UDP on port 443 (QUIC / HTTP3) so traffic immediately uses TCP
            if let Some(route) = config.get_mut("route") {
                if let Some(rules) = route.get_mut("rules").and_then(|r| r.as_array_mut()) {
                    rules.insert(0, json!({
                        "port": 443,
                        "network": "udp",
                        "action": "reject"
                    }));
                }
            }
        }
    }

    /// Generate complete Sing-box v1.14+ config conforming to PROTOCOL_SPEC.md (Shared Desktop & Android)
    pub fn generate_fallback_config(selected_mode: &str, split_tunneling: bool) -> Value {
        let mut rules = vec![
            json!({
                "action": "sniff",
                "timeout": "300ms"
            }),
            json!({
                "protocol": "dns",
                "action": "hijack-dns"
            }),
            json!({
                "ip_is_private": true,
                "outbound": "direct"
            }),
        ];

        if split_tunneling {
            rules.push(json!({
                "domain_suffix": [
                    ".ir",
                    ".gov.ir",
                    ".co.ir",
                    "shaparak.ir",
                    "divar.ir",
                    "digikala.com",
                    "snapp.ir"
                ],
                "outbound": "direct"
            }));
        }

        rules.push(json!({
            "clash_mode": "Direct",
            "outbound": "direct"
        }));
        rules.push(json!({
            "clash_mode": "Global",
            "outbound": "Sentra Select"
        }));

        json!({
            "log": {
                "level": "info",
                "timestamp": true
            },
            "dns": {
                "servers": [
                    {
                        "type": "fakeip",
                        "tag": "dns-fakeip",
                        "inet4_range": "198.18.0.0/15",
                        "inet6_range": "fc00::/18"
                    },
                    {
                        "type": "https",
                        "tag": "dns-doh",
                        "server": "1.1.1.1",
                        "server_port": 443,
                        "path": "/dns-query",
                        "detour": "Sentra Select"
                    },
                    {
                        "type": "local",
                        "tag": "dns-direct"
                    }
                ],
                "rules": [
                    { "domain_suffix": [".ir", ".gov.ir", ".co.ir", "shaparak.ir"], "server": "dns-direct" },
                    { "clash_mode": "Direct", "server": "dns-direct" },
                    { "clash_mode": "Global", "server": "dns-fakeip" },
                    { "query_type": ["A", "AAAA"], "server": "dns-fakeip" }
                ],
                "final": "dns-doh",
                "strategy": "prefer_ipv4"
            },
            "inbounds": [
                {
                    "type": "tun",
                    "tag": "tun-in",
                    "interface_name": "sentra-tun",
                    "address": ["172.19.0.1/30", "fdfe:dcba:9876::1/126"],
                    "mtu": 1400,
                    "auto_route": true,
                    "strict_route": true,
                    "stack": "mixed"
                }
            ],
            "outbounds": [
                {
                    "type": "selector",
                    "tag": "Sentra Select",
                    "outbounds": [
                        "direct"
                    ],
                    "default": if selected_mode == "direct" { "direct" } else { "direct" }
                },
                {
                    "type": "direct",
                    "tag": "direct"
                }
            ],
            "route": {
                "auto_detect_interface": true,
                "default_domain_resolver": "dns-direct",
                "rules": rules,
                "final": "Sentra Select"
            }
        })
    }

    /// Start VPN connection: routes through Android plugin or Desktop sidecar runner
    pub async fn start_vpn(
        &self,
        app_handle: AppHandle,
        app_state: AppState,
    ) -> Result<(), String> {
        if self.is_running.load(Ordering::SeqCst) {
            warn!("VPN is already running.");
            return Ok(());
        }

        self.is_running.store(true, Ordering::SeqCst);

        let (
            token_opt,
            mode,
            protocol,
            split,
            _sandbox,
            anti_dpi,
            location,
            dns_cfg,
            use_warp,
            routing_mode,
            selected_outbound_id,
            selected_personal_uri,
            auto_reconnect,
        ) = {
            let s = app_state.lock().await;
            (
                s.subscription_token.clone(),
                s.selected_mode.clone(),
                s.selected_protocol.clone(),
                s.split_tunneling,
                s.sandbox_loopback,
                s.anti_dpi.clone(),
                s.selected_location.clone(),
                s.dns_config.clone(),
                s.use_warp,
                s.routing_mode.clone(),
                s.selected_outbound_id.clone(),
                s.selected_personal_uri.clone(),
                s.auto_reconnect,
            )
        };

        let token = match token_opt {
            Some(t) if !t.trim().is_empty() => t,
            _ => {
                self.is_running.store(false, Ordering::SeqCst);
                return Err("برای برقراری اتصال VPN ابتدا وارد حساب کاربری خود شوید.".to_string());
            }
        };

        // Mark user intent as connected so wake / network-switch watchdog can recover cleanly
        {
            let mut s = app_state.lock().await;
            s.user_wants_connected = true;
        }

        // Enforce Strict Leak Protection on Static IP (Tunnel mode mandatory)
        if mode == "static_ip" {
            let mut s = app_state.lock().await;
            s.kill_switch = true;
            s.routing_mode = "tunnel".to_string();
            s.logs.push("[SECURITY] Strict Leak Protection engaged for Static IP (Kill-Switch enforced, Tunnel mode locked, IPv6 blocked).".to_string());
        }

        // Enforce Optimal Gaming TUN settings on Windows & Android (WARP off, Tunnel mode preferred)
        if mode == "gaming" {
            let mut s = app_state.lock().await;
            s.use_warp = false;
            s.routing_mode = "tunnel".to_string();
            s.logs.push("[GAMING] Ultra-Low-Latency Gaming engine engaged (MTU 1280, Full-Cone NAT, WARP bypassed, zero DPI/MUX jitter).".to_string());
        }

        // Perform crash-safe synchronization of any pending traffic from previous abnormal exit
        Self::sync_pending_traffic().await;

        // Transition status to Connecting
        {
            let mut state = app_state.lock().await;
            state.status = ConnectionStatus::Connecting;
            state.logs.push(format!(
                "[INFO] [Core] Initiating connection in mode [{}] with protocol [{}] (WARP: {}, Auto-Reconnect: {})...",
                mode,
                protocol,
                if use_warp && mode != "static_ip" && mode != "gaming" { "ON" } else { "OFF" },
                if auto_reconnect { "ON" } else { "OFF" }
            ));
        }

        TelemetryService::emit_status_change(&app_handle, "Connecting", &mode, None);
        TelemetryService::emit_log(
            &app_handle,
            "INFO",
            &format!(
                "[Core] Requesting secure profile for mode [{}] and protocol [{}] (WARP: {}, Auto-Reconnect: {})...",
                mode,
                protocol,
                if use_warp && mode != "static_ip" && mode != "gaming" { "ON" } else { "OFF" },
                if auto_reconnect { "ON" } else { "OFF" }
            ),
        );

        // Fetch / compile live config from Sentra Core
        let config_json = match Self::fetch_or_compile_config(
            &token,
            &mode,
            &protocol,
            split,
            &anti_dpi,
            Some(&location),
            &dns_cfg,
            use_warp,
            selected_outbound_id.as_deref(),
            selected_personal_uri.as_deref(),
        ).await {
            Ok(cfg) => cfg,
            Err(e) => {
                self.is_running.store(false, Ordering::SeqCst);
                {
                    let mut state = app_state.lock().await;
                    state.status = ConnectionStatus::Disconnected;
                    state.logs.push(format!("[ERROR] [VPN] {}", e));
                }
                TelemetryService::emit_status_change(&app_handle, "Disconnected", &mode, Some(&e));
                TelemetryService::emit_log(&app_handle, "ERROR", &e);
                return Err(e);
            }
        };

        // Save active configs to OS-safe writable app data directory
        let app_dir = crate::auth::AuthManager::app_data_dir();
        let _ = fs::create_dir_all(&app_dir);

        let ovpn_path = app_dir.join("active_sentra.ovpn");
        let singbox_path = app_dir.join("active_singbox.json");
        let auth_path = app_dir.join("auth.txt");

        let sb_cfg = config_json
            .get("singbox_config")
            .or_else(|| config_json.get("config"))
            .unwrap_or(&config_json);
        if sb_cfg.get("outbounds").is_some() {
            if let Ok(sb_str) = serde_json::to_string_pretty(sb_cfg) {
                let _ = fs::write(&singbox_path, sb_str);
            }
        }

        if let Some(ovpn_str) = config_json.get("ovpn_config").and_then(|v| v.as_str()) {
            let mut final_ovpn = ovpn_str.to_string();
            if routing_mode == "proxy" || routing_mode == "system_proxy" {
                final_ovpn.push_str("\n# Sentra Client - Proxy Mode (Do not replace system default gateway)\nroute-nopull\n");
            }
            let _ = fs::write(&ovpn_path, final_ovpn);
        }
        if let (Some(u), Some(p)) = (
            config_json.get("auth_username").and_then(|v| v.as_str()),
            config_json.get("auth_password").and_then(|v| v.as_str()),
        ) {
            let _ = fs::write(&auth_path, format!("{}\n{}\n", u, p));
        }

        if protocol == "stealth" {
            let stunnel_path = app_dir.join("stunnel.conf");
            let stunnel_host = config_json.get("stunnel").and_then(|s| s.get("host")).and_then(|h| h.as_str()).unwrap_or("127.0.0.1");
            let stunnel_port = config_json.get("stunnel").and_then(|s| s.get("port")).and_then(|p| p.as_u64()).unwrap_or(443);
            let stunnel_sni = config_json.get("stunnel").and_then(|s| s.get("sni")).and_then(|n| n.as_str()).unwrap_or("web.sentravpn.com");
            let conf_str = format!(
                "client = yes\n[sentra-stealth]\naccept = 127.0.0.1:11940\nconnect = {}:{}\nsni = {}\ncheckHost = {}\n",
                stunnel_host, stunnel_port, stunnel_sni, stunnel_sni
            );
            let _ = fs::write(&stunnel_path, conf_str);
        }

        // =========================================================================
        // 1. Android Platform Execution (VpnService & libbox Plugin)
        // =========================================================================
        #[cfg(target_os = "android")]
        {
            use tauri_plugin_sentra_vpn::SentraVpnPluginExt;
            info!("Android platform: Invoking native SentraVpnPlugin...");
            TelemetryService::emit_log(
                &app_handle,
                "INFO",
                "[Android] Preparing Android VpnService via SentraVpnPlugin...",
            );

            // Extract actual compiled Sing-box 1.14+ config JSON and active server display name for Android notification
            let singbox_payload = config_json
                .get("singbox_config")
                .or_else(|| config_json.get("config"))
                .unwrap_or(&config_json);
            let active_server_label = selected_outbound_id
                .clone()
                .or_else(|| {
                    config_json
                        .get("server_name")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                })
                .unwrap_or_else(|| "Sentra Auto".to_string());
            let config_str = serde_json::to_string(singbox_payload).unwrap_or_default();
            match app_handle
                .sentra_vpn()
                .connect_with_server(config_str, split, mode.clone(), active_server_label, auto_reconnect)
            {
                Ok(resp) => {
                    info!("SentraVpnPlugin connect responded: {:?}", resp);
                    let mut state = app_state.lock().await;
                    state.status = ConnectionStatus::Connected;
                    state.connected_since = Some(Utc::now());
                    state.logs.push("[INFO] [Android] Native VpnService active with libbox PlatformInterface.".to_string());
                    TelemetryService::emit_status_change(&app_handle, "Connected", &mode, None);
                }
                Err(e) => {
                    let mut ctx = serde_json::Map::new();
                    ctx.insert("mode".to_string(), json!(mode));
                    ctx.insert("protocol".to_string(), json!(protocol));
                    crate::error_reporter::report_native_error(
                        "sentra-client/src-tauri/src/vpn_manager.rs",
                        "android_vpn_service_start",
                        "AndroidVpnStartError",
                        &e,
                        None,
                        ctx,
                    );
                    let mut state = app_state.lock().await;
                    state.status = ConnectionStatus::Disconnected;
                    state.logs.push(format!("[ERROR] [Android] VpnService failed: {}", e));
                    self.is_running.store(false, Ordering::SeqCst);
                    TelemetryService::emit_status_change(&app_handle, "Disconnected", &mode, Some(&e));
                    return Err(e);
                }
            }
        }

        // =========================================================================
        // 2. Desktop Platform Execution (Sing-box / OpenVPN Sidecar)
        // =========================================================================
        #[cfg(not(target_os = "android"))]
        {
            let singbox_bin = Self::locate_singbox_binary(Some(&app_handle));
            let ovpn_bin = Self::locate_openvpn_binary(Some(&app_handle));
            let prefer_singbox = singbox_bin.is_some();

            if prefer_singbox && singbox_bin.is_some() && singbox_path.exists() {
                let bin_path = singbox_bin.unwrap_or_else(|| PathBuf::from("sing-box.exe"));
                info!("Launching native sing-box sidecar: {:?}", bin_path);
                TelemetryService::emit_log(
                    &app_handle,
                    "INFO",
                    &format!("[Sidecar] Spawning native sing-box engine from {:?}", bin_path),
                );
                let mut command = Command::new(&bin_path);
                command.arg("run").arg("-c").arg(&singbox_path);
                command.stdout(Stdio::piped());
                command.stderr(Stdio::piped());
                #[cfg(target_os = "windows")]
                {
                    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
                }

                match command.spawn() {
                    Ok(mut child) => {
                        TelemetryService::spawn_process_log_streamer(
                            &mut child,
                            app_handle.clone(),
                            Arc::clone(&self.is_running),
                        );
                        let mut child_lock = self.child_process.lock().await;
                        *child_lock = Some(child);
                        {
                            let mut state = app_state.lock().await;
                            state.status = ConnectionStatus::Connected;
                            state.connected_since = Some(Utc::now());
                            state.logs.push("[INFO] [Core] Native sing-box engine running.".to_string());
                        }
                        TelemetryService::emit_status_change(&app_handle, "Connected", &mode, None);
                    }
                    Err(e) => {
                        let err_msg = format!("خطا در اجرای هسته sing-box: {}", e);
                        let mut ctx = serde_json::Map::new();
                        ctx.insert("mode".to_string(), json!(mode));
                        ctx.insert("binary".to_string(), json!(bin_path.to_string_lossy().to_string()));
                        crate::error_reporter::report_native_error(
                            "sentra-client/src-tauri/src/vpn_manager.rs",
                            "windows_singbox_spawn",
                            "SingboxSpawnError",
                            &err_msg,
                            None,
                            ctx,
                        );
                        self.is_running.store(false, Ordering::SeqCst);
                        {
                            let mut state = app_state.lock().await;
                            state.status = ConnectionStatus::Disconnected;
                            state.logs.push(format!("[ERROR] [Sidecar] {}", err_msg));
                        }
                        TelemetryService::emit_status_change(&app_handle, "Disconnected", &mode, Some(&err_msg));
                        return Err(err_msg);
                    }
                }
            } else if ovpn_bin.is_some() && (protocol == "openvpn_udp" || protocol == "openvpn_tcp" || protocol == "stealth") {
                let bin_path = ovpn_bin.unwrap_or_else(|| PathBuf::from("openvpn.exe"));
                info!("Launching native OpenVPN sidecar: {:?}", bin_path);
                TelemetryService::emit_log(
                    &app_handle,
                    "INFO",
                    &format!("[Sidecar] Spawning native OpenVPN engine ({}) from {:?}", protocol, bin_path),
                );

                let mut command = Command::new(&bin_path);
                command.arg("--config").arg(&ovpn_path);
                command.arg("--auth-user-pass").arg(&auth_path);
                command.arg("--verb").arg("3");
                if routing_mode == "proxy" || routing_mode == "system_proxy" {
                    command.arg("--route-nopull");
                }
                command.stdout(Stdio::piped());
                command.stderr(Stdio::piped());

                match command.spawn() {
                    Ok(mut child) => {
                        TelemetryService::spawn_process_log_streamer(
                            &mut child,
                            app_handle.clone(),
                            Arc::clone(&self.is_running),
                        );

                        let mut child_lock = self.child_process.lock().await;
                        *child_lock = Some(child);

                        {
                            let mut state = app_state.lock().await;
                            state.status = ConnectionStatus::Connected;
                            state.connected_since = Some(Utc::now());
                            state.logs.push(format!("[INFO] [Core] Native OpenVPN process running. Protocol [{}] active.", protocol));
                        }

                        TelemetryService::emit_status_change(&app_handle, "Connected", &mode, None);
                    }
                    Err(e) => {
                        let err_msg = format!("Failed to start OpenVPN engine: {}", e);
                        self.is_running.store(false, Ordering::SeqCst);
                        let _ = sysproxy::disable_system_proxy();
                        {
                            let mut state = app_state.lock().await;
                            state.status = ConnectionStatus::Disconnected;
                            state.logs.push(format!("[ERROR] [Sidecar] {}", err_msg));
                        }
                        TelemetryService::emit_status_change(&app_handle, "Disconnected", &mode, Some(&err_msg));
                        return Err(err_msg);
                    }
                }
            } else {
                self.is_running.store(false, Ordering::SeqCst);
                let _ = sysproxy::disable_system_proxy();
                let err_msg = "هسته بومی sing-box در پوشه برنامه یافت نشد. لطفاً نسخه رسمی Windows را مجدداً نصب یا اکسترکت کنید.".to_string();
                let mut ctx = serde_json::Map::new();
                ctx.insert("mode".to_string(), json!(mode));
                ctx.insert("protocol".to_string(), json!(protocol));
                crate::error_reporter::report_native_error(
                    "sentra-client/src-tauri/src/vpn_manager.rs",
                    "windows_singbox_locate",
                    "MissingSingboxBinary",
                    &err_msg,
                    None,
                    ctx,
                );
                {
                    let mut state = app_state.lock().await;
                    state.status = ConnectionStatus::Disconnected;
                    state.logs.push(format!("[ERROR] [Sidecar] {}", err_msg));
                }
                TelemetryService::emit_status_change(&app_handle, "Disconnected", &mode, Some(&err_msg));
                return Err(err_msg);
            }

            // Manage Local Proxy (SOCKS5/HTTP) & Windows System Proxy
            if routing_mode == "proxy" || routing_mode == "system_proxy" {
                match LocalProxyService::start(10808, 10809).await {
                    Ok(srv) => {
                        let mut lp = self.local_proxy.lock().await;
                        *lp = Some(srv);
                        let mut s = app_state.lock().await;
                        s.logs.push("[INFO] [Proxy] Local SOCKS5 (127.0.0.1:10808) & HTTP (127.0.0.1:10809) active.".to_string());
                    }
                    Err(e) => {
                        warn!("Failed to start in-process local proxy: {}", e);
                        let mut s = app_state.lock().await;
                        s.logs.push(format!("[WARN] [Proxy] Could not start proxy ports: {}", e));
                    }
                }

                if routing_mode == "system_proxy" {
                    if let Err(e) = sysproxy::enable_system_proxy("127.0.0.1:10809") {
                        warn!("Failed to set Windows system proxy: {}", e);
                        let mut ctx = serde_json::Map::new();
                        ctx.insert("routing_mode".to_string(), json!(routing_mode));
                        crate::error_reporter::report_native_error(
                            "sentra-client/src-tauri/src/vpn_manager.rs",
                            "windows_enable_system_proxy",
                            "WindowsSystemProxyError",
                            &e.to_string(),
                            None,
                            ctx,
                        );
                    } else {
                        let mut s = app_state.lock().await;
                        s.logs.push("[INFO] [SystemProxy] Windows system proxy enabled (127.0.0.1:10809).".to_string());
                    }
                } else {
                    let _ = sysproxy::disable_system_proxy();
                }
            } else {
                let _ = sysproxy::disable_system_proxy();
                let mut s = app_state.lock().await;
                s.logs.push("[INFO] [Tunnel] Full system routing active via virtual adapter (Wintun).".to_string());
            }
        }

        // =========================================================================
        // 3. Periodic Heartbeat & Live Sing-box Clash API Traffic Sync (Every 60s)
        // =========================================================================
        let heartbeat_running = Arc::clone(&self.is_running);
        let hb_app_handle = app_handle.clone();
        let hb_app_state = app_state.clone();
        let hb_token = token.clone();
        let hb_mode = mode.clone();
        let hb_device_id = crate::auth::AuthManager::get_or_create_device_id();

        tokio::spawn(async move {
            let client = match reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(4))
                .build()
            {
                Ok(c) => c,
                Err(_) => return,
            };

            let mut last_clash_down: u64 = 0;
            let mut last_clash_up: u64 = 0;
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
            // First tick completes immediately, wait 60s for next tick
            interval.tick().await;

            while heartbeat_running.load(Ordering::SeqCst) {
                interval.tick().await;
                if !heartbeat_running.load(Ordering::SeqCst) {
                    break;
                }

                let mut delta_down = 0u64;
                let mut delta_up = 0u64;

                // 1. Query Clash API on 127.0.0.1:9090
                let clash_res = client
                    .get("http://127.0.0.1:9090/connections")
                    .header("Authorization", "Bearer sentra_internal_traffic_secret")
                    .send()
                    .await;

                if let Ok(resp) = clash_res {
                    if let Ok(val) = resp.json::<Value>().await {
                        let cur_down = val.get("downloadTotal").and_then(|v| v.as_u64()).unwrap_or(0);
                        let cur_up = val.get("uploadTotal").and_then(|v| v.as_u64()).unwrap_or(0);

                        if cur_down >= last_clash_down {
                            delta_down = cur_down - last_clash_down;
                            last_clash_down = cur_down;
                        }
                        if cur_up >= last_clash_up {
                            delta_up = cur_up - last_clash_up;
                            last_clash_up = cur_up;
                        }
                    }
                } else {
                    // Fallback to state metrics (sandbox loopback simulation)
                    let m = {
                        let s = hb_app_state.lock().await;
                        s.metrics.clone()
                    };
                    if m.total_download_bytes >= last_clash_down {
                        delta_down = m.total_download_bytes - last_clash_down;
                        last_clash_down = m.total_download_bytes;
                    }
                    if m.total_upload_bytes >= last_clash_up {
                        delta_up = m.total_upload_bytes - last_clash_up;
                        last_clash_up = m.total_upload_bytes;
                    }
                }

                // 2. Crash-Safe persistence: persist unsynced deltas before network send
                if delta_up > 0 || delta_down > 0 {
                    let unsynced_file = Self::unsynced_traffic_file();
                    let unsynced_data = UnsyncedTraffic {
                        token: hb_token.clone(),
                        device_id: hb_device_id.clone(),
                        mode: hb_mode.clone(),
                        delta_upload_bytes: delta_up,
                        delta_download_bytes: delta_down,
                    };
                    if let Ok(json_str) = serde_json::to_string(&unsynced_data) {
                        let _ = fs::write(&unsynced_file, json_str);
                    }
                }

                // 3. Send Heartbeat to backend with fallback
                let mut hb_success = false;
                for base_url in crate::auth::get_backend_urls() {
                    let url = format!("{}/api/v1/client/heartbeat", base_url);
                    let res = client
                        .post(&url)
                        .header("X-Subscription-Token", &hb_token)
                        .json(&json!({
                            "device_id": hb_device_id,
                            "mode": hb_mode,
                            "delta_upload_bytes": delta_up,
                            "delta_download_bytes": delta_down
                        }))
                        .send()
                        .await;

                    if let Ok(resp) = res {
                        if resp.status().is_success() {
                            let _ = fs::remove_file(Self::unsynced_traffic_file());
                            hb_success = true;

                            if let Ok(verdict) = resp.json::<Value>().await {
                                let action = verdict.get("action").and_then(|a| a.as_str()).unwrap_or("continue");
                                if action == "disconnect" {
                                    let msg = verdict
                                        .get("message")
                                        .and_then(|m| m.as_str())
                                        .unwrap_or("اتصال توسط سرور به پایان رسید.");
                                    let code = verdict.get("code").and_then(|c| c.as_str()).unwrap_or("DISCONNECT");

                                    tracing::warn!("[Heartbeat] Disconnect command received: {} ({})", code, msg);
                                    TelemetryService::emit_log(&hb_app_handle, "WARN", &format!("[Heartbeat] {}", msg));

                                    heartbeat_running.store(false, Ordering::SeqCst);
                                    {
                                        let mut s = hb_app_state.lock().await;
                                        s.user_wants_connected = false;
                                        s.status = ConnectionStatus::Disconnected;
                                        s.logs.push(format!("[DISCONNECT] {}", msg));
                                    }
                                    TelemetryService::emit_status_change(
                                        &hb_app_handle,
                                        "Disconnected",
                                        &hb_mode,
                                        Some(msg),
                                    );
                                    break;
                                } else if action == "continue" {
                                    if let Some(remaining) = verdict.get("remaining_bytes").and_then(|b| b.as_i64()) {
                                        let mut s = hb_app_state.lock().await;
                                        s.remaining_bytes = remaining;
                                    }
                                    let _ = hb_app_handle.emit("subscription-synced", &verdict);
                                }
                            }
                            break;
                        }
                    }
                }

                if !hb_success {
                    tracing::warn!("Heartbeat ping failed across all backend fallback URLs.");
                }
            }
        });

        Ok(())
    }

    /// Stop VPN and perform clean network reset (Desktop & Android)
    pub async fn stop_vpn(
        &self,
        app_handle: AppHandle,
        app_state: AppState,
    ) -> Result<(), String> {
        self.stop_vpn_internal(app_handle, app_state, false).await
    }

    /// Internal teardown helper. When `preserve_intent` is true, keeps `user_wants_connected = true`
    /// so an automatic reconnect cycle can cleanly rebuild the tunnel without flipping UI to Disconnected.
    async fn stop_vpn_internal(
        &self,
        app_handle: AppHandle,
        app_state: AppState,
        preserve_intent: bool,
    ) -> Result<(), String> {
        if !preserve_intent {
            let mut state = app_state.lock().await;
            state.user_wants_connected = false;
        }

        // Always guarantee Windows system proxy is reset even if tunnel flag was already cleared
        #[cfg(not(target_os = "android"))]
        {
            let _ = sysproxy::disable_system_proxy();
        }

        if !self.is_running.load(Ordering::SeqCst) {
            return Ok(());
        }

        info!("Stopping VPN and terminating Sing-box engine (preserve_intent={})...", preserve_intent);
        self.is_running.store(false, Ordering::SeqCst);

        // 1. Android stop
        #[cfg(target_os = "android")]
        {
            use tauri_plugin_sentra_vpn::SentraVpnPluginExt;
            info!("Android platform: Stopping VpnService via SentraVpnPlugin...");
            let _ = app_handle.sentra_vpn().disconnect();
        }

        // 2. Desktop stop
        #[cfg(not(target_os = "android"))]
        {
            let mut child_lock = self.child_process.lock().await;
            if let Some(mut child) = child_lock.take() {
                let _ = child.kill().await;
                info!("Sing-box child process terminated.");
            }

            // Stop local SOCKS5 & HTTP proxy service
            if let Some(mut srv) = self.local_proxy.lock().await.take() {
                srv.stop();
                info!("Local proxy service stopped.");
            }

            // Always revert Windows System Proxy
            let _ = sysproxy::disable_system_proxy();
        }

        // Clean up shared state
        if preserve_intent {
            let mut state = app_state.lock().await;
            state.status = ConnectionStatus::Connecting;
            state.metrics = crate::state::TelemetryMetrics::default();
            state.logs.push("[INFO] [AutoReconnect] Cleared stale tunnel before re-establishing connection.".to_string());
        } else {
            {
                let mut state = app_state.lock().await;
                state.status = ConnectionStatus::Disconnected;
                state.connected_since = None;
                state.metrics = crate::state::TelemetryMetrics::default();
                state.logs.push("[INFO] [TUN] Interface [sentra-tun] released safely. System network restored.".to_string());
                state.logs.push("[INFO] [Core] Sentra Connect disconnected cleanly.".to_string());
            }

            TelemetryService::emit_status_change(&app_handle, "Disconnected", "None", None);
            TelemetryService::emit_speed_update(
                &app_handle,
                &crate::state::TelemetryMetrics::default(),
            );
            TelemetryService::emit_log(
                &app_handle,
                "INFO",
                "[Core] Tunnel closed cleanly. Network routing restored.",
            );

            // Flush any pending unsynced usage immediately so Windows/Android/Telegram stay in sync
            Self::sync_pending_traffic().await;
            let _ = app_handle.emit("subscription-synced", json!({ "source": "disconnect" }));
        }

        Ok(())
    }

    /// Re-establish VPN tunnel cleanly after a network switch or wake from sleep.
    /// Uses an atomic guard and bounded exponential backoff (2s, 4s, 8s; max 3 attempts)
    /// and immediately aborts if the user manually disconnects.
    pub async fn reconnect_vpn(
        &self,
        app_handle: AppHandle,
        app_state: AppState,
        reason: &str,
    ) -> Result<(), String> {
        let (should_run, mode) = {
            let s = app_state.lock().await;
            (
                s.auto_reconnect && s.user_wants_connected && s.is_authenticated,
                s.selected_mode.clone(),
            )
        };

        if !should_run {
            return Ok(());
        }

        if self
            .is_reconnecting
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            info!("[AutoReconnect] Reconnect already in progress; coalescing trigger ({}).", reason);
            return Ok(());
        }

        struct ReconnectGuard(Arc<AtomicBool>);
        impl Drop for ReconnectGuard {
            fn drop(&mut self) {
                self.0.store(false, Ordering::SeqCst);
            }
        }
        let _guard = ReconnectGuard(Arc::clone(&self.is_reconnecting));

        info!("[AutoReconnect] Triggered ({}). Re-establishing VPN tunnel...", reason);
        {
            let mut s = app_state.lock().await;
            s.status = ConnectionStatus::Connecting;
            s.logs.push(format!(
                "[INFO] [AutoReconnect] Triggered ({}). Re-establishing VPN connection...",
                reason
            ));
        }
        TelemetryService::emit_status_change(&app_handle, "Connecting", &mode, None);
        TelemetryService::emit_log(
            &app_handle,
            "INFO",
            &format!("[AutoReconnect] Triggered ({}). Re-establishing VPN tunnel...", reason),
        );

        let _ = self
            .stop_vpn_internal(app_handle.clone(), app_state.clone(), true)
            .await;

        // Initial settle delay + exponential retry backoff (seconds)
        let delays_secs: [u64; 3] = [1, 3, 6];
        let mut last_err = String::new();

        for (idx, wait_secs) in delays_secs.iter().enumerate() {
            tokio::time::sleep(std::time::Duration::from_secs(*wait_secs)).await;

            let still_wanted = {
                let s = app_state.lock().await;
                s.auto_reconnect && s.user_wants_connected && s.is_authenticated
            };
            if !still_wanted {
                info!("[AutoReconnect] Aborted because user disconnected or disabled auto-reconnect.");
                return Ok(());
            }

            info!(
                "[AutoReconnect] Attempt {}/{} (reason: {})...",
                idx + 1,
                delays_secs.len(),
                reason
            );
            match self.start_vpn(app_handle.clone(), app_state.clone()).await {
                Ok(()) => {
                    {
                        let mut s = app_state.lock().await;
                        s.logs.push(format!(
                            "[INFO] [AutoReconnect] VPN connection re-established ({}).",
                            reason
                        ));
                    }
                    TelemetryService::emit_log(
                        &app_handle,
                        "INFO",
                        &format!("[AutoReconnect] VPN connection re-established ({}).", reason),
                    );
                    return Ok(());
                }
                Err(e) => {
                    warn!("[AutoReconnect] Attempt {} failed: {}", idx + 1, e);
                    last_err = e;
                }
            }
        }

        {
            let mut s = app_state.lock().await;
            s.status = ConnectionStatus::Disconnected;
            s.logs.push(format!(
                "[WARN] [AutoReconnect] Failed to re-establish VPN after {} attempts: {}",
                delays_secs.len(),
                last_err
            ));
        }
        TelemetryService::emit_status_change(
            &app_handle,
            "Disconnected",
            &mode,
            Some(&last_err),
        );
        Err(last_err)
    }

    /// Background Desktop Watchdog: detects OS sleep/wake via wall-clock jump (>= 15s)
    /// and default route / network interface switches (Wi-Fi <-> Ethernet <-> Hotspot)
    /// using a zero-packet UDP route lookup.
    #[cfg(desktop)]
    pub fn spawn_network_and_wake_watchdog(
        self: &Arc<Self>,
        app_handle: AppHandle,
        app_state: AppState,
    ) {
        let vpn = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let mut last_wall = std::time::SystemTime::now();
            let mut last_route_ip = Self::probe_default_route_ip();

            loop {
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;

                let now_wall = std::time::SystemTime::now();
                let wall_jump_secs = now_wall
                    .duration_since(last_wall)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                last_wall = now_wall;

                let current_route_ip = Self::probe_default_route_ip();
                let route_changed = current_route_ip.is_some() && current_route_ip != last_route_ip;
                last_route_ip = current_route_ip;

                let trigger_reason = if wall_jump_secs >= 15 {
                    Some("device_wake")
                } else if route_changed {
                    Some("network_switch")
                } else {
                    None
                };

                if let Some(reason) = trigger_reason {
                    let should_reconnect = {
                        let s = app_state.lock().await;
                        s.auto_reconnect && s.user_wants_connected && s.is_authenticated
                    };
                    if should_reconnect {
                        let vpn_clone = Arc::clone(&vpn);
                        let handle_clone = app_handle.clone();
                        let state_clone = Arc::clone(&app_state);
                        tauri::async_runtime::spawn(async move {
                            let _ = vpn_clone
                                .reconnect_vpn(handle_clone, state_clone, reason)
                                .await;
                        });
                    }
                }
            }
        });
    }

    #[cfg(desktop)]
    fn probe_default_route_ip() -> Option<std::net::IpAddr> {
        let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
        socket.connect("1.1.1.1:80").ok()?;
        socket.local_addr().ok().map(|addr| addr.ip())
    }
}
