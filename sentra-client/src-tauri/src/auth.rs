use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fs;
use std::path::PathBuf;
use tracing::{info, warn};

pub const BACKEND_FALLBACK_URLS: &[&str] = &[
    "http://116.203.188.124:8080",
    "https://head.cyberservice.sbs:8443",
];

/// Returns ordered list of backend API base URLs (never localhost unless explicitly configured).
/// Checks SENTRA_API_BASE_URL / VITE_API_BASE_URL env vars first, then production endpoints.
pub fn get_backend_urls() -> Vec<String> {
    let mut urls: Vec<String> = Vec::new();
    for env_key in ["SENTRA_API_BASE_URL", "VITE_API_BASE_URL"] {
        if let Ok(raw) = std::env::var(env_key) {
            let trimmed = raw.trim().trim_end_matches('/');
            if !trimmed.is_empty()
                && !trimmed.contains("localhost")
                && !trimmed.contains("127.0.0.1")
                && !urls.iter().any(|u| u == trimmed)
            {
                urls.push(trimmed.to_string());
            }
        }
    }
    for &fallback in BACKEND_FALLBACK_URLS {
        if !urls.iter().any(|u| u == fallback) {
            urls.push(fallback.to_string());
        }
    }
    urls
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SessionData {
    pub auth_token: String,
    pub subscription_token: String,
    pub tier: String,
    pub username: String,
    pub remaining_bytes: i64,
    pub expires_at: Option<String>,
}

pub struct AuthManager;

impl AuthManager {
    fn build_http_client() -> Result<reqwest::Client, String> {
        reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(6))
            .timeout(std::time::Duration::from_secs(12))
            .build()
            .map_err(|e| format!("خطا در ساخت کلاینت ارتباطی HTTP: {}", e))
    }

    /// Return OS-safe persistent application data directory (%APPDATA%/com.sentra.connect on Windows)
    pub fn app_data_dir() -> PathBuf {
        let base = if cfg!(target_os = "windows") {
            std::env::var_os("APPDATA")
                .or_else(|| std::env::var_os("LOCALAPPDATA"))
                .map(PathBuf::from)
        } else {
            std::env::var_os("XDG_DATA_HOME")
                .map(PathBuf::from)
                .or_else(|| {
                    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local").join("share"))
                })
        };

        let app_dir = base
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
            .join("com.sentra.connect");
        let _ = fs::create_dir_all(&app_dir);
        app_dir
    }

    /// Return the path to the persisted session file in OS AppData
    pub fn session_file_path() -> PathBuf {
        Self::app_data_dir().join("session.json")
    }

    /// Return the path to persisted personal configs file
    pub fn personal_configs_path() -> PathBuf {
        Self::app_data_dir().join("personal_configs.json")
    }

    /// Return persistent unique device identifier for this client instance
    pub fn get_or_create_device_id() -> String {
        let path = Self::app_data_dir().join("device_id.txt");
        if let Ok(id) = fs::read_to_string(&path) {
            let trimmed = id.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
        let rand_val: u32 = rand::random();
        let new_id = format!("sentra-pc-{:08x}", rand_val);
        let _ = fs::write(path, &new_id);
        new_id
    }

    /// Load persisted session from OS AppData (migrating legacy .sentra/session.json if present)
    pub fn load_saved_session() -> Option<SessionData> {
        let path = Self::session_file_path();
        if path.exists() {
            let content = fs::read_to_string(path).ok()?;
            return serde_json::from_str::<SessionData>(&content).ok();
        }
        // Migrate legacy relative .sentra/session.json once if present
        let legacy = std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(".sentra")
            .join("session.json");
        if legacy.exists() {
            if let Ok(content) = fs::read_to_string(&legacy) {
                if let Ok(sess) = serde_json::from_str::<SessionData>(&content) {
                    let _ = Self::save_session(&sess);
                    return Some(sess);
                }
            }
        }
        None
    }

    /// Save session securely to OS AppData
    pub fn save_session(session: &SessionData) -> Result<(), String> {
        let path = Self::session_file_path();
        let content = serde_json::to_string_pretty(session).map_err(|e| e.to_string())?;
        fs::write(path, content).map_err(|e| e.to_string())?;
        info!("Saved active user session persistently to AppData.");
        Ok(())
    }

    /// Clear persisted session upon explicit logout or revocation
    pub fn clear_session() {
        let path = Self::session_file_path();
        if path.exists() {
            let _ = fs::remove_file(path);
            info!("Local persistent session cleared.");
        }
    }

    /// Register a new account with username and password directly in the app
    pub async fn register_with_credentials(username: &str, password: &str) -> Result<SessionData, String> {
        let clean_username = username.trim().to_lowercase();
        let clean_password = password.trim();

        if clean_username.len() < 3 || clean_username.len() > 32 {
            return Err("نام کاربری باید بین ۳ تا ۳۲ کاراکتر باشد.".to_string());
        }
        if !clean_username.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err("نام کاربری فقط می‌تواند شامل حروف انگلیسی، اعداد و زیرخط (_) باشد.".to_string());
        }
        if clean_password.len() < 8 {
            return Err("رمز عبور باید حداقل ۸ کاراکتر باشد.".to_string());
        }

        let client = Self::build_http_client()?;

        let dev_id = Self::get_or_create_device_id();
        let dev_name = if cfg!(target_os = "android") {
            "Android Device".to_string()
        } else {
            "Windows PC".to_string()
        };

        let request_payload = json!({
            "username": clean_username,
            "password": clean_password,
            "device_identifier": dev_id,
            "device_name": dev_name,
            "os": if cfg!(target_os = "android") { "android" } else { "windows" },
            "client_version": "1.0.0"
        });

        let mut resp_opt = None;
        let mut last_err = None;

        for base_url in get_backend_urls() {
            let url = format!("{}/api/v1/auth/register", base_url);
            info!("Registering user via endpoint: {}", url);
            match client.post(&url).json(&request_payload).send().await {
                Ok(resp) => {
                    if resp.status().is_server_error() {
                        warn!("Backend {} returned HTTP {} on register; trying next fallback...", base_url, resp.status());
                        resp_opt = Some(resp);
                        continue;
                    }
                    resp_opt = Some(resp);
                    break;
                }
                Err(e) => {
                    warn!("Failed to reach {} on register: {}", base_url, e);
                    last_err = Some(e);
                }
            }
        }

        match resp_opt {
            Some(resp) if resp.status().is_success() => {
                let data: serde_json::Value = resp
                    .json()
                    .await
                    .map_err(|e| format!("خطا در پردازش پاسخ سرور: {}", e))?;

                let auth_token = data.get("access_token").and_then(|v| v.as_str()).unwrap_or("token_jwt_local").to_string();
                let sub_token = data.get("subscription").and_then(|s| s.get("token")).and_then(|t| t.as_str()).unwrap_or("sub_token_default").to_string();
                let tier = data.get("subscription").and_then(|s| s.get("tier")).and_then(|t| t.as_str()).unwrap_or("Sentra Lite").to_string();
                let uname = data.get("user").and_then(|u| u.get("username")).and_then(|n| n.as_str()).unwrap_or(&clean_username).to_string();
                let remaining_bytes = data.get("subscription").and_then(|s| s.get("remaining_bytes")).and_then(|b| b.as_i64()).unwrap_or(10_737_418_240);
                let expires_at = data.get("subscription").and_then(|s| s.get("expires_at")).and_then(|e| e.as_str()).map(|s| s.to_string());

                let session = SessionData {
                    auth_token,
                    subscription_token: sub_token,
                    tier,
                    username: uname,
                    remaining_bytes,
                    expires_at,
                };

                let _ = Self::save_session(&session);
                Ok(session)
            }
            Some(resp) => {
                let status = resp.status();
                let err_text = resp.text().await.unwrap_or_default();
                if let Ok(err_json) = serde_json::from_str::<serde_json::Value>(&err_text) {
                    if let Some(msg) = err_json.get("message").and_then(|m| m.as_str()) {
                        return Err(msg.to_string());
                    }
                    if let Some(msg) = err_json.get("error").and_then(|m| m.as_str()) {
                        return Err(msg.to_string());
                    }
                }
                Err(format!("خطا در ثبت‌نام حساب کاربری جدید (کد وضعیت {}).", status.as_u16()))
            }
            None => {
                let err_msg = last_err.map(|e| e.to_string()).unwrap_or_else(|| "سرور پاسخگو نیست".to_string());
                Err(format!("عدم برقراری ارتباط با سرور سنترا (116.203.188.124): لطفاً اتصال اینترنت را بررسی کنید ({})", err_msg))
            }
        }
    }

    /// Login directly with username and password
    pub async fn login_with_credentials(username: &str, password: &str) -> Result<SessionData, String> {
        let clean_username = username.trim().to_lowercase();
        let clean_password = password.trim();

        if clean_username.is_empty() || clean_password.is_empty() {
            return Err("لطفاً نام کاربری و رمز عبور خود را وارد نمایید.".to_string());
        }

        let client = Self::build_http_client()?;

        let dev_id = Self::get_or_create_device_id();
        let dev_name = if cfg!(target_os = "android") {
            "Android Device".to_string()
        } else {
            "Windows PC".to_string()
        };

        let request_payload = json!({
            "username": clean_username,
            "password": clean_password,
            "device_identifier": dev_id,
            "device_name": dev_name,
            "os": if cfg!(target_os = "android") { "android" } else { "windows" },
            "client_version": "1.0.0"
        });

        let mut resp_opt = None;
        let mut last_err = None;

        for base_url in get_backend_urls() {
            let url = format!("{}/api/v1/auth/login", base_url);
            info!("Logging in via endpoint: {}", url);
            match client.post(&url).json(&request_payload).send().await {
                Ok(resp) => {
                    if resp.status().is_server_error() {
                        warn!("Backend {} returned HTTP {} on login; trying next fallback...", base_url, resp.status());
                        resp_opt = Some(resp);
                        continue;
                    }
                    resp_opt = Some(resp);
                    break;
                }
                Err(e) => {
                    warn!("Failed to reach {} on login: {}", base_url, e);
                    last_err = Some(e);
                }
            }
        }

        match resp_opt {
            Some(resp) if resp.status().is_success() => {
                let data: serde_json::Value = resp
                    .json()
                    .await
                    .map_err(|e| format!("خطا در پردازش پاسخ سرور: {}", e))?;

                let auth_token = data.get("access_token").and_then(|v| v.as_str()).unwrap_or("token_jwt_local").to_string();
                let sub_token = data.get("subscription").and_then(|s| s.get("token")).and_then(|t| t.as_str()).unwrap_or("sub_token_default").to_string();
                let tier = data.get("subscription").and_then(|s| s.get("tier")).and_then(|t| t.as_str()).unwrap_or("Sentra Lite").to_string();
                let uname = data.get("user").and_then(|u| u.get("username")).and_then(|n| n.as_str()).unwrap_or(&clean_username).to_string();
                let remaining_bytes = data.get("subscription").and_then(|s| s.get("remaining_bytes")).and_then(|b| b.as_i64()).unwrap_or(10_737_418_240);
                let expires_at = data.get("subscription").and_then(|s| s.get("expires_at")).and_then(|e| e.as_str()).map(|s| s.to_string());

                let session = SessionData {
                    auth_token,
                    subscription_token: sub_token,
                    tier,
                    username: uname,
                    remaining_bytes,
                    expires_at,
                };

                let _ = Self::save_session(&session);
                Ok(session)
            }
            Some(resp) => {
                let err_text = resp.text().await.unwrap_or_default();
                if let Ok(err_json) = serde_json::from_str::<serde_json::Value>(&err_text) {
                    let code = err_json.get("code").and_then(|c| c.as_str()).unwrap_or("");
                    if code == "MAX_DEVICES_REACHED" {
                        return Err("MAX_DEVICES_REACHED: سقف اتصال هم‌زمان ۳ دستگاه برای این اشتراک تکمیل شده است. لطفاً از بخش مدیریت دستگاه‌ها یکی از دستگاه‌های قبلی را حذف کنید.".to_string());
                    } else if code == "ACCOUNT_SUSPENDED" {
                        let msg = err_json
                            .get("message")
                            .and_then(|m| m.as_str())
                            .unwrap_or("حساب شما موقتاً متوقف شده است.");
                        return Err(format!("ACCOUNT_SUSPENDED: {}", msg));
                    }
                    if let Some(msg) = err_json.get("message").and_then(|m| m.as_str()) {
                        return Err(msg.to_string());
                    }
                    if let Some(msg) = err_json.get("error").and_then(|m| m.as_str()) {
                        return Err(msg.to_string());
                    }
                }
                Err("نام کاربری یا رمز عبور اشتباه است.".to_string())
            }
            None => {
                let err_msg = last_err.map(|e| e.to_string()).unwrap_or_else(|| "سرور پاسخگو نیست".to_string());
                Err(format!("عدم برقراری ارتباط با سرور سنترا (116.203.188.124): لطفاً اتصال اینترنت را بررسی کنید ({})", err_msg))
            }
        }
    }

    /// Request a 6-digit link token from the backend to connect this client account to Telegram
    pub async fn get_telegram_link_code(subscription_token: &str) -> Result<String, String> {
        let client = Self::build_http_client()?;

        for base_url in get_backend_urls() {
            let url = format!("{}/api/v1/auth/link-token", base_url);
            let resp_res = client
                .post(&url)
                .header("X-Subscription-Token", subscription_token)
                .send()
                .await;

            if let Ok(resp) = resp_res {
                if resp.status().is_success() {
                    if let Ok(json_val) = resp.json::<serde_json::Value>().await {
                        if let Some(code) = json_val.get("link_code").and_then(|c| c.as_str()) {
                            return Ok(code.to_string());
                        }
                    }
                }
            }
        }

        Err("خطا در تولید کد اتصال موقت تلگرام. لطفاً اتصال اینترنت خود را بررسی نمایید.".to_string())
    }

    /// Validate 8-digit OTP with sentra-core backend or handle sandbox fallback
    pub async fn login_with_code(code: &str) -> Result<SessionData, String> {
        let clean_code = code.trim();
        if clean_code.len() != 8 || !clean_code.chars().all(|c| c.is_ascii_digit()) {
            return Err("کد ورود باید دقیقاً ۸ رقم عددی باشد.".to_string());
        }

        info!("Sending 8-digit auth code [{}] to Sentra Core API...", clean_code);

        let client = Self::build_http_client()?;

        let dev_id = Self::get_or_create_device_id();
        let dev_name = if cfg!(target_os = "android") {
            "Android Device".to_string()
        } else {
            "Windows PC".to_string()
        };

        let request_payload = json!({
            "code": clean_code,
            "device_identifier": dev_id,
            "device_name": dev_name,
            "os": if cfg!(target_os = "android") { "android" } else { "windows" },
            "client_version": "1.0.0"
        });

        // Try backend endpoints with automatic fallback
        let mut resp_opt = None;
        let mut last_err = None;

        for base_url in get_backend_urls() {
            let url = format!("{}/api/v1/auth/code-login", base_url);
            info!("Attempting authentication via endpoint: {}", url);
            match client.post(&url).json(&request_payload).send().await {
                Ok(resp) => {
                    if resp.status().is_server_error() {
                        warn!("Backend {} returned HTTP {} on code-login; trying next fallback...", base_url, resp.status());
                        resp_opt = Some(resp);
                        continue;
                    }
                    resp_opt = Some(resp);
                    break;
                }
                Err(e) => {
                    warn!("Failed to reach {} ({}). Switching to next fallback endpoint...", base_url, e);
                    last_err = Some(e);
                }
            }
        }

        match resp_opt {
            Some(resp) if resp.status().is_success() => {
                let data: serde_json::Value = resp
                    .json()
                    .await
                    .map_err(|e| format!("خطا در پردازش پاسخ سرور: {}", e))?;

                let auth_token = data
                    .get("access_token")
                    .and_then(|v| v.as_str())
                    .unwrap_or("token_jwt_local")
                    .to_string();

                let sub_token = data
                    .get("subscription")
                    .and_then(|s| s.get("token"))
                    .and_then(|t| t.as_str())
                    .unwrap_or("sub_token_default")
                    .to_string();

                let tier = data
                    .get("subscription")
                    .and_then(|s| s.get("tier"))
                    .and_then(|t| t.as_str())
                    .unwrap_or("Sentra Lite")
                    .to_string();

                let username = data
                    .get("user")
                    .and_then(|u| u.get("first_name"))
                    .and_then(|n| n.as_str())
                    .unwrap_or("کاربر")
                    .to_string();

                let remaining_bytes = data
                    .get("subscription")
                    .and_then(|s| s.get("remaining_bytes"))
                    .and_then(|b| b.as_i64())
                    .unwrap_or(10_737_418_240);

                let expires_at = data
                    .get("subscription")
                    .and_then(|s| s.get("expires_at"))
                    .and_then(|e| e.as_str())
                    .map(|s| s.to_string());

                let session = SessionData {
                    auth_token,
                    subscription_token: sub_token,
                    tier,
                    username,
                    remaining_bytes,
                    expires_at,
                };

                let _ = Self::save_session(&session);
                Ok(session)
            }
            Some(resp) => {
                let status = resp.status();
                let err_text = resp.text().await.unwrap_or_default();
                warn!("Backend rejected auth code (HTTP {}): {}", status, err_text);

                if let Ok(err_json) = serde_json::from_str::<serde_json::Value>(&err_text) {
                    let code = err_json.get("code").and_then(|c| c.as_str()).unwrap_or("");
                    if code == "MAX_DEVICES_REACHED" {
                        return Err("MAX_DEVICES_REACHED: سقف اتصال هم‌زمان ۳ دستگاه برای این اشتراک تکمیل شده است. لطفاً از بخش مدیریت دستگاه‌ها یکی از دستگاه‌های قبلی را حذف کنید.".to_string());
                    } else if code == "ACCOUNT_SUSPENDED" {
                        let msg = err_json
                            .get("message")
                            .and_then(|m| m.as_str())
                            .unwrap_or("حساب شما به دلیل الگوی مصرف ترافیک غیرعادی موقتاً متوقف شده است. لطفاً با پشتیبانی در ارتباط باشید.");
                        return Err(format!("ACCOUNT_SUSPENDED: {}", msg));
                    }
                    if let Some(msg) = err_json.get("message").and_then(|m| m.as_str()) {
                        return Err(msg.to_string());
                    }
                }

                Err(format!("کد ورود نامعتبر است یا منقضی شده است (HTTP {}).", status))
            }
            None => {
                let err_msg = last_err.map(|e| e.to_string()).unwrap_or_else(|| "Network unreachable".to_string());
                warn!("Could not reach any Sentra Core backend ({}).", err_msg);
                Err("ارتباط با سرور سنترا برقرار نشد. لطفاً اتصال اینترنت خود را بررسی نمایید.".to_string())
            }
        }
    }

    /// Fetch live user profile, subscription, devices, and ALL active outbounds from /api/v1/client/bootstrap
    pub async fn fetch_bootstrap(subscription_token: &str) -> Result<serde_json::Value, String> {
        let client = Self::build_http_client()?;
        let mut last_err = String::new();

        for base_url in get_backend_urls() {
            let url = format!("{}/api/v1/client/bootstrap", base_url);
            match client
                .get(&url)
                .header("X-Subscription-Token", subscription_token)
                .send()
                .await
            {
                Ok(resp) if resp.status().is_success() => {
                    let data: serde_json::Value = resp
                        .json()
                        .await
                        .map_err(|e| format!("خطا در پردازش پاسخ سرور: {}", e))?;
                    return Ok(data);
                }
                Ok(resp) => {
                    let status = resp.status();
                    let body = resp.text().await.unwrap_or_default();
                    if status.as_u16() == 401 || status.as_u16() == 403 || status.as_u16() == 404 {
                        return Err(format!("AUTH_EXPIRED: {}", body));
                    }
                    last_err = format!("HTTP {} از {}", status, base_url);
                }
                Err(e) => {
                    last_err = format!("{} ({})", base_url, e);
                }
            }
        }

        Err(format!("خطا در همگام‌سازی اطلاعات از سرور: {}", last_err))
    }

    /// Submit a personal proxy URI as a community-donated outbound for Admin Telegram review
    pub async fn donate_outbound(
        subscription_token: &str,
        uri: &str,
        name: Option<&str>,
        note: Option<&str>,
    ) -> Result<serde_json::Value, String> {
        let client = Self::build_http_client()?;
        let payload = json!({
            "uri": uri,
            "name": name,
            "note": note,
        });

        let mut last_err = String::new();
        for base_url in get_backend_urls() {
            let url = format!("{}/api/v1/client/outbounds/donate", base_url);
            match client
                .post(&url)
                .header("X-Subscription-Token", subscription_token)
                .json(&payload)
                .send()
                .await
            {
                Ok(resp) if resp.status().is_success() => {
                    return resp
                        .json::<serde_json::Value>()
                        .await
                        .map_err(|e| format!("خطا در پردازش پاسخ سرور: {}", e));
                }
                Ok(resp) => {
                    let body = resp.text().await.unwrap_or_default();
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
                        if let Some(m) = v.get("message").or_else(|| v.get("error")).and_then(|x| x.as_str()) {
                            return Err(m.to_string());
                        }
                    }
                    return Err(format!("خطا در ثبت اوتباند اهدایی (HTTP {}).", resp.status()));
                }
                Err(e) => {
                    last_err = e.to_string();
                }
            }
        }

        Err(format!("عدم ارتباط با سرور سنترا: {}", last_err))
    }

    /// Fetch the authenticated user's submitted outbound donations and reward status
    pub async fn get_my_donations(subscription_token: &str) -> Result<serde_json::Value, String> {
        let client = Self::build_http_client()?;
        let mut last_err = String::new();

        for base_url in get_backend_urls() {
            let url = format!("{}/api/v1/client/outbounds/my-donations", base_url);
            match client
                .get(&url)
                .header("X-Subscription-Token", subscription_token)
                .send()
                .await
            {
                Ok(resp) if resp.status().is_success() => {
                    return resp
                        .json::<serde_json::Value>()
                        .await
                        .map_err(|e| format!("خطا در پردازش پاسخ سرور: {}", e));
                }
                Ok(resp) => {
                    last_err = format!("HTTP {}", resp.status());
                }
                Err(e) => {
                    last_err = e.to_string();
                }
            }
        }

        Err(format!("خطا در دریافت لیست اوتباندهای اهدایی: {}", last_err))
    }

    /// Measure real TCP connect latency to a target host:port in milliseconds (-1 if unreachable)
    pub async fn ping_tcp(host: &str, port: u16) -> i64 {
        let target = format!("{}:{}", host.trim(), port);
        let start = std::time::Instant::now();
        match tokio::time::timeout(
            std::time::Duration::from_millis(3000),
            tokio::net::TcpStream::connect(&target),
        )
        .await
        {
            Ok(Ok(_)) => start.elapsed().as_millis().max(1) as i64,
            _ => -1,
        }
    }
}
