use crate::error::CoreError;
use crate::models::{DeviceSession, Outbound, Subscription, User};
use chrono::{Duration, Utc};
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

    // 1. USERS table
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

    // 2. SUBSCRIPTIONS table
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
        CREATE INDEX IF NOT EXISTS idx_subscriptions_tier ON subscriptions(tier);
        "#,
    )
    .execute(pool)
    .await?;

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
        "#,
    )
    .execute(pool)
    .await?;

    // Seed default outbounds
    let outbound_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM outbounds")
        .fetch_one(pool)
        .await?;

    if outbound_count == 0 {
        info!("Seeding 2 default test outbounds for immediate zero-cost local testing...");

        // 1. Sandbox Loopback Outbound (Local SOCKS5 on 127.0.0.1:10801)
        sqlx::query(
            r#"
            INSERT INTO outbounds (id, tag, protocol, server_address, server_port, network_transport, tls_enabled, min_tier, mode_category, country_code, is_active)
            VALUES (1, 'Sentra Sandbox Loopback', 'socks', '127.0.0.1', 10801, 'tcp', 0, 'Sentra Lite', 'Hydra', 'US', 1)
            "#,
        )
        .execute(pool)
        .await?;

        // 2. Standard Test Direct/Warp Outbound (Local SOCKS5 on 127.0.0.1:10804)
        sqlx::query(
            r#"
            INSERT INTO outbounds (id, tag, protocol, server_address, server_port, network_transport, tls_enabled, min_tier, mode_category, country_code, is_active)
            VALUES (2, 'Sentra Test Direct/Warp', 'socks', '127.0.0.1', 10804, 'tcp', 0, 'Sentra Lite', 'Pulse', 'DE', 1)
            "#,
        )
        .execute(pool)
        .await?;

        // Auxiliary modes for complete multi-tier testing
        sqlx::query(
            r#"
            INSERT INTO outbounds (id, tag, protocol, server_address, server_port, network_transport, tls_enabled, min_tier, mode_category, country_code, is_active)
            VALUES 
            (3, 'Sentra Shadow Sandbox', 'socks', '127.0.0.1', 10802, 'tcp', 0, 'Sentra Pro', 'Shadow', 'NL', 1),
            (4, 'Sentra Stealth Sandbox', 'http', '127.0.0.1', 10803, 'tcp', 0, 'Sentra Flow+', 'Stealth', 'US', 1)
            "#,
        )
        .execute(pool)
        .await?;

        info!("Default test outbounds seeded successfully.");
    }

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

        let user = sqlx::query_as::<_, User>(
            r#"
            INSERT INTO users (telegram_id, username, first_name, last_name, role, status)
            VALUES (?, ?, ?, ?, 'user', 'active')
            RETURNING *
            "#,
        )
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

        if let Some(sub) = existing {
            return Ok(sub);
        }

        let token = format!("sentra_{}", Uuid::new_v4().simple());
        let expires_at = Utc::now() + Duration::days(30);
        let traffic_limit: i64 = 10_737_418_240; // 10 GB
        let speed_limit: i64 = 10_485_760; // 10 Mbps

        let sub = sqlx::query_as::<_, Subscription>(
            r#"
            INSERT INTO subscriptions (user_id, tier, token, status, upload_bytes, download_bytes, traffic_limit_bytes, speed_limit_bps, max_concurrent_devices, expires_at)
            VALUES (?, 'Sentra Lite', ?, 'active', 0, 0, ?, ?, 1, ?)
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
                    max_concurrent_devices = ?, expires_at = ?, updated_at = CURRENT_TIMESTAMP
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
                INSERT INTO subscriptions (user_id, tier, token, status, upload_bytes, download_bytes, traffic_limit_bytes, speed_limit_bps, max_concurrent_devices, expires_at)
                VALUES (?, ?, ?, 'active', 0, 0, ?, ?, ?, ?)
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
        sqlx::query_as::<_, Subscription>(
            "SELECT * FROM subscriptions WHERE token = ? LIMIT 1",
        )
        .bind(token)
        .fetch_optional(pool)
        .await?
        .ok_or(CoreError::SubscriptionNotFound)
    }

    #[allow(dead_code)]
    pub async fn get_subscription_by_user_id(
        pool: &DbPool,
        user_id: i64,
    ) -> Result<Option<Subscription>, CoreError> {
        let sub = sqlx::query_as::<_, Subscription>(
            "SELECT * FROM subscriptions WHERE user_id = ? LIMIT 1",
        )
        .bind(user_id)
        .fetch_optional(pool)
        .await?;

        Ok(sub)
    }

    pub async fn generate_auth_code(
        pool: &DbPool,
        user_id: i64,
    ) -> Result<String, CoreError> {
        let code_str = {
            let mut rng = rand::thread_rng();
            let code: u32 = rng.gen_range(10_000_000..99_999_999);
            code.to_string()
        };
        let expires_at = Utc::now() + Duration::minutes(15);

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
            "SELECT * FROM users WHERE auth_code = ? AND auth_code_expires_at > CURRENT_TIMESTAMP LIMIT 1",
        )
        .bind(code)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| CoreError::AuthFailed("Invalid or expired 8-digit access code.".to_string()))?;

        if user.status != "active" {
            return Err(CoreError::UserBanned("Account is currently suspended.".to_string()));
        }

        let sub = sqlx::query_as::<_, Subscription>(
            "SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active' LIMIT 1",
        )
        .bind(user.id)
        .fetch_optional(pool)
        .await?
        .ok_or(CoreError::SubscriptionNotFound)?;

        // Enforce max concurrent devices
        let active_devices: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM device_sessions WHERE subscription_id = ? AND is_active = 1",
        )
        .bind(sub.id)
        .fetch_one(pool)
        .await?;

        let existing_device = sqlx::query_as::<_, DeviceSession>(
            "SELECT * FROM device_sessions WHERE subscription_id = ? AND device_identifier = ? LIMIT 1",
        )
        .bind(sub.id)
        .bind(device_identifier)
        .fetch_optional(pool)
        .await?;

        if existing_device.is_none() && active_devices >= sub.max_concurrent_devices {
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
                    "SELECT * FROM outbounds WHERE is_active = 1 ORDER BY weight DESC, id ASC",
                )
                .fetch_all(pool)
                .await?
            }
            "Sentra Pro" => {
                sqlx::query_as::<_, Outbound>(
                    "SELECT * FROM outbounds WHERE is_active = 1 AND min_tier IN ('Sentra Lite', 'Sentra Pro') ORDER BY weight DESC, id ASC",
                )
                .fetch_all(pool)
                .await?
            }
            _ => {
                sqlx::query_as::<_, Outbound>(
                    "SELECT * FROM outbounds WHERE is_active = 1 AND min_tier = 'Sentra Lite' ORDER BY weight DESC, id ASC",
                )
                .fetch_all(pool)
                .await?
            }
        };

        Ok(outbounds)
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

    #[allow(dead_code)]
    pub async fn set_user_status(
        pool: &DbPool,
        telegram_id: i64,
        status: &str,
    ) -> Result<(), CoreError> {
        sqlx::query("UPDATE users SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?")
            .bind(status)
            .bind(telegram_id)
            .execute(pool)
            .await?;

        Ok(())
    }

    pub async fn create_support_ticket(
        pool: &DbPool,
        user_id: i64,
        category: &str,
        subject: &str,
        description: &str,
    ) -> Result<String, CoreError> {
        let ticket_number = format!("TCK-{}", Uuid::new_v4().simple().to_string()[..8].to_uppercase());

        sqlx::query(
            r#"
            INSERT INTO support_tickets (ticket_number, user_id, category, subject, description, priority, status)
            VALUES (?, ?, ?, ?, ?, 'medium', 'open')
            "#,
        )
        .bind(&ticket_number)
        .bind(user_id)
        .bind(category)
        .bind(subject)
        .bind(description)
        .execute(pool)
        .await?;

        Ok(ticket_number)
    }

    pub async fn get_system_health(pool: &DbPool) -> Result<SystemHealthStats, CoreError> {
        let total_users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users").fetch_one(pool).await?;
        let lite_users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM subscriptions WHERE tier = 'Sentra Lite' AND status = 'active'").fetch_one(pool).await?;
        let pro_users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM subscriptions WHERE tier = 'Sentra Pro' AND status = 'active'").fetch_one(pool).await?;
        let flow_users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM subscriptions WHERE tier = 'Sentra Flow+' AND status = 'active'").fetch_one(pool).await?;
        let active_outbounds: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM outbounds WHERE is_active = 1").fetch_one(pool).await?;
        let open_tickets: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM support_tickets WHERE status = 'open'").fetch_one(pool).await?;

        Ok(SystemHealthStats {
            total_users,
            lite_users,
            pro_users,
            flow_users,
            active_outbounds,
            open_tickets,
            wal_mode_active: true,
        })
    }
}
