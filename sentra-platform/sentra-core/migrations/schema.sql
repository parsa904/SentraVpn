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
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

-- 2. SUBSCRIPTIONS TABLE
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
    protocol            TEXT NOT NULL CHECK(protocol IN ('socks', 'http', 'vless', 'vmess', 'trojan', 'hysteria2', 'shadowsocks', 'openvpn')),
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
    mode_category       TEXT NOT NULL CHECK(mode_category IN ('Hydra', 'Shadow', 'Stealth', 'Pulse')),
    country_code        TEXT NOT NULL DEFAULT 'XX',
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
