use crate::db::models::{DeviceSession, Outbound, Subscription, SupportTicket, User};
use crate::error::CoreError;
use chrono::{Duration, Utc};
use rand::Rng;
use sqlx::SqlitePool;
use uuid::Uuid;

pub struct Repository;

impl Repository {
    /// Retrieve user by Telegram ID or create a new user profile with default Lite tier
    pub async fn get_or_create_user(
        pool: &SqlitePool,
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
            // Update profile metadata if changed
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

        // Create new user
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

        // Automatically assign Sentra Lite tier subscription
        Self::create_or_ensure_lite_subscription(pool, user.id).await?;

        Ok(user)
    }

    /// Automatically initialize or return the free Sentra Lite subscription
    pub async fn create_or_ensure_lite_subscription(
        pool: &SqlitePool,
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
        let traffic_limit = 10_737_418_240; // 10 GB
        let speed_limit = 10_485_760; // 10 Mbps

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

    /// Upgrade user to Sentra Pro or Sentra Flow+ (instant simulation for testing)
    pub async fn upgrade_subscription(
        pool: &SqlitePool,
        user_id: i64,
        tier: &str,
    ) -> Result<Subscription, CoreError> {
        let (traffic_limit, speed_limit, devices, duration_days) = match tier {
            "Sentra Pro" => (161_061_273_600i64, 104_857_600i64, 3i64, 90),     // 150GB, 100Mbps, 3 devices
            "Sentra Flow+" => (1_099_511_627_776i64, 0i64, 10i64, 365),          // 1TB, Uncapped, 10 devices
            _ => (10_737_418_240i64, 10_485_760i64, 1i64, 30),                   // Lite
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
            .bind(tier)
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
            .bind(tier)
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

    /// Retrieve subscription by unique token
    pub async fn get_subscription_by_token(
        pool: &SqlitePool,
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

    /// Retrieve subscription for a user
    pub async fn get_subscription_by_user_id(
        pool: &SqlitePool,
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

    /// Generate an 8-digit OTP code for desktop/mobile app login
    pub async fn generate_auth_code(
        pool: &SqlitePool,
        user_id: i64,
    ) -> Result<String, CoreError> {
        let mut rng = rand::thread_rng();
        let code: u32 = rng.gen_range(10_000_000..99_999_999);
        let code_str = code.to_string();
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

    /// Exchange the 8-digit code for app login, recording the device session
    pub async fn exchange_auth_code(
        pool: &SqlitePool,
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
        .ok_or_else(|| CoreError::AuthFailed("Invalid or expired 8-digit login code.".to_string()))?;

        if user.status != "active" {
            return Err(CoreError::UserBanned("Your account is currently suspended.".to_string()));
        }

        let sub = sqlx::query_as::<_, Subscription>(
            "SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active' LIMIT 1",
        )
        .bind(user.id)
        .fetch_optional(pool)
        .await?
        .ok_or(CoreError::SubscriptionNotFound)?;

        // Enforce concurrent devices limit
        let active_devices: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM device_sessions WHERE subscription_id = ? AND is_active = 1",
        )
        .bind(sub.id)
        .fetch_one(pool)
        .await?;

        // If this device was already registered, refresh it; otherwise check limit
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

        // Invalidate auth code
        sqlx::query("UPDATE users SET auth_code = NULL, auth_code_expires_at = NULL WHERE id = ?")
            .bind(user.id)
            .execute(pool)
            .await?;

        Ok((user, sub))
    }

    /// Retrieve active outbounds accessible to a given subscription tier
    pub async fn get_allowed_outbounds_for_tier(
        pool: &SqlitePool,
        tier: &str,
    ) -> Result<Vec<Outbound>, CoreError> {
        let outbounds = match tier {
            "Sentra Flow+" => {
                // Flow+ accesses all active outbounds
                sqlx::query_as::<_, Outbound>(
                    "SELECT * FROM outbounds WHERE is_active = 1 ORDER BY weight DESC, id ASC",
                )
                .fetch_all(pool)
                .await?
            }
            "Sentra Pro" => {
                // Pro accesses Lite and Pro outbounds
                sqlx::query_as::<_, Outbound>(
                    "SELECT * FROM outbounds WHERE is_active = 1 AND min_tier IN ('Sentra Lite', 'Sentra Pro') ORDER BY weight DESC, id ASC",
                )
                .fetch_all(pool)
                .await?
            }
            _ => {
                // Lite accesses only Lite outbounds
                sqlx::query_as::<_, Outbound>(
                    "SELECT * FROM outbounds WHERE is_active = 1 AND min_tier = 'Sentra Lite' ORDER BY weight DESC, id ASC",
                )
                .fetch_all(pool)
                .await?
            }
        };

        Ok(outbounds)
    }

    /// List all outbounds (for Admin panel)
    pub async fn list_all_outbounds(pool: &SqlitePool) -> Result<Vec<Outbound>, CoreError> {
        let outbounds = sqlx::query_as::<_, Outbound>(
            "SELECT * FROM outbounds ORDER BY id ASC",
        )
        .fetch_all(pool)
        .await?;

        Ok(outbounds)
    }

    /// Toggle outbound active state (for Admin panel)
    pub async fn toggle_outbound_status(
        pool: &SqlitePool,
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

    /// List active users with their current subscriptions (for Admin panel)
    pub async fn list_active_users(
        pool: &SqlitePool,
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

    /// Update user status (approve, suspend, ban)
    pub async fn set_user_status(
        pool: &SqlitePool,
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

    /// Create a new support ticket
    pub async fn create_support_ticket(
        pool: &SqlitePool,
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

    /// Retrieve system health counts for /health endpoint & admin dashboard
    pub async fn get_system_health(pool: &SqlitePool) -> Result<(i64, i64, i64, i64), CoreError> {
        let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users").fetch_one(pool).await?;
        let active_subs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM subscriptions WHERE status = 'active'").fetch_one(pool).await?;
        let active_outbounds: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM outbounds WHERE is_active = 1").fetch_one(pool).await?;
        let open_tickets: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM support_tickets WHERE status = 'open'").fetch_one(pool).await?;

        Ok((users, active_subs, active_outbounds, open_tickets))
    }
}
