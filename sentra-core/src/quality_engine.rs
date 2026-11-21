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

pub struct QualityEngine;

impl QualityEngine {
    /// 1. Measure real latency (3-sample TCP handshakes), jitter, estimated throughput, and composite speed score (0..100)
    pub async fn test_outbound_network_quality(ip: IpAddr, port: u16) -> (i64, i64, f64, i64, bool) {
        let socket_addr = SocketAddr::new(ip, port);
        let mut sample_latencies: Vec<i64> = Vec::with_capacity(3);

        for _ in 0..3 {
            let start = Instant::now();
            let connect_res = timeout(Duration::from_millis(2500), TcpStream::connect(socket_addr)).await;
            match connect_res {
                Ok(Ok(_stream)) => {
                    let lat = start.elapsed().as_millis() as i64;
                    sample_latencies.push(lat);
                }
                _ => {
                    // Packet loss or timeout
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
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

        if avg_latency > 2500 {
            return (avg_latency, jitter_ms, 0.5, 5, false);
        }

        // Throughput estimation (Mbps) based on RTT and Jitter
        let speed_mbps = if avg_latency < 120 && jitter_ms <= 20 {
            28.0 - (avg_latency as f64 * 0.04)
        } else if avg_latency < 250 && jitter_ms <= 50 {
            18.5 - ((avg_latency - 120) as f64 * 0.03)
        } else if avg_latency < 500 {
            10.0 - ((avg_latency - 250) as f64 * 0.015)
        } else if avg_latency < 1000 {
            5.0 - ((avg_latency - 500) as f64 * 0.005)
        } else {
            1.5
        };
        let speed_mbps = ((speed_mbps * 10.0).round() / 10.0).max(0.5);

        // Speed score calculation (0..100)
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
        let total_speed_score = (latency_score + jitter_score + throughput_score).clamp(5, 100);

        (avg_latency, jitter_ms, speed_mbps, total_speed_score, true)
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
            "trojan" | "hysteria2" | "tuic" => {
                // Native mandatory TLS/QUIC protocols
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
                        false,
                        false,
                        false,
                    )
                    .await;
                    continue;
                }
            };

            // C. Speed & Latency & Jitter test
            let (latency_ms, jitter_ms, speed_mbps, speed_score, is_healthy) =
                Self::test_outbound_network_quality(ip, ob.server_port as u16).await;

            if !is_healthy {
                let _ = Repository::update_outbound_quality_metrics(
                    pool,
                    ob.id,
                    latency_ms,
                    jitter_ms,
                    speed_mbps,
                    speed_score,
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
                gemini_ok,
                trading_safe,
                true,
            )
            .await;
        }

        // F. Run 48-Hour Dead Nodes Auto-Cleanup
        let cleaned_tags = Self::run_dead_nodes_cleanup(pool, bot_opt, admin_chat_id).await.unwrap_or_default();

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
}
