-- ============================================================================
-- SentraVPN — Cloudflare D1 Free-Tier Optimization Migration (002_add_indexes)
-- Run once in Cloudflare D1 Console or via:
--   wrangler d1 execute sentra-db --remote --file=./migrations/002_add_indexes.sql
-- Safe & idempotent (CREATE TABLE / CREATE INDEX IF NOT EXISTS only)
-- ============================================================================

-- Ensure system_settings exists statically (zero runtime DDL in Worker code)
CREATE TABLE IF NOT EXISTS system_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 1. users: fast Telegram webhook lookup & admin role checks
CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- 2. subscriptions: fast token auth & active user subscription lookup
CREATE INDEX IF NOT EXISTS idx_subscriptions_token ON subscriptions(token);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_status ON subscriptions(user_id, status);

-- 3. donated_outbounds: active pool ranking, SHA-256 deduplication & 14-day pruning
CREATE INDEX IF NOT EXISTS idx_donated_status_official_health ON donated_outbounds(status, is_official, health_score);
CREATE UNIQUE INDEX IF NOT EXISTS idx_donated_fingerprint ON donated_outbounds(fingerprint_sha256);
CREATE INDEX IF NOT EXISTS idx_donated_status_updated_at ON donated_outbounds(status, updated_at);

-- 4. outbounds & device_sessions: fast active node & active device filtering
CREATE INDEX IF NOT EXISTS idx_outbounds_active_mode ON outbounds(is_active, mode_category);
CREATE INDEX IF NOT EXISTS idx_device_sessions_sub_active ON device_sessions(subscription_id, is_active);

-- 5. telegram_states: FSM lookup & 24-hour auto-pruning
CREATE INDEX IF NOT EXISTS idx_telegram_states_telegram_id ON telegram_states(telegram_id);
CREATE INDEX IF NOT EXISTS idx_telegram_states_updated_at ON telegram_states(updated_at);

-- 6. donations & support_tickets: admin review queues & user history
CREATE INDEX IF NOT EXISTS idx_donations_status_user ON donations(status, user_id);
CREATE INDEX IF NOT EXISTS idx_tickets_user_status ON support_tickets(user_id, status);
