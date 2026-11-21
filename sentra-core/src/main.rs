mod anomaly_detector;
mod api;
mod bot;
pub mod bridge_sync;
mod compiler;
mod config;
mod db;
mod error;
mod models;
pub mod outbound_analyzer;
pub mod warp_gen;

use config::Config;
use std::net::SocketAddr;
use tokio::net::TcpListener;
use tracing::info;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 1. Initialize structured tracing logger
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,sentra_core=debug".into()),
        )
        .init();

    info!("===============================================================");
    info!("   Starting Sentra Platform Core Backend & Telegram Bot Daemon ");
    info!("===============================================================");

    // 2. Load environment settings (.env with dotenvy)
    let config = Config::from_env();
    info!("Loaded configuration. Listening on {}:{}", config.host, config.port);

    // 3. Connect to SQLite and execute auto-migrations + default seed
    let pool = db::init_pool(&config.database_url).await?;
    db::run_migrations_and_seed(&pool).await?;

    // Synchronize sing-box server bridge configuration on startup
    if let Err(e) = bridge_sync::sync_server_bridge_config(&pool).await {
        tracing::warn!("Startup bridge sync warning: {:?}", e);
    }

    // 4. Spawn Telegram Bot in parallel Long-Polling mode (with proxy support)
    let bot_pool = pool.clone();
    let bot_token = config.teloxide_token.clone();
    let bot_proxy = config.teloxide_proxy.clone();
    let admin_chat_id = config.admin_chat_id;
    let base_url = config.base_url.clone();
    let pro_price = config.pro_subscription_price;

    tokio::spawn(async move {
        bot::run_telegram_bot(bot_token, bot_proxy, bot_pool, admin_chat_id, base_url, pro_price).await;
    });

    // 5. Initialize Anomaly Detector and build Axum REST API router
    let anomaly_detector = anomaly_detector::AnomalyDetector::new();
    let bot_for_api = match &config.teloxide_token {
        Some(t) if !t.trim().is_empty() && !t.contains("SAMPLE") => Some(teloxide::Bot::new(t)),
        _ => None,
    };

    // 6. Spawn 12-hour SQLite Hot Backup Task to Admin Telegram
    let backup_pool = pool.clone();
    let backup_bot = bot_for_api.clone();
    let backup_admin_chat_id = config.admin_chat_id;
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(12 * 3600));
        // First tick completes immediately, wait for the first 12-hour period
        interval.tick().await;

        loop {
            interval.tick().await;
            tracing::info!("Starting scheduled 12-hour SQLite database hot backup...");
            let backup_filename = "sentra_backup.db";
            if std::path::Path::new(backup_filename).exists() {
                let _ = tokio::fs::remove_file(backup_filename).await;
            }

            match sqlx::query("VACUUM INTO 'sentra_backup.db'").execute(&backup_pool).await {
                Ok(_) => {
                    tracing::info!("SQLite VACUUM INTO completed successfully.");
                    match tokio::fs::read(backup_filename).await {
                        Ok(data) => {
                            let _ = tokio::fs::remove_file(backup_filename).await;
                            if let Some(bot) = &backup_bot {
                                if backup_admin_chat_id != 0 {
                                    use teloxide::prelude::*;
                                    use teloxide::types::{ChatId, InputFile, ParseMode};
                                    let now_tehran = chrono::Utc::now().with_timezone(&chrono_tz::Asia::Tehran);
                                    let file_size_kb = data.len() / 1024;
                                    let filename = format!("sentra_backup_{}.db", now_tehran.format("%Y%m%d_%H%M%S"));
                                    let input_file = InputFile::memory(data).file_name(filename);
                                    let caption = format!(
                                        "📦 <b>پشتیبان‌گیری خودکار دیتابیس Sentra</b>\n\n⏰ تاریخ و ساعت (ایران): <code>{}</code>\n📊 حجم فایل: <code>{} KB</code>\n🔒 وضعیت: سالم و بدون قفل (VACUUM)",
                                        now_tehran.format("%Y-%m-%d %H:%M:%S"),
                                        file_size_kb
                                    );
                                    if let Err(e) = bot
                                        .send_document(ChatId(backup_admin_chat_id), input_file)
                                        .caption(caption)
                                        .parse_mode(ParseMode::Html)
                                        .await
                                    {
                                        tracing::error!("Failed to send database backup to Telegram admin: {:?}", e);
                                    } else {
                                        tracing::info!("Sentra database backup successfully sent to Telegram admin.");
                                    }
                                }
                            }
                        }
                        Err(e) => {
                            tracing::error!("Failed to read backup database file: {:?}", e);
                        }
                    }
                }
                Err(e) => {
                    tracing::error!("Failed to execute SQLite VACUUM INTO: {:?}", e);
                }
            }
        }
    });

    // 5c. Spawn periodic Donated Outbounds Health Monitor (every 30 minutes) & 7-Day Clawback Enforcer
    let health_monitor_pool = pool.clone();
    let health_bot = bot_for_api.clone();
    let health_admin_id = config.admin_chat_id;
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(1800)); // 30 minutes
        // Skip first immediate tick so system can boot fast
        interval.tick().await;

        loop {
            interval.tick().await;
            tracing::info!("Running periodic health check on active donated outbounds...");

            match db::Repository::get_all_active_donated_outbounds(&health_monitor_pool).await {
                Ok(outbounds) => {
                    let total = outbounds.len();
                    for ob in outbounds {
                        let ip_res = outbound_analyzer::OutboundAnalyzer::check_anti_ssrf(&ob.server_address).await;
                        match ip_res {
                            Ok(ip) => {
                                let (latency_ms, _speed, success, _err) =
                                    outbound_analyzer::OutboundAnalyzer::benchmark_proxy(ip, ob.server_port as u16).await;
                                let is_healthy = success && latency_ms <= 2500;
                                let _ = db::Repository::update_donated_outbound_health(
                                    &health_monitor_pool,
                                    ob.id,
                                    latency_ms,
                                    is_healthy,
                                )
                                .await;
                            }
                            Err(_) => {
                                // DNS or SSRF failed -> mark failed
                                let _ = db::Repository::update_donated_outbound_health(
                                    &health_monitor_pool,
                                    ob.id,
                                    9999,
                                    false,
                                )
                                .await;
                            }
                        }
                    }
                    tracing::info!("Completed periodic health check for {} donated outbounds.", total);
                }
                Err(e) => {
                    tracing::error!("Failed to load donated outbounds for health check: {:?}", e);
                }
            }

            // Clawback Enforcer: Check rewarded outbounds for <7 day offline violation
            if let Ok(candidates) = db::Repository::get_rewarded_donated_outbounds_for_clawback(&health_monitor_pool).await {
                let now = chrono::Utc::now();
                for ob in candidates {
                    if let Some(first_used) = ob.first_used_at {
                        let days_since_first_used = now.signed_duration_since(first_used).num_days();
                        if days_since_first_used < 7 {
                            if let Some(off_since) = ob.offline_since {
                                let offline_hours = now.signed_duration_since(off_since).num_hours();
                                let donor_uid = ob.donor_user_id.unwrap_or(0);

                                if offline_hours >= 2 {
                                    tracing::warn!("Executing clawback for outbound #{} (donor user #{}) - offline >2h within 7 days.", ob.id, donor_uid);
                                    let _ = db::Repository::execute_outbound_clawback(&health_monitor_pool, ob.id, donor_uid).await;

                                    if let Some(bot) = &health_bot {
                                        if let Ok(Some(donor)) = db::Repository::get_user_by_id(&health_monitor_pool, donor_uid).await {
                                            if let Some(tid) = donor.telegram_id {
                                                use teloxide::prelude::*;
                                                use teloxide::types::{ChatId, ParseMode};
                                                let msg = format!(
                                                    r#"⚠️ <b>ابطال اشتراک هدیه (قانون پایداری ۷ روزه اوتباند):</b>

سرور اهدایی شما با برچسب <code>{}</code> در کمتر از ۷ روز پس از ورود به چرخه مصرف، بیش از ۲ ساعت از دسترس خارج شد و جایگزین نگردید.

🚫 <b>اقدامات انجام‌شده:</b>
• اشتراک ویژه Sentra Pro هدیه داده‌شده لغو و حساب شما به پلن <b>Sentra Lite</b> بازگردانده شد.
• این نود به دلیل عدم پایداری از استخر شبکه Sentra حذف گردید.
• حساب شما از دریافت پاداش‌های بعدی اوتباند محروم شد."#,
                                                    ob.tag
                                                );
                                                let _ = bot.send_message(ChatId(tid), msg).parse_mode(ParseMode::Html).await;
                                            }
                                        }

                                        if health_admin_id != 0 {
                                            use teloxide::prelude::*;
                                            use teloxide::types::{ChatId, ParseMode};
                                            let admin_alert = format!(
                                                "🚨 <b>گزارش ابطال پاداش اوتباند (Clawback):</b>\n\nنود شماره <code>#{}</code> متعلق به کاربر <code>#{}</code> به دلیل خاموشی زودهنگام (<۷ روز) لغو و اشتراک Pro بازپس گرفته شد.",
                                                ob.id, donor_uid
                                            );
                                            let _ = bot.send_message(ChatId(health_admin_id), admin_alert).parse_mode(ParseMode::Html).await;
                                        }
                                    }
                                } else {
                                    // Offline < 2 hours -> Send 2-hour grace period warning
                                    if let Some(bot) = &health_bot {
                                        if let Ok(Some(donor)) = db::Repository::get_user_by_id(&health_monitor_pool, donor_uid).await {
                                            if let Some(tid) = donor.telegram_id {
                                                use teloxide::prelude::*;
                                                use teloxide::types::{ChatId, ParseMode};
                                                let warn_msg = format!(
                                                    r#"⚠️ <b>هشدار اختلال در سرور اهدایی شما:</b>

سرور اهدایی شما (<code>{}</code>) در مانیتورینگ شبکه Sentra از دسترس خارج شده است.

⏰ <b>مهلت رفع اشکال:</b>
طبق قوانین پایداری ۷ روزه، شما حداکثر <b>۲ ساعت</b> فرصت دارید تا سرور خود را آنلاین کنید؛ در غیر این صورت اشتراک Pro هدیه لغو خواهد گردید."#,
                                                    ob.tag
                                                );
                                                let _ = bot.send_message(ChatId(tid), warn_msg).parse_mode(ParseMode::Html).await;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    });

    let app = api::create_router(pool, anomaly_detector, bot_for_api, config.admin_chat_id, config.host.clone());

    // 6. Bind TCP listener on configured address (port 8080)
    let addr: SocketAddr = format!("{}:{}", config.host, config.port).parse()?;
    let listener = TcpListener::bind(addr).await?;
    info!("🚀 Sentra Core REST API running on http://{}", addr);
    info!("👉 Auth Code Login:     POST http://{}/api/v1/auth/code-login", addr);
    info!("👉 Client Dynamic Config: POST http://{}/api/v1/client/config", addr);
    info!("👉 V2Ray/Sing-box Sub:    GET  http://{}/api/v1/sub/{{token}}", addr);
    info!("👉 System Health:         GET  http://{}/health", addr);

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    info!("Sentra Core server shutdown gracefully.");
    Ok(())
}

async fn shutdown_signal() {
    tokio::signal::ctrl_c()
        .await
        .expect("Failed to install Ctrl+C signal handler");
    info!("Termination signal received. Shutting down Sentra Core cleanly...");
}
