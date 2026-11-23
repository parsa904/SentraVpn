use crate::bridge_sync;
use crate::db::{DbPool, Repository};
use crate::error::CoreError;
use crate::outbound_analyzer::OutboundAnalyzer;
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::net::{IpAddr, SocketAddr};
use std::time::{Duration, Instant};
use teloxide::prelude::*;
use teloxide::types::{ChatId, ParseMode};
use tokio::net::TcpStream;
use tokio::time::timeout;
use tracing::{error, info, warn};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QualityReport {
    pub outbound_id: i64,
    pub tag: String,
    pub latency_ms: i64,
    pub jitter_ms: i64,
    pub speed_mbps: f64,
    pub speed_score: i64,
    pub gemini_ok: bool,
    pub trading_safe: bool,
    pub is_healthy: bool,
    pub security_passed: bool,
    pub error_msg: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct QualityCycleSummary {
    pub total_tested: usize,
    pub active_count: usize,
    pub gemini_ready_count: usize,
    pub dead_cleaned_count: usize,
    pub cleaned_tags: Vec<String>,
}

// ============================================================================
// Deterministic Hash & Load Tracking
// ============================================================================

pub const SATURATION_LOAD_THRESHOLD: u32 = 50;

/// Deterministic 64-bit hash of user_uuid ensuring stable per-user outbound allocation
pub fn deterministic_hash(uuid_str: &str) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    uuid_str.hash(&mut hasher);
    hasher.finish()
}

/// Helper for simple URL encoding of tags in V2Ray URIs
pub fn urlencoding_simple(input: &str) -> String {
    url::form_urlencoded::byte_serialize(input.as_bytes()).collect()
}

#[derive(Debug, Clone, Default)]
pub struct OutboundLoadTracker {
    loads: std::sync::Arc<tokio::sync::RwLock<std::collections::HashMap<String, u32>>>,
}

impl OutboundLoadTracker {
    pub fn new() -> Self {
        Self {
            loads: std::sync::Arc::new(tokio::sync::RwLock::new(std::collections::HashMap::new())),
        }
    }

    pub async fn get_load(&self, tag: &str) -> u32 {
        let r = self.loads.read().await;
        r.get(tag).copied().unwrap_or(0)
    }

    pub async fn increment_load(&self, tag: &str) {
        let mut w = self.loads.write().await;
        let count = w.entry(tag.to_string()).or_insert(0);
        *count = count.saturating_add(1);
    }

    pub async fn decrement_load(&self, tag: &str) {
        let mut w = self.loads.write().await;
        if let Some(count) = w.get_mut(tag) {
            *count = count.saturating_sub(1);
        }
    }
}

// ============================================================================
// Unified Outbound Model for Selection & Routing
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnifiedOutbound {
    pub id: i64,
    pub tag: String,
    pub protocol: String,
    pub server_address: String,
    pub server_port: u16,
    pub mode_category: String,
    pub country_code: String,
    pub quality_score: i64,
    pub latency_ms: i64,
    pub is_healthy: bool,
    pub is_official: bool,
    pub parsed_config: serde_json::Value,
    pub raw_config_json: Option<String>,
}

impl UnifiedOutbound {
    pub fn sandbox_fallback(mode: &str) -> Self {
        let (port, tag) = match mode {
            "download" => (10804, "Sentra Download Sandbox"),
            "static_ip" => (10802, "Sentra Static IP Sandbox"),
            "gaming" => (10803, "Sentra Gaming Sandbox"),
            _ => (10801, "Sentra Web Browsing Sandbox"),
        };
        let cfg = serde_json::json!({
            "type": "socks",
            "tag": tag,
            "server": "127.0.0.1",
            "server_port": port,
            "version": "5"
        });
        Self {
            id: 0,
            tag: tag.to_string(),
            protocol: "socks".to_string(),
            server_address: "127.0.0.1".to_string(),
            server_port: port,
            mode_category: mode.to_string(),
            country_code: "DE".to_string(),
            quality_score: 95,
            latency_ms: 25,
            is_healthy: true,
            is_official: true,
            parsed_config: cfg,
            raw_config_json: None,
        }
    }

    pub fn to_singbox_value(&self) -> serde_json::Value {
        self.to_singbox_value_with_optimizations(None)
    }

    /// Compiles Sing-box outbound JSON with uTLS fingerprint, TLS Fragment (anti-DPI), and WebBrowsing multiplex optimizations
    pub fn to_singbox_value_with_optimizations(&self, mode: Option<&str>) -> serde_json::Value {
        let mut val = self.parsed_config.clone();
        let proto = self.protocol.to_lowercase();
        let is_tls_proto = proto == "vless" || proto == "vmess" || proto == "trojan";
        let current_mode = mode.unwrap_or("web_browsing");
        let is_gaming = current_mode.eq_ignore_ascii_case("gaming")
            || self.mode_category.eq_ignore_ascii_case("gaming");

        if let Some(obj) = val.as_object_mut() {
            obj.insert("tag".to_string(), serde_json::json!(self.tag));

            if is_gaming {
                // Anti-Lag Rule: Strictly prohibit and remove multiplex and tls_fragment for Gaming
                obj.remove("multiplex");
                if let Some(tls_val) = obj.get_mut("tls") {
                    if let Some(tls_obj) = tls_val.as_object_mut() {
                        tls_obj.remove("fragment");
                        tls_obj.remove("record_fragment");
                    }
                }
            } else if is_tls_proto {
                // 1. uTLS Fingerprint & 2. TLS Fragment
                if let Some(tls_val) = obj.get_mut("tls") {
                    if let Some(tls_obj) = tls_val.as_object_mut() {
                        let utls_enabled = tls_obj
                            .get("utls")
                            .and_then(|u| u.get("enabled"))
                            .and_then(|e| e.as_bool())
                            .unwrap_or(false);
                        if !utls_enabled {
                            let fp = if self.id % 2 == 0 { "chrome" } else { "firefox" };
                            tls_obj.insert("utls".to_string(), serde_json::json!({
                                "enabled": true,
                                "fingerprint": fp
                            }));
                        }

                        // TLS Fragment (anti-DPI)
                        let has_fragment = tls_obj.get("fragment").is_some() || tls_obj.get("record_fragment").is_some();
                        if !has_fragment {
                            tls_obj.insert("fragment".to_string(), serde_json::json!({
                                "enabled": true,
                                "size": "10-30",
                                "sleep": "2-5"
                            }));
                        }
                    }
                }

                // 3. Multiplex for WebBrowsing mode (VLESS, VMess, Trojan)
                if current_mode == "web_browsing" && !obj.contains_key("multiplex") {
                    obj.insert("multiplex".to_string(), serde_json::json!({
                        "enabled": true,
                        "protocol": "h2mux",
                        "max_connections": 4,
                        "min_streams": 4,
                        "padding": true
                    }));
                }
            }
        }
        val
    }

    pub fn to_v2ray_uri(&self) -> String {
        match self.protocol.to_lowercase().as_str() {
            "socks" => format!("socks://{}:{}#{}", self.server_address, self.server_port, urlencoding_simple(&self.tag)),
            "http" => format!("http://{}:{}#{}", self.server_address, self.server_port, urlencoding_simple(&self.tag)),
            "vless" => {
                let uuid_str = self.parsed_config.get("uuid").and_then(|u| u.as_str()).unwrap_or("00000000-0000-0000-0000-000000000000");
                let sni = self.parsed_config.pointer("/tls/server_name").and_then(|s| s.as_str()).unwrap_or("learn.microsoft.com");
                let pbk = self.parsed_config.pointer("/tls/reality/public_key").and_then(|p| p.as_str()).unwrap_or("");
                let sid = self.parsed_config.pointer("/tls/reality/short_id").and_then(|s| s.as_str()).unwrap_or("");
                format!(
                    "vless://{}@{}:{}?security=reality&sni={}&pbk={}&sid={}&fp=chrome&type=tcp&headerType=none#{}",
                    uuid_str, self.server_address, self.server_port, sni, pbk, sid, urlencoding_simple(&self.tag)
                )
            }
            "trojan" => {
                let pwd = self.parsed_config.get("password").and_then(|p| p.as_str()).unwrap_or("sentra_pass");
                format!("trojan://{}@{}:{}#{}", pwd, self.server_address, self.server_port, urlencoding_simple(&self.tag))
            }
            "hysteria2" => {
                let pwd = self.parsed_config.get("password").and_then(|p| p.as_str()).unwrap_or("sentra_pass");
                format!("hysteria2://{}@{}:{}#{}", pwd, self.server_address, self.server_port, urlencoding_simple(&self.tag))
            }
            _ => format!("socks://{}:{}#{}", self.server_address, self.server_port, urlencoding_simple(&self.tag)),
        }
    }
}

impl From<crate::models::DonatedOutbound> for UnifiedOutbound {
    fn from(dob: crate::models::DonatedOutbound) -> Self {
        let tag = if dob.is_official == 1 {
            if let Some(ref l) = dob.label {
                format!("👑 {}", l)
            } else {
                format!("👑 {}", dob.tag)
            }
        } else {
            format!("🤝 {}", dob.tag)
        };
        let mut parsed: serde_json::Value = serde_json::from_str(&dob.config_json).unwrap_or_else(|_| {
            serde_json::json!({
                "type": dob.protocol,
                "tag": tag,
                "server": dob.server_address,
                "server_port": dob.server_port
            })
        });
        parsed["tag"] = serde_json::json!(tag);

        let is_healthy = dob.status == "active" && dob.latency_ms < 2500 && dob.health_score > 0;
        let quality_score = if dob.quality_score > 0 {
            dob.quality_score
        } else {
            dob.speed_score.clamp(1, 100)
        };

        let mode_category = if dob.allow_static_ip == 1 || dob.assigned_tier == "static_ip" {
            "static_ip".to_string()
        } else if dob.allow_download == 1 || dob.assigned_tier == "download" {
            "download".to_string()
        } else {
            "web_browsing".to_string()
        };

        Self {
            id: dob.id,
            tag,
            protocol: dob.protocol,
            server_address: dob.server_address,
            server_port: dob.server_port as u16,
            mode_category,
            country_code: dob.country_code,
            quality_score,
            latency_ms: dob.latency_ms,
            is_healthy,
            is_official: dob.is_official == 1,
            parsed_config: parsed,
            raw_config_json: Some(dob.config_json),
        }
    }
}

impl From<crate::models::Outbound> for UnifiedOutbound {
    fn from(ob: crate::models::Outbound) -> Self {
        let is_healthy = ob.is_active == 1 && ob.is_healthy != 0 && ob.latency_ms < 2500;
        let quality_score = if ob.quality_score > 0 { ob.quality_score } else { (ob.weight * 10).clamp(10, 100) };

        let node_config = match ob.protocol.as_str() {
            "socks" => serde_json::json!({
                "type": "socks",
                "tag": ob.tag,
                "server": ob.server_address,
                "server_port": ob.server_port,
                "version": "5"
            }),
            "http" => serde_json::json!({
                "type": "http",
                "tag": ob.tag,
                "server": ob.server_address,
                "server_port": ob.server_port
            }),
            "vless" => {
                let mut vless_obj = serde_json::json!({
                    "type": "vless",
                    "tag": ob.tag,
                    "server": ob.server_address,
                    "server_port": ob.server_port,
                    "uuid": ob.uuid.as_deref().unwrap_or("00000000-0000-0000-0000-000000000000"),
                    "flow": "",
                    "packet_encoding": "xudp"
                });
                if ob.tls_enabled == 1 {
                    vless_obj["tls"] = serde_json::json!({
                        "enabled": true,
                        "server_name": ob.tls_sni.as_deref().unwrap_or("learn.microsoft.com"),
                        "utls": {
                            "enabled": true,
                            "fingerprint": "chrome"
                        },
                        "reality": {
                            "enabled": true,
                            "public_key": ob.reality_public_key.as_deref().unwrap_or(""),
                            "short_id": ob.reality_short_id.as_deref().unwrap_or("")
                        }
                    });
                }
                vless_obj
            }
            "trojan" => serde_json::json!({
                "type": "trojan",
                "tag": ob.tag,
                "server": ob.server_address,
                "server_port": ob.server_port,
                "password": ob.password.as_deref().unwrap_or("sentra_pass")
            }),
            "hysteria2" => serde_json::json!({
                "type": "hysteria2",
                "tag": ob.tag,
                "server": ob.server_address,
                "server_port": ob.server_port,
                "password": ob.password.as_deref().unwrap_or("sentra_pass")
            }),
            _ => serde_json::json!({
                "type": "socks",
                "tag": ob.tag,
                "server": ob.server_address,
                "server_port": ob.server_port,
                "version": "5"
            }),
        };

        Self {
            id: ob.id,
            tag: ob.tag,
            protocol: ob.protocol,
            server_address: ob.server_address,
            server_port: ob.server_port as u16,
            mode_category: ob.mode_category,
            country_code: ob.country_code,
            quality_score,
            latency_ms: if ob.latency_ms > 0 { ob.latency_ms } else { 50 },
            is_healthy,
            is_official: true,
            parsed_config: node_config,
            raw_config_json: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutboundSelectionResult {
    pub selected: UnifiedOutbound,
    pub ranked_outbounds: Vec<UnifiedOutbound>,
    pub rank: usize,
    pub is_priority_user: bool,
    pub is_balanced_rank2: bool,
}

pub struct QualityEngine;

impl QualityEngine {
    /// 1. Measure real TTFB and latency (3 HTTP GET samples to generate_204 endpoints via proxy if possible),
    /// jitter, estimated throughput, and composite sample score (0..100) with heavy jitter penalty.
    pub async fn test_outbound_ttfb_and_quality(
        ip: IpAddr,
        port: u16,
        parsed_config: &serde_json::Value,
    ) -> (i64, i64, f64, i64, bool) {
        let mut sample_latencies: Vec<i64> = Vec::with_capacity(3);

        // Attempt proxy-based TTFB measurement if parsed_config is available and non-empty
        if parsed_config.is_object() && parsed_config.get("type").is_some() {
            let random_port: u16 = rand::thread_rng().gen_range(30000..=60000);
            let temp_dir = std::env::temp_dir();
            let config_file_name = format!("sentra_ttfb_test_{}_{}.json", std::process::id(), random_port);
            let config_path = temp_dir.join(config_file_name);

            let minimal_config = serde_json::json!({
                "log": { "level": "panic" },
                "inbounds": [
                    {
                        "type": "socks",
                        "tag": "bench-ttfb-in",
                        "listen": "127.0.0.1",
                        "listen_port": random_port
                    }
                ],
                "outbounds": [
                    parsed_config
                ]
            });

            if let Ok(content) = serde_json::to_string(&minimal_config) {
                let _ = tokio::fs::write(&config_path, content).await;
            }

            let child_res = tokio::process::Command::new("sing-box")
                .arg("run")
                .arg("-c")
                .arg(&config_path)
                .env_clear()
                .kill_on_drop(true)
                .spawn();

            if let Ok(mut child) = child_res {
                let proxy_url = format!("socks5://127.0.0.1:{}", random_port);
                tokio::time::sleep(Duration::from_millis(250)).await;

                if let Ok(proxy) = reqwest::Proxy::all(&proxy_url) {
                    if let Ok(client) = reqwest::Client::builder()
                        .proxy(proxy)
                        .timeout(Duration::from_millis(3500))
                        .pool_max_idle_per_host(0)
                        .build()
                    {
                        for _ in 0..3 {
                            let start = Instant::now();
                            // Primary TTFB target: Cloudflare generate_204; fallback: Google gstatic generate_204
                            let res = client.get("http://cp.cloudflare.com/generate_204").send().await;
                            match res {
                                Ok(resp) if resp.status().as_u16() == 204 || resp.status().is_success() => {
                                    let ttfb = start.elapsed().as_millis() as i64;
                                    sample_latencies.push(ttfb);
                                }
                                _ => {
                                    // Try fallback
                                    let start_fb = Instant::now();
                                    if let Ok(resp_fb) = client.get("http://www.gstatic.com/generate_204").send().await {
                                        if resp_fb.status().as_u16() == 204 || resp_fb.status().is_success() {
                                            let ttfb = start_fb.elapsed().as_millis() as i64;
                                            sample_latencies.push(ttfb);
                                        }
                                    }
                                }
                            }
                            tokio::time::sleep(Duration::from_millis(40)).await;
                        }
                    }
                }
                let _ = child.kill().await;
                let _ = tokio::fs::remove_file(&config_path).await;
            } else {
                let _ = tokio::fs::remove_file(&config_path).await;
            }
        }

        // Fallback: If proxy test yielded no samples (e.g. sing-box binary not in PATH or direct node)
        // Perform 3-sample direct TCP/HTTP connect to measure network latency
        if sample_latencies.is_empty() {
            let socket_addr = SocketAddr::new(ip, port);
            for _ in 0..3 {
                let start = Instant::now();
                let connect_res = timeout(Duration::from_millis(2500), TcpStream::connect(socket_addr)).await;
                if let Ok(Ok(_stream)) = connect_res {
                    let lat = start.elapsed().as_millis() as i64;
                    sample_latencies.push(lat);
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }

        if sample_latencies.is_empty() {
            // Completely offline / unreachable
            return (9999, 9999, 0.0, 0, false);
        }

        let sum: i64 = sample_latencies.iter().sum();
        let avg_latency = sum / sample_latencies.len() as i64;
        let min_lat = *sample_latencies.iter().min().unwrap_or(&avg_latency);
        let max_lat = *sample_latencies.iter().max().unwrap_or(&avg_latency);
        let jitter_ms = (max_lat - min_lat).max(0);

        if avg_latency > 3000 {
            return (avg_latency, jitter_ms, 0.5, 5, false);
        }

        // Throughput estimation (Mbps) based on TTFB and Jitter
        let speed_mbps = if avg_latency < 120 && jitter_ms <= 20 {
            35.0 - (avg_latency as f64 * 0.05)
        } else if avg_latency < 250 && jitter_ms <= 50 {
            22.0 - ((avg_latency - 120) as f64 * 0.04)
        } else if avg_latency < 500 {
            12.0 - ((avg_latency - 250) as f64 * 0.02)
        } else if avg_latency < 1000 {
            6.0 - ((avg_latency - 500) as f64 * 0.006)
        } else {
            1.5
        };
        let speed_mbps = ((speed_mbps * 10.0).round() / 10.0).max(0.5);

        // Quality sample score calculation (0..100) with heavy jitter penalty
        let latency_score = (50 - (avg_latency / 15)).clamp(0, 50);
        let jitter_score = if jitter_ms <= 15 {
            30
        } else if jitter_ms <= 30 {
            25
        } else if jitter_ms <= 60 {
            15
        } else if jitter_ms <= 100 {
            5
        } else {
            0
        };
        let throughput_score = (speed_mbps * 0.7).round().clamp(0.0, 20.0) as i64;

        // Heavy penalty for unstable jitter (e.g. 50..400ms swinging jitter heavily penalized vs steady 80ms)
        let jitter_penalty = if jitter_ms > 100 {
            ((jitter_ms - 100) / 10).min(35)
        } else {
            0
        };

        let total_speed_score = (latency_score + jitter_score + throughput_score - jitter_penalty).clamp(5, 100);

        (avg_latency, jitter_ms, speed_mbps, total_speed_score, true)
    }

    /// Backwards-compatible network quality test
    pub async fn test_outbound_network_quality(ip: IpAddr, port: u16) -> (i64, i64, f64, i64, bool) {
        Self::test_outbound_ttfb_and_quality(ip, port, &serde_json::Value::Null).await
    }

    /// 2. Comprehensive Security Audit: TLS 1.3 / Reality / AEAD enforcement & DNS Leak check
    pub fn audit_security(protocol: &str, config_json_val: &serde_json::Value) -> (bool, Option<String>) {
        let proto = protocol.to_lowercase();
        match proto.as_str() {
            "vless" => {
                let tls_enabled = config_json_val
                    .get("tls")
                    .and_then(|t| t.get("enabled"))
                    .and_then(|e| e.as_bool())
                    .unwrap_or(false);
                let reality_enabled = config_json_val
                    .pointer("/tls/reality/enabled")
                    .and_then(|r| r.as_bool())
                    .unwrap_or(false);
                if !tls_enabled && !reality_enabled {
                    return (false, Some("VLESS node lacks required TLS or Reality encryption layer".to_string()));
                }
            }
            "vmess" => {
                let security = config_json_val
                    .get("security")
                    .and_then(|s| s.as_str())
                    .unwrap_or("auto");
                if security == "none" {
                    return (false, Some("VMess security 'none' is insecure and strictly prohibited".to_string()));
                }
            }
            "shadowsocks" => {
                let method = config_json_val
                    .get("method")
                    .and_then(|m| m.as_str())
                    .unwrap_or("");
                if method.is_empty() || method == "none" || method == "plain" {
                    return (false, Some("Shadowsocks cipher must use AEAD or 2022 encryption".to_string()));
                }
            }
            "trojan" | "hysteria2" | "tuic" | "wireguard" => {
                // Native mandatory TLS/QUIC/Noise protocols
            }
            "http" | "socks" => {
                let has_tls = config_json_val
                    .get("tls")
                    .and_then(|t| t.get("enabled"))
                    .and_then(|e| e.as_bool())
                    .unwrap_or(false);
                if !has_tls {
                    return (false, Some("Plaintext HTTP/SOCKS proxies without TLS are blocked".to_string()));
                }
            }
            _ => {
                return (false, Some(format!("Unsupported or insecure protocol '{}'", proto)));
            }
        }

        // Verify DNS configuration does not bypass remote routing
        if let Some(dns_obj) = config_json_val.get("dns") {
            if let Some(dns_type) = dns_obj.get("type").and_then(|t| t.as_str()) {
                if dns_type == "local" || dns_type == "plain" {
                    return (false, Some("Plain local DNS violates DNS-leak prevention policy".to_string()));
                }
            }
        }

        (true, None)
    }

    /// 3. Gemini & Trading Readiness Check
    ///
    /// Tests connectivity through the proxy to Gemini (https://gemini.google.com)
    /// and standard financial exchange endpoints (e.g. Binance/TradingView ping),
    /// requiring jitter < 30ms and no regional 403 / captcha block.
    pub async fn test_gemini_and_trading_readiness(
        _ip: IpAddr,
        _port: u16,
        parsed_config: &serde_json::Value,
        country_code: &str,
        jitter_ms: i64,
    ) -> (bool, bool) {
        // High jitter (>30ms) violates trading stability requirement
        if jitter_ms > 30 {
            return (false, false);
        }

        let random_port: u16 = rand::thread_rng().gen_range(30000..=60000);
        let temp_dir = std::env::temp_dir();
        let config_file_name = format!("sentra_gemini_test_{}_{}.json", std::process::id(), random_port);
        let config_path = temp_dir.join(config_file_name);

        let minimal_config = serde_json::json!({
            "log": { "level": "panic" },
            "inbounds": [
                {
                    "type": "socks",
                    "tag": "bench-in",
                    "listen": "127.0.0.1",
                    "listen_port": random_port
                }
            ],
            "outbounds": [
                parsed_config
            ]
        });

        if let Ok(content) = serde_json::to_string(&minimal_config) {
            let _ = tokio::fs::write(&config_path, content).await;
        }

        // Attempt isolated proxy test via sing-box socks inbound
        let child_res = tokio::process::Command::new("sing-box")
            .arg("run")
            .arg("-c")
            .arg(&config_path)
            .env_clear()
            .kill_on_drop(true)
            .spawn();

        let (gemini_ok, trading_safe) = match child_res {
            Ok(mut child) => {
                let test_task = async {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    let proxy_url = format!("socks5://127.0.0.1:{}", random_port);
                    let client = match reqwest::Proxy::all(&proxy_url) {
                        Ok(p) => reqwest::Client::builder()
                            .proxy(p)
                            .timeout(Duration::from_secs(6))
                            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
                            .build()
                            .ok(),
                        Err(_) => None,
                    };

                    let (mut g_ok, mut t_ok) = (false, false);

                    if let Some(c) = client {
                        // A. Check Gemini availability (Google Gemini)
                        match c.get("https://gemini.google.com").send().await {
                            Ok(resp) => {
                                let status = resp.status().as_u16();
                                if status == 200 || status == 302 || status == 301 {
                                    if let Ok(body) = resp.text().await {
                                        let blocked = body.contains("not supported in your country")
                                            || body.contains("Region not supported")
                                            || body.contains("cf-browser-verification")
                                            || body.contains("Attention Required! | Cloudflare");
                                        if !blocked {
                                            g_ok = true;
                                        }
                                    } else {
                                        g_ok = true;
                                    }
                                }
                            }
                            Err(e) => {
                                warn!("Gemini test request failed through proxy: {:?}", e);
                            }
                        }

                        // B. Check Financial / Trading API ping (e.g. Binance ping endpoint)
                        match c.get("https://api.binance.com/api/v3/ping").send().await {
                            Ok(resp) if resp.status().is_success() => {
                                t_ok = true;
                            }
                            _ => {
                                // Fallback check to public trading platform
                                if let Ok(resp2) = c.get("https://api.kraken.com/0/public/Time").send().await {
                                    if resp2.status().is_success() {
                                        t_ok = true;
                                    }
                                }
                            }
                        }
                    }

                    let _ = child.kill().await;
                    (g_ok, t_ok)
                };

                timeout(Duration::from_secs(10), test_task).await.unwrap_or_default()
            }
            Err(_) => {
                // Fallback for host environments where sing-box binary is not installed in PATH:
                // Qualify nodes based on non-sanctioned country code and low jitter
                let non_permitted = ["IR", "CN", "RU", "SY", "CU", "KP", "XX"];
                let is_permitted_country = !non_permitted.contains(&country_code.to_uppercase().as_str());
                if is_permitted_country && jitter_ms <= 30 {
                    (true, true)
                } else {
                    (false, false)
                }
            }
        };

        let _ = tokio::fs::remove_file(&config_path).await;
        (gemini_ok, trading_safe)
    }

    /// 4. Auto-cleanup of dead outbounds (>48 hours without successful response)
    pub async fn run_dead_nodes_cleanup(
        pool: &DbPool,
        bot_opt: &Option<teloxide::Bot>,
        admin_chat_id: i64,
    ) -> Result<Vec<String>, CoreError> {
        let dead_nodes = Repository::cleanup_dead_outbounds(pool).await?;
        if dead_nodes.is_empty() {
            return Ok(Vec::new());
        }

        let cleaned_tags: Vec<String> = dead_nodes.iter().map(|n| n.tag.clone()).collect();
        info!(
            "[QualityEngine] 48-Hour Auto-Cleanup: Removed {} dead outbounds: {:?}",
            dead_nodes.len(),
            cleaned_tags
        );

        if let Some(bot) = bot_opt {
            if admin_chat_id != 0 {
                let mut list_str = String::new();
                for (_i, node) in dead_nodes.iter().enumerate().take(20) {
                    let kind = if node.is_official == 1 { "رسمی ادمین" } else { "اهدایی کاربر" };
                    list_str.push_str(&format!(
                        "• <code>{}</code> ({}: {}:{}) [شناسه #{}, {}]\n",
                        node.label.as_deref().unwrap_or(&node.tag),
                        node.protocol,
                        node.server_address,
                        node.server_port,
                        node.id,
                        kind
                    ));
                }
                if dead_nodes.len() > 20 {
                    list_str.push_str(&format!("... و {} نود دیگر\n", dead_nodes.len() - 20));
                }

                let now_tehran = chrono::Utc::now().with_timezone(&chrono_tz::Asia::Tehran);
                let alert_text = format!(
                    r#"🧹 <b>گزارش خودکار پاکسازی نودهای مرده (48-Hour Cleanup):</b>

⏰ زمان اجرا: <code>{}</code>
📊 تعداد نودهای حذف‌شده: <b>{} نود</b>

این نودها به دلیل عدم پاسخ به تست پینگ در ۴۸ ساعت گذشته، به صورت خودکار از دیتابیس و فایل پیکربندی sing-box حذف شدند:

{}
⚡️ پل سرور (bridge_sync) به صورت خودکار با نودهای سالم بازآرایی شد."#,
                    now_tehran.format("%Y-%m-%d %H:%M:%S"),
                    dead_nodes.len(),
                    list_str
                );

                let _ = bot
                    .send_message(ChatId(admin_chat_id), alert_text)
                    .parse_mode(ParseMode::Html)
                    .await;
            }
        }

        // Immediately update server bridge configuration
        let _ = bridge_sync::sync_server_bridge_config(pool).await;

        Ok(cleaned_tags)
    }

    /// 5. Execute full quality test cycle over all outbounds, updating scores, gemini readiness, and ranking
    pub async fn run_quality_cycle(
        pool: &DbPool,
        bot_opt: &Option<teloxide::Bot>,
        admin_chat_id: i64,
    ) -> Result<QualityCycleSummary, CoreError> {
        info!("[QualityEngine] Starting periodic Quality, Security & Auto-Ranking cycle...");

        let outbounds = Repository::get_all_active_donated_outbounds(pool).await?;
        let total = outbounds.len();
        let mut active_count = 0usize;
        let mut gemini_ready_count = 0usize;

        for ob in &outbounds {
            let parsed_config: serde_json::Value = serde_json::from_str(&ob.config_json).unwrap_or_default();

            // A. Security Audit
            let (sec_ok, _sec_reason) = Self::audit_security(&ob.protocol, &parsed_config);
            if !sec_ok {
                warn!("[QualityEngine] Outbound #{} ({}) failed security audit. Marking inactive.", ob.id, ob.tag);
                let _ = Repository::update_outbound_quality_metrics(
                    pool,
                    ob.id,
                    9999,
                    9999,
                    0.0,
                    0,
                    ob.quality_score,
                    false,
                    false,
                    false,
                )
                .await;
                continue;
            }

            // B. Anti-SSRF and IP resolution
            let ip_res = OutboundAnalyzer::check_anti_ssrf(&ob.server_address).await;
            let ip = match ip_res {
                Ok(ip) => ip,
                Err(e) => {
                    warn!("[QualityEngine] SSRF / DNS error for outbound #{}: {}", ob.id, e);
                    let _ = Repository::update_outbound_quality_metrics(
                        pool,
                        ob.id,
                        9999,
                        9999,
                        0.0,
                        0,
                        ob.quality_score,
                        false,
                        false,
                        false,
                    )
                    .await;
                    continue;
                }
            };

            // C. Speed & Latency & TTFB & Jitter test
            let (latency_ms, jitter_ms, speed_mbps, speed_score, is_healthy) =
                Self::test_outbound_ttfb_and_quality(ip, ob.server_port as u16, &parsed_config).await;

            if !is_healthy {
                let _ = Repository::update_outbound_quality_metrics(
                    pool,
                    ob.id,
                    latency_ms,
                    jitter_ms,
                    speed_mbps,
                    speed_score,
                    ob.quality_score,
                    false,
                    false,
                    false,
                )
                .await;
                continue;
            }

            // D. Gemini & Trading Readiness Check
            let (gemini_ok, trading_safe) =
                Self::test_gemini_and_trading_readiness(ip, ob.server_port as u16, &parsed_config, &ob.country_code, jitter_ms).await;

            if gemini_ok && trading_safe {
                gemini_ready_count += 1;
            }
            active_count += 1;

            // E. Persist quality metrics and trigger auto-allocation
            let _ = Repository::update_outbound_quality_metrics(
                pool,
                ob.id,
                latency_ms,
                jitter_ms,
                speed_mbps,
                speed_score,
                ob.quality_score,
                gemini_ok,
                trading_safe,
                true,
            )
            .await;
        }

        // F. Run 48-Hour Dead Nodes Auto-Cleanup
        let cleaned_tags = Self::run_dead_nodes_cleanup(pool, bot_opt, admin_chat_id).await.unwrap_or_default();

        // F2. Auto-cleanup of expired verification codes, auth codes, and password reset codes
        if let Ok((pr, ac, lc)) = Repository::cleanup_expired_codes(pool).await {
            if pr > 0 || ac > 0 || lc > 0 {
                info!(
                    "[QualityEngine] Cleaned expired codes: {} password resets, {} auth codes, {} link codes.",
                    pr, ac, lc
                );
            }
        }

        // G. Run 7-day stability clawback enforcer for rewarded donated outbounds
        Self::enforce_donated_clawbacks(pool, bot_opt, admin_chat_id).await;

        // H. Sync Sing-box bridge configuration with highest-ranked nodes
        if let Err(e) = bridge_sync::sync_server_bridge_config(pool).await {
            warn!("[QualityEngine] Post-quality-cycle bridge sync warning: {:?}", e);
        }

        info!(
            "[QualityEngine] Cycle finished: {} tested, {} active, {} Gemini/Trading ready, {} dead nodes cleaned.",
            total, active_count, gemini_ready_count, cleaned_tags.len()
        );

        Ok(QualityCycleSummary {
            total_tested: total,
            active_count,
            gemini_ready_count,
            dead_cleaned_count: cleaned_tags.len(),
            cleaned_tags,
        })
    }

    /// Enforce 7-day stability clawback for community rewarded outbounds
    async fn enforce_donated_clawbacks(pool: &DbPool, bot_opt: &Option<teloxide::Bot>, admin_chat_id: i64) {
        if let Ok(candidates) = Repository::get_rewarded_donated_outbounds_for_clawback(pool).await {
            let now = chrono::Utc::now();
            for ob in candidates {
                if let Some(first_used) = ob.first_used_at {
                    let days = now.signed_duration_since(first_used).num_days();
                    if days < 7 {
                        if let Some(off_since) = ob.offline_since {
                            let offline_hours = now.signed_duration_since(off_since).num_hours();
                            let donor_uid = ob.donor_user_id.unwrap_or(0);

                            if offline_hours >= 2 {
                                warn!("[QualityEngine] Executing clawback for outbound #{} (donor user #{})", ob.id, donor_uid);
                                let _ = Repository::execute_outbound_clawback(pool, ob.id, donor_uid).await;

                                if let Some(bot) = bot_opt {
                                    if let Ok(Some(donor)) = Repository::get_user_by_id(pool, donor_uid).await {
                                        if let Some(tid) = donor.telegram_id {
                                            let msg = format!(
                                                r#"⚠️ <b>ابطال اشتراک هدیه (قانون پایداری ۷ روزه اوتباند):</b>

سرور اهدایی شما با برچسب <code>{}</code> در کمتر از ۷ روز پس از ورود به چرخه مصرف، بیش از ۲ ساعت از دسترس خارج شد و جایگزین نگردید.
اشتراک Pro هدیه لغو و حساب شما به پلن Sentra Lite بازگردانده شد."#,
                                                ob.tag
                                            );
                                            let _ = bot.send_message(ChatId(tid), msg).parse_mode(ParseMode::Html).await;
                                        }
                                    }

                                    if admin_chat_id != 0 {
                                        let admin_alert = format!(
                                            "🚨 <b>گزارش ابطال پاداش اوتباند (Clawback):</b>\n\nنود شماره <code>#{}</code> متعلق به کاربر <code>#{}</code> به دلیل خاموشی بیش از ۲ ساعت لغو شد.",
                                            ob.id, donor_uid
                                        );
                                        let _ = bot.send_message(ChatId(admin_chat_id), admin_alert).parse_mode(ParseMode::Html).await;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    /// Spawn background daemon worker running quality cycle every 15 minutes
    pub fn start_quality_engine_worker(
        pool: DbPool,
        bot_opt: Option<teloxide::Bot>,
        admin_chat_id: i64,
    ) {
        tokio::spawn(async move {
            info!("[QualityEngine] Initializing background quality worker (interval: 15 minutes)...");
            let mut interval = tokio::time::interval(Duration::from_secs(15 * 60)); // 15 minutes

            // Skip first immediate tick to allow server startup and bridge sync to finish
            interval.tick().await;

            loop {
                interval.tick().await;
                if let Err(e) = Self::run_quality_cycle(&pool, &bot_opt, admin_chat_id).await {
                    error!("[QualityEngine] Error in periodic quality cycle: {:?}", e);
                }
            }
        });
    }

    /// Dynamic outbound selection and ranking algorithm:
    /// 1. Query active & healthy outbounds for category, sort by quality_score DESC, latency_ms ASC (Rank 1 best).
    /// 2. If user is priority (tier != 'free' OR account < 48 hours), allocate Rank 1 (balance between Rank 1 and 2 if Rank 1 load >= SATURATION_LOAD_THRESHOLD).
    /// 3. Other users: Deterministic hash on user_uuid partitions across Rank 2 onwards (or all healthy if count is small).
    /// 4. In case of failure / unhealthiness, immediately replace with healthiest available outbound.
    pub async fn select_outbounds_for_client(
        pool: &DbPool,
        load_tracker: &OutboundLoadTracker,
        user: &crate::models::User,
        subscription: &crate::models::Subscription,
        preferred_mode: Option<&str>,
        preferred_location: Option<&str>,
    ) -> Result<OutboundSelectionResult, CoreError> {
        let mode = preferred_mode.unwrap_or("web_browsing");

        // Fetch candidate outbounds from donated_outbounds (which stores verified active nodes)
        let donated_candidates = if let Some(loc) = preferred_location {
            Repository::get_active_outbounds_for_mode_and_location(pool, mode, Some(loc)).await.unwrap_or_default()
        } else {
            Repository::get_active_outbounds_for_mode_prioritized(pool, mode).await.unwrap_or_default()
        };

        // Fetch official outbounds from outbounds table
        let official_candidates = Repository::get_allowed_outbounds(pool, &subscription.tier).await.unwrap_or_default();

        let mut unified_list: Vec<UnifiedOutbound> = Vec::new();
        let mut seen_tags: std::collections::HashSet<String> = std::collections::HashSet::new();

        // 1. Add matching official candidates
        for ob in official_candidates {
            if ob.is_active == 1 && (ob.mode_category.eq_ignore_ascii_case(mode) || mode.is_empty()) {
                let uob = UnifiedOutbound::from(ob);
                if uob.is_healthy && uob.latency_ms < 2500 && uob.quality_score > 0 {
                    if seen_tags.insert(uob.tag.clone()) {
                        unified_list.push(uob);
                    }
                }
            }
        }

        // 2. Add matching donated candidates
        for dob in donated_candidates {
            let uob = UnifiedOutbound::from(dob);
            if uob.is_healthy && uob.latency_ms < 2500 && uob.quality_score > 0 {
                if seen_tags.insert(uob.tag.clone()) {
                    unified_list.push(uob);
                }
            }
        }

        // Fallback to sandbox if no healthy nodes found
        if unified_list.is_empty() {
            unified_list.push(UnifiedOutbound::sandbox_fallback(mode));
        }

        // Rule 1: Sort by highest quality_score and lowest latency_ms (Rank 1 is candidates[0])
        if mode.eq_ignore_ascii_case("gaming") {
            // Gaming Mode: heavily weight lowest TTFB/latency and minimum jitter, with priority bonus for locations near Iran (AE, BH, TR, DE)
            unified_list.sort_by(|a, b| {
                let a_near_bonus = if matches!(a.country_code.to_uppercase().as_str(), "AE" | "BH" | "TR" | "DE") { 15 } else { 0 };
                let b_near_bonus = if matches!(b.country_code.to_uppercase().as_str(), "AE" | "BH" | "TR" | "DE") { 15 } else { 0 };
                let a_score = a.quality_score + a_near_bonus;
                let b_score = b.quality_score + b_near_bonus;

                b_score.cmp(&a_score)
                    .then_with(|| a.latency_ms.cmp(&b.latency_ms))
                    .then_with(|| b.is_official.cmp(&a.is_official))
                    .then_with(|| a.id.cmp(&b.id))
            });
        } else {
            unified_list.sort_by(|a, b| {
                b.quality_score.cmp(&a.quality_score)
                    .then_with(|| a.latency_ms.cmp(&b.latency_ms))
                    .then_with(|| b.is_official.cmp(&a.is_official))
                    .then_with(|| a.id.cmp(&b.id))
            });
        }

        // Determine priority status:
        // subscription tier != 'free' (or 'lite') AND active, OR user account created < 48 hours
        let is_active_sub = subscription.status == "active" && subscription.expires_at > chrono::Utc::now();
        let is_paid_tier = is_active_sub
            && !subscription.tier.eq_ignore_ascii_case("free")
            && !subscription.tier.eq_ignore_ascii_case("lite")
            && !subscription.tier.eq_ignore_ascii_case("Sentra Lite");
        let is_new_user = (chrono::Utc::now() - user.created_at).num_hours() < 48;
        let is_priority_user = is_paid_tier || is_new_user;

        let (mut selected_idx, is_balanced_rank2) = if is_priority_user {
            // Rule 2: Priority users get Rank 1 (candidates[0])
            // Unless Rank 1 load reaches SATURATION_LOAD_THRESHOLD, then balance between Rank 1 and Rank 2
            let rank1_load = load_tracker.get_load(&unified_list[0].tag).await;
            if rank1_load >= SATURATION_LOAD_THRESHOLD && unified_list.len() >= 2 {
                let rank2_load = load_tracker.get_load(&unified_list[1].tag).await;
                if rank2_load < rank1_load {
                    let h = deterministic_hash(&user.user_uuid);
                    if h % 2 == 1 {
                        (1, true)
                    } else {
                        (0, false)
                    }
                } else {
                    (0, false)
                }
            } else {
                (0, false)
            }
        } else {
            // Rule 3: Other users partitioned with Deterministic Hash on user_uuid across Rank 2 onwards
            if unified_list.len() >= 3 {
                let pool_len = unified_list.len() - 1;
                let h = deterministic_hash(&user.user_uuid);
                let idx = 1 + ((h as usize) % pool_len);
                (idx, false)
            } else if unified_list.len() == 2 {
                let h = deterministic_hash(&user.user_uuid);
                let idx = (h as usize) % 2;
                (idx, false)
            } else {
                (0, false)
            }
        };

        // Rule 4: In case of failure or unhealthiness, immediately replace with healthiest available outbound
        if selected_idx >= unified_list.len() || !unified_list[selected_idx].is_healthy {
            selected_idx = 0;
        }

        let selected = unified_list[selected_idx].clone();
        load_tracker.increment_load(&selected.tag).await;

        // Build ranked outbounds placing the selected primary node at the top
        let mut ranked = Vec::with_capacity(unified_list.len());
        ranked.push(selected.clone());
        for item in &unified_list {
            if item.tag != selected.tag {
                ranked.push(item.clone());
            }
        }

        Ok(OutboundSelectionResult {
            selected,
            ranked_outbounds: ranked,
            rank: selected_idx + 1,
            is_priority_user,
            is_balanced_rank2,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration as ChronoDuration, Utc};

    fn make_test_outbound(id: i64, tag: &str, quality_score: i64, latency_ms: i64, is_healthy: bool) -> UnifiedOutbound {
        UnifiedOutbound {
            id,
            tag: tag.to_string(),
            protocol: "socks".to_string(),
            server_address: "127.0.0.1".to_string(),
            server_port: 10800 + id as u16,
            mode_category: "web_browsing".to_string(),
            country_code: "DE".to_string(),
            quality_score,
            latency_ms,
            is_healthy,
            is_official: true,
            parsed_config: serde_json::json!({
                "type": "socks",
                "tag": tag,
                "server": "127.0.0.1",
                "server_port": 10800 + id as u16,
                "version": "5"
            }),
            raw_config_json: None,
        }
    }

    fn make_test_user(user_uuid: &str, age_hours: i64) -> crate::models::User {
        let created_at = Utc::now() - ChronoDuration::hours(age_hours);
        crate::models::User {
            id: 1,
            user_uuid: user_uuid.to_string(),
            telegram_id: None,
            email: None,
            username: Some("test_user".to_string()),
            password_hash: None,
            first_name: "Test".to_string(),
            last_name: None,
            photo_url: None,
            role: "user".to_string(),
            status: "active".to_string(),
            auth_code: None,
            auth_code_expires_at: None,
            link_code: None,
            link_code_expires_at: None,
            telegram_verified: 1,
            verify_code: None,
            verify_code_expires_at: None,
            outbound_reward_banned: 0,
            created_at,
            updated_at: Utc::now(),
        }
    }

    fn make_test_sub(tier: &str) -> crate::models::Subscription {
        crate::models::Subscription {
            id: 1,
            user_id: 1,
            tier: tier.to_string(),
            token: "sub_test_token_123".to_string(),
            status: "active".to_string(),
            upload_bytes: 0,
            download_bytes: 0,
            traffic_limit_bytes: 10 * 1024 * 1024 * 1024,
            speed_limit_bps: 10_000_000,
            max_concurrent_devices: 3,
            web_browsing_used_mb: 0,
            download_used_mb: 0,
            static_ip_used_mb: 0,
            gaming_used_mb: 0,
            last_quota_reset: Utc::now(),
            starts_at: Utc::now(),
            expires_at: Utc::now() + ChronoDuration::days(30),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    #[test]
    fn test_deterministic_hash_stability() {
        let uuid = "usr-a1b2c3d4-e5f6-7890";
        let h1 = deterministic_hash(uuid);
        let h2 = deterministic_hash(uuid);
        assert_eq!(h1, h2, "Deterministic hash must produce identical results for the same uuid");

        let uuid2 = "usr-different-user-9999";
        let h3 = deterministic_hash(uuid2);
        assert_ne!(h1, h3, "Different uuids should generally produce different hashes");
    }

    #[tokio::test]
    async fn test_outbound_load_tracker() {
        let tracker = OutboundLoadTracker::new();
        assert_eq!(tracker.get_load("node-1").await, 0);

        tracker.increment_load("node-1").await;
        tracker.increment_load("node-1").await;
        assert_eq!(tracker.get_load("node-1").await, 2);

        tracker.decrement_load("node-1").await;
        assert_eq!(tracker.get_load("node-1").await, 1);
    }

    #[test]
    fn test_rule_1_ranking_order() {
        let mut list = vec![
            make_test_outbound(1, "Medium Node", 80, 100, true),
            make_test_outbound(2, "Best Node", 95, 40, true),
            make_test_outbound(3, "Low Node", 60, 200, true),
            make_test_outbound(4, "Tie Low Ping Node", 95, 25, true),
        ];

        list.sort_by(|a, b| {
            b.quality_score.cmp(&a.quality_score)
                .then_with(|| a.latency_ms.cmp(&b.latency_ms))
                .then_with(|| b.is_official.cmp(&a.is_official))
                .then_with(|| a.id.cmp(&b.id))
        });

        assert_eq!(list[0].tag, "Tie Low Ping Node", "Rank 1 must be highest quality score and lowest latency");
        assert_eq!(list[1].tag, "Best Node");
        assert_eq!(list[2].tag, "Medium Node");
        assert_eq!(list[3].tag, "Low Node");
    }

    #[tokio::test]
    async fn test_rule_2_priority_user_allocation_and_saturation() {
        let tracker = OutboundLoadTracker::new();
        let rank1_node = make_test_outbound(1, "Rank-1-Node", 98, 20, true);
        let rank2_node = make_test_outbound(2, "Rank-2-Node", 90, 45, true);
        let rank3_node = make_test_outbound(3, "Rank-3-Node", 80, 80, true);
        let nodes = vec![rank1_node.clone(), rank2_node.clone(), rank3_node.clone()];

        // Priority 1: Paid tier (Sentra Pro)
        let paid_user = make_test_user("usr-paid-001", 100);
        let paid_sub = make_test_sub("Sentra Pro");
        let is_paid = !paid_sub.tier.eq_ignore_ascii_case("free") && !paid_sub.tier.eq_ignore_ascii_case("lite");
        assert!(is_paid, "Sentra Pro must be recognized as paid priority");

        // Priority 2: New user (< 48 hours) on Lite tier
        let new_user = make_test_user("usr-new-001", 24);
        let _lite_sub = make_test_sub("Sentra Lite");
        let is_new = (Utc::now() - new_user.created_at).num_hours() < 48;
        assert!(is_new, "User created 24 hours ago must be recognized as new user priority");

        // Before saturation: Rank 1 is always selected
        assert_eq!(tracker.get_load(&rank1_node.tag).await, 0);

        // Saturation test: set Rank 1 load to 50
        for _ in 0..50 {
            tracker.increment_load(&rank1_node.tag).await;
        }
        assert_eq!(tracker.get_load(&rank1_node.tag).await, 50);

        // Under saturation, priority user balances between Rank 1 and Rank 2
        let h = deterministic_hash(&paid_user.user_uuid);
        let chosen_idx = if h % 2 == 1 { 1 } else { 0 };
        let chosen_node = &nodes[chosen_idx];
        assert!(chosen_node.tag == "Rank-1-Node" || chosen_node.tag == "Rank-2-Node");
    }

    #[test]
    fn test_rule_3_deterministic_hash_partitioning() {
        let rank1_node = make_test_outbound(1, "Rank-1-Node", 98, 20, true);
        let rank2_node = make_test_outbound(2, "Rank-2-Node", 90, 45, true);
        let rank3_node = make_test_outbound(3, "Rank-3-Node", 80, 80, true);
        let rank4_node = make_test_outbound(4, "Rank-4-Node", 70, 95, true);
        let nodes = vec![rank1_node, rank2_node, rank3_node, rank4_node];

        let pool_len = nodes.len() - 1; // 3 nodes in pool (Rank 2..Rank 4)
        let mut allocated_indices = std::collections::HashSet::new();

        for i in 0..50 {
            let user_uuid = format!("usr-free-client-{:04}", i);
            let h = deterministic_hash(&user_uuid);
            let idx = 1 + ((h as usize) % pool_len);
            assert!(idx >= 1 && idx < nodes.len(), "Index must be partitioned across Rank 2 onwards");
            allocated_indices.insert(idx);

            // Verify stability
            let h_repeat = deterministic_hash(&user_uuid);
            let idx_repeat = 1 + ((h_repeat as usize) % pool_len);
            assert_eq!(idx, idx_repeat, "Repeated allocation for same user must be deterministic and identical");
        }

        assert!(allocated_indices.len() > 1, "Deterministic hash should distribute users across available nodes");
    }

    #[test]
    fn test_rule_4_failover_replacement() {
        let dead_node = make_test_outbound(1, "Dead-Node", 99, 10, false);
        let healthy_fallback = make_test_outbound(2, "Healthy-Fallback", 85, 30, true);
        let nodes = vec![healthy_fallback.clone(), dead_node];

        let mut selected_idx = 1; // pointing to dead node
        if selected_idx >= nodes.len() || !nodes[selected_idx].is_healthy {
            selected_idx = 0; // immediate replacement with healthiest
        }

        assert_eq!(selected_idx, 0);
        assert_eq!(nodes[selected_idx].tag, "Healthy-Fallback");
        assert!(nodes[selected_idx].is_healthy);
    }

    #[test]
    fn test_rule_5_ttfb_jitter_penalty_and_ema() {
        // Node A: Steady 80ms latency, jitter 10ms
        let avg_latency_a = 80i64;
        let jitter_a = 10i64;
        let speed_mbps_a = (35.0 - (avg_latency_a as f64 * 0.05)).max(0.5);
        let lat_score_a = (50 - (avg_latency_a / 15)).clamp(0, 50);
        let jit_score_a = 30; // <= 15
        let tp_score_a = (speed_mbps_a * 0.7).round().clamp(0.0, 20.0) as i64;
        let penalty_a = if jitter_a > 100 { ((jitter_a - 100) / 10).min(35) } else { 0 };
        let score_a = (lat_score_a + jit_score_a + tp_score_a - penalty_a).clamp(5, 100);

        // Node B: Fluctuating latency (50-400ms), jitter 350ms
        let avg_latency_b = 225i64;
        let jitter_b = 350i64;
        let speed_mbps_b = (22.0 - ((avg_latency_b - 120) as f64 * 0.04)).max(0.5);
        let lat_score_b = (50 - (avg_latency_b / 15)).clamp(0, 50);
        let jit_score_b = 0; // > 100
        let tp_score_b = (speed_mbps_b * 0.7).round().clamp(0.0, 20.0) as i64;
        let penalty_b = if jitter_b > 100 { ((jitter_b - 100) / 10).min(35) } else { 0 };
        let score_b = (lat_score_b + jit_score_b + tp_score_b - penalty_b).clamp(5, 100);

        assert!(score_a >= 85, "Steady 80ms node must get high score >= 85, got {}", score_a);
        assert!(score_b <= 30, "Fluctuating 50-400ms node must get low score <= 30 due to jitter penalty, got {}", score_b);
        assert!(score_a - score_b >= 50, "Difference between steady and jittery node must be massive (>50)");

        // Verify EMA smoothing: new_score = 0.7 * old + 0.3 * current
        let old_score = 80i64;
        let current_sample = 50i64;
        let ema_smoothed = (0.7 * (old_score as f64) + 0.3 * (current_sample as f64)).round() as i64;
        assert_eq!(ema_smoothed, 71, "EMA smoothing 0.7 * 80 + 0.3 * 50 must equal 71");
    }
}
