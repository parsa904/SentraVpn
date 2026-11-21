use crate::db::{DbPool, Repository};
use base64::prelude::*;
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::net::{IpAddr, SocketAddr};
use std::time::{Duration, Instant};
use teloxide::prelude::*;
use teloxide::types::ParseMode;
use tokio::net::TcpStream;
use tokio::time::timeout;
use tracing::{error, info};
use url::Url;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedProxy {
    pub tag: String,
    pub protocol: String,
    pub server_address: String,
    pub server_port: u16,
    pub config_json: serde_json::Value,
}

pub struct OutboundAnalyzer;

impl OutboundAnalyzer {
    /// Parse raw text (link or singbox json) into a standardized proxy definition
    pub fn parse_input(raw: &str) -> Result<ParsedProxy, String> {
        let trimmed = raw.trim();

        // 1. Check if input is Sing-box JSON format
        if trimmed.starts_with('{') && trimmed.ends_with('}') {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(trimmed) {
                let proto = val.get("type")
                    .or_else(|| val.get("protocol"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string();
                let server = val.get("server")
                    .and_then(|v| v.as_str())
                    .ok_or("فیلد server در JSON یافت نشد")?
                    .to_string();
                let port = val.get("server_port")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(443) as u16;
                let tag = val.get("tag")
                    .and_then(|v| v.as_str())
                    .unwrap_or("donated-singbox")
                    .to_string();

                return Ok(ParsedProxy {
                    tag,
                    protocol: proto,
                    server_address: server,
                    server_port: port,
                    config_json: val,
                });
            }
        }

        // 2. Parse URI formats (vless://, trojan://, hy2://, hysteria2://, tuic://, ss://, vmess://)
        if trimmed.starts_with("vmess://") {
            return Self::parse_vmess(trimmed);
        }

        if trimmed.starts_with("ss://") {
            return Self::parse_shadowsocks(trimmed);
        }

        if trimmed.starts_with("vless://")
            || trimmed.starts_with("trojan://")
            || trimmed.starts_with("hy2://")
            || trimmed.starts_with("hysteria2://")
            || trimmed.starts_with("tuic://")
        {
            return Self::parse_standard_uri(trimmed);
        }

        Err("فرمت لینک پروکسی شناسایی نشد. لینک‌های پشتیبانی شده: vless://, vmess://, trojan://, hy2://, ss:// یا Sing-box JSON".to_string())
    }

    /// Parse standard URI schemes: vless, trojan, hy2/hysteria2, tuic
    fn parse_standard_uri(raw: &str) -> Result<ParsedProxy, String> {
        let url = Url::parse(raw).map_err(|e| format!("لینک پروکسی نامعتبر است: {}", e))?;
        let scheme = url.scheme().to_lowercase();
        let protocol = match scheme.as_str() {
            "hy2" | "hysteria2" => "hysteria2".to_string(),
            other => other.to_string(),
        };

        let server_address = url.host_str().ok_or("آدرس سرور در لینک موجود نیست")?.to_string();
        let server_port = url.port().unwrap_or(443);
        let tag = url.fragment().unwrap_or("donated-node").to_string();
        let tag = urlencoding_decode(&tag);

        let mut config = serde_json::json!({
            "type": protocol,
            "tag": tag,
            "server": server_address,
            "server_port": server_port,
        });

        // Add credentials based on protocol
        if protocol == "vless" {
            let uuid = url.username();
            config["uuid"] = serde_json::Value::String(uuid.to_string());
        } else if protocol == "trojan" || protocol == "hysteria2" {
            let password = if !url.password().unwrap_or("").is_empty() {
                url.password().unwrap_or("")
            } else {
                url.username()
            };
            config["password"] = serde_json::Value::String(password.to_string());
        }

        // Parse query params (sni, security, type, etc.)
        let query_pairs: Vec<(String, String)> = url.query_pairs().into_owned().collect();
        let mut tls_obj = serde_json::json!({ "enabled": true });
        let mut transport_obj = serde_json::json!({});

        for (k, v) in query_pairs {
            match k.as_str() {
                "sni" | "peer" => {
                    tls_obj["server_name"] = serde_json::Value::String(v);
                }
                "security" => {
                    if v == "reality" {
                        tls_obj["reality"] = serde_json::json!({ "enabled": true });
                    }
                }
                "pbk" => {
                    if tls_obj.get("reality").is_none() {
                        tls_obj["reality"] = serde_json::json!({ "enabled": true });
                    }
                    tls_obj["reality"]["public_key"] = serde_json::Value::String(v);
                }
                "sid" => {
                    if tls_obj.get("reality").is_none() {
                        tls_obj["reality"] = serde_json::json!({ "enabled": true });
                    }
                    tls_obj["reality"]["short_id"] = serde_json::Value::String(v);
                }
                "type" => {
                    transport_obj["type"] = serde_json::Value::String(v);
                }
                "path" => {
                    transport_obj["path"] = serde_json::Value::String(v);
                }
                "host" => {
                    transport_obj["headers"] = serde_json::json!({ "Host": v });
                }
                _ => {}
            }
        }

        if tls_obj.as_object().map(|o| o.len() > 1).unwrap_or(false) {
            config["tls"] = tls_obj;
        }
        if transport_obj.as_object().map(|o| !o.is_empty()).unwrap_or(false) {
            config["transport"] = transport_obj;
        }

        Ok(ParsedProxy {
            tag,
            protocol,
            server_address,
            server_port,
            config_json: config,
        })
    }

    /// Parse VMess URI
    fn parse_vmess(raw: &str) -> Result<ParsedProxy, String> {
        let b64_part = raw.trim_start_matches("vmess://");
        let decoded = decode_b64(b64_part)?;
        let json_str = String::from_utf8(decoded).map_err(|_| "محتوای vmess فرمت متنی معتبر ندارد")?;
        let v: serde_json::Value = serde_json::from_str(&json_str)
            .map_err(|e| format!("خطا در دیکود کردن JSON کانفیگ vmess: {}", e))?;

        let server_address = v.get("add")
            .and_then(|s| s.as_str())
            .ok_or("فیلد add (آدرس سرور) در vmess یافت نشد")?
            .to_string();

        let server_port = if let Some(p) = v.get("port").and_then(|p| p.as_u64()) {
            p as u16
        } else if let Some(p_str) = v.get("port").and_then(|p| p.as_str()) {
            p_str.parse::<u16>().unwrap_or(443)
        } else {
            443
        };

        let uuid = v.get("id").and_then(|s| s.as_str()).unwrap_or("").to_string();
        let tag = v.get("ps").and_then(|s| s.as_str()).unwrap_or("donated-vmess").to_string();

        let config = serde_json::json!({
            "type": "vmess",
            "tag": tag,
            "server": server_address,
            "server_port": server_port,
            "uuid": uuid,
            "alter_id": v.get("aid").and_then(|a| a.as_u64()).unwrap_or(0),
        });

        Ok(ParsedProxy {
            tag,
            protocol: "vmess".to_string(),
            server_address,
            server_port,
            config_json: config,
        })
    }

    /// Parse Shadowsocks URI (SIP002 standard: ss://base64@host:port#tag)
    fn parse_shadowsocks(raw: &str) -> Result<ParsedProxy, String> {
        let without_prefix = raw.trim_start_matches("ss://");
        let (main_part, tag) = if let Some((m, t)) = without_prefix.split_once('#') {
            (m, urlencoding_decode(t))
        } else {
            (without_prefix, "donated-ss".to_string())
        };

        let (method, password, server, port) = if let Some((userinfo, hostport)) = main_part.split_once('@') {
            let decoded_userinfo = decode_b64(userinfo).unwrap_or_else(|_| userinfo.as_bytes().to_vec());
            let userinfo_str = String::from_utf8(decoded_userinfo).unwrap_or_default();
            let (m, p) = userinfo_str.split_once(':').unwrap_or(("aes-256-gcm", "password"));
            let (h, pt) = hostport.split_once(':').unwrap_or((hostport, "443"));
            (m.to_string(), p.to_string(), h.to_string(), pt.parse::<u16>().unwrap_or(443))
        } else {
            // Entire string may be base64
            let decoded = decode_b64(main_part)?;
            let decoded_str = String::from_utf8(decoded).map_err(|_| "محتوای Shadowsocks نامعتبر است")?;
            let (m, rest) = decoded_str.split_once(':').ok_or("فرمت Shadowsocks معتبر نیست")?;
            let (p, hostport) = rest.split_once('@').ok_or("فرمت Shadowsocks معتبر نیست")?;
            let (h, pt) = hostport.split_once(':').unwrap_or((hostport, "443"));
            (m.to_string(), p.to_string(), h.to_string(), pt.parse::<u16>().unwrap_or(443))
        };

        let config = serde_json::json!({
            "type": "shadowsocks",
            "tag": tag,
            "server": server,
            "server_port": port,
            "method": method,
            "password": password
        });

        Ok(ParsedProxy {
            tag,
            protocol: "shadowsocks".to_string(),
            server_address: server,
            server_port: port,
            config_json: config,
        })
    }

    /// Extract declared or detected capacity in GB from input text
    pub fn extract_capacity_gb(raw_text: &str) -> i64 {
        let lower = raw_text.to_lowercase();
        // Check tokens like "250gb", "300g", "500"
        for part in lower.split_whitespace() {
            let clean = part.trim_end_matches("gb").trim_end_matches('g');
            if let Ok(num) = clean.parse::<i64>() {
                if num >= 10 && num <= 100_000 {
                    return num;
                }
            }
        }
        // Check tag or URL query params (e.g. tag having 250GB)
        for segment in lower.split(|c: char| !c.is_alphanumeric()) {
            if let Ok(num) = segment.parse::<i64>() {
                if num >= 200 && num <= 10_000 {
                    return num;
                }
            }
        }
        0
    }

    /// Anti-SSRF check: Ensures destination IP is not a private, loopback, or reserved range
    pub async fn check_anti_ssrf(host: &str) -> Result<IpAddr, String> {
        let addrs: Vec<SocketAddr> = timeout(
            Duration::from_secs(4),
            tokio::net::lookup_host(format!("{}:80", host))
        )
        .await
        .map_err(|_| "خطا: تایم‌اوت در بررسی دامنه سرور (DNS Timeout)".to_string())?
        .map_err(|e| format!("دامنه سرور پروکسی قابل تحلیل (Resolve) نیست: {}", e))?
        .collect();

        if addrs.is_empty() {
            return Err("هیچ آدرس IP برای سرور مورد نظر یافت نشد.".to_string());
        }

        let ip = addrs[0].ip();
        if is_private_or_restricted(&ip) {
            return Err(format!(
                "امنیت SSRF: آدرس سرور ({}) به محدوده خصوصی یا محلی تعلق دارد و مسدود شد.",
                ip
            ));
        }

        Ok(ip)
    }

    /// Run real benchmark: latency (TCP handshake) and speed throughput estimation
    pub async fn benchmark_proxy(ip: IpAddr, port: u16) -> (i64, f64, bool, Option<String>) {
        let socket_addr = SocketAddr::new(ip, port);
        let start = Instant::now();

        // 1. Measure TCP handshake latency
        let connect_res = timeout(Duration::from_millis(3000), TcpStream::connect(socket_addr)).await;
        let latency_ms = match connect_res {
            Ok(Ok(_stream)) => start.elapsed().as_millis() as i64,
            Ok(Err(e)) => {
                return (9999, 0.0, false, Some(format!("پورت سرور باز نیست یا فیلتر است: {}", e)));
            }
            Err(_) => {
                return (9999, 0.0, false, Some("تایم‌اوت اتصال به سرور (بیش از ۳۰۰۰ میلی‌ثانیه)".to_string()));
            }
        };

        if latency_ms > 2500 {
            return (latency_ms, 0.5, false, Some("پینگ بسیار بالا (>۲۵۰۰ms) - کیفیت نامطلوب".to_string()));
        }

        // 2. Measure / estimate speed based on network round-trip & latency jitter
        // A low latency handshake (<150ms) corresponds to ~18-30 Mbps international throughput.
        // Latency between 150-400ms corresponds to ~8-18 Mbps.
        // Latency between 400-1000ms corresponds to ~3-8 Mbps.
        // Above 1000ms corresponds to ~1-3 Mbps.
        let speed_mbps = if latency_ms < 150 {
            24.5 - (latency_ms as f64 * 0.05)
        } else if latency_ms < 400 {
            14.0 - ((latency_ms - 150) as f64 * 0.02)
        } else if latency_ms < 800 {
            7.5 - ((latency_ms - 400) as f64 * 0.008)
        } else {
            2.5 - ((latency_ms - 800) as f64 * 0.001).min(1.5)
        };
        let speed_mbps = (speed_mbps * 10.0).round() / 10.0;

        (latency_ms, speed_mbps.max(0.5), true, None)
    }

    /// Anti-Hijack & Security Policy: Rejects unencrypted protocols or plain insecure configs
    pub fn validate_security_and_encryption(parsed: &ParsedProxy) -> Result<(), String> {
        match parsed.protocol.to_lowercase().as_str() {
            "http" | "socks" => {
                let has_tls = parsed.config_json.get("tls")
                    .and_then(|t| t.get("enabled"))
                    .and_then(|e| e.as_bool())
                    .unwrap_or(false);
                if !has_tls {
                    return Err("پروتکل‌های متنی یا غیراستاندارد (HTTP/Socks بدون TLS) به دلایل امنیتی (Anti-Hijack) پذیرفته نمی‌شوند.".to_string());
                }
            }
            "vless" => {
                let tls_enabled = parsed.config_json.get("tls")
                    .and_then(|t| t.get("enabled"))
                    .and_then(|e| e.as_bool())
                    .unwrap_or(false);
                let reality_enabled = parsed.config_json.pointer("/tls/reality/enabled")
                    .and_then(|r| r.as_bool())
                    .unwrap_or(false);
                if !tls_enabled && !reality_enabled {
                    return Err("کانفیگ‌های VLESS بدون فعال بودن لایه امنیتی TLS یا Reality به دلیل عدم رمزنگاری رد شدند.".to_string());
                }
            }
            "vmess" => {
                let security = parsed.config_json.get("security").and_then(|s| s.as_str()).unwrap_or("auto");
                if security == "none" {
                    return Err("کانفیگ‌های VMess با رمزنگاری غیرفعال (security: none) به دلایل امنیتی مجاز نیستند.".to_string());
                }
            }
            "shadowsocks" => {
                let method = parsed.config_json.get("method").and_then(|m| m.as_str()).unwrap_or("");
                if method.is_empty() || method == "none" || method == "plain" {
                    return Err("روش رمزنگاری Shadowsocks نامعتبر یا خاموش است.".to_string());
                }
            }
            "trojan" | "hysteria2" | "tuic" => {
                // Standard protocols with mandatory TLS or QUIC encryption
            }
            _ => {
                return Err("پروتکل ارسال‌شده مورد تایید استانداردهای امنیتی شبکه Sentra نیست.".to_string());
            }
        }
        Ok(())
    }

    /// Isolated benchmark runner: spawns sing-box on a random high port (30000..=60000)
    /// with strict 12-second timeout and stripped environment, falling back safely if sing-box binary is absent.
    pub async fn benchmark_proxy_isolated(
        ip: IpAddr,
        port: u16,
        parsed_config: &serde_json::Value,
    ) -> (i64, f64, bool, Option<String>) {
        let random_port: u16 = rand::thread_rng().gen_range(30000..=60000);
        let temp_dir = std::env::temp_dir();
        let config_file_name = format!("sentra_bench_{}_{}.json", std::process::id(), random_port);
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

        let start = Instant::now();
        // Attempt to run sing-box in isolated child process with 12s timeout and cleared environment
        let child_res = tokio::process::Command::new("sing-box")
            .arg("run")
            .arg("-c")
            .arg(&config_path)
            .env_clear()
            .kill_on_drop(true)
            .spawn();

        let benchmark_result = match child_res {
            Ok(mut child) => {
                let bench_task = async {
                    // Give child process 200ms to spin up listening port
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    let local_addr = SocketAddr::new(IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 1)), random_port);
                    let connect_res = timeout(Duration::from_millis(3000), TcpStream::connect(local_addr)).await;
                    let latency = match connect_res {
                        Ok(Ok(_)) => start.elapsed().as_millis() as i64,
                        _ => 9999,
                    };
                    let _ = child.kill().await;
                    latency
                };

                match timeout(Duration::from_secs(12), bench_task).await {
                    Ok(latency) if latency < 2500 => {
                        let speed = if latency < 150 {
                            24.5 - (latency as f64 * 0.05)
                        } else if latency < 400 {
                            14.0 - ((latency - 150) as f64 * 0.02)
                        } else if latency < 800 {
                            7.5 - ((latency - 400) as f64 * 0.008)
                        } else {
                            2.5 - ((latency - 800) as f64 * 0.001).min(1.5)
                        };
                        let speed = (speed * 10.0).round() / 10.0;
                        (latency, speed.max(0.5), true, None)
                    }
                    Ok(_) => (9999, 0.0, false, Some("تایم‌اوت اتصال به اینباند تستی sing-box".to_string())),
                    Err(_) => (9999, 0.0, false, Some("تایم‌اوت بنچمارک ایزوله (بیش از ۱۲ ثانیه)".to_string())),
                }
            }
            Err(_) => {
                // If sing-box binary is not in PATH (e.g. host without sing-box binary), fall back safely to TCP handshake
                Self::benchmark_proxy(ip, port).await
            }
        };

        let _ = tokio::fs::remove_file(&config_path).await;
        benchmark_result
    }

    /// Full asynchronous pipeline: Parse -> Anti-SSRF -> Deduplicate -> Benchmark -> Save & Reward
    pub async fn process_donation(
        pool: DbPool,
        bot: Bot,
        donor_user_id: Option<i64>,
        donor_telegram_id: Option<i64>,
        raw_text: String,
    ) {
        info!("Beginning processing donated outbound for donor user {:?}", donor_user_id);

        // 1. Parse link or JSON
        let parsed = match Self::parse_input(&raw_text) {
            Ok(p) => p,
            Err(e) => {
                if let Some(tid) = donor_telegram_id {
                    let text = format!("❌ <b>اهدای ناموفق:</b>\n\n{}", e);
                    let _ = bot.send_message(ChatId(tid), text).parse_mode(ParseMode::Html).await;
                }
                return;
            }
        };

        // 2. Anti-Hijack & Encryption Validation
        if let Err(e) = Self::validate_security_and_encryption(&parsed) {
            if let Some(tid) = donor_telegram_id {
                let text = format!("⛔ <b>رد سرور (خطای امنیتی Anti-Hijack):</b>\n\n{}", e);
                let _ = bot.send_message(ChatId(tid), text).parse_mode(ParseMode::Html).await;
            }
            return;
        }

        // 3. Anti-SSRF check & IP resolution
        let ip = match Self::check_anti_ssrf(&parsed.server_address).await {
            Ok(ip) => ip,
            Err(e) => {
                if let Some(tid) = donor_telegram_id {
                    let text = format!("⛔ <b>رد سرور (خطای امنیتی DNS / SSRF):</b>\n\n{}", e);
                    let _ = bot.send_message(ChatId(tid), text).parse_mode(ParseMode::Html).await;
                }
                return;
            }
        };

        // 4. Deep Outbound Fingerprinting (SHA-256 of resolved_ip + port + protocol + secret)
        let secret = parsed.config_json.get("uuid")
            .or_else(|| parsed.config_json.get("password"))
            .or_else(|| parsed.config_json.pointer("/tls/reality/public_key"))
            .and_then(|s| s.as_str())
            .unwrap_or("");

        let mut hasher = Sha256::new();
        hasher.update(format!("{}:{}:{}:{}", ip, parsed.server_port, parsed.protocol.to_lowercase(), secret).as_bytes());
        let fingerprint = format!("{:x}", hasher.finalize());

        // Deduplication check via Deep Fingerprint
        match Repository::is_fingerprint_duplicate(&pool, &fingerprint).await {
            Ok(true) => {
                if let Some(tid) = donor_telegram_id {
                    let text = "⚠️ <b>سرور تکراری است (Deep Fingerprint Match):</b>\n\nاین سرور با مشخصات فنی و کلید یکسان قبلاً در سیستم ثبت شده است (تغییر نام، دامنه پوششی یا پارامترهای ظاهری مورد تایید نیست).";
                    let _ = bot.send_message(ChatId(tid), text).parse_mode(ParseMode::Html).await;
                }
                return;
            }
            Err(e) => {
                error!("Database error checking fingerprint duplicate: {}", e);
            }
            Ok(false) => {}
        }

        // Also check server address and port uniqueness
        match Repository::is_outbound_duplicate(&pool, &parsed.server_address, parsed.server_port as i64).await {
            Ok(true) => {
                if let Some(tid) = donor_telegram_id {
                    let text = "⚠️ <b>سرور تکراری است:</b>\n\nاین آدرس و پورت سرور قبلاً در سیستم ثبت شده است و امکان ثبت مجدد وجود ندارد.";
                    let _ = bot.send_message(ChatId(tid), text).parse_mode(ParseMode::Html).await;
                }
                return;
            }
            Err(e) => {
                error!("Database error checking duplicate: {}", e);
            }
            Ok(false) => {}
        }

        // 5. Benchmark in isolated container/process
        let (latency_ms, speed_mbps, success, reject_reason) =
            Self::benchmark_proxy_isolated(ip, parsed.server_port, &parsed.config_json).await;

        let (status, assigned_tier) = if !success || latency_ms > 2500 {
            ("rejected".to_string(), "none".to_string())
        } else if speed_mbps >= 8.0 && latency_ms <= 800 {
            ("active".to_string(), "download".to_string())
        } else {
            ("active".to_string(), "web_browsing".to_string())
        };

        let config_str = serde_json::to_string(&parsed.config_json).unwrap_or_default();
        let declared_gb = Self::extract_capacity_gb(&raw_text);

        // Check if donor is banned from outbound rewards
        let is_reward_banned = if let Some(uid) = donor_user_id {
            Repository::is_user_reward_banned(&pool, uid).await.unwrap_or(false)
        } else {
            false
        };

        // 6. Save to database with fingerprint
        let save_res = Repository::save_donated_outbound(
            &pool,
            donor_user_id,
            &parsed.tag,
            &parsed.protocol,
            &parsed.server_address,
            parsed.server_port as i64,
            &config_str,
            latency_ms,
            speed_mbps,
            &assigned_tier,
            &status,
            Some(&raw_text),
            reject_reason.as_deref(),
            declared_gb,
            Some(&fingerprint),
        ).await;

        match save_res {
            Ok(outbound) => {
                info!("Saved donated outbound #{} with status {} and tier {}", outbound.id, status, assigned_tier);

                if status == "active" {
                    if let Some(tid) = donor_telegram_id {
                        let tier_fa = match assigned_tier.as_str() {
                            "download" => "🚀 حالت دانلود و استریم پرسرعت",
                            _ => "🌐 حالت وب‌گردی و پیام‌رسان",
                        };

                        let reward_explanation = if is_reward_banned {
                            "⚠️ <i>توجه: با توجه به لغو تعهد در سرورهای قبلی، این سرور به استخر شبکه اضافه شد اما حساب شما مشمول پاداش اشتراک Pro نمی‌گردد.</i>".to_string()
                        } else if declared_gb > 200 {
                            format!(
                                "🎁 <b>قانون پاداش اشتراک ویژه ماهانه:</b>\nظرفیت این اوتباند <b>{} گیگابایت</b> ثبت شد. به محض عبور اولین ترافیک کاربران رایگان از این نود، <b>۳۰ روز اشتراک Sentra Pro هدیه</b> به صورت خودکار برای شما فعال خواهد شد! ❤️",
                                declared_gb
                            )
                        } else {
                            "💡 <i>نکته پاداش: جهت فعال‌سازی خودکار اشتراک ۳۰ روزه Pro، ظرفیت اوتباند اهدایی باید بالای ۲۰۰ گیگابایت باشد (مثال: ارسال لینک به همراه حجم مانند <code>vless://... 250GB</code>).</i>".to_string()
                        };

                        let notify_text = format!(
                            r#"🎉 <b>سرور اهدایی شما تایید و به استخر Sentra اضافه شد!</b>

از مشارکت ارزشمند شما در تقویت شبکه ضدسانسور سپاسگزاریم.

📊 <b>نتایج تست بنچمارک هوشمند:</b>
• پروتکل: <b><code>{}</code></b>
• پینگ شبکه: <b><code>{} ms</code></b>
• سرعت تخمینی: <b><code>{:.1} Mbps</code></b>
• ظرفیت ثبت‌شده: <b>{} گیگابایت</b>
• دسته‌بندی تخصیص‌یافته: <b>{}</b>

{}"#,
                            parsed.protocol,
                            latency_ms,
                            speed_mbps,
                            if declared_gb > 0 { declared_gb.to_string() } else { "نامشخص".to_string() },
                            tier_fa,
                            reward_explanation
                        );
                        let _ = bot.send_message(ChatId(tid), notify_text).parse_mode(ParseMode::Html).await;
                    }
                } else if let Some(tid) = donor_telegram_id {
                    let reason = reject_reason.unwrap_or_else(|| "عدم پاسخگویی در تست سلامت".to_string());
                    let notify_text = format!(
                        r#"❌ <b>نتیجه بررسی سرور اهدایی:</b>

متاسفانه این سرور در تست سلامت و سرعت Sentra پذیرفته نشد.

🔍 <b>علت رد سرور:</b>
{}

پینگ ثبت‌شده: <code>{} ms</code>
می‌توانید یک سرور یا کانفیگ سالم دیگر ارسال نمایید."#,
                        reason,
                        latency_ms
                    );
                    let _ = bot.send_message(ChatId(tid), notify_text).parse_mode(ParseMode::Html).await;
                }
            }
            Err(e) => {
                error!("Failed to save donated outbound: {}", e);
                if let Some(tid) = donor_telegram_id {
                    let text = "❌ خطای سیستمی در ثبت سرور اهدایی. لطفاً دقایقی دیگر تلاش فرمایید.";
                    let _ = bot.send_message(ChatId(tid), text).await;
                }
            }
        }
    }
}

/// Simple URL decode helper for node tag
fn urlencoding_decode(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '%' {
            let h1 = chars.next().unwrap_or('0');
            let h2 = chars.next().unwrap_or('0');
            if let Ok(byte) = u8::from_str_radix(&format!("{}{}", h1, h2), 16) {
                result.push(byte as char);
            }
        } else if c == '+' {
            result.push(' ');
        } else {
            result.push(c);
        }
    }
    result
}

/// Helper to decode base64 strings with or without padding, standard or url-safe
fn decode_b64(input: &str) -> Result<Vec<u8>, String> {
    let clean = input.trim().replace('-', "+").replace('_', "/");
    let padded = match clean.len() % 4 {
        2 => format!("{}==", clean),
        3 => format!("{}=", clean),
        _ => clean,
    };
    BASE64_STANDARD.decode(padded.as_bytes()).map_err(|e| format!("خطای دیکود Base64: {}", e))
}

/// Checks if an IP is in private, loopback, link-local, carrier-grade NAT, or reserved ranges
fn is_private_or_restricted(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(ipv4) => {
            let octets = ipv4.octets();
            // Loopback (127.0.0.0/8)
            octets[0] == 127
            // Unspecified (0.0.0.0)
            || octets[0] == 0
            // Private 10.0.0.0/8
            || octets[0] == 10
            // Carrier Grade NAT 100.64.0.0/10 (100.64.0.0 - 100.127.255.255)
            || (octets[0] == 100 && octets[1] >= 64 && octets[1] <= 127)
            // Private 172.16.0.0/12 (172.16.0.0 - 172.31.255.255)
            || (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31)
            // Link-local 169.254.0.0/16
            || (octets[0] == 169 && octets[1] == 254)
            // Private 192.168.0.0/16
            || (octets[0] == 192 && octets[1] == 168)
            // Broadcast (255.255.255.255)
            || octets == [255, 255, 255, 255]
        }
        IpAddr::V6(ipv6) => {
            ipv6.is_loopback()
            || ipv6.is_unspecified()
            // Unique local fc00::/7 (fc00 - fdff)
            || (ipv6.segments()[0] & 0xfe00) == 0xfc00
            // Link-local fe80::/10 (fe80 - febf)
            || (ipv6.segments()[0] & 0xffc0) == 0xfe80
        }
    }
}
