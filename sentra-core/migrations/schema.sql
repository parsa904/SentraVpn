-- Enable foreign keys and WAL mode
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- 1. USERS TABLE
CREATE TABLE IF NOT EXISTS users (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id         INTEGER NOT NULL UNIQUE,
    username            TEXT,
    first_name          TEXT NOT NULL,
    last_name           TEXT,
    photo_url           TEXT,
    auth_date           INTEGER NOT NULL,
    role                TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user', 'admin', 'reseller')),
    status              TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'suspended', 'banned')),
    auth_code           TEXT,
    auth_code_expires_at DATETIME,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

-- 2. SUBSCRIPTIONS TABLE (Includes Daily Quotas for 4 Connection Modes)
CREATE TABLE IF NOT EXISTS subscriptions (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id                 INTEGER NOT NULL,
    tier                    TEXT NOT NULL CHECK(tier IN ('Sentra Lite', 'Sentra Pro', 'Sentra Flow+')),
    token                   TEXT NOT NULL UNIQUE,
    status                  TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'expired', 'depleted', 'disabled')),
    upload_bytes            INTEGER NOT NULL DEFAULT 0,
    download_bytes          INTEGER NOT NULL DEFAULT 0,
    traffic_limit_bytes     INTEGER NOT NULL,
    speed_limit_bps         INTEGER NOT NULL DEFAULT 0,
    max_concurrent_devices  INTEGER NOT NULL DEFAULT 1,
    web_browsing_used_mb    INTEGER NOT NULL DEFAULT 0,
    download_used_mb        INTEGER NOT NULL DEFAULT 0,
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
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);

-- 3. OUTBOUNDS TABLE
CREATE TABLE IF NOT EXISTS outbounds (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    tag                 TEXT NOT NULL,
    protocol            TEXT NOT NULL CHECK(protocol IN ('socks', 'http', 'vless', 'vmess', 'trojan', 'hysteria2', 'shadowsocks', 'openvpn', 'direct')),
    server_address      TEXT NOT NULL,
    server_port         INTEGER NOT NULL,
    uuid                TEXT,
    password            TEXT,
    network_transport   TEXT NOT NULL DEFAULT 'tcp' CHECK(network_transport IN ('tcp', 'ws', 'grpc', 'httpupgrade', 'quic')),
    tls_enabled         INTEGER NOT NULL DEFAULT 0,
    tls_sni             TEXT,
    reality_public_key  TEXT,
    reality_short_id    TEXT,
    min_tier            TEXT NOT NULL CHECK(min_tier IN ('Sentra Lite', 'Sentra Pro', 'Sentra Flow+')),
    mode_category       TEXT NOT NULL CHECK(mode_category IN ('web_browsing', 'download', 'gaming', 'static_ip', 'Hydra', 'Shadow', 'Stealth', 'Pulse', 'Warp', 'Direct')),
    country_code        TEXT NOT NULL DEFAULT 'XX',
    country_name        TEXT NOT NULL DEFAULT 'Unknown',
    is_active           INTEGER NOT NULL DEFAULT 1,
    weight              INTEGER NOT NULL DEFAULT 1,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_outbounds_mode ON outbounds(mode_category);
CREATE INDEX IF NOT EXISTS idx_outbounds_min_tier ON outbounds(min_tier);
CREATE INDEX IF NOT EXISTS idx_outbounds_is_active ON outbounds(is_active);

-- 4. SUPPORT TICKETS TABLE
CREATE TABLE IF NOT EXISTS support_tickets (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_number       TEXT NOT NULL UNIQUE,
    user_id             INTEGER NOT NULL,
    subscription_id     INTEGER,
    category            TEXT NOT NULL DEFAULT 'connection' CHECK(category IN ('connection', 'billing', 'device_setup', 'performance', 'other')),
    subject             TEXT NOT NULL,
    description         TEXT NOT NULL,
    priority            TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low', 'medium', 'high', 'urgent')),
    status              TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'awaiting_user', 'investigating', 'resolved', 'closed')),
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_tickets_user_id ON support_tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON support_tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_ticket_number ON support_tickets(ticket_number);

-- ============================================================================
-- 7. جدول دستگاه‌های فعال کاربر (USER_DEVICES) - سقف حداکثر ۳ دستگاه
-- ============================================================================
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

-- Triggers for updated_at
CREATE TRIGGER IF NOT EXISTS trg_users_updated_at AFTER UPDATE ON users
FOR EACH ROW BEGIN
    UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_subscriptions_updated_at AFTER UPDATE ON subscriptions
FOR EACH ROW BEGIN
    UPDATE subscriptions SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_outbounds_updated_at AFTER UPDATE ON outbounds
FOR EACH ROW BEGIN
    UPDATE outbounds SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_support_tickets_updated_at AFTER UPDATE ON support_tickets
FOR EACH ROW BEGIN
    UPDATE support_tickets SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id;
END;

-- ============================================================================
-- 8. APP RELEASES TABLE (Client App Binary Releases & Telegram File IDs)
-- ============================================================================
CREATE TABLE IF NOT EXISTS app_releases (
    platform            TEXT PRIMARY KEY CHECK(platform IN ('windows', 'android')),
    version             TEXT NOT NULL,
    telegram_file_id    TEXT NOT NULL,
    file_name           TEXT NOT NULL,
    file_size_mb        REAL NOT NULL DEFAULT 0.0,
    changelog           TEXT NOT NULL DEFAULT '',
    updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER IF NOT EXISTS trg_app_releases_updated_at AFTER UPDATE ON app_releases
FOR EACH ROW BEGIN
    UPDATE app_releases SET updated_at = CURRENT_TIMESTAMP WHERE platform = OLD.platform;
END;

-- ============================================================================
-- 9. DONATED_OUTBOUNDS TABLE (Community & Official Nodes with Country Support)
-- ============================================================================
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
    assigned_tier           TEXT NOT NULL CHECK(assigned_tier IN ('web_browsing', 'download', 'static_ip', 'rejected')),
    health_score            INTEGER NOT NULL DEFAULT 100,
    status                  TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('pending', 'active', 'inactive', 'rejected')),
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
    updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_donated_status ON donated_outbounds(status);
CREATE INDEX IF NOT EXISTS idx_donated_assigned_tier ON donated_outbounds(assigned_tier);
CREATE INDEX IF NOT EXISTS idx_donated_country_code ON donated_outbounds(country_code);

-- ============================================================================
-- 10. SUBSCRIPTION_SOURCES TABLE (Admin Subscription URLs with Periodic Re-Sync)
-- ============================================================================
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
