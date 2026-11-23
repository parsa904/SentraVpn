mod extensions;

use crate::error::CoreError;
use sqlx::Row;
use crate::models::{
    AppRelease, ConnectionModeInfo, DonatedOutbound, Donation, Outbound, Subscription, User,
    UserDevice,
};
use argon2::{
    password_hash::{
        rand_core::OsRng,
        PasswordHash, PasswordHasher, PasswordVerifier, SaltString,
    },
    Argon2,
};
use chrono::{Duration, Utc};
use chrono_tz::Asia::Tehran;
use rand::Rng;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::{Pool, Sqlite};
use std::str::FromStr;
use tracing::info;
use uuid::Uuid;

pub type DbPool = Pool<Sqlite>;

#[derive(Debug, Clone)]
pub struct SystemHealthStats {
    pub total_users: i64,
    pub lite_users: i64,
    pub pro_users: i64,
    pub flow_users: i64,
    pub active_outbounds: i64,
    pub open_tickets: i64,
    pub wal_mode_active: bool,
}

pub async fn init_pool(database_url: &str) -> anyhow::Result<DbPool> {
    let connection_options = SqliteConnectOptions::from_str(database_url)?
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .foreign_keys(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(10)
        .connect_with(connection_options)
        .await?;

    info!("SQLite database connection established with WAL mode & foreign keys enabled.");
    Ok(pool)
}

pub async fn run_migrations_and_seed(pool: &DbPool) -> anyhow::Result<()> {
    info!("Executing auto-migrations based on SCHEMA_AND_API.md...");

    // 1. USERS table (Unified Account: user_uuid, optional telegram_id, username & password_hash)
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS users (
            id                      INTEGER PRIMARY KEY AUTOINCREMENT,
            user_uuid               TEXT NOT NULL UNIQUE,
            telegram_id             BIGINT UNIQUE,
            username                TEXT UNIQUE,
            password_hash           TEXT,
            first_name              TEXT NOT NULL DEFAULT 'User',
            last_name               TEXT,
            photo_url               TEXT,
            role                    TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user', 'admin', 'reseller')),
            status                  TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'suspended', 'banned')),
            auth_code               TEXT,
            auth_code_expires_at    DATETIME,
            link_code               TEXT,
            link_code_expires_at    DATETIME,
            created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_users_uuid ON users(user_uuid);
        CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);
        CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
        CREATE INDEX IF NOT EXISTS idx_users_auth_code ON users(auth_code);
        CREATE INDEX IF NOT EXISTS idx_users_link_code ON users(link_code);
        "#,
    )
    .execute(pool)
    .await?;

    // Safe migration: Add new columns if missing in existing database
    let _ = sqlx::query("ALTER TABLE users ADD COLUMN user_uuid TEXT DEFAULT ''").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE users ADD COLUMN password_hash TEXT").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE users ADD COLUMN link_code TEXT").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE users ADD COLUMN link_code_expires_at DATETIME").execute(pool).await;

    // Backfill any empty user_uuid with valid UUIDs
    let empty_uuid_rows: Vec<(i64, Option<String>)> = sqlx::query_as(
        "SELECT id, user_uuid FROM users WHERE user_uuid IS NULL OR user_uuid = ''"
    )
    .fetch_all(pool)
    .await
    .unwrap_or_default();

    for (uid, _) in empty_uuid_rows {
        let new_uuid = uuid::Uuid::new_v4().to_string();
        let _ = sqlx::query("UPDATE users SET user_uuid = ? WHERE id = ?")
            .bind(new_uuid)
            .bind(uid)
            .execute(pool)
            .await;
    }

    // Check if telegram_id in users table has NOT NULL constraint from legacy schema
    #[derive(sqlx::FromRow)]
    struct ColInfo {
        name: String,
        notnull: i64,
    }
    let cols: Vec<ColInfo> = sqlx::query_as("PRAGMA table_info(users)")
        .fetch_all(pool)
        .await
        .unwrap_or_default();

    if cols.iter().any(|c| c.name == "telegram_id" && c.notnull == 1) {
        info!("Migrating legacy users table to allow nullable telegram_id for standalone app registration...");
        let _ = sqlx::query(
            r#"
            PRAGMA foreign_keys=OFF;
            CREATE TABLE IF NOT EXISTS users_migration_temp (
                id                      INTEGER PRIMARY KEY AUTOINCREMENT,
                user_uuid               TEXT NOT NULL UNIQUE,
                telegram_id             BIGINT UNIQUE,
                username                TEXT UNIQUE,
                password_hash           TEXT,
                first_name              TEXT NOT NULL DEFAULT 'User',
                last_name               TEXT,
                photo_url               TEXT,
                role                    TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user', 'admin', 'reseller')),
                status                  TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'suspended', 'banned')),
                auth_code               TEXT,
                auth_code_expires_at    DATETIME,
                link_code               TEXT,
                link_code_expires_at    DATETIME,
                outbound_reward_banned  INTEGER NOT NULL DEFAULT 0,
                created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            INSERT INTO users_migration_temp (id, user_uuid, telegram_id, username, password_hash, first_name, last_name, photo_url, role, status, auth_code, auth_code_expires_at, link_code, link_code_expires_at, outbound_reward_banned, created_at, updated_at)
            SELECT id, COALESCE(NULLIF(user_uuid, ''), lower(hex(randomblob(16)))), telegram_id, username, password_hash, first_name, last_name, photo_url, role, status, auth_code, auth_code_expires_at, link_code, link_code_expires_at, 0, created_at, updated_at FROM users;
            DROP TABLE users;
            ALTER TABLE users_migration_temp RENAME TO users;
            CREATE INDEX IF NOT EXISTS idx_users_uuid ON users(user_uuid);
            CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);
            CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
            CREATE INDEX IF NOT EXISTS idx_users_auth_code ON users(auth_code);
            CREATE INDEX IF NOT EXISTS idx_users_link_code ON users(link_code);
            PRAGMA foreign_keys=ON;
            "#
        )
        .execute(pool)
        .await;
    }

    // 2. SUBSCRIPTIONS table
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS subscriptions (
            id                      INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id                 INTEGER NOT NULL,
            tier                    TEXT NOT NULL CHECK(tier IN ('Sentra Lite', 'Sentra Pro', 'Sentra Flow+')),
            token                   TEXT NOT NULL UNIQUE,
            status                  TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'expired', 'depleted', 'disabled', 'suspended')),
            upload_bytes            BIGINT NOT NULL DEFAULT 0,
            download_bytes          BIGINT NOT NULL DEFAULT 0,
            traffic_limit_bytes     BIGINT NOT NULL,
            speed_limit_bps         INTEGER NOT NULL DEFAULT 0,
            max_concurrent_devices  INTEGER NOT NULL DEFAULT 1,
            web_browsing_used_mb    BIGINT NOT NULL DEFAULT 0,
            download_used_mb        BIGINT NOT NULL DEFAULT 0,
            static_ip_used_mb       BIGINT NOT NULL DEFAULT 0,
            gaming_used_mb          INTEGER NOT NULL DEFAULT 0,
            last_quota_reset        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            starts_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            expires_at              DATETIME NOT NULL,
            created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_subscriptions_token ON subscriptions(token);
        CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
        CREATE INDEX IF NOT EXISTS idx_subscriptions_tier ON subscriptions(tier);
        "#,
    )
    .execute(pool)
    .await?;

    // Safe migration: Add daily and mode quota columns if missing in existing database
    let _ = sqlx::query("ALTER TABLE subscriptions ADD COLUMN web_browsing_used_mb BIGINT NOT NULL DEFAULT 0")
        .execute(pool)
        .await;
    let _ = sqlx::query("ALTER TABLE subscriptions ADD COLUMN download_used_mb BIGINT NOT NULL DEFAULT 0")
        .execute(pool)
        .await;
    let _ = sqlx::query("ALTER TABLE subscriptions ADD COLUMN static_ip_used_mb BIGINT NOT NULL DEFAULT 0")
        .execute(pool)
        .await;
    let _ = sqlx::query("ALTER TABLE subscriptions ADD COLUMN gaming_used_mb INTEGER NOT NULL DEFAULT 0")
        .execute(pool)
        .await;
    let _ = sqlx::query("ALTER TABLE subscriptions ADD COLUMN last_quota_reset DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP")
        .execute(pool)
        .await;

    // 3. OUTBOUNDS table
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
            mode_category           TEXT NOT NULL,
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

    // 4. DEVICE_SESSIONS table
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

    // 5. TRAFFIC_LOGS table
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
        CREATE INDEX IF NOT EXISTS idx_traffic_logs_sub ON traffic_logs(subscription_id);
        "#,
    )
    .execute(pool)
    .await?;

    // 6. SUPPORT_TICKETS table
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
        CREATE INDEX IF NOT EXISTS idx_tickets_user_id ON support_tickets(user_id);
        CREATE INDEX IF NOT EXISTS idx_tickets_status ON support_tickets(status);

        -- 7. USER_DEVICES table (Max 3 Devices Enforcement)
        CREATE TABLE IF NOT EXISTS user_devices (
            id                      INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id                 INTEGER NOT NULL,
            subscription_id         INTEGER NOT NULL,
            device_id               TEXT NOT NULL,
            device_name             TEXT NOT NULL,
            platform                TEXT NOT NULL,
            last_active_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE,
            UNIQUE(user_id, device_id)
        );
        CREATE INDEX IF NOT EXISTS idx_user_devices_user ON user_devices(user_id);
        CREATE INDEX IF NOT EXISTS idx_user_devices_sub ON user_devices(subscription_id);
        "#,
    )
    .execute(pool)
    .await?;

    // 7. DONATED_OUTBOUNDS table (Community Outbound Donation & Real Benchmark & Official Outbounds)
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS donated_outbounds (
            id                      INTEGER PRIMARY KEY AUTOINCREMENT,
            donor_user_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
            tag                     TEXT NOT NULL,
            protocol                TEXT NOT NULL,
            server_address          TEXT NOT NULL,
            server_port             INTEGER NOT NULL,
            config_json             TEXT NOT NULL,
            latency_ms              INTEGER NOT NULL DEFAULT 9999,
            speed_mbps              REAL NOT NULL DEFAULT 0.0,
            assigned_tier           TEXT NOT NULL CHECK(assigned_tier IN ('web_browsing', 'download', 'static_ip', 'gaming', 'rejected')),
            health_score            INTEGER NOT NULL DEFAULT 100,
            status                  TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('pending', 'active', 'inactive', 'rejected', 'degraded')),
            fail_count              INTEGER NOT NULL DEFAULT 0,
            reward_granted          INTEGER NOT NULL DEFAULT 0,
            raw_link                TEXT,
            rejection_reason        TEXT,
            declared_or_detected_gb BIGINT NOT NULL DEFAULT 0,
            bytes_served            BIGINT NOT NULL DEFAULT 0,
            first_used_at           DATETIME,
            monthly_reward_granted  INTEGER NOT NULL DEFAULT 0,
            is_official             INTEGER NOT NULL DEFAULT 0,
            label                   TEXT,
            country_code            TEXT NOT NULL DEFAULT 'XX',
            country_name            TEXT NOT NULL DEFAULT 'Unknown',
            last_checked_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            allow_web               INTEGER NOT NULL DEFAULT 1,
            allow_download          INTEGER NOT NULL DEFAULT 1,
            allow_static_ip         INTEGER NOT NULL DEFAULT 0,
            gemini_ok               INTEGER NOT NULL DEFAULT 0,
            trading_safe            INTEGER NOT NULL DEFAULT 0,
            speed_score             INTEGER NOT NULL DEFAULT 50,
            jitter_ms               INTEGER NOT NULL DEFAULT 0,
            last_online_at          DATETIME,
            allocation_mode         TEXT NOT NULL DEFAULT 'auto'
        );
        CREATE INDEX IF NOT EXISTS idx_donated_status ON donated_outbounds(status);
        CREATE INDEX IF NOT EXISTS idx_donated_assigned_tier ON donated_outbounds(assigned_tier);
        CREATE INDEX IF NOT EXISTS idx_donated_server ON donated_outbounds(server_address, server_port);
        CREATE INDEX IF NOT EXISTS idx_donated_is_official ON donated_outbounds(is_official);
        CREATE INDEX IF NOT EXISTS idx_donated_speed_score ON donated_outbounds(speed_score);
        CREATE INDEX IF NOT EXISTS idx_donated_allow_static ON donated_outbounds(allow_static_ip);
        CREATE INDEX IF NOT EXISTS idx_donated_allow_web ON donated_outbounds(allow_web);
        CREATE INDEX IF NOT EXISTS idx_donated_allow_dl ON donated_outbounds(allow_download);
        "#,
    )
    .execute(pool)
    .await?;

    // Safe column migrations for users
    let _ = sqlx::query("ALTER TABLE users ADD COLUMN outbound_reward_banned INTEGER NOT NULL DEFAULT 0").execute(pool).await;

    // Safe column migrations for existing donated_outbounds schema
    let _ = sqlx::query("ALTER TABLE donated_outbounds ADD COLUMN declared_or_detected_gb BIGINT NOT NULL DEFAULT 0").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE donated_outbounds ADD COLUMN bytes_served BIGINT NOT NULL DEFAULT 0").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE donated_outbounds ADD COLUMN first_used_at DATETIME").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE donated_outbounds ADD COLUMN monthly_reward_granted INTEGER NOT NULL DEFAULT 0").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE donated_outbounds ADD COLUMN fingerprint_sha256 TEXT").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE donated_outbounds ADD COLUMN offline_since DATETIME").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE donated_outbounds ADD COLUMN clawback_executed INTEGER NOT NULL DEFAULT 0").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE donated_outbounds ADD COLUMN is_official INTEGER NOT NULL DEFAULT 0").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE donated_outbounds ADD COLUMN label TEXT").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE donated_outbounds ADD COLUMN country_code TEXT NOT NULL DEFAULT 'XX'").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE donated_outbounds ADD COLUMN country_name TEXT NOT NULL DEFAULT 'Unknown'").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE outbounds ADD COLUMN country_name TEXT NOT NULL DEFAULT 'Unknown'").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE donated_outbounds ADD COLUMN allow_web INTEGER NOT NULL DEFAULT 1").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE donated_outbounds ADD COLUMN allow_download INTEGER NOT NULL DEFAULT 1").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE donated_outbounds ADD COLUMN allow_static_ip INTEGER NOT NULL DEFAULT 0").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE donated_outbounds ADD COLUMN gemini_ok INTEGER NOT NULL DEFAULT 0").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE donated_outbounds ADD COLUMN trading_safe INTEGER NOT NULL DEFAULT 0").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE donated_outbounds ADD COLUMN speed_score INTEGER NOT NULL DEFAULT 50").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE donated_outbounds ADD COLUMN jitter_ms INTEGER NOT NULL DEFAULT 0").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE donated_outbounds ADD COLUMN last_online_at DATETIME").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE donated_outbounds ADD COLUMN allocation_mode TEXT NOT NULL DEFAULT 'auto'").execute(pool).await;
    let _ = sqlx::query("CREATE INDEX IF NOT EXISTS idx_donated_speed_score ON donated_outbounds(speed_score)").execute(pool).await;
    let _ = sqlx::query("CREATE INDEX IF NOT EXISTS idx_donated_allow_static ON donated_outbounds(allow_static_ip)").execute(pool).await;
    let _ = sqlx::query("CREATE INDEX IF NOT EXISTS idx_donated_allow_web ON donated_outbounds(allow_web)").execute(pool).await;
    let _ = sqlx::query("CREATE INDEX IF NOT EXISTS idx_donated_allow_dl ON donated_outbounds(allow_download)").execute(pool).await;
    let _ = sqlx::query("UPDATE donated_outbounds SET last_online_at = updated_at WHERE last_online_at IS NULL AND status = 'active'").execute(pool).await;
    let _ = sqlx::query("UPDATE donated_outbounds SET allow_static_ip = 1 WHERE assigned_tier = 'static_ip'").execute(pool).await;
    let _ = sqlx::query("UPDATE donated_outbounds SET allow_web = 1 WHERE assigned_tier IN ('web_browsing', 'static_ip')").execute(pool).await;
    let _ = sqlx::query("UPDATE donated_outbounds SET allow_download = 1 WHERE assigned_tier IN ('download', 'static_ip')").execute(pool).await;
    let _ = sqlx::query("CREATE INDEX IF NOT EXISTS idx_donated_is_official ON donated_outbounds(is_official)").execute(pool).await;
    let _ = sqlx::query("CREATE INDEX IF NOT EXISTS idx_donated_country_code ON donated_outbounds(country_code)").execute(pool).await;
    let _ = sqlx::query("CREATE UNIQUE INDEX IF NOT EXISTS idx_donated_fingerprint ON donated_outbounds(fingerprint_sha256)").execute(pool).await;

    // Outbound quality score migrations for dynamic quality ranking
    let _ = sqlx::query("ALTER TABLE donated_outbounds ADD COLUMN quality_score INTEGER NOT NULL DEFAULT 50").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE outbounds ADD COLUMN quality_score INTEGER NOT NULL DEFAULT 50").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE outbounds ADD COLUMN latency_ms INTEGER NOT NULL DEFAULT 9999").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE outbounds ADD COLUMN is_healthy INTEGER NOT NULL DEFAULT 1").execute(pool).await;
    let _ = sqlx::query("CREATE INDEX IF NOT EXISTS idx_donated_quality_score ON donated_outbounds(quality_score)").execute(pool).await;
    let _ = sqlx::query("CREATE INDEX IF NOT EXISTS idx_outbounds_quality_score ON outbounds(quality_score)").execute(pool).await;
    let _ = sqlx::query("UPDATE donated_outbounds SET quality_score = speed_score WHERE quality_score = 50 AND speed_score > 0").execute(pool).await;

    // Subscription sources table (Admin Sub URLs with periodic re-sync)
    let _ = sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS subscription_sources (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            category            TEXT NOT NULL,
            url                 TEXT NOT NULL UNIQUE,
            label               TEXT,
            node_count          INTEGER NOT NULL DEFAULT 0,
            healthy_count       INTEGER NOT NULL DEFAULT 0,
            last_synced_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        "#
    ).execute(pool).await;

    // Cloudflare WARP Accounts table
    let _ = sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS warp_accounts (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            private_key         TEXT NOT NULL,
            public_key          TEXT NOT NULL,
            address_v4          TEXT NOT NULL,
            address_v6          TEXT NOT NULL,
            reserved            TEXT NOT NULL,
            account_id          TEXT,
            token               TEXT,
            license_key         TEXT,
            account_type        TEXT NOT NULL DEFAULT 'free',
            is_active           INTEGER NOT NULL DEFAULT 1,
            created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_warp_accounts_is_active ON warp_accounts(is_active);
        "#
    ).execute(pool).await;

    // Add use_warp column to device_sessions
    let _ = sqlx::query("ALTER TABLE device_sessions ADD COLUMN use_warp INTEGER NOT NULL DEFAULT 0").execute(pool).await;

    // Check if existing donated_outbounds table includes static_ip in CHECK constraint
    let table_sql: Option<String> = sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE type='table' AND name='donated_outbounds'")
        .fetch_optional(pool)
        .await
        .unwrap_or(None);
    if let Some(sql) = table_sql {
        if !sql.contains("static_ip") {
            info!("Migrating donated_outbounds schema to support 'static_ip' for official outbounds...");
            let _ = sqlx::query(
                r#"
                PRAGMA foreign_keys=OFF;
                CREATE TABLE IF NOT EXISTS donated_outbounds_mig (
                    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
                    donor_user_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
                    tag                     TEXT NOT NULL,
                    protocol                TEXT NOT NULL,
                    server_address          TEXT NOT NULL,
                    server_port             INTEGER NOT NULL,
                    config_json             TEXT NOT NULL,
                    latency_ms              INTEGER NOT NULL DEFAULT 9999,
                    speed_mbps              REAL NOT NULL DEFAULT 0.0,
                    assigned_tier           TEXT NOT NULL CHECK(assigned_tier IN ('web_browsing', 'download', 'static_ip', 'gaming', 'rejected')),
                    health_score            INTEGER NOT NULL DEFAULT 100,
                    status                  TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('pending', 'active', 'inactive', 'rejected', 'degraded')),
                    fail_count              INTEGER NOT NULL DEFAULT 0,
                    reward_granted          INTEGER NOT NULL DEFAULT 0,
                    raw_link                TEXT,
                    rejection_reason        TEXT,
                    declared_or_detected_gb BIGINT NOT NULL DEFAULT 0,
                    bytes_served            BIGINT NOT NULL DEFAULT 0,
                    first_used_at           DATETIME,
                    monthly_reward_granted  INTEGER NOT NULL DEFAULT 0,
                    fingerprint_sha256      TEXT,
                    offline_since           DATETIME,
                    clawback_executed       INTEGER NOT NULL DEFAULT 0,
                    is_official             INTEGER NOT NULL DEFAULT 0,
                    label                   TEXT,
                    country_code            TEXT NOT NULL DEFAULT 'XX',
                    country_name            TEXT NOT NULL DEFAULT 'Unknown',
                    last_checked_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    allow_web               INTEGER NOT NULL DEFAULT 1,
                    allow_download          INTEGER NOT NULL DEFAULT 1,
                    allow_static_ip         INTEGER NOT NULL DEFAULT 0,
                    gemini_ok               INTEGER NOT NULL DEFAULT 0,
                    trading_safe            INTEGER NOT NULL DEFAULT 0,
                    speed_score             INTEGER NOT NULL DEFAULT 50,
                    jitter_ms               INTEGER NOT NULL DEFAULT 0,
                    last_online_at          DATETIME,
                    allocation_mode         TEXT NOT NULL DEFAULT 'auto'
                );
                INSERT INTO donated_outbounds_mig (
                    id, donor_user_id, tag, protocol, server_address, server_port, config_json, latency_ms, speed_mbps,
                    assigned_tier, health_score, status, fail_count, reward_granted, raw_link, rejection_reason,
                    declared_or_detected_gb, bytes_served, first_used_at, monthly_reward_granted, fingerprint_sha256,
                    offline_since, clawback_executed, is_official, label, country_code, country_name, last_checked_at, created_at, updated_at
                )
                SELECT 
                    id, donor_user_id, tag, protocol, server_address, server_port, config_json, latency_ms, speed_mbps,
                    assigned_tier, health_score, status, fail_count, reward_granted, raw_link, rejection_reason,
                    declared_or_detected_gb, bytes_served, first_used_at, monthly_reward_granted, fingerprint_sha256,
                    offline_since, clawback_executed, COALESCE(is_official, 0), label,
                    COALESCE(country_code, 'XX'), COALESCE(country_name, 'Unknown'), last_checked_at, created_at, updated_at
                FROM donated_outbounds;
                DROP TABLE donated_outbounds;
                ALTER TABLE donated_outbounds_mig RENAME TO donated_outbounds;
                CREATE INDEX IF NOT EXISTS idx_donated_status ON donated_outbounds(status);
                CREATE INDEX IF NOT EXISTS idx_donated_assigned_tier ON donated_outbounds(assigned_tier);
                CREATE INDEX IF NOT EXISTS idx_donated_server ON donated_outbounds(server_address, server_port);
                CREATE INDEX IF NOT EXISTS idx_donated_is_official ON donated_outbounds(is_official);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_donated_fingerprint ON donated_outbounds(fingerprint_sha256);
                PRAGMA foreign_keys=ON;
                "#
            )
            .execute(pool)
            .await;
        }
    }

    // 8. DONATIONS table (Financial Support & Reward Tracking)
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS donations (
            id                      INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id                 INTEGER NOT NULL,
            amount                  BIGINT NOT NULL,
            receipt_file_id         TEXT NOT NULL,
            file_unique_id          TEXT,
            image_sha256            TEXT,
            status                  TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
            subscription_granted    INTEGER NOT NULL DEFAULT 0,
            created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_donations_user_id ON donations(user_id);
        CREATE INDEX IF NOT EXISTS idx_donations_status ON donations(status);
        CREATE INDEX IF NOT EXISTS idx_donations_file_unique_id ON donations(file_unique_id);
        CREATE INDEX IF NOT EXISTS idx_donations_image_sha256 ON donations(image_sha256);
        "#,
    )
    .execute(pool)
    .await?;

    let _ = sqlx::query("ALTER TABLE donations ADD COLUMN file_unique_id TEXT").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE donations ADD COLUMN image_sha256 TEXT").execute(pool).await;
    let _ = sqlx::query("CREATE INDEX IF NOT EXISTS idx_donations_file_unique_id ON donations(file_unique_id)").execute(pool).await;
    let _ = sqlx::query("CREATE INDEX IF NOT EXISTS idx_donations_image_sha256 ON donations(image_sha256)").execute(pool).await;

    // 9. IP Registrations table for rate limiting (max 2 accounts per 24 hours per IP)
    let _ = sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS ip_registrations (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            ip          TEXT NOT NULL,
            created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_ip_registrations_lookup ON ip_registrations(ip, created_at);
        "#
    ).execute(pool).await;

    // 10. APP RELEASES table (Unified Client App Releases)
    let _ = sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS app_releases (
            id                  INTEGER PRIMARY KEY CHECK(id = 1),
            version             TEXT NOT NULL DEFAULT '1.0.0',
            changelog           TEXT NOT NULL DEFAULT '',
            windows_file_id     TEXT,
            windows_github_url  TEXT,
            android_file_id     TEXT,
            android_github_url  TEXT,
            updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        "#
    ).execute(pool).await;

    // Run extended migrations (users alter, unified app_releases migration, password_resets)
    extensions::run_extended_migrations(pool).await?;

    // Seed/Update 4 Connection Modes outbounds (web_browsing, download, static_ip, gaming)
    sqlx::query(
        r#"
        INSERT OR REPLACE INTO outbounds (id, tag, protocol, server_address, server_port, network_transport, tls_enabled, min_tier, mode_category, country_code, is_active)
        VALUES 
        (1, 'Sentra Web Browsing', 'http', '127.0.0.1', 10801, 'httpupgrade', 0, 'Sentra Lite', 'web_browsing', 'DE', 1),
        (2, 'Sentra Download', 'socks', '127.0.0.1', 10804, 'tcp', 0, 'Sentra Lite', 'download', 'FI', 1),
        (3, 'Sentra Static IP US', 'vless', '127.0.0.1', 10802, 'tcp', 1, 'Sentra Pro', 'static_ip', 'US', 1),
        (4, 'Sentra Gaming Node', 'socks', '127.0.0.1', 10803, 'quic', 0, 'Sentra Flow+', 'gaming', 'TR', 1)
        "#,
    )
    .execute(pool)
    .await?;

    info!("Database auto-migrations and 4-mode outbounds initialized successfully.");
    Ok(())
}

// ============================================================================
// Repository Methods
// ============================================================================

pub struct Repository;

impl Repository {
    pub async fn get_or_create_user(
        pool: &DbPool,
        telegram_id: i64,
        username: Option<&str>,
        first_name: &str,
        last_name: Option<&str>,
    ) -> Result<User, CoreError> {
        let existing = sqlx::query_as::<_, User>(
            "SELECT * FROM users WHERE telegram_id = ? LIMIT 1",
        )
        .bind(telegram_id)
        .fetch_optional(pool)
        .await?;

        if let Some(user) = existing {
            sqlx::query(
                "UPDATE users SET username = ?, first_name = ?, last_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            )
            .bind(username)
            .bind(first_name)
            .bind(last_name)
            .bind(user.id)
            .execute(pool)
            .await?;

            return Ok(user);
        }

        let user_uuid = Uuid::new_v4().to_string();
        let user = sqlx::query_as::<_, User>(
            r#"
            INSERT INTO users (user_uuid, telegram_id, username, first_name, last_name, role, status)
            VALUES (?, ?, ?, ?, ?, 'user', 'active')
            RETURNING *
            "#,
        )
        .bind(user_uuid)
        .bind(telegram_id)
        .bind(username)
        .bind(first_name)
        .bind(last_name)
        .fetch_one(pool)
        .await?;

        Self::create_or_ensure_lite_subscription(pool, user.id).await?;
        Ok(user)
    }

    pub async fn create_or_ensure_lite_subscription(
        pool: &DbPool,
        user_id: i64,
    ) -> Result<Subscription, CoreError> {
        let existing = sqlx::query_as::<_, Subscription>(
            "SELECT * FROM subscriptions WHERE user_id = ? LIMIT 1",
        )
        .bind(user_id)
        .fetch_optional(pool)
        .await?;

        if let Some(mut sub) = existing {
            Self::check_and_reset_daily_quota(pool, &mut sub).await?;
            return Ok(sub);
        }

        let token = format!("sentra_{}", Uuid::new_v4().simple());
        let expires_at = Utc::now() + Duration::days(30);
        let traffic_limit: i64 = 10_737_418_240; // 10 GB
        let speed_limit: i64 = 10_485_760; // 10 Mbps

        let sub = sqlx::query_as::<_, Subscription>(
            r#"
            INSERT INTO subscriptions (user_id, tier, token, status, upload_bytes, download_bytes, traffic_limit_bytes, speed_limit_bps, max_concurrent_devices, web_browsing_used_mb, download_used_mb, last_quota_reset, expires_at)
            VALUES (?, 'Sentra Lite', ?, 'active', 0, 0, ?, ?, 1, 0, 0, CURRENT_TIMESTAMP, ?)
            RETURNING *
            "#,
        )
        .bind(user_id)
        .bind(token)
        .bind(traffic_limit)
        .bind(speed_limit)
        .bind(expires_at)
        .fetch_one(pool)
        .await?;

        Ok(sub)
    }

    pub async fn upgrade_user_subscription(
        pool: &DbPool,
        user_id: i64,
        tier: &str,
    ) -> Result<Subscription, CoreError> {
        let (traffic_limit, speed_limit, devices, duration_days) = match tier {
            "Sentra Flow+" | "tier_flow" => (1_099_511_627_776i64, 0i64, 10i64, 365), // 1TB, Uncapped, 10 devices
            "Sentra Pro" | "tier_pro" => (161_061_273_600i64, 104_857_600i64, 3i64, 90), // 150GB, 100Mbps, 3 devices
            _ => (10_737_418_240i64, 10_485_760i64, 1i64, 30),
        };

        let formal_tier = match tier {
            "tier_flow" | "Sentra Flow+" => "Sentra Flow+",
            "tier_pro" | "Sentra Pro" => "Sentra Pro",
            _ => "Sentra Lite",
        };

        let expires_at = Utc::now() + Duration::days(duration_days);

        let existing = sqlx::query_as::<_, Subscription>(
            "SELECT * FROM subscriptions WHERE user_id = ? LIMIT 1",
        )
        .bind(user_id)
        .fetch_optional(pool)
        .await?;

        let sub = if let Some(sub) = existing {
            sqlx::query_as::<_, Subscription>(
                r#"
                UPDATE subscriptions
                SET tier = ?, status = 'active', traffic_limit_bytes = ?, speed_limit_bps = ?,
                    max_concurrent_devices = ?, expires_at = ?, static_ip_used_mb = 0, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                RETURNING *
                "#,
            )
            .bind(formal_tier)
            .bind(traffic_limit)
            .bind(speed_limit)
            .bind(devices)
            .bind(expires_at)
            .bind(sub.id)
            .fetch_one(pool)
            .await?
        } else {
            let token = format!("sentra_{}", Uuid::new_v4().simple());
            sqlx::query_as::<_, Subscription>(
                r#"
                INSERT INTO subscriptions (user_id, tier, token, status, upload_bytes, download_bytes, traffic_limit_bytes, speed_limit_bps, max_concurrent_devices, web_browsing_used_mb, download_used_mb, last_quota_reset, expires_at)
                VALUES (?, ?, ?, 'active', 0, 0, ?, ?, ?, 0, 0, CURRENT_TIMESTAMP, ?)
                RETURNING *
                "#,
            )
            .bind(user_id)
            .bind(formal_tier)
            .bind(token)
            .bind(traffic_limit)
            .bind(speed_limit)
            .bind(devices)
            .bind(expires_at)
            .fetch_one(pool)
            .await?
        };

        Ok(sub)
    }

    pub async fn get_subscription_by_token(
        pool: &DbPool,
        token: &str,
    ) -> Result<Subscription, CoreError> {
        let mut sub = sqlx::query_as::<_, Subscription>(
            "SELECT * FROM subscriptions WHERE token = ? LIMIT 1",
        )
        .bind(token)
        .fetch_optional(pool)
        .await?
        .ok_or(CoreError::SubscriptionNotFound)?;

        Self::check_and_reset_daily_quota(pool, &mut sub).await?;
        Ok(sub)
    }

    pub async fn get_subscription_by_user_id(
        pool: &DbPool,
        user_id: i64,
    ) -> Result<Option<Subscription>, CoreError> {
        let sub_opt = sqlx::query_as::<_, Subscription>(
            "SELECT * FROM subscriptions WHERE user_id = ? LIMIT 1",
        )
        .bind(user_id)
        .fetch_optional(pool)
        .await?;

        if let Some(mut sub) = sub_opt {
            Self::check_and_reset_daily_quota(pool, &mut sub).await?;
            return Ok(Some(sub));
        }

        Ok(None)
    }

    /// Automatically resets daily quota based strictly on Iran official date (Asia/Tehran midnight)
    pub async fn check_and_reset_daily_quota(
        pool: &DbPool,
        sub: &mut Subscription,
    ) -> Result<(), CoreError> {
        let now = Utc::now();
        let tehran_now = now.with_timezone(&Tehran);
        let tehran_last_reset = sub.last_quota_reset.with_timezone(&Tehran);

        if tehran_now.date_naive() > tehran_last_reset.date_naive() {
            sub.web_browsing_used_mb = 0;
            sub.download_used_mb = 0;
            sub.gaming_used_mb = 0;
            sub.last_quota_reset = now;

            sqlx::query(
                "UPDATE subscriptions SET web_browsing_used_mb = 0, download_used_mb = 0, gaming_used_mb = 0, last_quota_reset = CURRENT_TIMESTAMP WHERE id = ?",
            )
            .bind(sub.id)
            .execute(pool)
            .await?;

            tracing::info!(
                "Subscription #{} daily quota reset applied at Asia/Tehran date {:?}",
                sub.id,
                tehran_now.date_naive()
            );
        }
        Ok(())
    }

    /// Record mode traffic usage (simulated or heartbeat increment)
    #[allow(dead_code)]
    pub async fn record_mode_usage(
        pool: &DbPool,
        sub_id: i64,
        mode: &str,
        delta_mb: i64,
    ) -> Result<(), CoreError> {
        match mode {
            "web_browsing" => {
                sqlx::query("UPDATE subscriptions SET web_browsing_used_mb = web_browsing_used_mb + ? WHERE id = ?")
                    .bind(delta_mb)
                    .bind(sub_id)
                    .execute(pool)
                    .await?;
            }
            "download" => {
                sqlx::query("UPDATE subscriptions SET download_used_mb = download_used_mb + ? WHERE id = ?")
                    .bind(delta_mb)
                    .bind(sub_id)
                    .execute(pool)
                    .await?;
            }
            "gaming" => {
                sqlx::query("UPDATE subscriptions SET gaming_used_mb = gaming_used_mb + ? WHERE id = ?")
                    .bind(delta_mb)
                    .bind(sub_id)
                    .execute(pool)
                    .await?;
            }
            _ => {}
        }
        Ok(())
    }

    /// Builds dynamic 4-mode information for a specific user
    pub fn build_modes_info(sub: &Subscription, telegram_verified: bool) -> Vec<ConnectionModeInfo> {
        let is_free = sub.tier == "Sentra Lite";

        let (wb_status, wb_rem) = if is_free {
            let rem = (2048 - sub.web_browsing_used_mb).max(0);
            let status = if rem == 0 { "depleted" } else { "active" };
            (status.to_string(), rem)
        } else {
            ("active".to_string(), 999_999)
        };

        let (dl_status, dl_rem, dl_badge) = if is_free {
            if !telegram_verified {
                (
                    "locked".to_string(),
                    0i64,
                    Some("قفل • نیاز به تایید حساب در ربات تلگرام".to_string()),
                )
            } else {
                let rem = (3072 - sub.download_used_mb).max(0);
                let status = if rem == 0 { "depleted" } else { "active" };
                (
                    status.to_string(),
                    rem,
                    Some("رایگان • ۳ گیگابایت روزانه".to_string()),
                )
            }
        } else {
            ("active".to_string(), 999_999, Some("نامحدود".to_string()))
        };

        let (gaming_status, gaming_badge, gaming_rem) = if is_free {
            let rem = (3072 - sub.gaming_used_mb).max(0);
            let status = if rem == 0 { "depleted" } else { "active" };
            (status.to_string(), Some("رایگان • ۳ گیگابایت روزانه".to_string()), rem)
        } else {
            ("active".to_string(), Some("نامحدود • کمترین تاخیر".to_string()), 999_999)
        };

        let (static_status, static_badge, static_limit, static_used, static_rem) = if is_free {
            ("locked".to_string(), Some("قفل • نیاز به ارتقا".to_string()), 0i64, 0i64, 0i64)
        } else {
            let limit = 30_720i64; // 30 GB per monthly subscription
            let rem = (limit - sub.static_ip_used_mb).max(0);
            let status = if rem == 0 { "depleted" } else { "active" };
            let badge = if rem == 0 {
                "سقف ۳۰ گیگابایت ماهانه تکمیل شد (نیاز به تمدید)".to_string()
            } else {
                format!("{:.1} گیگابایت باقیمانده از ۳۰ گیگ", rem as f64 / 1024.0)
            };
            (status.to_string(), Some(badge), limit, sub.static_ip_used_mb, rem)
        };

        vec![
            ConnectionModeInfo {
                id: "web_browsing".to_string(),
                name: "وبگردی".to_string(),
                icon: "🌐".to_string(),
                status: wb_status,
                badge: if is_free { Some("رایگان • ۲ گیگابایت روزانه".to_string()) } else { Some("نامحدود".to_string()) },
                daily_limit_mb: if is_free { 2048 } else { 0 },
                used_today_mb: sub.web_browsing_used_mb,
                remaining_today_mb: wb_rem,
                speed_desc: "سرعت متوسط".to_string(),
                security_desc: "امنیت کم".to_string(),
                description: "مناسب مرور روزمره وب و شبکه‌های اجتماعی (پروفایل سبک WS+Fragment)".to_string(),
            },
            ConnectionModeInfo {
                id: "download".to_string(),
                name: "دانلود".to_string(),
                icon: "📥".to_string(),
                status: dl_status,
                badge: dl_badge,
                daily_limit_mb: if is_free { 3072 } else { 0 },
                used_today_mb: sub.download_used_mb,
                remaining_today_mb: dl_rem,
                speed_desc: "سرعت بالا و پایداری مناسب".to_string(),
                security_desc: "امنیت استاندارد".to_string(),
                description: "مبتنی بر Hysteria 2 / پروتکل پرسرعت انتقال فایل".to_string(),
            },
            ConnectionModeInfo {
                id: "gaming".to_string(),
                name: "گیمینگ".to_string(),
                icon: "🎮".to_string(),
                status: gaming_status,
                badge: gaming_badge,
                daily_limit_mb: if is_free { 3072 } else { 0 },
                used_today_mb: sub.gaming_used_mb,
                remaining_today_mb: gaming_rem,
                speed_desc: "پینگ فوق‌العاده کم (Low Latency)".to_string(),
                security_desc: "پایداری بالا و UDP بهینه".to_string(),
                description: "بهینه‌شده برای بازی‌های آنلاین رقابتی، ترافیک بدون لگ و کاهش نوسان پینگ (WireGuard / TUIC / Hysteria 2)".to_string(),
            },
            ConnectionModeInfo {
                id: "static_ip".to_string(),
                name: "آی‌پی ثابت".to_string(),
                icon: "🔒".to_string(),
                status: static_status,
                badge: static_badge,
                daily_limit_mb: static_limit,
                used_today_mb: static_used,
                remaining_today_mb: static_rem,
                speed_desc: "اتصال پایدار".to_string(),
                security_desc: "امنیت بالا و کیفیت مناسب".to_string(),
                description: "امکان استفاده بدون خطا در سایت‌های ترید (صرافی‌های ارز دیجیتال) و سایت جمنای (Google Gemini / AI) با Residential Static IP (سقف ماهانه ۳۰ گیگابایت)".to_string(),
            },
        ]
    }

    /// Default public modes list for unauthenticated preview
    pub fn build_default_modes_info() -> Vec<ConnectionModeInfo> {
        vec![
            ConnectionModeInfo {
                id: "web_browsing".to_string(),
                name: "وبگردی".to_string(),
                icon: "🌐".to_string(),
                status: "active".to_string(),
                badge: Some("رایگان • ۲ گیگابایت روزانه".to_string()),
                daily_limit_mb: 2048,
                used_today_mb: 0,
                remaining_today_mb: 2048,
                speed_desc: "سرعت متوسط".to_string(),
                security_desc: "امنیت کم".to_string(),
                description: "مناسب مرور روزمره وب و شبکه‌های اجتماعی (پروفایل سبک WS+Fragment)".to_string(),
            },
            ConnectionModeInfo {
                id: "download".to_string(),
                name: "دانلود".to_string(),
                icon: "📥".to_string(),
                status: "active".to_string(),
                badge: Some("رایگان • ۳ گیگابایت روزانه".to_string()),
                daily_limit_mb: 3072,
                used_today_mb: 0,
                remaining_today_mb: 3072,
                speed_desc: "سرعت بالا و پایداری مناسب".to_string(),
                security_desc: "امنیت استاندارد".to_string(),
                description: "مبتنی بر Hysteria 2 / پروتکل پرسرعت انتقال فایل".to_string(),
            },
            ConnectionModeInfo {
                id: "gaming".to_string(),
                name: "گیمینگ".to_string(),
                icon: "🎮".to_string(),
                status: "active".to_string(),
                badge: Some("پینگ فوق‌العاده کم • UDP بهینه".to_string()),
                daily_limit_mb: 3072,
                used_today_mb: 0,
                remaining_today_mb: 3072,
                speed_desc: "پینگ فوق‌العاده کم (Low Latency)".to_string(),
                security_desc: "پایداری بالا و UDP بهینه".to_string(),
                description: "کاهش چشمگیر پینگ و جیتر ویژه بازی‌های آنلاین رقابتی (WireGuard / TUIC / Hysteria 2)".to_string(),
            },
            ConnectionModeInfo {
                id: "static_ip".to_string(),
                name: "آی‌پی ثابت".to_string(),
                icon: "🔒".to_string(),
                status: "locked".to_string(),
                badge: Some("قفل • نیاز به ارتقا".to_string()),
                daily_limit_mb: 0,
                used_today_mb: 0,
                remaining_today_mb: 0,
                speed_desc: "اتصال پایدار".to_string(),
                security_desc: "امنیت بالا و کیفیت مناسب".to_string(),
                description: "امکان استفاده بدون خطا در سایت‌های ترید و سایت جمنای (Residential Static IP)".to_string(),
            },
        ]
    }

    #[allow(dead_code)]
    pub async fn generate_auth_code(
        pool: &DbPool,
        user_id: i64,
    ) -> Result<String, CoreError> {
        let code_str = {
            let mut rng = rand::thread_rng();
            let code: u32 = rng.gen_range(10_000_000..99_999_999);
            code.to_string()
        };
        let expires_at = Utc::now() + Duration::seconds(300); // 5 minutes strict expiration

        sqlx::query(
            "UPDATE users SET auth_code = ?, auth_code_expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        )
        .bind(&code_str)
        .bind(expires_at)
        .bind(user_id)
        .execute(pool)
        .await?;

        Ok(code_str)
    }

    pub async fn validate_and_exchange_code(
        pool: &DbPool,
        code: &str,
        device_identifier: &str,
        device_name: &str,
        os: &str,
        client_version: &str,
        ip_address: &str,
    ) -> Result<(User, Subscription), CoreError> {
        let user = sqlx::query_as::<_, User>(
            r#"
            SELECT * FROM users
            WHERE auth_code = ? AND auth_code_expires_at > CURRENT_TIMESTAMP
            LIMIT 1
            "#,
        )
        .bind(code)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| CoreError::AuthFailed("کد ورود نامعتبر است یا منقضی شده است.".to_string()))?;

        if user.status == "suspended" {
            return Err(CoreError::AccountSuspended(
                "حساب شما به دلیل الگوی مصرف ترافیک غیرعادی موقتاً متوقف شده است. لطفاً با پشتیبانی در ارتباط باشید.".to_string(),
            ));
        }
        if user.status == "banned" {
            return Err(CoreError::UserBanned("حساب کاربری شما مسدود شده است.".to_string()));
        }

        let mut sub = sqlx::query_as::<_, Subscription>(
            "SELECT * FROM subscriptions WHERE user_id = ? LIMIT 1",
        )
        .bind(user.id)
        .fetch_optional(pool)
        .await?
        .ok_or(CoreError::SubscriptionNotFound)?;

        if sub.status == "suspended" {
            return Err(CoreError::AccountSuspended(
                "اشتراک شما به دلیل الگوی مصرف ترافیک غیرعادی موقتاً متوقف شده است. لطفاً با پشتیبانی در ارتباط باشید.".to_string(),
            ));
        }

        Self::check_and_reset_daily_quota(pool, &mut sub).await?;

        // Enforce MAX 3 DEVICES per user
        Self::register_or_update_device(pool, user.id, sub.id, device_identifier, device_name, os).await?;

        // Check concurrent device limit
        let active_devices: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM device_sessions WHERE subscription_id = ? AND is_active = 1 AND device_identifier != ?",
        )
        .bind(sub.id)
        .bind(device_identifier)
        .fetch_one(pool)
        .await?;

        if active_devices >= sub.max_concurrent_devices {
            return Err(CoreError::DeviceLimitExceeded(sub.max_concurrent_devices));
        }

        // Upsert device session
        sqlx::query(
            r#"
            INSERT INTO device_sessions (subscription_id, device_identifier, device_name, os, client_version, ip_address, is_active, last_seen_at)
            VALUES (?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
            ON CONFLICT(subscription_id, device_identifier) DO UPDATE SET
                device_name = excluded.device_name,
                os = excluded.os,
                client_version = excluded.client_version,
                ip_address = excluded.ip_address,
                is_active = 1,
                last_seen_at = CURRENT_TIMESTAMP
            "#,
        )
        .bind(sub.id)
        .bind(device_identifier)
        .bind(device_name)
        .bind(os)
        .bind(client_version)
        .bind(ip_address)
        .execute(pool)
        .await?;

        // Invalidate OTP code
        sqlx::query("UPDATE users SET auth_code = NULL, auth_code_expires_at = NULL WHERE id = ?")
            .bind(user.id)
            .execute(pool)
            .await?;

        Ok((user, sub))
    }

    pub async fn get_allowed_outbounds(
        pool: &DbPool,
        tier: &str,
    ) -> Result<Vec<Outbound>, CoreError> {
        let outbounds = match tier {
            "Sentra Flow+" => {
                sqlx::query_as::<_, Outbound>(
                    "SELECT * FROM outbounds WHERE is_active = 1 ORDER BY quality_score DESC, latency_ms ASC, weight DESC, id ASC",
                )
                .fetch_all(pool)
                .await?
            }
            "Sentra Pro" => {
                sqlx::query_as::<_, Outbound>(
                    "SELECT * FROM outbounds WHERE is_active = 1 AND min_tier IN ('Sentra Lite', 'Sentra Pro') ORDER BY quality_score DESC, latency_ms ASC, weight DESC, id ASC",
                )
                .fetch_all(pool)
                .await?
            }
            _ => {
                sqlx::query_as::<_, Outbound>(
                    "SELECT * FROM outbounds WHERE is_active = 1 AND min_tier = 'Sentra Lite' ORDER BY quality_score DESC, latency_ms ASC, weight DESC, id ASC",
                )
                .fetch_all(pool)
                .await?
            }
        };

        Ok(outbounds)
    }

    #[allow(dead_code)]
    pub async fn get_outbounds_for_mode(
        pool: &DbPool,
        tier: &str,
        mode: &str,
    ) -> Result<Vec<Outbound>, CoreError> {
        let all_allowed = Self::get_allowed_outbounds(pool, tier).await?;
        let filtered: Vec<Outbound> = all_allowed
            .into_iter()
            .filter(|ob| ob.mode_category.eq_ignore_ascii_case(mode))
            .collect();

        if filtered.is_empty() {
            // Fallback to general allowed outbounds if exact mode not found
            Self::get_allowed_outbounds(pool, tier).await
        } else {
            Ok(filtered)
        }
    }

    pub async fn list_all_outbounds(pool: &DbPool) -> Result<Vec<Outbound>, CoreError> {
        let outbounds = sqlx::query_as::<_, Outbound>(
            "SELECT * FROM outbounds ORDER BY id ASC",
        )
        .fetch_all(pool)
        .await?;

        Ok(outbounds)
    }

    pub async fn toggle_outbound_status(
        pool: &DbPool,
        outbound_id: i64,
    ) -> Result<bool, CoreError> {
        let current_state: Option<i64> = sqlx::query_scalar(
            "SELECT is_active FROM outbounds WHERE id = ?",
        )
        .bind(outbound_id)
        .fetch_optional(pool)
        .await?;

        let new_state = match current_state {
            Some(1) => 0,
            _ => 1,
        };

        sqlx::query("UPDATE outbounds SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
            .bind(new_state)
            .bind(outbound_id)
            .execute(pool)
            .await?;

        Ok(new_state == 1)
    }

    #[allow(dead_code)]
    pub async fn list_users_summary(
        pool: &DbPool,
    ) -> Result<Vec<(User, Option<Subscription>)>, CoreError> {
        let users = sqlx::query_as::<_, User>(
            "SELECT * FROM users ORDER BY id DESC LIMIT 50",
        )
        .fetch_all(pool)
        .await?;

        let mut results = Vec::new();
        for user in users {
            let sub = sqlx::query_as::<_, Subscription>(
                "SELECT * FROM subscriptions WHERE user_id = ? LIMIT 1",
            )
            .bind(user.id)
            .fetch_optional(pool)
            .await?;
            results.push((user, sub));
        }

        Ok(results)
    }

    pub async fn get_system_health(pool: &DbPool) -> Result<SystemHealthStats, CoreError> {
        let total_users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(pool)
            .await?;

        let lite_users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM subscriptions WHERE tier = 'Sentra Lite'")
            .fetch_one(pool)
            .await?;

        let pro_users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM subscriptions WHERE tier = 'Sentra Pro'")
            .fetch_one(pool)
            .await?;

        let flow_users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM subscriptions WHERE tier = 'Sentra Flow+'")
            .fetch_one(pool)
            .await?;

        let active_outbounds: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM outbounds WHERE is_active = 1")
            .fetch_one(pool)
            .await?;

        let open_tickets: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM support_tickets WHERE status = 'open'")
            .fetch_one(pool)
            .await?;

        let journal_mode: String = sqlx::query_scalar("PRAGMA journal_mode")
            .fetch_one(pool)
            .await?;

        Ok(SystemHealthStats {
            total_users,
            lite_users,
            pro_users,
            flow_users,
            active_outbounds,
            open_tickets,
            wal_mode_active: journal_mode.to_lowercase() == "wal",
        })
    }

    /// Creates a user support ticket
    pub async fn create_support_ticket(
        pool: &DbPool,
        user_id: i64,
        category: &str,
        subject: &str,
        description: &str,
    ) -> Result<String, CoreError> {
        let ticket_num = format!("TKT-{}", Utc::now().timestamp_millis());
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            INSERT INTO support_tickets (ticket_number, user_id, category, subject, description, status, priority, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'open', 'normal', ?, ?)
            "#,
        )
        .bind(&ticket_num)
        .bind(user_id)
        .bind(category)
        .bind(subject)
        .bind(description)
        .bind(&now)
        .bind(&now)
        .execute(pool)
        .await?;

        Ok(ticket_num)
    }

    /// Register or update a user device, enforcing MAX 3 DEVICES per user
    pub async fn register_or_update_device(
        pool: &DbPool,
        user_id: i64,
        subscription_id: i64,
        device_id: &str,
        device_name: &str,
        platform: &str,
    ) -> Result<UserDevice, CoreError> {
        let existing = sqlx::query_as::<_, UserDevice>(
            "SELECT * FROM user_devices WHERE user_id = ? AND device_id = ? LIMIT 1",
        )
        .bind(user_id)
        .bind(device_id)
        .fetch_optional(pool)
        .await?;

        if let Some(mut dev) = existing {
            let now = Utc::now();
            sqlx::query(
                "UPDATE user_devices SET last_active_at = ?, device_name = ?, platform = ? WHERE id = ?",
            )
            .bind(now)
            .bind(device_name)
            .bind(platform)
            .bind(dev.id)
            .execute(pool)
            .await?;

            dev.last_active_at = now;
            dev.device_name = device_name.to_string();
            dev.platform = platform.to_string();
            return Ok(dev);
        }

        // Check current count
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM user_devices WHERE user_id = ?",
        )
        .bind(user_id)
        .fetch_one(pool)
        .await?;

        if count >= 3 {
            return Err(CoreError::MaxDevicesReached { max: 3 });
        }

        let now = Utc::now();
        let inserted = sqlx::query_as::<_, UserDevice>(
            r#"
            INSERT INTO user_devices (user_id, subscription_id, device_id, device_name, platform, last_active_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            RETURNING *
            "#,
        )
        .bind(user_id)
        .bind(subscription_id)
        .bind(device_id)
        .bind(device_name)
        .bind(platform)
        .bind(now)
        .bind(now)
        .fetch_one(pool)
        .await?;

        Ok(inserted)
    }

    /// List user devices
    pub async fn get_user_devices(
        pool: &DbPool,
        user_id: i64,
    ) -> Result<Vec<UserDevice>, CoreError> {
        let devices = sqlx::query_as::<_, UserDevice>(
            "SELECT * FROM user_devices WHERE user_id = ? ORDER BY last_active_at DESC",
        )
        .bind(user_id)
        .fetch_all(pool)
        .await?;
        Ok(devices)
    }

    /// Delete user device by device_id or primary key id
    pub async fn delete_user_device(
        pool: &DbPool,
        user_id: i64,
        identifier: &str,
    ) -> Result<bool, CoreError> {
        let res = if let Ok(id_num) = identifier.parse::<i64>() {
            sqlx::query("DELETE FROM user_devices WHERE user_id = ? AND (id = ? OR device_id = ?)")
                .bind(user_id)
                .bind(id_num)
                .bind(identifier)
                .execute(pool)
                .await?
        } else {
            sqlx::query("DELETE FROM user_devices WHERE user_id = ? AND device_id = ?")
                .bind(user_id)
                .bind(identifier)
                .execute(pool)
                .await?
        };
        Ok(res.rows_affected() > 0)
    }

    /// Get user by primary key ID
    pub async fn get_user_by_id(pool: &DbPool, user_id: i64) -> Result<Option<User>, CoreError> {
        let u = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = ? LIMIT 1")
            .bind(user_id)
            .fetch_optional(pool)
            .await?;
        Ok(u)
    }

    /// Suspend user account due to anomaly or admin action
    pub async fn suspend_user_account(
        pool: &DbPool,
        user_id: i64,
        reason: &str,
    ) -> Result<(), CoreError> {
        sqlx::query("UPDATE users SET status = 'suspended' WHERE id = ?")
            .bind(user_id)
            .execute(pool)
            .await?;
        sqlx::query("UPDATE subscriptions SET status = 'suspended' WHERE user_id = ?")
            .bind(user_id)
            .execute(pool)
            .await?;
        tracing::warn!("User {} account suspended. Reason: {}", user_id, reason);
        Ok(())
    }

    /// Unsuspend user account
    #[allow(dead_code)]
    pub async fn unsuspend_user_account(
        pool: &DbPool,
        user_id: i64,
    ) -> Result<(), CoreError> {
        sqlx::query("UPDATE users SET status = 'active' WHERE id = ?")
            .bind(user_id)
            .execute(pool)
            .await?;
        sqlx::query("UPDATE subscriptions SET status = 'active' WHERE user_id = ?")
            .bind(user_id)
            .execute(pool)
            .await?;
        tracing::info!("User {} account unsuspended by admin.", user_id);
        Ok(())
    }

    /// Permanently ban user account
    #[allow(dead_code)]
    pub async fn ban_user_account(
        pool: &DbPool,
        user_id: i64,
        reason: &str,
    ) -> Result<(), CoreError> {
        sqlx::query("UPDATE users SET status = 'banned' WHERE id = ?")
            .bind(user_id)
            .execute(pool)
            .await?;
        sqlx::query("UPDATE subscriptions SET status = 'disabled' WHERE user_id = ?")
            .bind(user_id)
            .execute(pool)
            .await?;
        tracing::warn!("User {} account permanently banned. Reason: {}", user_id, reason);
        Ok(())
    }

    /// Retrieve comprehensive realtime statistics for admin dashboard
    pub async fn get_admin_realtime_stats(pool: &DbPool) -> Result<AdminRealtimeStats, CoreError> {
        let total_users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(pool)
            .await?;

        let premium_users: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM subscriptions WHERE tier IN ('Sentra Pro', 'Sentra Flow+') AND status = 'active'"
        )
        .fetch_one(pool)
        .await?;

        let suspended_users: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM users WHERE status = 'suspended'"
        )
        .fetch_one(pool)
        .await?;

        let active_sessions: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM user_devices"
        )
        .fetch_one(pool)
        .await?;

        let traffic_24h: Option<i64> = sqlx::query_scalar(
            "SELECT SUM(bytes_sent + bytes_received) FROM traffic_logs WHERE recorded_at >= datetime('now', '-24 hours')"
        )
        .fetch_one(pool)
        .await?;

        let traffic_24h_bytes = match traffic_24h {
            Some(bytes) if bytes > 0 => bytes,
            _ => {
                let fallback: Option<i64> = sqlx::query_scalar(
                    "SELECT SUM(upload_bytes + download_bytes) FROM subscriptions"
                )
                .fetch_one(pool)
                .await?;
                fallback.unwrap_or(0)
            }
        };

        Ok(AdminRealtimeStats {
            total_users,
            premium_users,
            suspended_users,
            active_sessions,
            traffic_24h_bytes,
        })
    }

    /// Search user by numeric Telegram ID, internal ID, or username
    pub async fn find_user_by_query(pool: &DbPool, query: &str) -> Result<Option<User>, CoreError> {
        let clean = query.trim().trim_start_matches('@');
        if clean.is_empty() {
            return Ok(None);
        }

        if let Ok(num_id) = clean.parse::<i64>() {
            let user = sqlx::query_as::<_, User>(
                "SELECT * FROM users WHERE telegram_id = ? OR id = ? LIMIT 1"
            )
            .bind(num_id)
            .bind(num_id)
            .fetch_optional(pool)
            .await?;
            if user.is_some() {
                return Ok(user);
            }
        }

        let user = sqlx::query_as::<_, User>(
            "SELECT * FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?) LIMIT 1"
        )
        .bind(clean)
        .bind(clean)
        .fetch_optional(pool)
        .await?;

        Ok(user)
    }

    /// Get user together with active subscription and registered devices
    pub async fn get_user_with_subscription_and_devices(
        pool: &DbPool,
        user_id: i64,
    ) -> Result<Option<(User, Option<Subscription>, Vec<UserDevice>)>, CoreError> {
        let user_opt = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = ? LIMIT 1")
            .bind(user_id)
            .fetch_optional(pool)
            .await?;

        let user = match user_opt {
            Some(u) => u,
            None => return Ok(None),
        };

        let sub = sqlx::query_as::<_, Subscription>(
            "SELECT * FROM subscriptions WHERE user_id = ? LIMIT 1"
        )
        .bind(user.id)
        .fetch_optional(pool)
        .await?;

        let devices = sqlx::query_as::<_, UserDevice>(
            "SELECT * FROM user_devices WHERE user_id = ? ORDER BY last_active_at DESC"
        )
        .bind(user.id)
        .fetch_all(pool)
        .await?;

        Ok(Some((user, sub, devices)))
    }

    /// Upgrade user subscription for 30 days
    pub async fn upgrade_subscription_30_days(
        pool: &DbPool,
        user_id: i64,
        tier: &str,
    ) -> Result<Subscription, CoreError> {
        let (traffic_limit, speed_limit, devices) = match tier {
            "Sentra Flow+" | "tier_flow" => (1_099_511_627_776i64, 0i64, 10i64),
            _ => (161_061_273_600i64, 104_857_600i64, 3i64),
        };

        let formal_tier = match tier {
            "tier_flow" | "Sentra Flow+" => "Sentra Flow+",
            _ => "Sentra Pro",
        };

        let expires_at = Utc::now() + Duration::days(30);

        let existing = sqlx::query_as::<_, Subscription>(
            "SELECT * FROM subscriptions WHERE user_id = ? LIMIT 1"
        )
        .bind(user_id)
        .fetch_optional(pool)
        .await?;

        let sub = if let Some(sub) = existing {
            sqlx::query_as::<_, Subscription>(
                r#"
                UPDATE subscriptions
                SET tier = ?, status = 'active', traffic_limit_bytes = ?, speed_limit_bps = ?,
                    max_concurrent_devices = ?, expires_at = ?, static_ip_used_mb = 0, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                RETURNING *
                "#,
            )
            .bind(formal_tier)
            .bind(traffic_limit)
            .bind(speed_limit)
            .bind(devices)
            .bind(expires_at)
            .bind(sub.id)
            .fetch_one(pool)
            .await?
        } else {
            let token = format!("sentra_{}", Uuid::new_v4().simple());
            sqlx::query_as::<_, Subscription>(
                r#"
                INSERT INTO subscriptions (
                    user_id, tier, token, status, traffic_limit_bytes, speed_limit_bps,
                    max_concurrent_devices, expires_at
                )
                VALUES (?, ?, ?, 'active', ?, ?, ?, ?)
                RETURNING *
                "#,
            )
            .bind(user_id)
            .bind(formal_tier)
            .bind(&token)
            .bind(traffic_limit)
            .bind(speed_limit)
            .bind(devices)
            .bind(expires_at)
            .fetch_one(pool)
            .await?
        };

        // Ensure user is active
        sqlx::query("UPDATE users SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
            .bind(user_id)
            .execute(pool)
            .await?;

        Ok(sub)
    }

    /// Reset daily quotas for user (web_browsing and download)
    pub async fn reset_user_daily_quota(pool: &DbPool, user_id: i64) -> Result<(), CoreError> {
        sqlx::query(
            "UPDATE subscriptions SET web_browsing_used_mb = 0, download_used_mb = 0, last_quota_reset = CURRENT_TIMESTAMP WHERE user_id = ?"
        )
        .bind(user_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Clear all registered devices for a user
    pub async fn clear_user_devices(pool: &DbPool, user_id: i64) -> Result<u64, CoreError> {
        let count1 = sqlx::query("DELETE FROM user_devices WHERE user_id = ?")
            .bind(user_id)
            .execute(pool)
            .await?
            .rows_affected();

        let _ = sqlx::query(
            "DELETE FROM device_sessions WHERE subscription_id IN (SELECT id FROM subscriptions WHERE user_id = ?)"
        )
        .bind(user_id)
        .execute(pool)
        .await;

        Ok(count1)
    }

    /// Toggle user suspension status between active and suspended
    pub async fn toggle_user_block(pool: &DbPool, user_id: i64) -> Result<String, CoreError> {
        let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = ? LIMIT 1")
            .bind(user_id)
            .fetch_one(pool)
            .await?;

        let new_status = if user.status == "suspended" {
            "active"
        } else {
            "suspended"
        };

        sqlx::query("UPDATE users SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
            .bind(new_status)
            .bind(user_id)
            .execute(pool)
            .await?;

        sqlx::query("UPDATE subscriptions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?")
            .bind(new_status)
            .bind(user_id)
            .execute(pool)
            .await?;

        Ok(new_status.to_string())
    }

    /// Check if a specific device_id is currently registered for user
    pub async fn is_device_registered(
        pool: &DbPool,
        user_id: i64,
        device_id: &str,
    ) -> Result<bool, CoreError> {
        let exists: Option<i64> = sqlx::query_scalar(
            "SELECT id FROM user_devices WHERE user_id = ? AND device_id = ? LIMIT 1",
        )
        .bind(user_id)
        .bind(device_id)
        .fetch_optional(pool)
        .await?;

        Ok(exists.is_some())
    }

    /// Process periodic client heartbeat, update mode quotas, enforce limits and session validity
    pub async fn process_heartbeat(
        pool: &DbPool,
        token: &str,
        device_id: &str,
        mode: &str,
        delta_up: u64,
        delta_down: u64,
    ) -> Result<HeartbeatVerdict, CoreError> {
        let mut sub = Self::get_subscription_by_token(pool, token).await?;

        // 1. Verify user status
        let user = match Self::get_user_by_id(pool, sub.user_id).await? {
            Some(u) => u,
            None => {
                return Ok(HeartbeatVerdict::Disconnect {
                    code: "USER_NOT_FOUND".to_string(),
                    message: "کاربر در سامانه یافت نشد.".to_string(),
                });
            }
        };

        if user.status == "suspended" || sub.status == "suspended" {
            return Ok(HeartbeatVerdict::Disconnect {
                code: "ACCOUNT_SUSPENDED".to_string(),
                message: "حساب کاربری شما به دلیل الگوی مصرف مشکوک به صورت موقت مسدود شده است.".to_string(),
            });
        }

        if user.status == "banned" {
            return Ok(HeartbeatVerdict::Disconnect {
                code: "USER_BANNED".to_string(),
                message: "حساب کاربری شما مسدود شده است.".to_string(),
            });
        }

        // 2. Verify device registration (Detect revoked / deleted devices)
        let is_registered = Self::is_device_registered(pool, user.id, device_id).await?;
        if !is_registered {
            return Ok(HeartbeatVerdict::Disconnect {
                code: "DEVICE_REVOKED".to_string(),
                message: "این دستگاه از فهرست دستگاه‌های مجاز حساب شما حذف شده است.".to_string(),
            });
        }

        // 3. Check and reset daily quota on Asia/Tehran calendar day rollover
        Self::check_and_reset_daily_quota(pool, &mut sub).await?;

        // 4. Update traffic and mode-specific daily usage
        let delta_total = (delta_up + delta_down) as i64;
        let delta_mb = if delta_total > 0 {
            (delta_total + 1_048_575) / 1_048_576
        } else {
            0
        };

        let delta_wb = if mode == "web_browsing" { delta_mb } else { 0 };
        let delta_dl = if mode == "download" { delta_mb } else { 0 };
        let delta_static = if mode == "static_ip" { delta_mb } else { 0 };
        let delta_gaming = if mode == "gaming" { delta_mb } else { 0 };

        if delta_total > 0 {
            sqlx::query(
                r#"
                UPDATE subscriptions
                SET upload_bytes = upload_bytes + ?,
                    download_bytes = download_bytes + ?,
                    web_browsing_used_mb = web_browsing_used_mb + ?,
                    download_used_mb = download_used_mb + ?,
                    static_ip_used_mb = static_ip_used_mb + ?,
                    gaming_used_mb = gaming_used_mb + ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                "#,
            )
            .bind(delta_up as i64)
            .bind(delta_down as i64)
            .bind(delta_wb)
            .bind(delta_dl)
            .bind(delta_static)
            .bind(delta_gaming)
            .bind(sub.id)
            .execute(pool)
            .await?;

            sub.upload_bytes += delta_up as i64;
            sub.download_bytes += delta_down as i64;
            sub.web_browsing_used_mb += delta_wb;
            sub.download_used_mb += delta_dl;
            sub.static_ip_used_mb += delta_static;
            sub.gaming_used_mb += delta_gaming;

            // Log into traffic_logs
            let _ = sqlx::query(
                "INSERT INTO traffic_logs (subscription_id, bytes_sent, bytes_received) VALUES (?, ?, ?)"
            )
            .bind(sub.id)
            .bind(delta_up as i64)
            .bind(delta_down as i64)
            .execute(pool)
            .await;

            // Touch last_active_at on user_devices
            let _ = sqlx::query(
                "UPDATE user_devices SET last_active_at = CURRENT_TIMESTAMP WHERE user_id = ? AND device_id = ?"
            )
            .bind(user.id)
            .bind(device_id)
            .execute(pool)
            .await;
        }

        // 5. Mode quota checks
        if mode == "static_ip" {
            if sub.tier == "Sentra Lite" {
                return Ok(HeartbeatVerdict::Disconnect {
                    code: "MODE_LOCKED".to_string(),
                    message: "حالت آی‌پی ثابت اختصاصی نیاز به ارتقا به اشتراک Pro دارد.".to_string(),
                });
            }
            if sub.static_ip_used_mb >= 30_720 {
                return Ok(HeartbeatVerdict::Disconnect {
                    code: "STATIC_IP_QUOTA_EXCEEDED".to_string(),
                    message: "سقف حجم ۳۰ گیگابایت آی‌پی ثابت اختصاصی شما به پایان رسید. دسترسی وب‌گردی و دانلود شما همچنان فعال و نامحدود است.".to_string(),
                });
            }
        } else if sub.tier == "Sentra Lite" {
            // Check daily quotas for free tier
            if mode == "web_browsing" && sub.web_browsing_used_mb >= 2048 {
                return Ok(HeartbeatVerdict::Disconnect {
                    code: "QUOTA_EXCEEDED".to_string(),
                    message: "سقف حجم روزانه ۲ گیگابایت وب‌گردی به پایان رسید. ریست روزانه ساعت ۰۰:۰۰ به وقت ایران انجام می‌شود.".to_string(),
                });
            }
            if mode == "download" && sub.download_used_mb >= 3072 {
                return Ok(HeartbeatVerdict::Disconnect {
                    code: "QUOTA_EXCEEDED".to_string(),
                    message: "سقف حجم روزانه ۳ گیگابایت دانلود به پایان رسید. ریست روزانه ساعت ۰۰:۰۰ به وقت ایران انجام می‌شود.".to_string(),
                });
            }
            if mode == "gaming" && sub.gaming_used_mb >= 3072 {
                return Ok(HeartbeatVerdict::Disconnect {
                    code: "QUOTA_EXCEEDED".to_string(),
                    message: "سقف حجم روزانه ۳ گیگابایت گیمینگ به پایان رسید. ریست روزانه ساعت ۰۰:۰۰ به وقت ایران انجام می‌شود.".to_string(),
                });
            }
        }

        // Check overall total package bytes (only for Lite since Pro/Flow+ web & download are unlimited)
        let total_used = sub.upload_bytes + sub.download_bytes;
        if sub.tier == "Sentra Lite" && total_used >= sub.traffic_limit_bytes {
            return Ok(HeartbeatVerdict::Disconnect {
                code: "PACKAGE_DEPLETED".to_string(),
                message: "حجم کلی بسته اشتراک شما به پایان رسیده است.".to_string(),
            });
        }

        let remaining = if sub.tier == "Sentra Lite" {
            (sub.traffic_limit_bytes - total_used).max(0)
        } else {
            999_999_999_999
        };

        let static_rem = if sub.tier == "Sentra Lite" {
            0
        } else {
            (30_720 - sub.static_ip_used_mb).max(0)
        };

        Ok(HeartbeatVerdict::Continue {
            remaining_bytes: remaining,
            web_browsing_used_mb: sub.web_browsing_used_mb,
            download_used_mb: sub.download_used_mb,
            static_ip_used_mb: sub.static_ip_used_mb,
            static_ip_remaining_mb: static_rem,
            gaming_used_mb: sub.gaming_used_mb,
        })
    }

    pub const RESERVED_USERNAMES: &'static [&'static str] = &[
        "admin", "root", "sentra", "support", "system", "administrator", "sentravpn", "superuser"
    ];

    /// Hash password using modern Argon2id with random salt
    pub fn hash_password_argon2(password: &str) -> Result<String, CoreError> {
        let salt = SaltString::generate(&mut OsRng);
        let argon2 = Argon2::default();
        argon2
            .hash_password(password.as_bytes(), &salt)
            .map(|h| h.to_string())
            .map_err(|e| CoreError::Internal(format!("Failed to hash password with Argon2: {}", e)))
    }

    /// Verify password against Argon2id (or fallback bcrypt hash)
    pub fn verify_password_hash(password: &str, hash: &str) -> bool {
        if hash.starts_with("$argon2") {
            if let Ok(parsed_hash) = PasswordHash::new(hash) {
                return Argon2::default().verify_password(password.as_bytes(), &parsed_hash).is_ok();
            }
            false
        } else {
            bcrypt::verify(password, hash).unwrap_or(false)
        }
    }

    /// Check IP registration rate limit: max 2 accounts per 24 hours per IP
    pub async fn check_and_record_ip_registration(pool: &DbPool, ip: &str) -> Result<(), CoreError> {
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM ip_registrations WHERE ip = ? AND created_at > datetime('now', '-24 hours')"
        )
        .bind(ip)
        .fetch_one(pool)
        .await
        .unwrap_or(0);

        if count >= 2 {
            return Err(CoreError::TooManyRequests(
                "سقف مجاز ساخت حساب کاربری با این آدرس IP تکمیل شده است (حداکثر ۲ حساب در هر ۲۴ ساعت).".to_string()
            ));
        }

        let _ = sqlx::query("INSERT INTO ip_registrations (ip) VALUES (?)")
            .bind(ip)
            .execute(pool)
            .await;

        Ok(())
    }

    /// Register a new standalone user with username and password
    pub async fn register_user_with_credentials(
        pool: &DbPool,
        username: &str,
        password: &str,
        first_name: Option<&str>,
    ) -> Result<(User, Subscription), CoreError> {
        let clean_username = username.trim().to_lowercase();
        if clean_username.len() < 3 || clean_username.len() > 32 {
            return Err(CoreError::BadRequest("نام کاربری باید بین ۳ تا ۳۲ کاراکتر باشد.".to_string()));
        }
        if !clean_username.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err(CoreError::BadRequest("نام کاربری فقط می‌تواند شامل حروف و اعداد انگلیسی و خط زیر (_) باشد.".to_string()));
        }
        if Self::RESERVED_USERNAMES.contains(&clean_username.as_str()) {
            return Err(CoreError::BadRequest("این نام کاربری رزرو شده و قابل انتخاب نیست.".to_string()));
        }
        if password.len() < 8 {
            return Err(CoreError::BadRequest("رمز عبور باید حداقل ۸ کاراکتر باشد.".to_string()));
        }

        // Check if username already taken
        let exists: Option<i64> = sqlx::query_scalar(
            "SELECT id FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1"
        )
        .bind(&clean_username)
        .fetch_optional(pool)
        .await?;

        if exists.is_some() {
            return Err(CoreError::BadRequest("این نام کاربری قبلاً ثبت شده است. لطفاً نام دیگری انتخاب کنید.".to_string()));
        }

        let password_hash = Self::hash_password_argon2(password)?;

        let user_uuid = Uuid::new_v4().to_string();
        let display_name = first_name.unwrap_or(clean_username.as_str());

        let user = sqlx::query_as::<_, User>(
            r#"
            INSERT INTO users (user_uuid, username, password_hash, first_name, role, status)
            VALUES (?, ?, ?, ?, 'user', 'active')
            RETURNING *
            "#
        )
        .bind(user_uuid)
        .bind(&clean_username)
        .bind(password_hash)
        .bind(display_name)
        .fetch_one(pool)
        .await?;

        let sub = Self::create_or_ensure_lite_subscription(pool, user.id).await?;
        Ok((user, sub))
    }

    /// Authenticate standalone user with username and password
    #[allow(dead_code)]
    pub async fn login_user_with_credentials(
        pool: &DbPool,
        username: &str,
        password: &str,
    ) -> Result<(User, Subscription), CoreError> {
        let clean_username = username.trim().to_lowercase();
        let user_opt = sqlx::query_as::<_, User>(
            "SELECT * FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1"
        )
        .bind(&clean_username)
        .fetch_optional(pool)
        .await?;

        let user = match user_opt {
            Some(u) => u,
            None => return Err(CoreError::AuthFailed("نام کاربری یا رمز عبور اشتباه است.".to_string())),
        };

        let hash = match &user.password_hash {
            Some(h) if !h.is_empty() => h,
            _ => return Err(CoreError::AuthFailed("برای این حساب کاربری رمز عبور ثبت نشده است. لطفاً از طریق ربات تلگرام یا کد یک‌بار مصرف وارد شوید.".to_string())),
        };

        let valid = Self::verify_password_hash(password, hash);

        if !valid {
            return Err(CoreError::AuthFailed("نام کاربری یا رمز عبور اشتباه است.".to_string()));
        }

        if user.status == "suspended" {
            return Err(CoreError::AccountSuspended("حساب کاربری شما موقتاً مسدود شده است. لطفاً با پشتیبانی در ارتباط باشید.".to_string()));
        }
        if user.status == "banned" {
            return Err(CoreError::AuthFailed("حساب کاربری شما مسدود شده است.".to_string()));
        }

        let mut sub = Self::create_or_ensure_lite_subscription(pool, user.id).await?;
        Self::check_and_reset_daily_quota(pool, &mut sub).await?;

        Ok((user, sub))
    }

    /// Generate 6-digit temporary account linking code (valid for 5 minutes)
    pub async fn generate_link_code(pool: &DbPool, user_id: i64) -> Result<String, CoreError> {
        let code: u32 = rand::thread_rng().gen_range(100_000..999_999);
        let link_code = format!("{:06}", code);

        sqlx::query(
            "UPDATE users SET link_code = ?, link_code_expires_at = datetime('now', '+300 seconds') WHERE id = ?"
        )
        .bind(&link_code)
        .bind(user_id)
        .execute(pool)
        .await?;

        Ok(link_code)
    }

    /// Link Telegram account to app account using 6-digit link code
    /// Hardened: checks neither account is suspended, takes MAX of quotas (no quota summing), enforces MAX 3 devices
    #[allow(dead_code)]
    pub async fn link_telegram_account_by_code(
        pool: &DbPool,
        telegram_id: i64,
        link_code: &str,
        first_name: &str,
        tg_username: Option<&str>,
    ) -> Result<User, CoreError> {
        let clean_code = link_code.trim();
        let target_user_opt = sqlx::query_as::<_, User>(
            "SELECT * FROM users WHERE link_code = ? AND link_code_expires_at > CURRENT_TIMESTAMP LIMIT 1"
        )
        .bind(clean_code)
        .fetch_optional(pool)
        .await?;

        let target_user = match target_user_opt {
            Some(u) => u,
            None => return Err(CoreError::BadRequest("کد اتصال نامعتبر است یا بیش از ۵ دقیقه از زمان صدور آن گذشته است.".to_string())),
        };

        // Security check: Target user must not be suspended or banned
        if target_user.status == "suspended" || target_user.status == "banned" {
            return Err(CoreError::AccountSuspended("حساب کاربری اپلیکیشن مسدود یا تعلیق شده است و امکان ادغام آن وجود ندارد.".to_string()));
        }

        if let Some(existing_tid) = target_user.telegram_id {
            if existing_tid != telegram_id {
                return Err(CoreError::BadRequest("این حساب کاربری قبلاً به حساب تلگرام دیگری متصل شده است.".to_string()));
            }
        }

        // Check if there is already an existing user for this telegram_id
        let existing_tg_user = sqlx::query_as::<_, User>(
            "SELECT * FROM users WHERE telegram_id = ? AND id != ? LIMIT 1"
        )
        .bind(telegram_id)
        .bind(target_user.id)
        .fetch_optional(pool)
        .await?;

        if let Some(old_u) = existing_tg_user {
            // Security check: Old user must not be suspended or banned
            if old_u.status == "suspended" || old_u.status == "banned" {
                return Err(CoreError::AccountSuspended("حساب کاربری تلگرام شما مسدود یا تعلیق شده است و امکان ادغام آن وجود ندارد.".to_string()));
            }

            let old_sub = Self::get_subscription_by_user_id(pool, old_u.id).await.ok().flatten();
            let target_sub = Self::get_subscription_by_user_id(pool, target_user.id).await.ok().flatten();

            if let (Some(os), Some(ts)) = (old_sub, target_sub) {
                // Tier resolution: highest tier preserved
                let higher_tier = if os.tier.contains("Flow") || ts.tier.contains("Flow") {
                    "Sentra Flow+"
                } else if os.tier.contains("Pro") || ts.tier.contains("Pro") {
                    "Sentra Pro"
                } else {
                    "Sentra Lite"
                };

                let higher_limit = os.traffic_limit_bytes.max(ts.traffic_limit_bytes);
                let higher_devices = os.max_concurrent_devices.max(ts.max_concurrent_devices).min(3);
                let later_expires = os.expires_at.max(ts.expires_at);

                // Anti-fraud: Quotas MUST NOT be summed! Take MAX(old_used, target_used)
                let max_web_mb = os.web_browsing_used_mb.max(ts.web_browsing_used_mb);
                let max_dl_mb = os.download_used_mb.max(ts.download_used_mb);
                let max_up_bytes = os.upload_bytes.max(ts.upload_bytes);
                let max_down_bytes = os.download_bytes.max(ts.download_bytes);

                // Update target_sub with the reconciled parameters
                sqlx::query(
                    r#"
                    UPDATE subscriptions
                    SET tier = ?,
                        traffic_limit_bytes = ?,
                        max_concurrent_devices = ?,
                        expires_at = ?,
                        web_browsing_used_mb = ?,
                        download_used_mb = ?,
                        upload_bytes = ?,
                        download_bytes = ?,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                    "#
                )
                .bind(higher_tier)
                .bind(higher_limit)
                .bind(higher_devices)
                .bind(later_expires)
                .bind(max_web_mb)
                .bind(max_dl_mb)
                .bind(max_up_bytes)
                .bind(max_down_bytes)
                .bind(ts.id)
                .execute(pool)
                .await?;

                // Delete old subscription
                let _ = sqlx::query("DELETE FROM subscriptions WHERE id = ?").bind(os.id).execute(pool).await;

                // Transfer devices to target_user and target_sub
                let _ = sqlx::query("UPDATE user_devices SET user_id = ?, subscription_id = ? WHERE user_id = ?")
                    .bind(target_user.id)
                    .bind(ts.id)
                    .bind(old_u.id)
                    .execute(pool)
                    .await;

                // Enforce strictly MAX 3 DEVICES (keep 3 most recent, delete excess)
                #[derive(sqlx::FromRow)]
                struct DevRow {
                    id: i64,
                }
                let user_devs: Vec<DevRow> = sqlx::query_as(
                    "SELECT id FROM user_devices WHERE user_id = ? ORDER BY last_active_at DESC"
                )
                .bind(target_user.id)
                .fetch_all(pool)
                .await
                .unwrap_or_default();

                if user_devs.len() > 3 {
                    for dev in &user_devs[3..] {
                        let _ = sqlx::query("DELETE FROM user_devices WHERE id = ?")
                            .bind(dev.id)
                            .execute(pool)
                            .await;
                    }
                }
            }

            // Transfer donations and outbounds to the unified user
            let _ = sqlx::query("UPDATE donations SET user_id = ? WHERE user_id = ?")
                .bind(target_user.id)
                .bind(old_u.id)
                .execute(pool)
                .await;

            let _ = sqlx::query("UPDATE donated_outbounds SET donor_user_id = ? WHERE donor_user_id = ?")
                .bind(target_user.id)
                .bind(old_u.id)
                .execute(pool)
                .await;

            let _ = sqlx::query("DELETE FROM users WHERE id = ?")
                .bind(old_u.id)
                .execute(pool)
                .await;
        }

        let updated_user = sqlx::query_as::<_, User>(
            r#"
            UPDATE users 
            SET telegram_id = ?, 
                first_name = COALESCE(NULLIF(first_name, 'User'), ?),
                username = COALESCE(username, ?),
                link_code = NULL, 
                link_code_expires_at = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            RETURNING *
            "#
        )
        .bind(telegram_id)
        .bind(first_name)
        .bind(tg_username)
        .bind(target_user.id)
        .fetch_one(pool)
        .await?;

        Ok(updated_user)
    }

    /// Set or update username and password for a user
    #[allow(dead_code)]
    pub async fn set_credentials_for_user(
        pool: &DbPool,
        user_id: i64,
        username: &str,
        password: &str,
    ) -> Result<(), CoreError> {
        let clean_username = username.trim().to_lowercase();
        if clean_username.len() < 3 || clean_username.len() > 32 {
            return Err(CoreError::BadRequest("نام کاربری باید بین ۳ تا ۳۲ کاراکتر باشد.".to_string()));
        }
        if !clean_username.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err(CoreError::BadRequest("نام کاربری فقط می‌تواند شامل حروف و اعداد انگلیسی و خط زیر (_) باشد.".to_string()));
        }
        if Self::RESERVED_USERNAMES.contains(&clean_username.as_str()) {
            return Err(CoreError::BadRequest("این نام کاربری رزرو شده و قابل انتخاب نیست.".to_string()));
        }
        if password.len() < 8 {
            return Err(CoreError::BadRequest("رمز عبور باید حداقل ۸ کاراکتر باشد.".to_string()));
        }

        let exists: Option<i64> = sqlx::query_scalar(
            "SELECT id FROM users WHERE LOWER(username) = LOWER(?) AND id != ? LIMIT 1"
        )
        .bind(&clean_username)
        .bind(user_id)
        .fetch_optional(pool)
        .await?;

        if exists.is_some() {
            return Err(CoreError::BadRequest("این نام کاربری قبلاً ثبت شده است.".to_string()));
        }

        let password_hash = Self::hash_password_argon2(password)?;

        sqlx::query(
            "UPDATE users SET username = ?, password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        )
        .bind(clean_username)
        .bind(password_hash)
        .bind(user_id)
        .execute(pool)
        .await?;

        Ok(())
    }

    // =========================================================================
    // Community Outbound Donation Methods
    // =========================================================================

    /// Check if an outbound with same fingerprint hash already exists in system
    pub async fn is_fingerprint_duplicate(
        pool: &DbPool,
        fingerprint: &str,
    ) -> Result<bool, CoreError> {
        let exists: Option<i64> = sqlx::query_scalar(
            "SELECT id FROM donated_outbounds WHERE fingerprint_sha256 = ? AND status != 'rejected' LIMIT 1"
        )
        .bind(fingerprint)
        .fetch_optional(pool)
        .await?;

        Ok(exists.is_some())
    }

    /// Check if a user is banned from outbound donation rewards
    pub async fn is_user_reward_banned(pool: &DbPool, user_id: i64) -> Result<bool, CoreError> {
        let banned: Option<i64> = sqlx::query_scalar(
            "SELECT outbound_reward_banned FROM users WHERE id = ? LIMIT 1"
        )
        .bind(user_id)
        .fetch_optional(pool)
        .await?;

        Ok(banned.unwrap_or(0) == 1)
    }

    /// Check if an outbound with same server and port already exists in system
    pub async fn is_outbound_duplicate(
        pool: &DbPool,
        server_address: &str,
        server_port: i64,
    ) -> Result<bool, CoreError> {
        let exists_official: Option<i64> = sqlx::query_scalar(
            "SELECT id FROM outbounds WHERE LOWER(server_address) = LOWER(?) AND server_port = ? LIMIT 1"
        )
        .bind(server_address)
        .bind(server_port)
        .fetch_optional(pool)
        .await?;

        if exists_official.is_some() {
            return Ok(true);
        }

        let exists_donated: Option<i64> = sqlx::query_scalar(
            "SELECT id FROM donated_outbounds WHERE LOWER(server_address) = LOWER(?) AND server_port = ? AND status != 'rejected' LIMIT 1"
        )
        .bind(server_address)
        .bind(server_port)
        .fetch_optional(pool)
        .await?;

        Ok(exists_donated.is_some())
    }

    /// Save a newly analyzed donated outbound with deep SHA-256 fingerprint
    #[allow(clippy::too_many_arguments)]
    pub async fn save_donated_outbound(
        pool: &DbPool,
        donor_user_id: Option<i64>,
        tag: &str,
        protocol: &str,
        server_address: &str,
        server_port: i64,
        config_json: &str,
        latency_ms: i64,
        speed_mbps: f64,
        assigned_tier: &str,
        status: &str,
        raw_link: Option<&str>,
        rejection_reason: Option<&str>,
        declared_or_detected_gb: i64,
        fingerprint_sha256: Option<&str>,
        country_code: &str,
        country_name: &str,
    ) -> Result<DonatedOutbound, CoreError> {
        let row = sqlx::query_as::<_, DonatedOutbound>(
            r#"
            INSERT INTO donated_outbounds (
                donor_user_id, tag, protocol, server_address, server_port, config_json,
                latency_ms, speed_mbps, assigned_tier, health_score, status, raw_link,
                rejection_reason, declared_or_detected_gb, bytes_served, monthly_reward_granted,
                fingerprint_sha256, country_code, country_name, last_checked_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 100, ?, ?, ?, ?, 0, 0, ?, ?, ?, CURRENT_TIMESTAMP)
            RETURNING *
            "#
        )
        .bind(donor_user_id)
        .bind(tag)
        .bind(protocol)
        .bind(server_address)
        .bind(server_port)
        .bind(config_json)
        .bind(latency_ms)
        .bind(speed_mbps)
        .bind(assigned_tier)
        .bind(status)
        .bind(raw_link)
        .bind(rejection_reason)
        .bind(declared_or_detected_gb)
        .bind(fingerprint_sha256)
        .bind(country_code)
        .bind(country_name)
        .fetch_one(pool)
        .await?;

        Ok(row)
    }

    /// Record bytes served on active donated outbounds for this mode, and trigger 30-day Pro reward on first real usage if capacity > 200 GB
    pub async fn record_donated_outbound_usage(
        pool: &DbPool,
        mode: &str,
        delta_bytes: i64,
        bot_opt: Option<&teloxide::Bot>,
    ) -> Result<(), CoreError> {
        let active_donated = Self::get_active_donated_outbounds_for_mode(pool, mode).await.unwrap_or_default();
        for ob in active_donated {
            // 1. Update bytes_served and set first_used_at on first real traffic report
            let _ = sqlx::query(
                r#"
                UPDATE donated_outbounds
                SET bytes_served = bytes_served + ?,
                    first_used_at = COALESCE(first_used_at, CURRENT_TIMESTAMP),
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                "#
            )
            .bind(delta_bytes)
            .bind(ob.id)
            .execute(pool)
            .await;

            // 2. Check reward trigger: community outbounds with capacity > 200 GB & not yet rewarded
            if ob.is_official == 0 && ob.declared_or_detected_gb > 200 && ob.monthly_reward_granted == 0 {
                if let Some(donor_uid) = ob.donor_user_id {
                    let is_banned = Self::is_user_reward_banned(pool, donor_uid).await.unwrap_or(false);
                    if !is_banned {
                        let _ = Self::upgrade_subscription_30_days(pool, donor_uid, "Sentra Pro").await;
                        let _ = sqlx::query("UPDATE donated_outbounds SET monthly_reward_granted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
                            .bind(ob.id)
                            .execute(pool)
                            .await;

                        if let Some(bot) = bot_opt {
                            if let Ok(Some(donor_user)) = Self::get_user_by_id(pool, donor_uid).await {
                                if let Some(tid) = donor_user.telegram_id {
                                    use teloxide::prelude::*;
                                    use teloxide::types::{ChatId, ParseMode};
                                    let msg_text = format!(
                                        r#"🎉 <b>اوتباند اهدایی شما (بالای ۲۰۰ گیگابایت) با موفقیت وارد چرخه استفاده شد!</b>

به پاس حمایت شما از شبکه ضدسانسور Sentra، <b>اشتراک رایگان ماهانه (۳۰ روزه Sentra Pro)</b> روی حساب شما فعال گردید. ❤️

📊 <b>مشخصات اوتباند فعال‌شده:</b>
• برچسب نود: <code>{}</code>
• پروتکل: <code>{}</code>
• ظرفیت تاییدشده: <b>{} گیگابایت</b>"#,
                                        ob.tag, ob.protocol, ob.declared_or_detected_gb
                                    );
                                    let _ = bot.send_message(ChatId(tid), msg_text).parse_mode(ParseMode::Html).await;
                                }
                            }
                        }
                    }
                }
            }
        }
        Ok(())
    }

    // =========================================================================
    // Financial Support / Donations Methods
    // =========================================================================

    /// Check if a receipt file or image hash was already submitted (Anti-Replay)
    pub async fn is_receipt_replay(
        pool: &DbPool,
        file_unique_id: &str,
        image_sha256: &str,
    ) -> Result<bool, CoreError> {
        let exists: Option<i64> = sqlx::query_scalar(
            "SELECT id FROM donations WHERE file_unique_id = ? OR image_sha256 = ? LIMIT 1"
        )
        .bind(file_unique_id)
        .bind(image_sha256)
        .fetch_optional(pool)
        .await?;

        Ok(exists.is_some())
    }

    /// Create a pending donation entry with unique file ID and image hash
    pub async fn create_donation(
        pool: &DbPool,
        user_id: i64,
        amount: i64,
        receipt_file_id: &str,
        file_unique_id: Option<&str>,
        image_sha256: Option<&str>,
    ) -> Result<Donation, CoreError> {
        let row = sqlx::query_as::<_, Donation>(
            r#"
            INSERT INTO donations (user_id, amount, receipt_file_id, file_unique_id, image_sha256, status, subscription_granted, created_at)
            VALUES (?, ?, ?, ?, ?, 'pending', 0, CURRENT_TIMESTAMP)
            RETURNING *
            "#
        )
        .bind(user_id)
        .bind(amount)
        .bind(receipt_file_id)
        .bind(file_unique_id)
        .bind(image_sha256)
        .fetch_one(pool)
        .await?;

        Ok(row)
    }

    /// Get donation by id
    pub async fn get_donation_by_id(pool: &DbPool, donation_id: i64) -> Result<Option<Donation>, CoreError> {
        let row = sqlx::query_as::<_, Donation>("SELECT * FROM donations WHERE id = ? LIMIT 1")
            .bind(donation_id)
            .fetch_optional(pool)
            .await?;
        Ok(row)
    }

    /// Approve a donation, optionally granting 30 days of Sentra Pro
    pub async fn approve_donation(
        pool: &DbPool,
        donation_id: i64,
        grant_pro: bool,
    ) -> Result<Donation, CoreError> {
        let donation = Self::get_donation_by_id(pool, donation_id).await?
            .ok_or_else(|| CoreError::BadRequest("تراکنش حمایت مالی یافت نشد.".to_string()))?;

        if grant_pro {
            let _ = Self::upgrade_subscription_30_days(pool, donation.user_id, "Sentra Pro").await?;
        }

        let updated = sqlx::query_as::<_, Donation>(
            r#"
            UPDATE donations
            SET status = 'approved',
                subscription_granted = ?
            WHERE id = ?
            RETURNING *
            "#
        )
        .bind(if grant_pro { 1 } else { 0 })
        .bind(donation_id)
        .fetch_one(pool)
        .await?;

        Ok(updated)
    }

    /// Reject a donation
    pub async fn reject_donation(
        pool: &DbPool,
        donation_id: i64,
    ) -> Result<Donation, CoreError> {
        let updated = sqlx::query_as::<_, Donation>(
            r#"
            UPDATE donations
            SET status = 'rejected'
            WHERE id = ?
            RETURNING *
            "#
        )
        .bind(donation_id)
        .fetch_one(pool)
        .await?;

        Ok(updated)
    }

    /// Reward a donor user with 1 day of Sentra Pro tier gift
    #[allow(dead_code)]
    pub async fn reward_donor_user(pool: &DbPool, donor_user_id: i64) -> Result<(), CoreError> {
        let sub_opt = Self::get_subscription_by_user_id(pool, donor_user_id).await.ok().flatten();
        if let Some(sub) = sub_opt {
            let new_tier = if sub.tier == "Sentra Lite" { "Sentra Pro" } else { &sub.tier };
            sqlx::query(
                r#"
                UPDATE subscriptions 
                SET tier = ?,
                    expires_at = datetime(MAX(expires_at, CURRENT_TIMESTAMP), '+1 day'),
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                "#
            )
            .bind(new_tier)
            .bind(sub.id)
            .execute(pool)
            .await?;
        }
        Ok(())
    }

    /// Retrieve active donated outbounds for a specific connection mode
    pub async fn get_active_donated_outbounds_for_mode(
        pool: &DbPool,
        mode: &str,
    ) -> Result<Vec<DonatedOutbound>, CoreError> {
        let rows = sqlx::query_as::<_, DonatedOutbound>(
            "SELECT * FROM donated_outbounds WHERE status = 'active' AND assigned_tier = ? ORDER BY health_score DESC, speed_mbps DESC LIMIT 10"
        )
        .bind(mode)
        .fetch_all(pool)
        .await?;

        Ok(rows)
    }

    /// Retrieve all active donated outbounds for periodic 30-minute health checking
    pub async fn get_all_active_donated_outbounds(pool: &DbPool) -> Result<Vec<DonatedOutbound>, CoreError> {
        let rows = sqlx::query_as::<_, DonatedOutbound>(
            "SELECT * FROM donated_outbounds WHERE status = 'active'"
        )
        .fetch_all(pool)
        .await?;

        Ok(rows)
    }

    /// Update health check result for a donated outbound
    #[allow(dead_code)]
    pub async fn update_donated_outbound_health(
        pool: &DbPool,
        id: i64,
        latency_ms: i64,
        is_up: bool,
    ) -> Result<(), CoreError> {
        if is_up {
            sqlx::query(
                r#"
                UPDATE donated_outbounds 
                SET latency_ms = ?, 
                    fail_count = 0, 
                    health_score = MIN(100, health_score + 5),
                    offline_since = NULL,
                    last_checked_at = CURRENT_TIMESTAMP 
                WHERE id = ?
                "#
            )
            .bind(latency_ms)
            .bind(id)
            .execute(pool)
            .await?;
        } else {
            sqlx::query(
                r#"
                UPDATE donated_outbounds 
                SET fail_count = fail_count + 1,
                    health_score = MAX(0, health_score - 20),
                    offline_since = COALESCE(offline_since, CURRENT_TIMESTAMP),
                    status = CASE WHEN fail_count >= 2 THEN 'inactive' ELSE status END,
                    last_checked_at = CURRENT_TIMESTAMP 
                WHERE id = ?
                "#
            )
            .bind(id)
            .execute(pool)
            .await?;
        }
        Ok(())
    }

    /// Retrieve rewarded outbounds for monitoring 7-day stability & clawback eligibility
    pub async fn get_rewarded_donated_outbounds_for_clawback(pool: &DbPool) -> Result<Vec<DonatedOutbound>, CoreError> {
        let rows = sqlx::query_as::<_, DonatedOutbound>(
            r#"
            SELECT * FROM donated_outbounds 
            WHERE monthly_reward_granted = 1 
              AND clawback_executed = 0 
              AND donor_user_id IS NOT NULL 
              AND first_used_at IS NOT NULL
              AND is_official = 0
            "#
        )
        .fetch_all(pool)
        .await?;

        Ok(rows)
    }

    /// Execute clawback for an outbound that died within 7 days of reward
    pub async fn execute_outbound_clawback(
        pool: &DbPool,
        outbound_id: i64,
        donor_user_id: i64,
    ) -> Result<bool, CoreError> {
        // 1. Mark clawback executed on outbound
        sqlx::query("UPDATE donated_outbounds SET clawback_executed = 1, status = 'inactive' WHERE id = ?")
            .bind(outbound_id)
            .execute(pool)
            .await?;

        // 2. Ban user from future outbound donation rewards
        sqlx::query("UPDATE users SET outbound_reward_banned = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
            .bind(donor_user_id)
            .execute(pool)
            .await?;

        // 3. Revoke granted Pro subscription (downgrade to Sentra Lite)
        let sub = Self::get_subscription_by_user_id(pool, donor_user_id).await.ok().flatten();
        if let Some(s) = sub {
            if s.tier.contains("Pro") {
                sqlx::query(
                    r#"
                    UPDATE subscriptions
                    SET tier = 'Sentra Lite',
                        traffic_limit_bytes = 21474836480,
                        max_concurrent_devices = 3,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                    "#
                )
                .bind(s.id)
                .execute(pool)
                .await?;
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Reset static IP quota (30 GB) for user
    pub async fn reset_user_static_ip_quota(pool: &DbPool, user_id: i64) -> Result<(), CoreError> {
        sqlx::query(
            "UPDATE subscriptions SET static_ip_used_mb = 0, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?"
        )
        .bind(user_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Retrieve all active Telegram IDs for broadcasting
    pub async fn get_all_active_telegram_ids(pool: &DbPool) -> Result<Vec<i64>, CoreError> {
        let ids: Vec<i64> = sqlx::query_scalar("SELECT telegram_id FROM users WHERE status != 'banned' AND telegram_id IS NOT NULL")
            .fetch_all(pool)
            .await?;
        Ok(ids)
    }

    /// Upsert an app release for a given platform ('windows' or 'android')
    pub async fn upsert_app_release(
        pool: &DbPool,
        platform: &str,
        version: &str,
        telegram_file_id: &str,
        _file_name: &str,
        _file_size_mb: f64,
        changelog: &str,
    ) -> Result<AppRelease, CoreError> {
        sqlx::query(
            "INSERT OR IGNORE INTO app_releases (id, version, changelog) VALUES (1, ?, ?)",
        )
        .bind(version)
        .bind(changelog)
        .execute(pool)
        .await?;

        if platform == "windows" {
            sqlx::query(
                r#"
                UPDATE app_releases
                SET version = ?, changelog = ?, windows_file_id = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = 1
                "#,
            )
            .bind(version)
            .bind(changelog)
            .bind(telegram_file_id)
            .execute(pool)
            .await?;
        } else if platform == "android" {
            sqlx::query(
                r#"
                UPDATE app_releases
                SET version = ?, changelog = ?, android_file_id = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = 1
                "#,
            )
            .bind(version)
            .bind(changelog)
            .bind(telegram_file_id)
            .execute(pool)
            .await?;
        }

        Self::get_latest_app_release(pool)
            .await?
            .ok_or_else(|| CoreError::Database(sqlx::Error::RowNotFound))
    }

    /// Get an app release by platform ('windows' or 'android')
    #[allow(dead_code)]
    pub async fn get_app_release_by_platform(
        pool: &DbPool,
        _platform: &str,
    ) -> Result<Option<AppRelease>, CoreError> {
        Self::get_latest_app_release(pool).await
    }

    /// Get all app releases
    #[allow(dead_code)]
    pub async fn get_all_app_releases(
        pool: &DbPool,
    ) -> Result<Vec<AppRelease>, CoreError> {
        let releases = sqlx::query_as::<_, AppRelease>(
            r#"
            SELECT id, version, changelog, windows_file_id, windows_github_url, android_file_id, android_github_url, updated_at
            FROM app_releases
            ORDER BY id DESC
            "#,
        )
        .fetch_all(pool)
        .await?;

        Ok(releases)
    }

    /// Insert or update an official outbound node added by admin
    #[allow(clippy::too_many_arguments)]
    pub async fn insert_official_outbound(
        pool: &DbPool,
        label: &str,
        tag: &str,
        protocol: &str,
        server_address: &str,
        server_port: i64,
        config_json: &str,
        latency_ms: i64,
        speed_mbps: f64,
        category: &str,
        raw_link: Option<&str>,
        fingerprint_sha256: &str,
        status: &str,
        health_score: i64,
        country_code: &str,
        country_name: &str,
    ) -> Result<DonatedOutbound, CoreError> {
        let (allow_web, allow_download, allow_static_ip, alloc_mode, assigned_tier) = match category {
            "gaming" => (0, 0, 0, "gaming", "gaming"),
            "free_only" => (1, 1, 0, "free_only", "web_browsing"),
            "static_only" | "static_ip" => (0, 0, 1, "static_only", "static_ip"),
            "both" => (1, 1, 1, "both", "static_ip"),
            "auto" => (1, 1, 0, "auto", "web_browsing"),
            "download" => (0, 1, 0, "free_only", "download"),
            _ => (1, 0, 0, "free_only", "web_browsing"),
        };
        let speed_score = (60 - (latency_ms / 20)).clamp(10, 100);

        sqlx::query(
            r#"
            INSERT INTO donated_outbounds (
                donor_user_id, tag, protocol, server_address, server_port,
                config_json, latency_ms, speed_mbps, assigned_tier, health_score,
                status, fail_count, reward_granted, raw_link, rejection_reason,
                declared_or_detected_gb, bytes_served, first_used_at, monthly_reward_granted,
                fingerprint_sha256, offline_since, clawback_executed, is_official, label,
                country_code, country_name, last_checked_at, created_at, updated_at,
                allow_web, allow_download, allow_static_ip, gemini_ok, trading_safe,
                speed_score, jitter_ms, last_online_at, allocation_mode
            )
            VALUES (
                NULL, ?, ?, ?, ?,
                ?, ?, ?, ?, ?,
                ?, 0, 0, ?, NULL,
                10000, 0, NULL, 0,
                ?, NULL, 0, 1, ?,
                ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
                ?, ?, ?, 0, 0,
                ?, 0, CURRENT_TIMESTAMP, ?
            )
            ON CONFLICT(fingerprint_sha256) DO UPDATE SET
                label = excluded.label,
                tag = excluded.tag,
                protocol = excluded.protocol,
                server_address = excluded.server_address,
                server_port = excluded.server_port,
                config_json = excluded.config_json,
                latency_ms = excluded.latency_ms,
                speed_mbps = excluded.speed_mbps,
                assigned_tier = excluded.assigned_tier,
                health_score = excluded.health_score,
                status = excluded.status,
                raw_link = excluded.raw_link,
                is_official = 1,
                country_code = excluded.country_code,
                country_name = excluded.country_name,
                allow_web = excluded.allow_web,
                allow_download = excluded.allow_download,
                allow_static_ip = excluded.allow_static_ip,
                speed_score = excluded.speed_score,
                allocation_mode = excluded.allocation_mode,
                last_online_at = CURRENT_TIMESTAMP,
                last_checked_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            "#,
        )
        .bind(tag)
        .bind(protocol)
        .bind(server_address)
        .bind(server_port)
        .bind(config_json)
        .bind(latency_ms)
        .bind(speed_mbps)
        .bind(assigned_tier)
        .bind(health_score)
        .bind(status)
        .bind(raw_link)
        .bind(fingerprint_sha256)
        .bind(label)
        .bind(country_code)
        .bind(country_name)
        .bind(allow_web)
        .bind(allow_download)
        .bind(allow_static_ip)
        .bind(speed_score)
        .bind(alloc_mode)
        .execute(pool)
        .await?;

        let row = sqlx::query_as::<_, DonatedOutbound>(
            "SELECT * FROM donated_outbounds WHERE fingerprint_sha256 = ?"
        )
        .bind(fingerprint_sha256)
        .fetch_one(pool)
        .await?;

        Ok(row)
    }

    /// Update allocation settings for an outbound
    pub async fn update_outbound_allocation(
        pool: &DbPool,
        id: i64,
        allow_web: bool,
        allow_download: bool,
        allow_static_ip: bool,
        allocation_mode: &str,
    ) -> Result<(), CoreError> {
        let assigned_tier = if allocation_mode == "gaming" {
            "gaming"
        } else if allow_static_ip {
            "static_ip"
        } else if allow_download && !allow_web {
            "download"
        } else {
            "web_browsing"
        };

        sqlx::query(
            r#"
            UPDATE donated_outbounds
            SET allow_web = ?,
                allow_download = ?,
                allow_static_ip = ?,
                allocation_mode = ?,
                assigned_tier = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            "#
        )
        .bind(if allow_web { 1 } else { 0 })
        .bind(if allow_download { 1 } else { 0 })
        .bind(if allow_static_ip { 1 } else { 0 })
        .bind(allocation_mode)
        .bind(assigned_tier)
        .bind(id)
        .execute(pool)
        .await?;

        Ok(())
    }

    /// Update full quality metrics from quality engine benchmark with EMA smoothing and 3-strike degraded status
    #[allow(clippy::too_many_arguments)]
    pub async fn update_outbound_quality_metrics(
        pool: &DbPool,
        id: i64,
        latency_ms: i64,
        jitter_ms: i64,
        speed_mbps: f64,
        speed_score: i64,
        old_quality_score: i64,
        gemini_ok: bool,
        trading_safe: bool,
        is_up: bool,
    ) -> Result<i64, CoreError> {
        let g_val = if gemini_ok { 1 } else { 0 };
        let t_val = if trading_safe { 1 } else { 0 };

        let quality_score = if is_up {
            // Smart EMA formula: new_score = 0.7 * old_score + 0.3 * current_sample_score
            let ema_base = if old_quality_score > 0 {
                (0.7 * (old_quality_score as f64) + 0.3 * (speed_score as f64)).round() as i64
            } else {
                speed_score
            };
            let mut final_score = ema_base.clamp(1, 100);
            if gemini_ok && trading_safe {
                final_score = (final_score + 5).min(100);
            }
            final_score
        } else {
            0
        };

        if is_up {
            sqlx::query(
                r#"
                UPDATE donated_outbounds
                SET latency_ms = ?,
                    jitter_ms = ?,
                    speed_mbps = ?,
                    speed_score = ?,
                    quality_score = ?,
                    gemini_ok = ?,
                    trading_safe = ?,
                    fail_count = 0,
                    health_score = MIN(100, health_score + 5),
                    offline_since = NULL,
                    last_online_at = CURRENT_TIMESTAMP,
                    last_checked_at = CURRENT_TIMESTAMP,
                    status = 'active',
                    allow_static_ip = CASE 
                        WHEN allocation_mode = 'auto' AND ? = 1 AND ? = 1 THEN 1
                        WHEN allocation_mode = 'auto' AND (? = 0 OR ? = 0) THEN 0
                        ELSE allow_static_ip
                    END,
                    assigned_tier = CASE
                        WHEN allocation_mode = 'auto' AND ? = 1 AND ? = 1 THEN 'static_ip'
                        ELSE assigned_tier
                    END
                WHERE id = ?
                "#
            )
            .bind(latency_ms)
            .bind(jitter_ms)
            .bind(speed_mbps)
            .bind(speed_score)
            .bind(quality_score)
            .bind(g_val)
            .bind(t_val)
            .bind(g_val)
            .bind(t_val)
            .bind(g_val)
            .bind(t_val)
            .bind(g_val)
            .bind(t_val)
            .bind(id)
            .execute(pool)
            .await?;
        } else {
            // If failed in 3 consecutive tests, immediately mark as 'degraded' (pulling out of active pool)
            sqlx::query(
                r#"
                UPDATE donated_outbounds
                SET fail_count = fail_count + 1,
                    health_score = MAX(0, health_score - 20),
                    quality_score = 0,
                    offline_since = COALESCE(offline_since, CURRENT_TIMESTAMP),
                    status = CASE WHEN (fail_count + 1) >= 3 THEN 'degraded' ELSE status END,
                    last_checked_at = CURRENT_TIMESTAMP
                WHERE id = ?
                "#
            )
            .bind(id)
            .execute(pool)
            .await?;
        }

        Ok(quality_score)
    }

    /// Automatically clean up dead outbounds older than 48 hours without successful response
    pub async fn cleanup_dead_outbounds(pool: &DbPool) -> Result<Vec<DonatedOutbound>, CoreError> {
        let dead_nodes = sqlx::query_as::<_, DonatedOutbound>(
            r#"
            SELECT * FROM donated_outbounds
            WHERE (last_online_at IS NOT NULL AND last_online_at < datetime('now', '-48 hours'))
               OR (last_online_at IS NULL AND created_at < datetime('now', '-48 hours') AND status IN ('inactive', 'degraded'))
            "#
        )
        .fetch_all(pool)
        .await?;

        if !dead_nodes.is_empty() {
            for node in &dead_nodes {
                let _ = sqlx::query("DELETE FROM donated_outbounds WHERE id = ?")
                    .bind(node.id)
                    .execute(pool)
                    .await?;
            }
        }

        Ok(dead_nodes)
    }

    /// Periodically cleans up expired/used password reset codes, auth codes, and telegram link codes
    pub async fn cleanup_expired_codes(pool: &DbPool) -> Result<(u64, u64, u64), CoreError> {
        // 1. Delete expired or used password reset codes older than 1 hour past expiration or 24 hours after use
        let pr_res = sqlx::query(
            "DELETE FROM password_resets WHERE expires_at < datetime('now', '-1 hour') OR (used = 1 AND created_at < datetime('now', '-24 hours'))"
        )
        .execute(pool)
        .await
        .map_err(CoreError::Database)?;

        // 2. Clear expired auth codes
        let ac_res = sqlx::query(
            "UPDATE users SET auth_code = NULL, auth_code_expires_at = NULL WHERE auth_code_expires_at IS NOT NULL AND auth_code_expires_at < datetime('now')"
        )
        .execute(pool)
        .await
        .map_err(CoreError::Database)?;

        // 3. Clear expired link codes (Telegram verification)
        let lc_res = sqlx::query(
            "UPDATE users SET link_code = NULL, link_code_expires_at = NULL WHERE link_code_expires_at IS NOT NULL AND link_code_expires_at < datetime('now')"
        )
        .execute(pool)
        .await
        .map_err(CoreError::Database)?;

        Ok((pr_res.rows_affected(), ac_res.rows_affected(), lc_res.rows_affected()))
    }

    /// Retrieve any donated or official outbound by ID
    #[allow(dead_code)]
    pub async fn get_donated_outbound_by_id(
        pool: &DbPool,
        id: i64,
    ) -> Result<Option<DonatedOutbound>, CoreError> {
        let row = sqlx::query_as::<_, DonatedOutbound>(
            "SELECT * FROM donated_outbounds WHERE id = ?"
        )
        .bind(id)
        .fetch_optional(pool)
        .await?;
        Ok(row)
    }

    /// Retrieve official outbounds registered for a specific category ('web_browsing', 'download', 'static_ip')
    pub async fn get_official_outbounds_by_category(
        pool: &DbPool,
        category: &str,
    ) -> Result<Vec<DonatedOutbound>, CoreError> {
        let filter_col = match category {
            "gaming" => "assigned_tier = 'gaming'",
            "static_ip" | "static_only" => "allow_static_ip = 1",
            "download" => "allow_download = 1",
            _ => "allow_web = 1",
        };

        let query = format!(
            r#"
            SELECT * FROM donated_outbounds 
            WHERE is_official = 1 AND ({} OR assigned_tier = ?) 
            ORDER BY speed_score DESC, latency_ms ASC, id DESC
            "#,
            filter_col
        );

        let rows = sqlx::query_as::<_, DonatedOutbound>(&query)
            .bind(category)
            .fetch_all(pool)
            .await?;
        Ok(rows)
    }

    /// Retrieve all official outbounds
    #[allow(dead_code)]
    pub async fn get_all_official_outbounds(
        pool: &DbPool,
    ) -> Result<Vec<DonatedOutbound>, CoreError> {
        let rows = sqlx::query_as::<_, DonatedOutbound>(
            "SELECT * FROM donated_outbounds WHERE is_official = 1 ORDER BY speed_score DESC, latency_ms ASC, id DESC"
        )
        .fetch_all(pool)
        .await?;
        Ok(rows)
    }

    /// Retrieve a single official outbound by ID
    pub async fn get_official_outbound_by_id(
        pool: &DbPool,
        id: i64,
    ) -> Result<Option<DonatedOutbound>, CoreError> {
        let row = sqlx::query_as::<_, DonatedOutbound>(
            "SELECT * FROM donated_outbounds WHERE id = ? AND is_official = 1"
        )
        .bind(id)
        .fetch_optional(pool)
        .await?;
        Ok(row)
    }

    /// Toggle official outbound status between active and inactive
    pub async fn toggle_official_outbound_status(
        pool: &DbPool,
        id: i64,
    ) -> Result<String, CoreError> {
        sqlx::query(
            r#"
            UPDATE donated_outbounds 
            SET status = CASE WHEN status = 'active' THEN 'inactive' ELSE 'active' END,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND is_official = 1
            "#
        )
        .bind(id)
        .execute(pool)
        .await?;

        let status: String = sqlx::query_scalar("SELECT status FROM donated_outbounds WHERE id = ?")
            .bind(id)
            .fetch_one(pool)
            .await?;
        Ok(status)
    }

    /// Delete an official outbound
    pub async fn delete_official_outbound(
        pool: &DbPool,
        id: i64,
    ) -> Result<bool, CoreError> {
        let res = sqlx::query("DELETE FROM donated_outbounds WHERE id = ? AND is_official = 1")
            .bind(id)
            .execute(pool)
            .await?;
        Ok(res.rows_affected() > 0)
    }

    /// Update official outbound benchmark results
    #[allow(dead_code)]
    pub async fn update_official_outbound_benchmark(
        pool: &DbPool,
        id: i64,
        latency_ms: i64,
        speed_mbps: f64,
        is_online: bool,
    ) -> Result<(), CoreError> {
        let status = if is_online { "active" } else { "inactive" };
        let health_score = if is_online { 100 } else { 0 };
        sqlx::query(
            r#"
            UPDATE donated_outbounds
            SET latency_ms = ?,
                speed_mbps = ?,
                status = ?,
                health_score = ?,
                last_checked_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND is_official = 1
            "#
        )
        .bind(latency_ms)
        .bind(speed_mbps)
        .bind(status)
        .bind(health_score)
        .bind(id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Retrieve active official outbounds for static_ip mode (and community nodes qualified for static_ip)
    pub async fn get_active_official_outbounds_for_mode(
        pool: &DbPool,
        mode: &str,
    ) -> Result<Vec<DonatedOutbound>, CoreError> {
        let (filter_col, official_cond) = if mode == "static_ip" {
            // Include official static outbounds and all nodes qualified for static_ip (e.g. gemini/trading passed)
            ("(allow_static_ip = 1 OR assigned_tier = 'static_ip')", "")
        } else if mode == "download" {
            ("(allow_download = 1 OR assigned_tier = 'download')", "AND is_official = 1")
        } else {
            ("(allow_web = 1 OR assigned_tier = 'web_browsing')", "AND is_official = 1")
        };

        let query = format!(
            r#"
            SELECT * FROM donated_outbounds 
            WHERE status = 'active' AND {} {}
            ORDER BY is_official DESC, speed_score DESC, latency_ms ASC, health_score DESC
            "#,
            filter_col, official_cond
        );

        let rows = sqlx::query_as::<_, DonatedOutbound>(&query)
            .fetch_all(pool)
            .await?;
        Ok(rows)
    }

    /// Retrieve active outbounds for client modes (web_browsing and download), prioritizing official outbounds
    pub async fn get_active_outbounds_for_mode_prioritized(
        pool: &DbPool,
        mode: &str,
    ) -> Result<Vec<DonatedOutbound>, CoreError> {
        let filter_col = match mode {
            "static_ip" => "(allow_static_ip = 1 OR assigned_tier = 'static_ip')",
            "download" => "(allow_download = 1 OR assigned_tier = 'download')",
            _ => "(allow_web = 1 OR assigned_tier = 'web_browsing')",
        };

        let query = format!(
            r#"
            SELECT * FROM donated_outbounds 
            WHERE status = 'active' AND latency_ms < 2500 AND {}
            ORDER BY quality_score DESC, latency_ms ASC, is_official DESC, speed_score DESC, health_score DESC
            LIMIT 15
            "#,
            filter_col
        );

        let rows = sqlx::query_as::<_, DonatedOutbound>(&query)
            .fetch_all(pool)
            .await?;
        Ok(rows)
    }

    /// Retrieve active outbounds for a mode and optional location code (with auto fallback)
    pub async fn get_active_outbounds_for_mode_and_location(
        pool: &DbPool,
        mode: &str,
        location_code: Option<&str>,
    ) -> Result<Vec<DonatedOutbound>, CoreError> {
        let code = location_code.unwrap_or("auto").trim();
        let filter_col = match mode {
            "static_ip" => "(allow_static_ip = 1 OR assigned_tier = 'static_ip')",
            "download" => "(allow_download = 1 OR assigned_tier = 'download')",
            _ => "(allow_web = 1 OR assigned_tier = 'web_browsing')",
        };

        if !code.is_empty() && !code.eq_ignore_ascii_case("auto") {
            let query = format!(
                r#"
                SELECT * FROM donated_outbounds 
                WHERE status = 'active' AND latency_ms < 2500 AND {} AND UPPER(country_code) = UPPER(?)
                ORDER BY quality_score DESC, latency_ms ASC, is_official DESC, speed_score DESC, health_score DESC
                LIMIT 15
                "#,
                filter_col
            );

            let loc_rows = sqlx::query_as::<_, DonatedOutbound>(&query)
                .bind(code)
                .fetch_all(pool)
                .await?;

            if !loc_rows.is_empty() {
                return Ok(loc_rows);
            }
        }

        // Default or fallback to fastest active nodes
        Self::get_active_outbounds_for_mode_prioritized(pool, mode).await
    }

    /// Retrieve active locations list for client location switcher
    pub async fn get_active_locations_for_free_modes(
        pool: &DbPool,
    ) -> Result<Vec<crate::models::ActiveLocationInfo>, CoreError> {
        use sqlx::Row;

        let rows = sqlx::query(
            r#"
            SELECT 
                country_code,
                country_name,
                MIN(latency_ms) as min_ping,
                COUNT(*) as active_count
            FROM donated_outbounds
            WHERE status = 'active' 
              AND (allow_web = 1 OR allow_download = 1 OR assigned_tier IN ('web_browsing', 'download'))
              AND country_code != 'XX'
            GROUP BY country_code, country_name
            HAVING active_count > 0
            ORDER BY min_ping ASC
            "#
        )
        .fetch_all(pool)
        .await
        .unwrap_or_default();

        let mut locations = Vec::new();
        let mut total_active_nodes = 0i64;
        let mut best_auto_ping = 45i64;

        for (idx, r) in rows.iter().enumerate() {
            let code: String = r.try_get("country_code").unwrap_or_else(|_| "XX".to_string());
            let name_raw: String = r.try_get("country_name").unwrap_or_else(|_| "Unknown".to_string());
            let ping: i64 = r.try_get("min_ping").unwrap_or(99);
            let count: i64 = r.try_get("active_count").unwrap_or(1);

            total_active_nodes += count;
            if idx == 0 {
                best_auto_ping = ping;
            }

            let name = if name_raw.is_empty() || name_raw == "Unknown" {
                crate::outbound_analyzer::OutboundAnalyzer::country_code_to_name(&code)
            } else {
                name_raw
            };
            let flag = crate::outbound_analyzer::OutboundAnalyzer::country_code_to_flag(&code);

            locations.push(crate::models::ActiveLocationInfo {
                code: code.clone(),
                name,
                country_code: code,
                flag,
                ping_ms: ping,
                active_nodes: count,
                is_auto: false,
            });
        }

        // Add Auto option as the very first choice
        let mut final_locations = Vec::new();
        final_locations.push(crate::models::ActiveLocationInfo {
            code: "auto".to_string(),
            name: "⚡️ انتخاب خودکار سریع‌ترین لوکیشن (Auto)".to_string(),
            country_code: "AUTO".to_string(),
            flag: "⚡️".to_string(),
            ping_ms: best_auto_ping,
            active_nodes: total_active_nodes.max(1),
            is_auto: true,
        });
        final_locations.extend(locations);

        // If no locations configured yet in local dev environment, provide default fast locations
        if final_locations.len() <= 1 {
            final_locations.push(crate::models::ActiveLocationInfo {
                code: "DE".to_string(),
                name: "آلمان 🇩🇪".to_string(),
                country_code: "DE".to_string(),
                flag: "🇩🇪".to_string(),
                ping_ms: 48,
                active_nodes: 3,
                is_auto: false,
            });
            final_locations.push(crate::models::ActiveLocationInfo {
                code: "NL".to_string(),
                name: "هلند 🇳🇱".to_string(),
                country_code: "NL".to_string(),
                flag: "🇳🇱".to_string(),
                ping_ms: 62,
                active_nodes: 2,
                is_auto: false,
            });
            final_locations.push(crate::models::ActiveLocationInfo {
                code: "FI".to_string(),
                name: "فنلاند 🇫🇮".to_string(),
                country_code: "FI".to_string(),
                flag: "🇫🇮".to_string(),
                ping_ms: 70,
                active_nodes: 1,
                is_auto: false,
            });
        }

        Ok(final_locations)
    }

    /// Save or update subscription source URL in database
    pub async fn save_subscription_source(
        pool: &DbPool,
        category: &str,
        url: &str,
        label: Option<&str>,
        node_count: i64,
        healthy_count: i64,
    ) -> Result<i64, CoreError> {
        use sqlx::Row;
        let row = sqlx::query(
            r#"
            INSERT INTO subscription_sources (category, url, label, node_count, healthy_count, last_synced_at, created_at)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT(url) DO UPDATE SET
                category = excluded.category,
                label = excluded.label,
                node_count = excluded.node_count,
                healthy_count = excluded.healthy_count,
                last_synced_at = CURRENT_TIMESTAMP
            RETURNING id
            "#
        )
        .bind(category)
        .bind(url)
        .bind(label)
        .bind(node_count)
        .bind(healthy_count)
        .fetch_one(pool)
        .await?;

        let id: i64 = row.try_get("id").unwrap_or(1);
        Ok(id)
    }

    /// Retrieve subscription source by ID
    pub async fn get_subscription_source_by_id(
        pool: &DbPool,
        id: i64,
    ) -> Result<Option<crate::models::SubscriptionSource>, CoreError> {
        let row = sqlx::query_as::<_, crate::models::SubscriptionSource>(
            "SELECT * FROM subscription_sources WHERE id = ?"
        )
        .bind(id)
        .fetch_optional(pool)
        .await?;
        Ok(row)
    }

    /// Save or replace active Cloudflare WARP account
    #[allow(clippy::too_many_arguments)]
    pub async fn save_warp_account(
        pool: &DbPool,
        private_key: &str,
        public_key: &str,
        address_v4: &str,
        address_v6: &str,
        reserved: &str,
        account_id: Option<&str>,
        token: Option<&str>,
        license_key: Option<&str>,
        account_type: &str,
    ) -> Result<i64, CoreError> {
        // Deactivate previous WARP accounts to keep a single active master
        let _ = sqlx::query("UPDATE warp_accounts SET is_active = 0").execute(pool).await;

        let row = sqlx::query(
            r#"
            INSERT INTO warp_accounts (
                private_key, public_key, address_v4, address_v6, reserved,
                account_id, token, license_key, account_type, is_active
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
            RETURNING id
            "#
        )
        .bind(private_key)
        .bind(public_key)
        .bind(address_v4)
        .bind(address_v6)
        .bind(reserved)
        .bind(account_id)
        .bind(token)
        .bind(license_key)
        .bind(account_type)
        .fetch_one(pool)
        .await?;

        let id: i64 = row.try_get("id").unwrap_or(1);
        Ok(id)
    }

    /// Get current active Cloudflare WARP account
    pub async fn get_active_warp_account(
        pool: &DbPool,
    ) -> Result<Option<crate::models::WarpAccount>, CoreError> {
        let row = sqlx::query_as::<_, crate::models::WarpAccount>(
            "SELECT * FROM warp_accounts WHERE is_active = 1 ORDER BY id DESC LIMIT 1"
        )
        .fetch_optional(pool)
        .await?;
        Ok(row)
    }

    /// Update user session WARP preference
    pub async fn update_device_use_warp(
        pool: &DbPool,
        subscription_id: i64,
        device_identifier: &str,
        use_warp: bool,
    ) -> Result<(), CoreError> {
        let warp_val = if use_warp { 1 } else { 0 };
        let _ = sqlx::query(
            "UPDATE device_sessions SET use_warp = ? WHERE subscription_id = ? AND device_identifier = ?"
        )
        .bind(warp_val)
        .bind(subscription_id)
        .bind(device_identifier)
        .execute(pool)
        .await;
        Ok(())
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "action", rename_all = "lowercase")]
pub enum HeartbeatVerdict {
    Continue {
        remaining_bytes: i64,
        web_browsing_used_mb: i64,
        download_used_mb: i64,
        static_ip_used_mb: i64,
        static_ip_remaining_mb: i64,
        gaming_used_mb: i64,
    },
    Disconnect {
        code: String,
        message: String,
    },
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AdminRealtimeStats {
    pub total_users: i64,
    pub premium_users: i64,
    pub suspended_users: i64,
    pub active_sessions: i64,
    pub traffic_24h_bytes: i64,
}
