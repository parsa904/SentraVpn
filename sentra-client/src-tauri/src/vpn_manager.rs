use crate::local_proxy::LocalProxyService;
use crate::sandbox::SandboxEngine;
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
use tauri::AppHandle;
use tokio::sync::Mutex;
use tracing::{info, warn};

#[cfg(not(target_os = "android"))]
use std::process::Stdio;
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

    /// Locate sing-box binary on the system (Sidecar path, environment, or system PATH) - Desktop Only
    #[cfg(not(target_os = "android"))]
    #[allow(dead_code)]
    pub fn locate_singbox_binary(app_handle: Option<&AppHandle>) -> Option<PathBuf> {
        // 1. Check SING_BOX_PATH env var
        if let Ok(p) = std::env::var("SING_BOX_PATH") {
            let path = PathBuf::from(p);
            if path.exists() {
                return Some(path);
            }
        }

        // 2. Check Tauri Sidecar bundled binary path if app_handle is provided
        if let Some(_app) = app_handle {
            // Check relative binaries directory
            let candidate = PathBuf::from("binaries").join(format!("sing-box-{}", std::env::consts::ARCH));
            if candidate.exists() {
                return Some(candidate);
            }
        }

        // 3. Check system PATH via where.exe (Windows)
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
            "use_warp": if selected_mode == "static_ip" { false } else { use_warp }
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

        let mut config_resp = None;
        let mut last_status = None;
        let mut last_err_body = None;

        for base_url in crate::auth::get_backend_urls() {
            let url = format!("{}/api/v1/client/config", base_url);
            match client
                .post(&url)
                .header("X-Subscription-Token", token)
                .json(&request_body)
                .send()
                .await
            {
                Ok(resp) if resp.status().is_success() => {
                    config_resp = Some(resp);
                    break;
                }
                Ok(resp) if resp.status().is_server_error() => {
                    last_status = Some(resp.status());
                    last_err_body = resp.text().await.ok();
                    warn!("Config endpoint {} returned 5xx; trying next fallback...", base_url);
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

        let mut config_val = match config_resp {
            Some(resp) => resp
                .json::<Value>()
                .await
                .map_err(|e| format!("پاسخ پیکربندی سرور نامعتبر بود: {}", e))?,
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

                    return Err(format!("خطا در دریافت تنظیمات اتصال از سرور (HTTP {}).", status));
                }
                return Err("امکان برقراری ارتباط با سرور مرکزی سنترا جهت دریافت پیکربندی اتصال وجود ندارد. اینترنت خود را بررسی کنید.".to_string());
            }
        };

        // Apply client-side split-tunnel, DNS & Anti-DPI adjustments to the embedded singbox_config object if present
        if let Some(sb_cfg) = config_val.get_mut("singbox_config") {
            Self::apply_anti_dpi_settings(sb_cfg, anti_dpi);
        }

        // Customize mode in the config if required
        if selected_mode != "Sentra Auto" {
            if let Some(selector) = config_val.get_mut("outbounds").and_then(|o| o.as_array_mut()) {
                for item in selector {
                    if item.get("tag").and_then(|t| t.as_str()) == Some("Sentra Select") {
                        item["default"] = json!(selected_mode);
                    }
                }
            }
        }

        // Handle Split Tunneling
        if !split_tunneling {
            if let Some(rules) = config_val
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

        // Strict Leak Protection for Static IP (Trade & Crypto Protection)
        if selected_mode == "static_ip" {
            info!("Enforcing Strict Leak Protection for Static IP (IPv6 blocked, Remote Clean Global DoH enforced).");
            if let Some(dns) = config_val.get_mut("dns") {
                dns["servers"] = json!([
                    {
                        "tag": "dns-remote",
                        "address": "https://1.1.1.1/dns-query",
                        "strategy": "ipv4_only",
                        "detour": "Sentra Select"
                    },
                    {
                        "tag": "dns-block",
                        "address": "rcode://success"
                    }
                ]);
                dns["rules"] = json!([
                    { "outbound": "any", "server": "dns-remote" }
                ]);
            }
            if let Some(rules) = config_val.get_mut("route").and_then(|r| r.get_mut("rules")).and_then(|r| r.as_array_mut()) {
                rules.insert(0, json!({
                    "ip_version": 6,
                    "outbound": "block"
                }));
            }
        } else {
            // Apply Custom / Selected DNS for free modes
            let target_dns = if !dns_config.selected_dns_address.is_empty() && dns_config.selected_dns_id != "auto" {
                Some(dns_config.selected_dns_address.as_str())
            } else {
                None
            };

            if let Some(dns_addr) = target_dns {
                info!("Injecting customized DNS into connection profile: {}", dns_addr);
                if let Some(dns) = config_val.get_mut("dns") {
                    if let Some(servers) = dns.get_mut("servers").and_then(|s| s.as_array_mut()) {
                        for s in servers {
                            if s.get("tag").and_then(|t| t.as_str()) == Some("dns-remote") {
                                s["address"] = json!(dns_addr);
                            }
                        }
                    }
                }
                if let Some(ovpn_str) = config_val.get_mut("ovpn_config").and_then(|o| o.as_str()) {
                    let mut new_ovpn = ovpn_str.to_string();
                    if !dns_addr.starts_with("http") {
                        new_ovpn.push_str(&format!("\ndhcp-option DNS {}\n", dns_addr));
                    }
                    config_val["ovpn_config"] = json!(new_ovpn);
                }
            }
        }

        // Ensure experimental.clash_api exists for live kernel traffic sync
        if config_val.get("experimental").is_none() {
            config_val["experimental"] = json!({
                "clash_api": {
                    "external_controller": "127.0.0.1:9090",
                    "secret": "sentra_internal_traffic_secret"
                }
            });
        }

        // Apply Anti-DPI Lab parameters into Sing-box config
        Self::apply_anti_dpi_settings(&mut config_val, anti_dpi);

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

        // 3. Anti-Poisoning DNS
        let doh_url = match anti_dpi.dns_mode.as_str() {
            "google" => "https://8.8.8.8/dns-query",
            "quad9" => "https://9.9.9.9/dns-query",
            "fakeip" => "fakeip",
            _ => "https://1.1.1.1/dns-query",
        };

        if let Some(dns) = config.get_mut("dns") {
            if let Some(servers) = dns.get_mut("servers").and_then(|s| s.as_array_mut()) {
                for s in servers {
                    let tag = s.get("tag").and_then(|t| t.as_str()).unwrap_or("");
                    if tag == "dns-remote" || tag == "dns-doh" {
                        s["address"] = json!(doh_url);
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

        // 5. National Internet / UDP Disruption preset overrides
        if anti_dpi.preset == "national_disruption" {
            // Force TCP: block UDP on port 443 (QUIC / HTTP3) so traffic immediately uses TCP
            if let Some(route) = config.get_mut("route") {
                if let Some(rules) = route.get_mut("rules").and_then(|r| r.as_array_mut()) {
                    rules.insert(0, json!({
                        "port": 443,
                        "network": "udp",
                        "outbound": "block"
                    }));
                }
            }
        }
    }

    /// Generate complete Sing-box v1.10+ config conforming to PROTOCOL_SPEC.md (Shared Desktop & Android)
    pub fn generate_fallback_config(selected_mode: &str, split_tunneling: bool) -> Value {
        let mut rules = vec![
            json!({
                "protocol": "dns",
                "outbound": "dns-out"
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
                    { "tag": "dns-fakeip", "address": "fakeip" },
                    { "tag": "dns-remote", "address": "https://1.1.1.1/dns-query", "address_resolver": "dns-direct", "strategy": "ipv4_only", "detour": "Sentra Select" },
                    { "tag": "dns-direct", "address": "local", "detour": "direct" },
                    { "tag": "dns-block", "address": "rcode://success" }
                ],
                "rules": [
                    { "outbound": "any", "server": "dns-direct" },
                    { "domain_suffix": [".ir", ".gov.ir", ".co.ir", "shaparak.ir"], "server": "dns-direct" },
                    { "clash_mode": "Direct", "server": "dns-direct" },
                    { "clash_mode": "Global", "server": "dns-fakeip" },
                    { "query_type": ["A", "AAAA"], "server": "dns-fakeip" }
                ],
                "fakeip": {
                    "enabled": true,
                    "inet4_range": "198.18.0.0/15",
                    "inet6_range": "fc00::/18"
                },
                "independent_cache": true
            },
            "inbounds": [
                {
                    "type": "tun",
                    "tag": "tun-in",
                    "interface_name": "sentra-tun",
                    "inet4_address": "172.19.0.1/30",
                    "inet6_address": "fdfe:dcba:9876::1/126",
                    "mtu": 1400,
                    "auto_route": true,
                    "strict_route": true,
                    "stack": "mixed",
                    "sniff": true,
                    "sniff_override_destination": true
                }
            ],
            "outbounds": [
                {
                    "type": "selector",
                    "tag": "Sentra Select",
                    "outbounds": [
                        "Sentra Auto",
                        "Sentra Hydra",
                        "Sentra Shadow",
                        "Sentra Stealth",
                        "Sentra Pulse",
                        "direct"
                    ],
                    "default": selected_mode
                },
                {
                    "type": "urltest",
                    "tag": "Sentra Auto",
                    "outbounds": [
                        "Sentra Hydra",
                        "Sentra Shadow",
                        "Sentra Stealth",
                        "Sentra Pulse"
                    ],
                    "url": "https://cp.cloudflare.com/generate_204",
                    "interval": "15s",
                    "tolerance": 50
                },
                {
                    "type": "socks",
                    "tag": "Sentra Hydra",
                    "server": "127.0.0.1",
                    "server_port": 10801,
                    "version": "5"
                },
                {
                    "type": "socks",
                    "tag": "Sentra Shadow",
                    "server": "127.0.0.1",
                    "server_port": 10802,
                    "version": "5"
                },
                {
                    "type": "http",
                    "tag": "Sentra Stealth",
                    "server": "127.0.0.1",
                    "server_port": 10803
                },
                {
                    "type": "socks",
                    "tag": "Sentra Pulse",
                    "server": "127.0.0.1",
                    "server_port": 10804,
                    "version": "5"
                },
                {
                    "type": "direct",
                    "tag": "direct"
                },
                {
                    "type": "block",
                    "tag": "block"
                },
                {
                    "type": "dns",
                    "tag": "dns-out"
                }
            ],
            "route": {
                "auto_detect_interface": true,
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
                if use_warp && mode != "static_ip" { "ON" } else { "OFF" },
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
                if use_warp && mode != "static_ip" { "ON" } else { "OFF" },
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

        if let Some(sb_cfg) = config_json.get("singbox_config") {
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

            // Extract actual compiled Sing-box config JSON and active server display name for Android notification
            let singbox_payload = config_json.get("singbox_config").unwrap_or(&config_json);
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
            let prefer_singbox = selected_outbound_id.is_some()
                || selected_personal_uri.is_some()
                || (singbox_bin.is_some() && ovpn_bin.is_none());

            if prefer_singbox && singbox_bin.is_some() && singbox_path.exists() {
                let bin_path = singbox_bin.unwrap_or_else(|| PathBuf::from("sing-box"));
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
                SandboxEngine::run_simulation(
                    app_handle.clone(),
                    app_state.clone(),
                    mode.clone(),
                    Arc::clone(&self.is_running),
                )
                .await;
                return Err("Native VPN engine (sing-box or OpenVPN) was not found in binaries or system PATH.".to_string());
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
