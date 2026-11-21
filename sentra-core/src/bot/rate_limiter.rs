use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

#[derive(Debug, PartialEq, Eq)]
pub enum RateLimitVerdict {
    Allowed,
    BlockAndWarn,
    SilentDrop,
}

#[derive(Debug)]
struct UserRateEntry {
    timestamps: Vec<Instant>,
    cooldown_until: Option<Instant>,
    warned: bool,
}

#[derive(Clone)]
pub struct BotRateLimiter {
    states: Arc<RwLock<HashMap<i64, UserRateEntry>>>,
}

impl BotRateLimiter {
    pub fn new() -> Self {
        Self {
            states: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Check incoming message or button click from a telegram_user_id:
    /// - Max 5 requests in <= 10 seconds.
    /// - Exceeding triggers 5-minute (300s) cooldown.
    /// - Warns user exactly once, then silently drops all updates.
    pub async fn check(&self, telegram_user_id: i64) -> RateLimitVerdict {
        let now = Instant::now();
        let ten_secs = Duration::from_secs(10);
        let cooldown_dur = Duration::from_secs(300);

        let mut map = self.states.write().await;
        let entry = map.entry(telegram_user_id).or_insert_with(|| UserRateEntry {
            timestamps: Vec::new(),
            cooldown_until: None,
            warned: false,
        });

        // 1. Check if currently in Cooldown
        if let Some(until) = entry.cooldown_until {
            if now < until {
                if !entry.warned {
                    entry.warned = true;
                    return RateLimitVerdict::BlockAndWarn;
                } else {
                    return RateLimitVerdict::SilentDrop;
                }
            } else {
                // Cooldown period expired! Reset state
                entry.cooldown_until = None;
                entry.warned = false;
                entry.timestamps.clear();
            }
        }

        // 2. Add current timestamp & keep only timestamps within the last 10 seconds
        entry.timestamps.push(now);
        entry.timestamps.retain(|t| now.duration_since(*t) <= ten_secs);

        // 3. Check threshold: more than 5 requests in <= 10 seconds
        if entry.timestamps.len() > 5 {
            entry.cooldown_until = Some(now + cooldown_dur);
            entry.warned = true;
            return RateLimitVerdict::BlockAndWarn;
        }

        RateLimitVerdict::Allowed
    }
}
