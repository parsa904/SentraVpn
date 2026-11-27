-- ============================================================================
-- SentraVPN Migration 004: Precompiled sing-box 1.14+ Outbounds & Quarantine
-- Compatible with: wrangler d1 execute sentra-db --remote --file=./migrations/004_precompiled_outbounds.sql
-- (Zero PRAGMA / TRIGGER statements; preserves all existing rows & indexes)
-- ============================================================================

-- Rebuild donated_outbounds cleanly to:
-- 1. Add `compiled_outbound_json TEXT` (validated sing-box 1.14+ outbound JSON)
-- 2. Add `validation_error TEXT` (exact sing-box check / whitelist rejection reason)
-- 3. Extend `status` CHECK constraint to include `'quarantined'`
-- 4. Backfill `compiled_outbound_json` from existing `config_json`

CREATE TABLE donated_outbounds_v4 (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    donor_user_id           INTEGER,
    tag                     TEXT NOT NULL,
    protocol                TEXT NOT NULL,
    server_address          TEXT NOT NULL,
    server_port             INTEGER NOT NULL,
    config_json             TEXT NOT NULL,
    compiled_outbound_json  TEXT,
    validation_error        TEXT,
    latency_ms              INTEGER NOT NULL DEFAULT 9999,
    speed_mbps              REAL NOT NULL DEFAULT 0.0,
    assigned_tier           TEXT NOT NULL DEFAULT 'web_browsing'
                            CHECK(assigned_tier IN ('web_browsing', 'download', 'gaming', 'static_ip', 'rejected')),
    health_score            INTEGER NOT NULL DEFAULT 100,
    status                  TEXT NOT NULL DEFAULT 'active'
                            CHECK(status IN ('pending', 'active', 'inactive', 'rejected', 'quarantined')),
    fail_count              INTEGER NOT NULL DEFAULT 0,
    reward_granted          INTEGER NOT NULL DEFAULT 0,
    raw_link                TEXT,
    rejection_reason        TEXT,
    declared_or_detected_gb INTEGER NOT NULL DEFAULT 0,
    bytes_served            INTEGER NOT NULL DEFAULT 0,
    first_used_at           TEXT,
    monthly_reward_granted  INTEGER NOT NULL DEFAULT 0,
    fingerprint_sha256      TEXT,
    offline_since           TEXT,
    clawback_executed       INTEGER NOT NULL DEFAULT 0,
    is_official             INTEGER NOT NULL DEFAULT 0,
    label                   TEXT,
    country_code            TEXT NOT NULL DEFAULT 'XX',
    country_name            TEXT NOT NULL DEFAULT 'جهانی 🌍',
    allow_web               INTEGER NOT NULL DEFAULT 1,
    allow_download          INTEGER NOT NULL DEFAULT 1,
    allow_gaming            INTEGER NOT NULL DEFAULT 0,
    allow_static_ip         INTEGER NOT NULL DEFAULT 0,
    gemini_ok               INTEGER NOT NULL DEFAULT 0,
    trading_safe            INTEGER NOT NULL DEFAULT 0,
    speed_score             INTEGER NOT NULL DEFAULT 50,
    jitter_ms               INTEGER NOT NULL DEFAULT 0,
    last_online_at          TEXT,
    allocation_mode         TEXT NOT NULL DEFAULT 'auto',
    last_checked_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (donor_user_id) REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO donated_outbounds_v4 (
    id, donor_user_id, tag, protocol, server_address, server_port, config_json,
    compiled_outbound_json, validation_error,
    latency_ms, speed_mbps, assigned_tier, health_score, status, fail_count,
    reward_granted, raw_link, rejection_reason, declared_or_detected_gb,
    bytes_served, first_used_at, monthly_reward_granted, fingerprint_sha256,
    offline_since, clawback_executed, is_official, label, country_code,
    country_name, allow_web, allow_download, allow_gaming, allow_static_ip,
    gemini_ok, trading_safe, speed_score, jitter_ms, last_online_at,
    allocation_mode, last_checked_at, created_at, updated_at
)
SELECT
    id, donor_user_id, tag, protocol, server_address, server_port, config_json,
    config_json, NULL,
    latency_ms, speed_mbps, assigned_tier, health_score, status, fail_count,
    reward_granted, raw_link, rejection_reason, declared_or_detected_gb,
    bytes_served, first_used_at, monthly_reward_granted, fingerprint_sha256,
    offline_since, clawback_executed, is_official, label, country_code,
    country_name, allow_web, allow_download, allow_gaming, allow_static_ip,
    gemini_ok, trading_safe, speed_score, jitter_ms, last_online_at,
    allocation_mode, last_checked_at, created_at, updated_at
FROM donated_outbounds;

DROP TABLE donated_outbounds;

ALTER TABLE donated_outbounds_v4 RENAME TO donated_outbounds;

CREATE INDEX IF NOT EXISTS idx_donated_status ON donated_outbounds(status);
CREATE INDEX IF NOT EXISTS idx_donated_assigned_tier ON donated_outbounds(assigned_tier);
CREATE INDEX IF NOT EXISTS idx_donated_server ON donated_outbounds(server_address, server_port);
CREATE INDEX IF NOT EXISTS idx_donated_is_official ON donated_outbounds(is_official);
CREATE INDEX IF NOT EXISTS idx_donated_country_code ON donated_outbounds(country_code);
CREATE INDEX IF NOT EXISTS idx_donated_speed_score ON donated_outbounds(speed_score);
CREATE INDEX IF NOT EXISTS idx_donated_allow_static ON donated_outbounds(allow_static_ip);
CREATE INDEX IF NOT EXISTS idx_donated_allow_gaming ON donated_outbounds(allow_gaming);
CREATE INDEX IF NOT EXISTS idx_donated_allow_web ON donated_outbounds(allow_web);
CREATE INDEX IF NOT EXISTS idx_donated_allow_dl ON donated_outbounds(allow_download);
CREATE INDEX IF NOT EXISTS idx_donated_status_official_health ON donated_outbounds(status, is_official, health_score);
CREATE INDEX IF NOT EXISTS idx_donated_status_updated_at ON donated_outbounds(status, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_donated_fingerprint ON donated_outbounds(fingerprint_sha256);
