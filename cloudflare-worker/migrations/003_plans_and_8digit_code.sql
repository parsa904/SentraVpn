-- ============================================================================
-- Migration 003: SentraVPN Plans (Free / Pro / Flow+), 8-Digit Connect Code,
-- Dynamic Quotas, Secure Community Sublinks, and Automated Release File Sync
--
-- Compatible with Cloudflare D1 (SQLite) — run once via:
--   wrangler d1 execute sentra-db --remote --file=./migrations/003_plans_and_8digit_code.sql
-- ============================================================================

-- 1. Subscriptions: 8-digit connect_code, plan_tier, dynamic byte quotas & 1GB trial flag
ALTER TABLE subscriptions ADD COLUMN connect_code TEXT;
ALTER TABLE subscriptions ADD COLUMN plan_tier TEXT NOT NULL DEFAULT 'free';
ALTER TABLE subscriptions ADD COLUMN web_used_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN download_used_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN special_quota_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN special_used_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN has_used_special_trial INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_connect_code ON subscriptions(connect_code);
CREATE INDEX IF NOT EXISTS idx_subscriptions_plan_tier ON subscriptions(plan_tier);

-- Backfill plan_tier for existing subscriptions based on legacy tier names
UPDATE subscriptions
SET plan_tier = CASE
    WHEN tier = 'Sentra Flow+' THEN 'flow_plus'
    WHEN tier IN ('Sentra Pro', 'Sentra Static IP', 'Sentra Gaming') THEN 'pro'
    ELSE 'free'
END
WHERE plan_tier = 'free' AND tier != 'Sentra Lite';

-- 2. Subscription Sources: track community submitter + pending/active/rejected moderation state
ALTER TABLE subscription_sources ADD COLUMN submitted_by_user_id INTEGER;
ALTER TABLE subscription_sources ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';

-- Mark pre-existing admin-configured subscription sources as active
UPDATE subscription_sources
SET status = 'active'
WHERE submitted_by_user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_sub_sources_status ON subscription_sources(status);
CREATE INDEX IF NOT EXISTS idx_sub_sources_user_created ON subscription_sources(submitted_by_user_id, created_at);

-- 3. Automated Release Sync Table (GitHub Releases + Telegram file_id cache)
CREATE TABLE IF NOT EXISTS app_release_files (
    platform         TEXT PRIMARY KEY CHECK(platform IN ('android', 'windows')),
    version          TEXT NOT NULL,
    github_url       TEXT NOT NULL,
    telegram_file_id TEXT,
    updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 4. Dynamic Free-Tier Quotas in system_settings (GB)
INSERT OR IGNORE INTO system_settings (key, value) VALUES ('free_web_quota_gb', '2');
INSERT OR IGNORE INTO system_settings (key, value) VALUES ('free_download_quota_gb', '3');
