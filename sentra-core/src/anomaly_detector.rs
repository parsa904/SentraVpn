use crate::db::{DbPool, Repository};
use crate::error::CoreError;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use teloxide::prelude::*;
use teloxide::types::{ChatId, InlineKeyboardButton, InlineKeyboardMarkup, ParseMode};
use tokio::sync::RwLock;

#[derive(Debug, Clone)]
struct TrafficEntry {
    timestamp: Instant,
    bytes: i64,
}

#[derive(Clone)]
pub struct AnomalyDetector {
    traffic_window: Arc<RwLock<HashMap<i64, Vec<TrafficEntry>>>>,
}

impl AnomalyDetector {
    pub fn new() -> Self {
        Self {
            traffic_window: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Records traffic delta and evaluates sliding window limits:
    /// - 15 minutes threshold: 5 GB (5,368,709,120 bytes)
    /// - 60 minutes threshold: 20 GB (21,474,836,480 bytes)
    pub async fn record_and_check(
        &self,
        pool: &DbPool,
        user_id: i64,
        bytes_delta: i64,
        bot_opt: Option<&Bot>,
        admin_chat_id: i64,
    ) -> Result<bool, CoreError> {
        if bytes_delta <= 0 {
            return Ok(false);
        }

        let now = Instant::now();
        let one_hour = Duration::from_secs(3600);
        let fifteen_mins = Duration::from_secs(900);

        let limit_15m: i64 = 5 * 1024 * 1024 * 1024; // 5 GB
        let limit_60m: i64 = 20 * 1024 * 1024 * 1024; // 20 GB

        let mut map = self.traffic_window.write().await;
        let entries = map.entry(user_id).or_insert_with(Vec::new);

        entries.push(TrafficEntry {
            timestamp: now,
            bytes: bytes_delta,
        });

        // Retain only entries within the last 1 hour
        entries.retain(|e| now.duration_since(e.timestamp) <= one_hour);

        let mut sum_15m: i64 = 0;
        let mut sum_60m: i64 = 0;

        for e in entries.iter() {
            let age = now.duration_since(e.timestamp);
            sum_60m += e.bytes;
            if age <= fifteen_mins {
                sum_15m += e.bytes;
            }
        }

        let is_anomaly_15m = sum_15m > limit_15m;
        let is_anomaly_60m = sum_60m > limit_60m;

        if is_anomaly_15m || is_anomaly_60m {
            let reason = if is_anomaly_15m {
                format!(
                    "مصرف بیش از ۵ گیگابایت در ۱۵ دقیقه ({:.2} GB در ۱۵ دقیقه)",
                    sum_15m as f64 / (1024.0 * 1024.0 * 1024.0)
                )
            } else {
                format!(
                    "مصرف بیش از ۲۰ گیگابایت در ۱ ساعت ({:.2} GB در ۶۰ دقیقه)",
                    sum_60m as f64 / (1024.0 * 1024.0 * 1024.0)
                )
            };

            // 1. Suspend user immediately in Database
            Repository::suspend_user_account(pool, user_id, &reason).await?;

            // 2. Dispatch urgent Telegram alert to ADMIN_CHAT_ID
            if let Some(bot) = bot_opt {
                if admin_chat_id != 0 {
                    let user_res = Repository::get_user_by_id(pool, user_id).await?;
                    let (uname, fname, t_id) = if let Some(u) = user_res {
                        (
                            u.username.unwrap_or_else(|| "ندارد".to_string()),
                            u.first_name,
                            u.telegram_id.unwrap_or(0),
                        )
                    } else {
                        ("نامشخص".to_string(), "کاربر".to_string(), 0)
                    };

                    let alert_text = format!(
                        r#"🚨 <b>هشدار امنیتی: تشخیص مصرف ترافیک مشکوک (Anomaly Detected)</b>

👤 <b>مشخصات کاربر:</b>
• شناسه سیستم: <code>{}</code>
• نام کاربری: @{}
• نام کاربر: <b>{}</b>
• شناسه عددی تلگرام: <code>{}</code>

📊 <b>جزئیات الگوی ترافیک غیرعادی:</b>
• تخلف: <b>{}</b>
• تحلیل تهدید: <b>احتمال اشتراک‌گذاری کانفیگ با ده‌ها نفر یا حمله فلود ترافیکی</b>
• اقدام سیستمی: 🔴 <b>حساب کاربری موقتاً مسدود گردید (Suspended)</b>

<i>اتصال کلاینت این کاربر به صورت خودکار متوقف گردید. جهت تعیین وضعیت کاربر اقدام فرمایید:</i>"#,
                        user_id, uname, fname, t_id, reason
                    );

                    let keyboard = InlineKeyboardMarkup::new(vec![vec![
                        InlineKeyboardButton::callback(
                            "✅ رفع مسدودیت کاربر",
                            format!("admin_unsuspend_{}", user_id),
                        ),
                        InlineKeyboardButton::callback(
                            "🚫 مسدودیت دائم",
                            format!("admin_ban_{}", user_id),
                        ),
                    ]]);

                    let _ = bot
                        .send_message(ChatId(admin_chat_id), alert_text)
                        .parse_mode(ParseMode::Html)
                        .reply_markup(keyboard)
                        .await;
                }
            }

            return Ok(true);
        }

        Ok(false)
    }

    /// Reset sliding window after admin unsuspends user
    #[allow(dead_code)]
    pub async fn reset_user(&self, user_id: i64) {
        let mut map = self.traffic_window.write().await;
        map.remove(&user_id);
    }
}
