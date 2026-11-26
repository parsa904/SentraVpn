mod anomaly_detector;
mod api;
mod bot;
mod compiler;
mod config;
mod db;
mod error;
mod models;
pub mod outbound_analyzer;
pub mod quality_engine;
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

    // 5c. Spawn periodic Quality, Security & Auto-Ranking Engine (every 15 minutes)
    // Runs jitter benchmark, Gemini/Trading readiness test, 48-hour dead nodes cleanup, clawback, and bridge auto-sync
    quality_engine::QualityEngine::start_quality_engine_worker(
        pool.clone(),
        bot_for_api.clone(),
        config.admin_chat_id,
    );

    let app = api::create_router(
        pool,
        anomaly_detector,
        bot_for_api,
        config.admin_chat_id,
        config.host.clone(),
        config.bot_username.clone(),
    );

    // 6. Bind TCP listener on configured address (port 8080)
    let addr: SocketAddr = format!("{}:{}", config.host, config.port).parse()?;
    let listener = TcpListener::bind(addr).await?;
    info!("🚀 Sentra Core REST API running on http://{}", addr);
    info!("👉 Auth Code Login:       POST http://{}/api/v1/auth/code-login", addr);
    info!("👉 Client Bootstrap:      GET  http://{}/api/v1/client/bootstrap", addr);
    info!("👉 Client Dynamic Config: POST http://{}/api/v1/client/config", addr);
    info!("👉 Donate Outbound:       POST http://{}/api/v1/client/outbounds/donate", addr);
    info!("👉 V2Ray/Sing-box Sub:    GET  http://{}/api/v1/sub/{{token}}", addr);
    info!("👉 System Health:         GET  http://{}/health", addr);

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
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
