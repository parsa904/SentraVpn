-- ============================================================================
-- Sentra Platform — Cloudflare D1 (SQLite) Complete Schema
-- Derived from docs/SCHEMA_AND_API.md with Serverless Webhook & Gaming extensions
-- ============================================================================

PRAGMA foreign_keys = ON;

-- 1. USERS
CREATE TABLE IF NOT EXISTS users (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_uuid               TEXT NOT NULL UNIQUE,
    telegram_id             INTEGER UNIQUE,
    username                TEXT UNIQUE,
    email                   TEXT UNIQUE,
    password_hash           TEXT,
    first_name              TEXT NOT NULL,
    last_name               TEXT,
    role                    TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user', 'admin', 'reseller')),
    status                  TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'suspended', 'banned')),
    auth_code               TEXT,
    auth_code_expires_at    TEXT,
    link_code               TEXT,
    link_code_expires_at    TEXT,
    outbound_reward_banned  INTEGER NOT NULL DEFAULT 0,
    created_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_uuid ON users(user_uuid);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_users_auth_code ON users(auth_code);
CREATE INDEX IF NOT EXISTS idx_users_link_code ON users(link_code);

-- 2. SUBSCRIPTIONS
CREATE TABLE IF NOT EXISTS subscriptions (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id                 INTEGER NOT NULL,
    tier                    TEXT NOT NULL DEFAULT 'Sentra Lite'
                            CHECK(tier IN ('Sentra Lite', 'Sentra Gaming', 'Sentra Static IP', 'Sentra Pro', 'Sentra Flow+')),
    token                   TEXT NOT NULL UNIQUE,
    status                  TEXT NOT NULL DEFAULT 'active'
                            CHECK(status IN ('active', 'expired', 'depleted', 'disabled')),
    upload_bytes            INTEGER NOT NULL DEFAULT 0,
    download_bytes          INTEGER NOT NULL DEFAULT 0,
    traffic_limit_bytes     INTEGER NOT NULL DEFAULT 10737418240,
    speed_limit_bps         INTEGER NOT NULL DEFAULT 0,
    max_concurrent_devices  INTEGER NOT NULL DEFAULT 3,
    web_browsing_used_mb    INTEGER NOT NULL DEFAULT 0,
    download_used_mb        INTEGER NOT NULL DEFAULT 0,
    static_ip_used_mb       INTEGER NOT NULL DEFAULT 0,
    last_quota_reset        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    starts_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at              TEXT NOT NULL,
    created_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_token ON subscriptions(token);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_tier ON subscriptions(tier);

-- 3. DEVICE_SESSIONS
CREATE TABLE IF NOT EXISTS device_sessions (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    subscription_id         INTEGER NOT NULL,
    device_identifier       TEXT NOT NULL,
    device_name             TEXT NOT NULL,
    os                      TEXT NOT NULL DEFAULT 'web',
    client_version          TEXT NOT NULL DEFAULT '1.0.0',
    ip_address              TEXT NOT NULL DEFAULT '0.0.0.0',
    use_warp                INTEGER NOT NULL DEFAULT 0,
    is_active               INTEGER NOT NULL DEFAULT 1,
    last_seen_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE,
    UNIQUE(subscription_id, device_identifier)
);

CREATE INDEX IF NOT EXISTS idx_device_sessions_sub_id ON device_sessions(subscription_id);
CREATE INDEX IF NOT EXISTS idx_device_sessions_last_seen ON device_sessions(last_seen_at);

-- 4. OUTBOUNDS (Core Static Outbounds)
CREATE TABLE IF NOT EXISTS outbounds (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    tag                     TEXT NOT NULL,
    protocol                TEXT NOT NULL
                            CHECK(protocol IN ('socks', 'http', 'vless', 'vmess', 'trojan', 'hysteria2', 'shadowsocks', 'tuic', 'wireguard', 'openvpn')),
    mode_category           TEXT NOT NULL DEFAULT 'all'
                            CHECK(mode_category IN ('web_browsing', 'download', 'gaming', 'static_ip', 'all')),
    server_address          TEXT NOT NULL,
    server_port             INTEGER NOT NULL,
    uuid                    TEXT,
    password                TEXT,
    network_transport       TEXT NOT NULL DEFAULT 'tcp'
                            CHECK(network_transport IN ('tcp', 'ws', 'grpc', 'httpupgrade', 'quic')),
    tls_enabled             INTEGER NOT NULL DEFAULT 0,
    tls_sni                 TEXT,
    reality_public_key      TEXT,
    reality_short_id        TEXT,
    min_tier                TEXT NOT NULL DEFAULT 'Sentra Lite'
                            CHECK(min_tier IN ('Sentra Lite', 'Sentra Gaming', 'Sentra Static IP', 'Sentra Pro', 'Sentra Flow+')),
    country_code            TEXT NOT NULL DEFAULT 'XX',
    is_active               INTEGER NOT NULL DEFAULT 1,
    weight                  INTEGER NOT NULL DEFAULT 1,
    created_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_outbounds_mode ON outbounds(mode_category);
CREATE INDEX IF NOT EXISTS idx_outbounds_min_tier ON outbounds(min_tier);

-- 4.1. DONATED_OUTBOUNDS (Official Admin + Community Ecosystem Outbounds)
CREATE TABLE IF NOT EXISTS donated_outbounds (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    donor_user_id           INTEGER,
    tag                     TEXT NOT NULL,
    protocol                TEXT NOT NULL,
    server_address          TEXT NOT NULL,
    server_port             INTEGER NOT NULL,
    config_json             TEXT NOT NULL,
    latency_ms              INTEGER NOT NULL DEFAULT 9999,
    speed_mbps              REAL NOT NULL DEFAULT 0.0,
    assigned_tier           TEXT NOT NULL DEFAULT 'web_browsing'
                            CHECK(assigned_tier IN ('web_browsing', 'download', 'gaming', 'static_ip', 'rejected')),
    health_score            INTEGER NOT NULL DEFAULT 100,
    status                  TEXT NOT NULL DEFAULT 'active'
                            CHECK(status IN ('pending', 'active', 'inactive', 'rejected')),
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_donated_fingerprint ON donated_outbounds(fingerprint_sha256);

-- 4.2. SUBSCRIPTION_SOURCES (Admin Subscription URLs)
CREATE TABLE IF NOT EXISTS subscription_sources (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    category                TEXT NOT NULL CHECK(category IN ('web_browsing', 'download', 'gaming', 'static_ip')),
    sub_url                 TEXT NOT NULL,
    tag                     TEXT,
    total_nodes             INTEGER NOT NULL DEFAULT 0,
    healthy_nodes           INTEGER NOT NULL DEFAULT 0,
    last_sync_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sub_sources_category ON subscription_sources(category);

-- 4.3. DONATIONS (Financial Receipts)
CREATE TABLE IF NOT EXISTS donations (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id                 INTEGER NOT NULL,
    amount                  INTEGER NOT NULL,
    receipt_file_id         TEXT NOT NULL,
    file_unique_id          TEXT,
    image_sha256            TEXT,
    status                  TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
    subscription_granted    INTEGER NOT NULL DEFAULT 0,
    created_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_donations_user_id ON donations(user_id);
CREATE INDEX IF NOT EXISTS idx_donations_status ON donations(status);
CREATE INDEX IF NOT EXISTS idx_donations_file_unique_id ON donations(file_unique_id);
CREATE INDEX IF NOT EXISTS idx_donations_image_sha256 ON donations(image_sha256);

-- 4.4. IP_REGISTRATIONS (Anti-Abuse Rate Limit Table)
CREATE TABLE IF NOT EXISTS ip_registrations (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    ip                      TEXT NOT NULL,
    created_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ip_registrations_lookup ON ip_registrations(ip, created_at);

-- 4.5. WARP_ACCOUNTS (Cloudflare WARP Credentials for Dual-Chain Bridge)
CREATE TABLE IF NOT EXISTS warp_accounts (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id              TEXT NOT NULL,
    private_key             TEXT NOT NULL,
    public_key              TEXT NOT NULL,
    ipv4_address            TEXT NOT NULL,
    ipv6_address            TEXT NOT NULL,
    reserved                TEXT NOT NULL,
    license_key             TEXT,
    is_active               INTEGER NOT NULL DEFAULT 1,
    created_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_warp_accounts_active ON warp_accounts(is_active);

-- 5. TRAFFIC_LOGS
CREATE TABLE IF NOT EXISTS traffic_logs (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    subscription_id         INTEGER NOT NULL,
    outbound_id             INTEGER,
    bytes_sent              INTEGER NOT NULL DEFAULT 0,
    bytes_received          INTEGER NOT NULL DEFAULT 0,
    recorded_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE,
    FOREIGN KEY (outbound_id) REFERENCES outbounds(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_traffic_logs_sub ON traffic_logs(subscription_id);
CREATE INDEX IF NOT EXISTS idx_traffic_logs_recorded ON traffic_logs(recorded_at);

-- 6. SUPPORT_TICKETS
CREATE TABLE IF NOT EXISTS support_tickets (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_number           TEXT NOT NULL UNIQUE,
    user_id                 INTEGER NOT NULL,
    subscription_id         INTEGER,
    category                TEXT NOT NULL DEFAULT 'connection'
                            CHECK(category IN ('connection', 'billing', 'device_setup', 'performance', 'other')),
    subject                 TEXT NOT NULL,
    description             TEXT NOT NULL,
    priority                TEXT NOT NULL DEFAULT 'medium'
                            CHECK(priority IN ('low', 'medium', 'high', 'urgent')),
    status                  TEXT NOT NULL DEFAULT 'open'
                            CHECK(status IN ('open', 'awaiting_user', 'investigating', 'resolved', 'closed')),
    created_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_tickets_user_id ON support_tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON support_tickets(status);

-- 7. APP_RELEASES
CREATE TABLE IF NOT EXISTS app_releases (
    platform                TEXT PRIMARY KEY CHECK(platform IN ('windows', 'android')),
    version                 TEXT NOT NULL,
    telegram_file_id        TEXT NOT NULL,
    file_name               TEXT NOT NULL,
    file_size_mb            REAL NOT NULL DEFAULT 0.0,
    changelog               TEXT NOT NULL DEFAULT '',
    updated_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER IF NOT EXISTS trg_app_releases_updated_at AFTER UPDATE ON app_releases
FOR EACH ROW BEGIN
    UPDATE app_releases SET updated_at = CURRENT_TIMESTAMP WHERE platform = OLD.platform;
END;

-- 8. CLIENT_STATES (Cross-Device Personal Configs & Preferences Sync)
CREATE TABLE IF NOT EXISTS client_states (
    user_id                 INTEGER PRIMARY KEY,
    personal_configs_json   TEXT NOT NULL DEFAULT '[]',
    preferences_json        TEXT NOT NULL DEFAULT '{}',
    updated_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 9. TELEGRAM_STATES (Stateless Webhook Conversation FSM Persistence)
CREATE TABLE IF NOT EXISTS telegram_states (
    telegram_id             INTEGER PRIMARY KEY,
    state_type              TEXT NOT NULL,
    payload_json            TEXT NOT NULL DEFAULT '{}',
    updated_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
