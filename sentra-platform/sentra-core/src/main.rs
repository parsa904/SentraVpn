mod api;
mod bot;
mod compiler;
mod config;
mod db;
mod error;
mod models;

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

    tokio::spawn(async move {
        bot::run_telegram_bot(bot_token, bot_proxy, bot_pool, admin_chat_id, base_url).await;
    });

    // 5. Build Axum REST API router
    let app = api::create_router(pool);

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
