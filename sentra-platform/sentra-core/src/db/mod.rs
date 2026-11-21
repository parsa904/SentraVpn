pub mod models;
pub mod repository;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Pool, Sqlite};
use std::str::FromStr;
use tracing::info;

pub type DbPool = Pool<Sqlite>;

pub async fn init_pool(database_url: &str) -> anyhow::Result<DbPool> {
    let connection_options = SqliteConnectOptions::from_str(database_url)?
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .foreign_keys(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(10)
        .connect_with(connection_options)
        .await?;

    info!("SQLite database connection established successfully.");
    Ok(pool)
}

pub async fn run_migrations_and_seed(pool: &DbPool) -> anyhow::Result<()> {
    info!("Running auto-migrations on SQLite database...");

    // Create USERS table
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS users (
            id                      INTEGER PRIMARY KEY AUTOINCREMENT,
            telegram_id             BIGINT NOT NULL UNIQUE,
            username                TEXT,
            first_name              TEXT NOT NULL,
            last_name               TEXT,
            role                    TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user', 'admin', 'reseller')),
            status                  TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'suspended', 'banned')),
            auth_code               TEXT,
            auth_code_expires_at    DATETIME,
            created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);
        CREATE INDEX IF NOT EXISTS idx_users_auth_code ON users(auth_code);
        "#,
    )
    .execute(pool)
    .await?;

    // Create SUBSCRIPTIONS table
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS subscriptions (
            id                      INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id                 INTEGER NOT NULL,
            tier                    TEXT NOT NULL CHECK(tier IN ('Sentra Lite', 'Sentra Pro', 'Sentra Flow+')),
            token                   TEXT NOT NULL UNIQUE,
            status                  TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'expired', 'depleted', 'disabled')),
            upload_bytes            BIGINT NOT NULL DEFAULT 0,
            download_bytes          BIGINT NOT NULL DEFAULT 0,
            traffic_limit_bytes     BIGINT NOT NULL,
            speed_limit_bps         INTEGER NOT NULL DEFAULT 0,
            max_concurrent_devices  INTEGER NOT NULL DEFAULT 1,
            starts_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            expires_at              DATETIME NOT NULL,
            created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_subscriptions_token ON subscriptions(token);
        CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
        "#,
    )
    .execute(pool)
    .await?;

    // Create OUTBOUNDS table
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS outbounds (
            id                      INTEGER PRIMARY KEY AUTOINCREMENT,
            tag                     TEXT NOT NULL,
            protocol                TEXT NOT NULL CHECK(protocol IN ('socks', 'http', 'vless', 'vmess', 'trojan', 'hysteria2', 'shadowsocks', 'openvpn', 'direct')),
            server_address          TEXT NOT NULL,
            server_port             INTEGER NOT NULL,
            uuid                    TEXT,
            password                TEXT,
            network_transport       TEXT NOT NULL DEFAULT 'tcp' CHECK(network_transport IN ('tcp', 'ws', 'grpc', 'httpupgrade', 'quic')),
            tls_enabled             INTEGER NOT NULL DEFAULT 0,
            tls_sni                 TEXT,
            reality_public_key      TEXT,
            reality_short_id        TEXT,
            min_tier                TEXT NOT NULL CHECK(min_tier IN ('Sentra Lite', 'Sentra Pro', 'Sentra Flow+')),
            mode_category           TEXT NOT NULL CHECK(mode_category IN ('Hydra', 'Shadow', 'Stealth', 'Pulse', 'Warp', 'Direct')),
            country_code            TEXT NOT NULL DEFAULT 'XX',
            is_active               INTEGER NOT NULL DEFAULT 1,
            weight                  INTEGER NOT NULL DEFAULT 1,
            created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_outbounds_mode ON outbounds(mode_category);
        CREATE INDEX IF NOT EXISTS idx_outbounds_min_tier ON outbounds(min_tier);
        CREATE INDEX IF NOT EXISTS idx_outbounds_is_active ON outbounds(is_active);
        "#,
    )
    .execute(pool)
    .await?;

    // Create DEVICE_SESSIONS table
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS device_sessions (
            id                      INTEGER PRIMARY KEY AUTOINCREMENT,
            subscription_id         INTEGER NOT NULL,
            device_identifier       TEXT NOT NULL,
            device_name             TEXT NOT NULL,
            os                      TEXT NOT NULL,
            client_version          TEXT NOT NULL,
            ip_address              TEXT NOT NULL,
            is_active               INTEGER NOT NULL DEFAULT 1,
            last_seen_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE,
            UNIQUE(subscription_id, device_identifier)
        );
        CREATE INDEX IF NOT EXISTS idx_device_sessions_sub_id ON device_sessions(subscription_id);
        "#,
    )
    .execute(pool)
    .await?;

    // Create TRAFFIC_LOGS table
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS traffic_logs (
            id                      INTEGER PRIMARY KEY AUTOINCREMENT,
            subscription_id         INTEGER NOT NULL,
            outbound_id             INTEGER,
            bytes_sent              BIGINT NOT NULL DEFAULT 0,
            bytes_received          BIGINT NOT NULL DEFAULT 0,
            recorded_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE,
            FOREIGN KEY (outbound_id) REFERENCES outbounds(id) ON DELETE SET NULL
        );
        "#,
    )
    .execute(pool)
    .await?;

    // Create SUPPORT_TICKETS table
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS support_tickets (
            id                      INTEGER PRIMARY KEY AUTOINCREMENT,
            ticket_number           TEXT NOT NULL UNIQUE,
            user_id                 INTEGER NOT NULL,
            subscription_id         INTEGER,
            category                TEXT NOT NULL DEFAULT 'connection' CHECK(category IN ('connection', 'billing', 'device_setup', 'performance', 'other')),
            subject                 TEXT NOT NULL,
            description             TEXT NOT NULL,
            priority                TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low', 'medium', 'high', 'urgent')),
            status                  TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'awaiting_user', 'investigating', 'resolved', 'closed')),
            created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE SET NULL
        );
        "#,
    )
    .execute(pool)
    .await?;

    info!("Database tables verified/created. Seeding default test outbounds...");

    // Seed 2 default test outbounds as required:
    // 1. A local sandbox loopback outbound ("Sentra Sandbox Loopback" on 127.0.0.1:10801)
    // 2. A test direct/warp outbound ("Sentra Test Direct/Warp" on 127.0.0.1:10804 or direct detour)
    let outbound_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM outbounds")
        .fetch_one(pool)
        .await?;

    if outbound_count == 0 {
        info!("Seeding initial sandbox outbounds for zero-cost local testing...");

        // Outbound 1: Local sandbox loopback outbound (SOCKS5 on 127.0.0.1:10801)
        sqlx::query(
            r#"
            INSERT INTO outbounds (id, tag, protocol, server_address, server_port, network_transport, tls_enabled, min_tier, mode_category, country_code, is_active)
            VALUES (1, 'Sentra Sandbox Loopback', 'socks', '127.0.0.1', 10801, 'tcp', 0, 'Sentra Lite', 'Hydra', 'US', 1)
            "#
        )
        .execute(pool)
        .await?;

        // Outbound 2: Test direct / warp outbound (on 127.0.0.1:10804 or direct sandbox)
        sqlx::query(
            r#"
            INSERT INTO outbounds (id, tag, protocol, server_address, server_port, network_transport, tls_enabled, min_tier, mode_category, country_code, is_active)
            VALUES (2, 'Sentra Test Direct/Warp', 'socks', '127.0.0.1', 10804, 'tcp', 0, 'Sentra Lite', 'Pulse', 'DE', 1)
            "#
        )
        .execute(pool)
        .await?;

        // Optional auxiliary modes for complete 4-mode coverage in development
        sqlx::query(
            r#"
            INSERT INTO outbounds (id, tag, protocol, server_address, server_port, network_transport, tls_enabled, min_tier, mode_category, country_code, is_active)
            VALUES 
            (3, 'Sentra Shadow Sandbox', 'socks', '127.0.0.1', 10802, 'tcp', 0, 'Sentra Pro', 'Shadow', 'NL', 1),
            (4, 'Sentra Stealth Sandbox', 'http', '127.0.0.1', 10803, 'tcp', 0, 'Sentra Flow+', 'Stealth', 'US', 1)
            "#
        )
        .execute(pool)
        .await?;
        
        info!("Successfully seeded test outbounds.");
    }

    // Seed default admin and test user if empty
    let user_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(pool)
        .await?;

    if user_count == 0 {
        info!("Seeding default developer and tester accounts...");
        // Test User 1: Lite User
        sqlx::query(
            r#"
            INSERT INTO users (id, telegram_id, username, first_name, last_name, role, status, auth_code)
            VALUES (1, 100000001, 'sentra_tester', 'Sandbox', 'Tester', 'user', 'active', '12345678')
            "#
        )
        .execute(pool)
        .await?;

        // Active subscription for Test User 1 (Sentra Lite, 10GB)
        sqlx::query(
            r#"
            INSERT INTO subscriptions (id, user_id, tier, token, status, upload_bytes, download_bytes, traffic_limit_bytes, speed_limit_bps, max_concurrent_devices, expires_at)
            VALUES (1, 1, 'Sentra Lite', 'token_lite_sandbox_001', 'active', 52428800, 1048576000, 10737418240, 10485760, 1, datetime('now', '+30 days'))
            "#
        )
        .execute(pool)
        .await?;

        // Test User 2: Pro User
        sqlx::query(
            r#"
            INSERT INTO users (id, telegram_id, username, first_name, last_name, role, status)
            VALUES (2, 100000002, 'pro_tester', 'Pro', 'Tester', 'user', 'active')
            "#
        )
        .execute(pool)
        .await?;

        sqlx::query(
            r#"
            INSERT INTO subscriptions (id, user_id, tier, token, status, upload_bytes, download_bytes, traffic_limit_bytes, speed_limit_bps, max_concurrent_devices, expires_at)
            VALUES (2, 2, 'Sentra Pro', 'token_pro_sandbox_002', 'active', 1073741824, 21474836480, 161061273600, 104857600, 3, datetime('now', '+90 days'))
            "#
        )
        .execute(pool)
        .await?;

        // Test User 3: Flow+ User
        sqlx::query(
            r#"
            INSERT INTO users (id, telegram_id, username, first_name, last_name, role, status)
            VALUES (3, 100000003, 'flow_tester', 'Flow', 'VIP', 'user', 'active')
            "#
        )
        .execute(pool)
        .await?;

        sqlx::query(
            r#"
            INSERT INTO subscriptions (id, user_id, tier, token, status, upload_bytes, download_bytes, traffic_limit_bytes, speed_limit_bps, max_concurrent_devices, expires_at)
            VALUES (3, 3, 'Sentra Flow+', 'token_flow_sandbox_003', 'active', 5368709120, 107374182400, 1099511627776, 0, 10, datetime('now', '+365 days'))
            "#
        )
        .execute(pool)
        .await?;

        info!("Seeded default users and test subscriptions.");
    }

    Ok(())
}
