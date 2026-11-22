use super::*;
use chrono::{DateTime, Duration, Utc};
use rand::Rng;
use sha2::{Digest, Sha256};

pub fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    format!("{:x}", hasher.finalize())
}

pub fn constant_time_eq_bytes(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

pub fn generate_6_digit_code() -> String {
    let code: u32 = rand::rngs::OsRng.gen_range(100_000..=999_999);
    format!("{:06}", code)
}

pub fn is_valid_email(email: &str) -> bool {
    let email = email.trim();
    if email.len() < 5 || email.len() > 254 {
        return false;
    }
    let parts: Vec<&str> = email.split('@').collect();
    if parts.len() != 2 {
        return false;
    }
    let (user, domain) = (parts[0], parts[1]);
    if user.is_empty() || domain.is_empty() {
        return false;
    }
    if !domain.contains('.') {
        return false;
    }
    let domain_parts: Vec<&str> = domain.split('.').collect();
    if domain_parts.iter().any(|p| p.is_empty()) {
        return false;
    }
    if email.chars().any(|c| c.is_whitespace()) {
        return false;
    }
    true
}

#[derive(sqlx::FromRow)]
#[allow(dead_code)]
struct PasswordResetRow {
    id: i64,
    code_hash: String,
    attempts: i64,
    expires_at: DateTime<Utc>,
}

pub(super) async fn run_extended_migrations(pool: &DbPool) -> anyhow::Result<()> {
    // 1. Safely add missing columns to users table
    let _ = sqlx::query("ALTER TABLE users ADD COLUMN email TEXT").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE users ADD COLUMN telegram_verified INTEGER NOT NULL DEFAULT 0").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE users ADD COLUMN verify_code TEXT").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE users ADD COLUMN verify_code_expires_at DATETIME").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE users ADD COLUMN outbound_reward_banned INTEGER NOT NULL DEFAULT 0").execute(pool).await;

    let _ = sqlx::query("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL").execute(pool).await;
    let _ = sqlx::query("CREATE INDEX IF NOT EXISTS idx_users_verify_code ON users(verify_code)").execute(pool).await;

    // 2. Check PRAGMA table_info(app_releases) for legacy platform column
    #[derive(sqlx::FromRow)]
    struct ColInfo {
        name: String,
    }
    let cols: Vec<ColInfo> = sqlx::query_as("PRAGMA table_info(app_releases)")
        .fetch_all(pool)
        .await
        .unwrap_or_default();

    let has_platform = cols.iter().any(|c| c.name == "platform");
    if has_platform {
        #[derive(sqlx::FromRow)]
        struct LegacyRelease {
            platform: String,
            version: String,
            telegram_file_id: String,
            changelog: String,
        }
        let legacy_rows: Vec<LegacyRelease> = sqlx::query_as(
            "SELECT platform, version, telegram_file_id, changelog FROM app_releases"
        )
        .fetch_all(pool)
        .await
        .unwrap_or_default();

        let mut version = "1.0.0".to_string();
        let mut changelog = String::new();
        let mut windows_file_id: Option<String> = None;
        let mut android_file_id: Option<String> = None;

        for row in legacy_rows {
            version = row.version;
            if !row.changelog.is_empty() {
                changelog = row.changelog;
            }
            if row.platform == "windows" {
                windows_file_id = Some(row.telegram_file_id);
            } else if row.platform == "android" {
                android_file_id = Some(row.telegram_file_id);
            }
        }

        let _ = sqlx::query("DROP TRIGGER IF EXISTS trg_app_releases_updated_at").execute(pool).await;
        let _ = sqlx::query("DROP TABLE IF EXISTS app_releases").execute(pool).await;

        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS app_releases (
                id INTEGER PRIMARY KEY CHECK(id = 1),
                version TEXT NOT NULL DEFAULT '1.0.0',
                changelog TEXT NOT NULL DEFAULT '',
                windows_file_id TEXT,
                windows_github_url TEXT,
                android_file_id TEXT,
                android_github_url TEXT,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            "#,
        )
        .execute(pool)
        .await?;

        let _ = sqlx::query(
            r#"
            INSERT INTO app_releases (id, version, changelog, windows_file_id, android_file_id)
            VALUES (1, ?, ?, ?, ?)
            "#,
        )
        .bind(version)
        .bind(changelog)
        .bind(windows_file_id)
        .bind(android_file_id)
        .execute(pool)
        .await;
    } else {
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS app_releases (
                id INTEGER PRIMARY KEY CHECK(id = 1),
                version TEXT NOT NULL DEFAULT '1.0.0',
                changelog TEXT NOT NULL DEFAULT '',
                windows_file_id TEXT,
                windows_github_url TEXT,
                android_file_id TEXT,
                android_github_url TEXT,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            "#,
        )
        .execute(pool)
        .await?;
    }

    // 3. Create password_resets table and indexes
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS password_resets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            code_hash TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            used INTEGER NOT NULL DEFAULT 0,
            expires_at DATETIME NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_password_resets_user_created ON password_resets(user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_password_resets_user_active ON password_resets(user_id, used, expires_at);
        "#,
    )
    .execute(pool)
    .await?;

    Ok(())
}

impl Repository {
    pub async fn register_user_with_email_and_password(
        pool: &DbPool,
        email: &str,
        password: &str,
        first_name: Option<&str>,
    ) -> Result<(User, Subscription), CoreError> {
        let clean_email = email.trim().to_lowercase();
        if !is_valid_email(&clean_email) {
            return Err(CoreError::BadRequest("فرمت ایمیل وارد شده معتبر نمی‌باشد.".to_string()));
        }
        if password.len() < 8 || password.len() > 128 {
            return Err(CoreError::BadRequest("طول رمز عبور باید بین ۸ تا ۱۲۸ کاراکتر باشد.".to_string()));
        }

        let existing: Option<i64> = sqlx::query_scalar(
            "SELECT id FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1",
        )
        .bind(&clean_email)
        .fetch_optional(pool)
        .await?;

        if existing.is_some() {
            return Err(CoreError::BadRequest("این آدرس ایمیل قبلاً در سیستم ثبت شده است.".to_string()));
        }

        let password_hash = Self::hash_password_argon2(password)?;
        let user_uuid = uuid::Uuid::new_v4().to_string();
        let display_name = first_name.unwrap_or("کاربر سنترا");

        let user = sqlx::query_as::<_, User>(
            r#"
            INSERT INTO users (user_uuid, email, password_hash, first_name, role, status, telegram_verified)
            VALUES (?, ?, ?, ?, 'user', 'active', 0)
            RETURNING *
            "#,
        )
        .bind(user_uuid)
        .bind(&clean_email)
        .bind(password_hash)
        .bind(display_name)
        .fetch_one(pool)
        .await?;

        let sub = Self::create_or_ensure_lite_subscription(pool, user.id).await?;
        Ok((user, sub))
    }

    pub async fn login_user_with_email_and_password(
        pool: &DbPool,
        identifier: &str,
        password: &str,
    ) -> Result<(User, Subscription), CoreError> {
        let clean = identifier.trim().to_lowercase();
        let user_opt = sqlx::query_as::<_, User>(
            "SELECT * FROM users WHERE LOWER(email) = LOWER(?) OR LOWER(username) = LOWER(?) LIMIT 1",
        )
        .bind(&clean)
        .bind(&clean)
        .fetch_optional(pool)
        .await?;

        let user = match user_opt {
            Some(u) => u,
            None => return Err(CoreError::AuthFailed("نام کاربری/ایمیل یا رمز عبور اشتباه است.".to_string())),
        };

        let hash = match &user.password_hash {
            Some(h) if !h.is_empty() => h,
            _ => return Err(CoreError::AuthFailed("برای این حساب رمز عبور تعریف نشده است. لطفاً از طریق تلگرام یا کد یکبار مصرف اقدام فرمایید.".to_string())),
        };

        if !Self::verify_password_hash(password, hash) {
            return Err(CoreError::AuthFailed("نام کاربری/ایمیل یا رمز عبور اشتباه است.".to_string()));
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

    pub async fn request_telegram_verify(pool: &DbPool, user_id: i64) -> Result<String, CoreError> {
        let code = generate_6_digit_code();
        let expires_at = Utc::now() + Duration::minutes(15);

        sqlx::query(
            "UPDATE users SET verify_code = ?, verify_code_expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        )
        .bind(&code)
        .bind(expires_at)
        .bind(user_id)
        .execute(pool)
        .await?;

        Ok(code)
    }

    pub async fn verify_telegram_code(
        pool: &DbPool,
        telegram_id: i64,
        code: &str,
    ) -> Result<Option<User>, CoreError> {
        let clean_code = code.trim();
        if clean_code.len() != 6 || !clean_code.chars().all(|c| c.is_ascii_digit()) {
            return Ok(None);
        }

        let now = Utc::now();
        let target_user = sqlx::query_as::<_, User>(
            "SELECT * FROM users WHERE verify_code = ? AND verify_code_expires_at >= ? LIMIT 1",
        )
        .bind(clean_code)
        .bind(now)
        .fetch_optional(pool)
        .await?;

        let target_user = match target_user {
            Some(u) => u,
            None => return Ok(None),
        };

        if target_user.status == "suspended" || target_user.status == "banned" {
            return Err(CoreError::AccountSuspended("حساب کاربری شما مسدود شده است.".to_string()));
        }

        // Check if a bare Telegram row exists (telegram_id = ? AND id != target_user.id)
        let bare_user_opt = sqlx::query_as::<_, User>(
            "SELECT * FROM users WHERE telegram_id = ? AND id != ? LIMIT 1",
        )
        .bind(telegram_id)
        .bind(target_user.id)
        .fetch_optional(pool)
        .await?;

        if let Some(bare_user) = bare_user_opt {
            if bare_user.status == "suspended" || bare_user.status == "banned" {
                return Err(CoreError::AccountSuspended("حساب تلگرام متصل به این شناسه مسدود شده است.".to_string()));
            }

            // Merge subscription
            let target_sub_opt = Self::get_subscription_by_user_id(pool, target_user.id).await?;
            let bare_sub_opt = Self::get_subscription_by_user_id(pool, bare_user.id).await?;

            if let (Some(target_sub), Some(bare_sub)) = (target_sub_opt, bare_sub_opt) {
                let tier_rank = |t: &str| -> u8 {
                    match t {
                        "Sentra Flow+" => 3,
                        "Sentra Pro" => 2,
                        _ => 1,
                    }
                };

                let merged_tier = if tier_rank(&bare_sub.tier) > tier_rank(&target_sub.tier) {
                    bare_sub.tier
                } else {
                    target_sub.tier
                };

                let merged_traffic = target_sub.traffic_limit_bytes.max(bare_sub.traffic_limit_bytes);
                let merged_devices = target_sub.max_concurrent_devices.max(bare_sub.max_concurrent_devices).min(3);
                let merged_expires = target_sub.expires_at.max(bare_sub.expires_at);
                let merged_upload = target_sub.upload_bytes.max(bare_sub.upload_bytes);
                let merged_download = target_sub.download_bytes.max(bare_sub.download_bytes);

                sqlx::query(
                    r#"
                    UPDATE subscriptions
                    SET tier = ?, traffic_limit_bytes = ?, max_concurrent_devices = ?, expires_at = ?,
                        upload_bytes = ?, download_bytes = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                    "#,
                )
                .bind(merged_tier)
                .bind(merged_traffic)
                .bind(merged_devices)
                .bind(merged_expires)
                .bind(merged_upload)
                .bind(merged_download)
                .bind(target_sub.id)
                .execute(pool)
                .await?;

                // Reassign user_devices
                sqlx::query(
                    "UPDATE user_devices SET user_id = ?, subscription_id = ? WHERE user_id = ?",
                )
                .bind(target_user.id)
                .bind(target_sub.id)
                .bind(bare_user.id)
                .execute(pool)
                .await?;

                // Keep top 3 devices
                let _ = sqlx::query(
                    r#"
                    DELETE FROM user_devices
                    WHERE user_id = ?
                    AND id NOT IN (
                        SELECT id FROM user_devices WHERE user_id = ? ORDER BY last_active_at DESC LIMIT 3
                    )
                    "#,
                )
                .bind(target_user.id)
                .bind(target_user.id)
                .execute(pool)
                .await;

                // Reassign donations
                let _ = sqlx::query("UPDATE donations SET user_id = ? WHERE user_id = ?")
                    .bind(target_user.id)
                    .bind(bare_user.id)
                    .execute(pool)
                    .await;

                // Reassign donated_outbounds
                let _ = sqlx::query("UPDATE donated_outbounds SET donor_user_id = ? WHERE donor_user_id = ?")
                    .bind(target_user.id)
                    .bind(bare_user.id)
                    .execute(pool)
                    .await;

                // Reassign support_tickets
                let _ = sqlx::query("UPDATE support_tickets SET user_id = ?, subscription_id = ? WHERE user_id = ?")
                    .bind(target_user.id)
                    .bind(target_sub.id)
                    .bind(bare_user.id)
                    .execute(pool)
                    .await;

                // Delete old password_resets for bare user
                let _ = sqlx::query("DELETE FROM password_resets WHERE user_id = ?")
                    .bind(bare_user.id)
                    .execute(pool)
                    .await;

                // Delete bare user's subscription
                let _ = sqlx::query("DELETE FROM subscriptions WHERE user_id = ?")
                    .bind(bare_user.id)
                    .execute(pool)
                    .await;
            }

            // Delete bare user row
            let _ = sqlx::query("DELETE FROM users WHERE id = ?")
                .bind(bare_user.id)
                .execute(pool)
                .await;
        }

        // Set telegram_id, telegram_verified = 1, clear verify_code on target user
        sqlx::query(
            r#"
            UPDATE users
            SET telegram_id = ?, telegram_verified = 1, verify_code = NULL, verify_code_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            "#,
        )
        .bind(telegram_id)
        .bind(target_user.id)
        .execute(pool)
        .await?;

        let updated_user = Self::get_user_by_id(pool, target_user.id).await?;
        Ok(updated_user)
    }

    pub async fn get_latest_app_release(pool: &DbPool) -> Result<Option<AppRelease>, CoreError> {
        let release = sqlx::query_as::<_, AppRelease>(
            r#"
            SELECT id, version, changelog, windows_file_id, windows_github_url, android_file_id, android_github_url, updated_at
            FROM app_releases
            ORDER BY id DESC
            LIMIT 1
            "#,
        )
        .fetch_optional(pool)
        .await?;

        Ok(release)
    }

    pub async fn set_github_app_release(
        pool: &DbPool,
        version: &str,
        windows_github_url: &str,
        android_github_url: &str,
        changelog: &str,
    ) -> Result<AppRelease, CoreError> {
        sqlx::query(
            r#"
            INSERT INTO app_releases (id, version, windows_github_url, android_github_url, changelog, updated_at)
            VALUES (1, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET
                version = excluded.version,
                windows_github_url = excluded.windows_github_url,
                android_github_url = excluded.android_github_url,
                changelog = excluded.changelog,
                updated_at = CURRENT_TIMESTAMP
            "#,
        )
        .bind(version)
        .bind(windows_github_url)
        .bind(android_github_url)
        .bind(changelog)
        .execute(pool)
        .await?;

        Self::get_latest_app_release(pool)
            .await?
            .ok_or_else(|| CoreError::Database(sqlx::Error::RowNotFound))
    }

    pub async fn find_user_for_password_reset(
        pool: &DbPool,
        identifier: &str,
    ) -> Result<Option<User>, CoreError> {
        let clean = identifier.trim().trim_start_matches('@');
        if clean.is_empty() {
            return Ok(None);
        }

        let user = sqlx::query_as::<_, User>(
            "SELECT * FROM users WHERE LOWER(email) = LOWER(?) OR LOWER(username) = LOWER(?) LIMIT 1",
        )
        .bind(clean)
        .bind(clean)
        .fetch_optional(pool)
        .await?;

        Ok(user)
    }

    pub async fn get_user_by_telegram_id(
        pool: &DbPool,
        telegram_id: i64,
    ) -> Result<Option<User>, CoreError> {
        let user = sqlx::query_as::<_, User>(
            "SELECT * FROM users WHERE telegram_id = ? LIMIT 1",
        )
        .bind(telegram_id)
        .fetch_optional(pool)
        .await?;

        Ok(user)
    }

    pub async fn create_password_reset_code(
        pool: &DbPool,
        user_id: i64,
    ) -> Result<String, CoreError> {
        let fifteen_mins_ago = Utc::now() - Duration::minutes(15);
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM password_resets WHERE user_id = ? AND created_at >= ?",
        )
        .bind(user_id)
        .bind(fifteen_mins_ago)
        .fetch_one(pool)
        .await
        .unwrap_or(0);

        if count >= 3 {
            return Err(CoreError::TooManyRequests(
                "تعداد درخواست‌های بازیابی رمز عبور بیش از حد مجاز است. لطفاً ۱۵ دقیقه دیگر مجدداً تلاش فرمایید.".to_string(),
            ));
        }

        // Invalidate previous unused codes
        sqlx::query("UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0")
            .bind(user_id)
            .execute(pool)
            .await?;

        let code = generate_6_digit_code();
        let code_hash = sha256_hex(&code);
        let expires_at = Utc::now() + Duration::minutes(10);

        sqlx::query(
            r#"
            INSERT INTO password_resets (user_id, code_hash, attempts, used, expires_at, created_at)
            VALUES (?, ?, 0, 0, ?, CURRENT_TIMESTAMP)
            "#,
        )
        .bind(user_id)
        .bind(code_hash)
        .bind(expires_at)
        .execute(pool)
        .await?;

        Ok(code)
    }

    pub async fn confirm_password_reset(
        pool: &DbPool,
        identifier: &str,
        code: &str,
        new_password: &str,
    ) -> Result<User, CoreError> {
        let clean_code = code.trim();
        if clean_code.len() != 6 || !clean_code.chars().all(|c| c.is_ascii_digit()) {
            return Err(CoreError::BadRequest("کد تایید ۶ رقمی نامعتبر است.".to_string()));
        }
        if new_password.len() < 8 || new_password.len() > 128 {
            return Err(CoreError::BadRequest("طول رمز عبور باید بین ۸ تا ۱۲۸ کاراکتر باشد.".to_string()));
        }

        let user = Self::find_user_for_password_reset(pool, identifier)
            .await?
            .ok_or(CoreError::UserNotFound)?;

        if user.status == "suspended" || user.status == "banned" {
            return Err(CoreError::AccountSuspended("حساب کاربری شما مسدود شده است.".to_string()));
        }

        let reset_row: Option<PasswordResetRow> = sqlx::query_as(
            r#"
            SELECT id, code_hash, attempts, expires_at
            FROM password_resets
            WHERE user_id = ? AND used = 0
            ORDER BY id DESC
            LIMIT 1
            "#,
        )
        .bind(user.id)
        .fetch_optional(pool)
        .await?;

        let row = match reset_row {
            Some(r) => r,
            None => return Err(CoreError::BadRequest("کد بازیابی معتبری برای این حساب یافت نشد یا منقضی شده است.".to_string())),
        };

        if Utc::now() > row.expires_at {
            let _ = sqlx::query("UPDATE password_resets SET used = 1 WHERE id = ?")
                .bind(row.id)
                .execute(pool)
                .await;
            return Err(CoreError::BadRequest("کد بازیابی منقضی شده است. لطفاً مجدداً درخواست کد دهید.".to_string()));
        }

        if row.attempts >= 5 {
            let _ = sqlx::query("UPDATE password_resets SET used = 1 WHERE id = ?")
                .bind(row.id)
                .execute(pool)
                .await;
            return Err(CoreError::BadRequest("تعداد دفعات تلاش ناموفق بیش از حد مجاز است. این کد باطل گردید.".to_string()));
        }

        let input_hash = sha256_hex(clean_code);
        let is_valid = constant_time_eq_bytes(input_hash.as_bytes(), row.code_hash.as_bytes());

        if !is_valid {
            let new_attempts = row.attempts + 1;
            let mark_used = if new_attempts >= 5 { 1 } else { 0 };
            sqlx::query("UPDATE password_resets SET attempts = ?, used = ? WHERE id = ?")
                .bind(new_attempts)
                .bind(mark_used)
                .bind(row.id)
                .execute(pool)
                .await?;

            if new_attempts >= 5 {
                return Err(CoreError::BadRequest("تعداد دفعات تلاش ناموفق بیش از حد مجاز بود. کد بازیابی باطل شد.".to_string()));
            } else {
                return Err(CoreError::BadRequest(format!("کد بازیابی اشتباه است. (تلاش {} از ۵)", new_attempts)));
            }
        }

        let new_hash = Self::hash_password_argon2(new_password)?;
        sqlx::query("UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
            .bind(&new_hash)
            .bind(user.id)
            .execute(pool)
            .await?;

        // Invalidate all unused reset codes
        sqlx::query("UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0")
            .bind(user.id)
            .execute(pool)
            .await?;

        let updated_user = Self::get_user_by_id(pool, user.id)
            .await?
            .ok_or(CoreError::UserNotFound)?;

        Ok(updated_user)
    }

    pub async fn update_user_password_by_telegram_id(
        pool: &DbPool,
        telegram_id: i64,
        new_password: &str,
    ) -> Result<User, CoreError> {
        if new_password.len() < 8 || new_password.len() > 128 {
            return Err(CoreError::BadRequest("طول رمز عبور باید بین ۸ تا ۱۲۸ کاراکتر باشد.".to_string()));
        }

        let user = Self::get_user_by_telegram_id(pool, telegram_id)
            .await?
            .ok_or(CoreError::UserNotFound)?;

        let new_hash = Self::hash_password_argon2(new_password)?;
        sqlx::query("UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
            .bind(&new_hash)
            .bind(user.id)
            .execute(pool)
            .await?;

        let _ = sqlx::query("UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0")
            .bind(user.id)
            .execute(pool)
            .await;

        let updated_user = Self::get_user_by_id(pool, user.id)
            .await?
            .ok_or(CoreError::UserNotFound)?;

        Ok(updated_user)
    }

    pub async fn invalidate_password_resets_by_telegram_id(
        pool: &DbPool,
        telegram_id: i64,
    ) -> Result<u64, CoreError> {
        let user = Self::get_user_by_telegram_id(pool, telegram_id)
            .await?
            .ok_or(CoreError::UserNotFound)?;

        let result = sqlx::query("UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0")
            .bind(user.id)
            .execute(pool)
            .await?;

        Ok(result.rows_affected())
    }
}
