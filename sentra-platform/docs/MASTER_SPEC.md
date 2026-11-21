# Sentra Platform - Technical Specification (Phase 1: Local Development)

**Document Version:** 1.0.0  
**Target Environment:** Local Development / Sandbox Testing  
**Architecture:** Monorepo (`sentra-platform`)  
**Core Technologies:** SQLite3, Go / Node.js REST API, Sing-box v1.10+, OpenVPN, Telegram Auth Widget  

---

## 1. Monorepo Architecture Overview

`sentra-platform` is structured as a modular monorepo to isolate core backend services, client applications, and cross-cutting specifications:

```text
sentra-platform/
├── docs/
│   └── MASTER_SPEC.md                 # Complete technical blueprint (this document)
├── sentra-core/                       # Central management service & subscription engine
│   ├── cmd/server/                    # API server entrypoint
│   ├── internal/
│   │   ├── auth/                      # Telegram HMAC validation & JWT issue
│   │   ├── database/                  # SQLite migrations & queries
│   │   ├── subscription/              # Tier enforcement & payload generators
│   │   └── proxy/                     # Sandbox mock listeners & node registry
│   └── config/                        # Local environment configuration
└── sentra-client/                     # Client application runtime & Sing-box wrapper
    ├── assets/                        # Icons, assets, and branding
    ├── configs/                       # Sing-box & OpenVPN configuration templates
    └── src/                           # Client daemon, IPC, and TUN controller
```

---

## 2. Subscription Tiers Specification

Sentra provides three distinct subscription tiers tailored for privacy, latency-critical operations, and censorship evasion:

| Feature / Metric | `Sentra Lite` (Free) | `Sentra Pro` | `Sentra Flow+` |
| :--- | :--- | :--- | :--- |
| **Target Audience** | Trial users, light browsing | Power users, streaming, gaming | Heavy users, high-security bypass |
| **Monthly Traffic** | 10 GB (capped) | 150 GB | Unlimited (Soft cap 1 TB) |
| **Max Concurrent Devices** | 1 device | 3 devices | 10 devices |
| **Max Bandwidth** | 10 Mbps throttled | 100 Mbps burstable | Gigabit unthrottled (1 Gbps+) |
| **Available Outbounds** | `Sentra Pulse` (Basic) | `Sentra Pulse`, `Sentra Shadow` | All modes (`Hydra`, `Shadow`, `Stealth`, `Pulse`) |
| **Protocol Support** | Standard SOCKS/HTTP/VLESS | VLESS-Reality, Trojan | VLESS-Reality, Hysteria2, Multi-path Hydra, OVPN |
| **Priority Level** | Low (Best effort) | Medium-High | Ultra-High (Direct peering & BGP) |
| **Support SLA** | Community / Ticket (48h) | Ticket (12h) | Dedicated Priority Ticket (1h) |

---

## 3. SQLite Database Schema Specification

The database utilizes SQLite 3 with WAL mode enabled (`PRAGMA journal_mode=WAL;`) for optimal concurrency during local testing.

### 3.1 DDL Schema (`schema.sql`)

```sql
-- Enable foreign keys and WAL mode for high performance
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- ============================================================================
-- 1. USERS TABLE
-- Stores authenticated users originating from Telegram Widget / WebApp
-- ============================================================================
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

-- ============================================================================
-- 2. SUBSCRIPTIONS TABLE
-- Tracks tier privileges, cryptographic access tokens, and traffic metrics
-- ============================================================================
CREATE TABLE IF NOT EXISTS subscriptions (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id                 INTEGER NOT NULL,
    tier                    TEXT NOT NULL CHECK(tier IN ('Sentra Lite', 'Sentra Pro', 'Sentra Flow+')),
    token                   TEXT NOT NULL UNIQUE,
    status                  TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'expired', 'depleted', 'disabled')),
    upload_bytes            INTEGER NOT NULL DEFAULT 0,
    download_bytes          INTEGER NOT NULL DEFAULT 0,
    traffic_limit_bytes     INTEGER NOT NULL, -- 10737418240 (10GB) for Lite, 161061273600 (150GB) for Pro, 1099511627776 (1TB) for Flow+
    speed_limit_bps         INTEGER NOT NULL DEFAULT 0, -- 0 = uncapped
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

-- ============================================================================
-- 3. OUTBOUNDS TABLE
-- Server topology and endpoint nodes tagged for Sentra modes and tiers
-- ============================================================================
CREATE TABLE IF NOT EXISTS outbounds (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    tag                 TEXT NOT NULL, -- e.g., 'Sentra Hydra', 'Sentra Shadow', etc.
    protocol            TEXT NOT NULL CHECK(protocol IN ('socks', 'http', 'vless', 'vmess', 'trojan', 'hysteria2', 'shadowsocks', 'openvpn')),
    server_address      TEXT NOT NULL,
    server_port         INTEGER NOT NULL,
    uuid                TEXT,           -- VLESS/VMess UUID or OpenVPN Auth
    password            TEXT,           -- Trojan / Shadowsocks / SOCKS auth
    network_transport   TEXT NOT NULL DEFAULT 'tcp' CHECK(network_transport IN ('tcp', 'ws', 'grpc', 'httpupgrade', 'quic')),
    tls_enabled         INTEGER NOT NULL DEFAULT 0, -- 0 = false, 1 = true
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

-- ============================================================================
-- 4. SUPPORT TICKETS TABLE
-- Multi-tier user customer service and network diagnostic requests
-- ============================================================================
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
-- AUTOMATIC TIMESTAMP TRIGGERS
-- ============================================================================
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
```

### 3.2 Local Sandbox Seed Data (`seed.sql`)

```sql
-- Seed initial users for testing (Lite, Pro, Flow+)
INSERT INTO users (id, telegram_id, username, first_name, last_name, role, status) VALUES
(1, 100000001, 'tester_lite', 'Alice', 'Lite', 'user', 'active'),
(2, 100000002, 'tester_pro', 'Bob', 'Pro', 'user', 'active'),
(3, 100000003, 'tester_flow', 'Charlie', 'Flow', 'user', 'active'),
(4, 999999999, 'sentra_admin', 'Admin', 'Root', 'admin', 'active');

-- Seed subscriptions with fixed tokens for mock API testing
INSERT INTO subscriptions (id, user_id, tier, token, status, upload_bytes, download_bytes, traffic_limit_bytes, speed_limit_bps, max_concurrent_devices, expires_at) VALUES
(1, 1, 'Sentra Lite', 'token_lite_sandbox_001', 'active', 52428800, 1048576000, 10737418240, 10485760, 1, datetime('now', '+30 days')),
(2, 2, 'Sentra Pro', 'token_pro_sandbox_002', 'active', 1073741824, 21474836480, 161061273600, 104857600, 3, datetime('now', '+90 days')),
(3, 3, 'Sentra Flow+', 'token_flow_sandbox_003', 'active', 5368709120, 107374182400, 1099511627776, 0, 10, datetime('now', '+365 days'));

-- Seed local testing outbounds pointing to localhost sandbox listeners (zero cost)
INSERT INTO outbounds (id, tag, protocol, server_address, server_port, network_transport, tls_enabled, min_tier, mode_category, country_code) VALUES
(1, 'Sentra Hydra', 'socks', '127.0.0.1', 10801, 'tcp', 0, 'Sentra Flow+', 'Hydra', 'US'),
(2, 'Sentra Shadow', 'socks', '127.0.0.1', 10802, 'tcp', 0, 'Sentra Pro', 'Shadow', 'DE'),
(3, 'Sentra Stealth', 'http', '127.0.0.1', 10803, 'tcp', 0, 'Sentra Flow+', 'Stealth', 'NL'),
(4, 'Sentra Pulse', 'socks', '127.0.0.1', 10804, 'tcp', 0, 'Sentra Lite', 'Pulse', 'SG');

-- Seed support tickets
INSERT INTO support_tickets (id, ticket_number, user_id, subscription_id, category, subject, description, priority, status) VALUES
(1, 'TCK-2026-0001', 1, 1, 'connection', 'Slow speed on Lite node', 'Latency reaches 400ms when connecting to Pulse Singapore in sandbox.', 'low', 'open'),
(2, 'TCK-2026-0002', 3, 3, 'billing', 'Upgrade to annual corporate flow', 'Requesting custom invoice for Flow+ enterprise deployment.', 'medium', 'in_progress');
```

---

## 4. REST API Contracts (Phase 1)

Base URL: `http://localhost:8080/api/v1`

---

### 4.1 `POST /api/v1/auth/telegram-login`

Validates Telegram WebApp or Login Widget authorization data using HMAC-SHA256 signature verification according to Telegram's official specification. Returns a JWT session token and user profile.

#### Request
- **Headers:** `Content-Type: application/json`
- **Body Schema:**
```json
{
  "id": 100000001,
  "first_name": "Alice",
  "last_name": "Lite",
  "username": "tester_lite",
  "photo_url": "https://t.me/i/userpic/320/tester_lite.jpg",
  "auth_date": 1731837600,
  "hash": "7b8f9e2b1c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f"
}
```

#### HMAC Verification Logic
1. Check that `auth_date` is not older than 86,400 seconds (24 hours).
2. Collect all received fields except `hash`, sort alphabetically by key.
3. Construct `data_check_string = "auth_date=<val>\nfirst_name=<val>\nid=<val>..."`.
4. Derive secret key: `secret_key = SHA256(bot_token)`.
5. Compute `hex(HMAC_SHA256(secret_key, data_check_string))`. Compare securely against `hash`.

#### Responses
- **200 OK**
```json
{
  "success": true,
  "token_type": "Bearer",
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expires_in": 604800,
  "user": {
    "id": 1,
    "telegram_id": 100000001,
    "username": "tester_lite",
    "first_name": "Alice",
    "last_name": "Lite",
    "role": "user"
  },
  "active_subscription": {
    "tier": "Sentra Lite",
    "token": "token_lite_sandbox_001",
    "status": "active",
    "remaining_bytes": 9636413440,
    "expires_at": "2026-12-17T10:00:00Z"
  }
}
```
- **401 Unauthorized**
```json
{
  "success": false,
  "error": "INVALID_TELEGRAM_HASH",
  "message": "Signature verification failed for the provided authentication hash."
}
```

#### Curl Command
```bash
curl -X POST http://localhost:8080/api/v1/auth/telegram-login \
  -H "Content-Type: application/json" \
  -d '{
    "id": 100000001,
    "first_name": "Alice",
    "last_name": "Lite",
    "username": "tester_lite",
    "auth_date": 1731837600,
    "hash": "7b8f9e2b1c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f"
  }'
```

---

### 4.2 `GET /api/v1/client/config`

Returns dynamic client runtime metadata, available nodes, policy rules, and feature flags based on the user's subscription tier.

#### Request
- **Headers:**
  - `Authorization: Bearer <jwt_access_token>` OR
  - `X-Subscription-Token: <subscription_token>`
- **Query Parameters:**
  - `platform` (optional, string: `windows` | `darwin` | `linux` | `android` | `ios`)
  - `client_version` (optional, string: `1.0.0`)

#### Response (200 OK)
```json
{
  "success": true,
  "generated_at": "2026-11-17T13:40:00Z",
  "subscription": {
    "tier": "Sentra Flow+",
    "status": "active",
    "upload_bytes": 5368709120,
    "download_bytes": 107374182400,
    "traffic_limit_bytes": 1099511627776,
    "remaining_bytes": 986768736256,
    "speed_limit_bps": 0,
    "max_concurrent_devices": 10,
    "expires_at": "2027-11-17T13:40:00Z"
  },
  "features": {
    "allow_tun_mode": true,
    "allow_fakeip_dns": true,
    "allow_mode_selection": true,
    "enabled_modes": ["Sentra Hydra", "Sentra Shadow", "Sentra Stealth", "Sentra Pulse"]
  },
  "dns": {
    "fakeip_range_v4": "198.18.0.0/15",
    "fakeip_range_v6": "fc00::/18",
    "upstream_servers": ["https://1.1.1.1/dns-query", "https://8.8.8.8/dns-query"],
    "direct_servers": ["local"]
  },
  "available_nodes": [
    {
      "id": 1,
      "tag": "Sentra Hydra",
      "mode": "Hydra",
      "protocol": "socks",
      "server": "127.0.0.1",
      "port": 10801,
      "country": "US",
      "latency_test_url": "https://cp.cloudflare.com/generate_204"
    },
    {
      "id": 2,
      "tag": "Sentra Shadow",
      "mode": "Shadow",
      "protocol": "socks",
      "server": "127.0.0.1",
      "port": 10802,
      "country": "DE",
      "latency_test_url": "https://cp.cloudflare.com/generate_204"
    },
    {
      "id": 3,
      "tag": "Sentra Stealth",
      "mode": "Stealth",
      "protocol": "http",
      "server": "127.0.0.1",
      "port": 10803,
      "country": "NL",
      "latency_test_url": "https://cp.cloudflare.com/generate_204"
    },
    {
      "id": 4,
      "tag": "Sentra Pulse",
      "mode": "Pulse",
      "protocol": "socks",
      "server": "127.0.0.1",
      "port": 10804,
      "country": "SG",
      "latency_test_url": "https://cp.cloudflare.com/generate_204"
    }
  ]
}
```

#### Curl Command
```bash
curl -X GET http://localhost:8080/api/v1/client/config \
  -H "X-Subscription-Token: token_flow_sandbox_003"
```

---

### 4.3 `GET /api/v1/sub/{token}` (V2Ray / Sing-box Subscription)

Generates standard V2Ray subscription lines (Base64-encoded URI links) containing only the nodes permitted under the subscription's tier.

#### Request
- **Path Parameters:**
  - `token` (string, required): Subscription secret token.
- **Query Parameters:**
  - `raw` (optional, boolean: `true` to return decoded plain-text links for debugging).

#### Response Headers
```http
HTTP/1.1 200 OK
Content-Type: text/plain; charset=utf-8
Content-Disposition: attachment; filename="sentra-sub.txt"
Subscription-Userinfo: upload=5368709120; download=107374182400; total=1099511627776; expire=1826458800
Profile-Update-Interval: 24
```

#### Decoded Body Representation
```text
socks://127.0.0.1:10801#Sentra%20Hydra
socks://127.0.0.1:10802#Sentra%20Shadow
http://127.0.0.1:10803#Sentra%20Stealth
socks://127.0.0.1:10804#Sentra%20Pulse
```

#### Raw Encoded Response Body
```text
c29ja3M6Ly8xMjcuMC4wLjE6MTA4MDEjU2VudHJhJTIwSHlkcmEKc29ja3M6Ly8xMjcuMC4wLjE6MTA4MDIjU2VudHJhJTIwU2hhZG93Cmh0dHA6Ly8xMjcuMC4wLjE6MTA4MDMjU2VudHJhJTIwU3RlYWx0aApzb2NrczovLzEyNy4wLjAuMToxMDgwNCMTZW50cmElMjBQdWxzZQ==
```

#### Curl Command
```bash
curl -i http://localhost:8080/api/v1/sub/token_flow_sandbox_003
```

---

### 4.4 `GET /api/v1/ovpn/{token}` (OpenVPN Configuration Profile)

Generates a standalone, ready-to-import OpenVPN `.ovpn` configuration file containing embedded CA, TLS authentication, and client credentials.

#### Request
- **Path Parameters:**
  - `token` (string, required): Subscription secret token.
- **Query Parameters:**
  - `proto` (optional: `udp` | `tcp`, default: `udp`)

#### Response Headers
```http
HTTP/1.1 200 OK
Content-Type: application/x-openvpn-profile
Content-Disposition: attachment; filename="sentra-token_flow_sandbox_003.ovpn"
```

#### Response Body Example
```text
client
dev tun
proto udp
remote 127.0.0.1 1194
resolv-retry infinite
nobind
persist-key
persist-tun
remote-cert-tls server
cipher AES-256-GCM
auth SHA256
verb 3
auth-user-pass

# Embedded certificates and cryptographic material
<ca>
-----BEGIN CERTIFICATE-----
MIIDSzCCAjOgAwIBAgIUW8d0Q3k9M...[SENTRA-SANDBOX-CA]...
-----END CERTIFICATE-----
</ca>

<cert>
-----BEGIN CERTIFICATE-----
MIIDRjCCAi6gAwIBAgIUX9e1R4l0N...[SENTRA-SANDBOX-CLIENT-CERT]...
-----END CERTIFICATE-----
</cert>

<key>
-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQE...[SENTRA-SANDBOX-CLIENT-KEY]...
-----END PRIVATE KEY-----
</key>

<tls-crypt>
-----BEGIN OpenVPN Static key V1-----
a1b2c3d4e5f60718293a4b5c6d7e8f90...[SENTRA-TLS-CRYPT-KEY]...
-----END OpenVPN Static key V1-----
</tls-crypt>
```

#### Curl Command
```bash
curl -OJ http://localhost:8080/api/v1/ovpn/token_flow_sandbox_003
```

---

## 5. Sing-box v1.10+ Client JSON Template

This configuration is fully compliant with Sing-box v1.10+ schema definitions, utilizing:
1. `inbounds[0].type = "tun"` with strict system routing, stack `mixed`, and destination sniffing enabled.
2. `dns` engine equipped with FakeIP ranges `198.18.0.0/15` and `fc00::/18`.
3. `outbounds` featuring the `urltest` group tagged `"Sentra Auto"` balancing across the 4 mode outbounds.
4. The 4 dedicated mode tags (`Sentra Hydra`, `Sentra Shadow`, `Sentra Stealth`, `Sentra Pulse`) configured to loopback sandbox test proxies on ports `10801-10804` for zero-cost testing.

### 5.1 Complete `sing-box.json`

```json
{
  "log": {
    "level": "info",
    "timestamp": true
  },
  "dns": {
    "servers": [
      {
        "tag": "dns-fakeip",
        "address": "fakeip"
      },
      {
        "tag": "dns-remote",
        "address": "https://1.1.1.1/dns-query",
        "address_resolver": "dns-direct",
        "strategy": "prefer_ipv4",
        "detour": "Sentra Select"
      },
      {
        "tag": "dns-direct",
        "address": "local",
        "detour": "direct"
      },
      {
        "tag": "dns-block",
        "address": "rcode://success"
      }
    ],
    "rules": [
      {
        "outbound": "any",
        "server": "dns-direct"
      },
      {
        "clash_mode": "Direct",
        "server": "dns-direct"
      },
      {
        "clash_mode": "Global",
        "server": "dns-fakeip"
      },
      {
        "rule_set": "geosite-category-ads-all",
        "server": "dns-block"
      },
      {
        "query_type": [
          "A",
          "AAAA"
        ],
        "server": "dns-fakeip"
      }
    ],
    "fakeip": {
      "enabled": true,
      "inet4_range": "198.18.0.0/15",
      "inet6_range": "fc00::/18"
    },
    "independent_cache": true
  },
  "inbounds": [
    {
      "type": "tun",
      "tag": "tun-in",
      "interface_name": "sentra-tun",
      "inet4_address": "172.19.0.1/30",
      "inet6_address": "fdfe:dcba:9876::1/126",
      "mtu": 9000,
      "auto_route": true,
      "strict_route": true,
      "stack": "mixed",
      "sniff": true,
      "sniff_override_destination": true
    }
  ],
  "outbounds": [
    {
      "type": "selector",
      "tag": "Sentra Select",
      "outbounds": [
        "Sentra Auto",
        "Sentra Hydra",
        "Sentra Shadow",
        "Sentra Stealth",
        "Sentra Pulse",
        "direct"
      ],
      "default": "Sentra Auto"
    },
    {
      "type": "urltest",
      "tag": "Sentra Auto",
      "outbounds": [
        "Sentra Hydra",
        "Sentra Shadow",
        "Sentra Stealth",
        "Sentra Pulse"
      ],
      "url": "https://cp.cloudflare.com/generate_204",
      "interval": "3m",
      "tolerance": 50
    },
    {
      "type": "socks",
      "tag": "Sentra Hydra",
      "server": "127.0.0.1",
      "server_port": 10801,
      "version": "5"
    },
    {
      "type": "socks",
      "tag": "Sentra Shadow",
      "server": "127.0.0.1",
      "server_port": 10802,
      "version": "5"
    },
    {
      "type": "http",
      "tag": "Sentra Stealth",
      "server": "127.0.0.1",
      "server_port": 10803
    },
    {
      "type": "socks",
      "tag": "Sentra Pulse",
      "server": "127.0.0.1",
      "server_port": 10804,
      "version": "5"
    },
    {
      "type": "direct",
      "tag": "direct"
    },
    {
      "type": "block",
      "tag": "block"
    },
    {
      "type": "dns",
      "tag": "dns-out"
    }
  ],
  "route": {
    "auto_detect_interface": true,
    "rules": [
      {
        "protocol": "dns",
        "outbound": "dns-out"
      },
      {
        "clash_mode": "Direct",
        "outbound": "direct"
      },
      {
        "clash_mode": "Global",
        "outbound": "Sentra Select"
      },
      {
        "ip_is_private": true,
        "outbound": "direct"
      }
    ],
    "final": "Sentra Select"
  }
}
```

---

## 6. Zero-Cost Sandbox Verification Strategy

To execute Phase 1 integration tests without procuring remote cloud infrastructure:

### 6.1 Mock Proxy Listeners Setup
Run lightweight Python SOCKS5 / HTTP test servers locally on ports 10801 to 10804:
```python
# test_sandbox_listeners.py
import socket, threading

def mock_server(port, protocol_name):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(('127.0.0.1', port))
    s.listen(5)
    print(f"[Sandbox] {protocol_name} listening on 127.0.0.1:{port}")
    while True:
        conn, addr = s.accept()
        # Drain handshake and simulate active upstream
        threading.Thread(target=lambda c: c.close(), args=(conn,)).start()

for port, name in [
    (10801, "Sentra Hydra (SOCKS5)"),
    (10802, "Sentra Shadow (SOCKS5)"),
    (10803, "Sentra Stealth (HTTP)"),
    (10804, "Sentra Pulse (SOCKS5)")
]:
    threading.Thread(target=mock_server, args=(port, name), daemon=True).start()
```

### 6.2 Sing-box Config Validation Command
```bash
sing-box check -c sing-box.json
```
Expected output:
```text
configuration file is valid
```

### 6.3 SQLite Migration & Query Verification
```bash
sqlite3 sentra_local.db < schema.sql
sqlite3 sentra_local.db < seed.sql
sqlite3 sentra_local.db "SELECT u.username, s.tier, s.token, o.tag FROM users u JOIN subscriptions s ON u.id = s.user_id JOIN outbounds o ON s.tier = o.min_tier;"
```

---
*End of Master Specification.*
