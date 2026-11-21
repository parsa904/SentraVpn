# مستندات پایگاه داده و قراردادهای API پلتفرم سنترا (`docs/SCHEMA_AND_API.md`)

**نگارش:** ۱.۰.۰  
**فناوری پایگاه داده:** SQLx (طراحی شده برای SQLite در فاز ۱ و کاملاً آماده برای ارتقا به PostgreSQL در فاز ۲)  
**معماری API:** RESTful JSON مبتنی بر توکن‌های حامل (Bearer JWT) و توکن‌های رمزشده اشتراک (Subscription Tokens)  

---

## ۱. ساختار پایگاه داده (SQLx Database Schema)

جداول به گونه‌ای طراحی شده‌اند که انواع داده‌ای در هر دو دیتابیس **SQLite** و **PostgreSQL** بدون تغییر در منطق کدهای Rust سازگار باشند. در فاز ۱ فیلدهای زمانی با استاندارد ISO-8601 UTC ذخیره می‌گردند.

```text
+-------------------+       +-----------------------+       +------------------------+
|       users       | 1---N |     subscriptions     | 1---N |    device_sessions     |
| (Telegram ID,     |       | (Tier, Token, Limits, |       | (Device MAC, OS, IP,   |
|  8-Digit AuthCode)|       |  Traffic, Expiration) |       |  Concurrent Devices)   |
+-------------------+       +-----------------------+       +------------------------+
          |                             |                               |
          | 1---N                       | 1---N                         |
          v                             v                               |
+-------------------+       +-----------------------+                   |
|  support_tickets  |       |     traffic_logs      | <-----------------+
| (Tickets, Status) |       | (Hourly Aggregates,   |
+-------------------+       |  Bandwidth Tracking)  |
                            +-----------------------+
                                        ^
                                        | N---1
                            +-----------------------+
                            |       outbounds       |
                            | (Protocols, Tiers,    |
                            |  Tags, Sandbox Ports) |
                            +-----------------------+
```

### ۱.۱. متن کامل اسکریپت DDL سازگار با SQLx

```sql
-- ============================================================================
-- 1. جدول کاربران (USERS)
-- ============================================================================
CREATE TABLE IF NOT EXISTS users (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id             BIGINT NOT NULL UNIQUE,
    username                TEXT,
    first_name              TEXT NOT NULL,
    last_name               TEXT,
    role                    TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user', 'admin', 'reseller')),
    status                  TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'suspended', 'banned')),
    auth_code               TEXT,               -- کد ۸ رقمی تولیدشده توسط ربات تلگرام برای ورود به اپلیکیشن
    auth_code_expires_at    DATETIME,           -- تاریخ انقضای کد یکبارمصرف (معمولاً ۵ دقیقه)
    created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_users_auth_code ON users(auth_code);

-- ============================================================================
-- 2. جدول اشتراک‌ها (SUBSCRIPTIONS)
-- ============================================================================
CREATE TABLE IF NOT EXISTS subscriptions (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id                 INTEGER NOT NULL,
    tier                    TEXT NOT NULL CHECK(tier IN ('Sentra Lite', 'Sentra Pro', 'Sentra Flow+')),
    token                   TEXT NOT NULL UNIQUE, -- توکن ایمن UUIDv4 برای دریافت کانفیگ و سابسکریپشن
    status                  TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'expired', 'depleted', 'disabled')),
    upload_bytes            BIGINT NOT NULL DEFAULT 0,
    download_bytes          BIGINT NOT NULL DEFAULT 0,
    traffic_limit_bytes     BIGINT NOT NULL,     -- سقف حجم: 10GB برای Lite، 150GB برای Pro، 1TB برای Flow+
    speed_limit_bps         INTEGER NOT NULL DEFAULT 0, -- 0 به معنی بدون محدودیت سرعت
    max_concurrent_devices  INTEGER NOT NULL DEFAULT 1, -- تعداد سقف دستگاه همزمان
    starts_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at              DATETIME NOT NULL,
    created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_token ON subscriptions(token);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_tier ON subscriptions(tier);

-- ============================================================================
-- 3. جدول نشست دستگاه‌ها جهت کنترل کاربران همزمان (DEVICE_SESSIONS)
-- ============================================================================
CREATE TABLE IF NOT EXISTS device_sessions (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    subscription_id         INTEGER NOT NULL,
    device_identifier       TEXT NOT NULL,       -- هش یکتای ترکیبی سخت‌افزار (Hardware Fingerprint)
    device_name             TEXT NOT NULL,       -- نام دستگاه کاربر (مثلا: "Alice Windows Laptop")
    os                      TEXT NOT NULL,       -- windows, android, darwin, linux
    client_version          TEXT NOT NULL,       -- نگارش کلاینت سنترا (مثلا: "1.0.0")
    ip_address              TEXT NOT NULL,       -- آخرین IP کلاینت
    is_active               INTEGER NOT NULL DEFAULT 1,
    last_seen_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE,
    UNIQUE(subscription_id, device_identifier)
);

CREATE INDEX IF NOT EXISTS idx_device_sessions_sub_id ON device_sessions(subscription_id);
CREATE INDEX IF NOT EXISTS idx_device_sessions_last_seen ON device_sessions(last_seen_at);

-- ============================================================================
-- 4. جدول سرورها و خروجی‌های شبکه (OUTBOUNDS)
-- ============================================================================
CREATE TABLE IF NOT EXISTS outbounds (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    tag                     TEXT NOT NULL,       -- 'Sentra Hydra', 'Sentra Shadow', 'Sentra Stealth', 'Sentra Pulse'
    protocol                TEXT NOT NULL CHECK(protocol IN ('socks', 'http', 'vless', 'vmess', 'trojan', 'hysteria2', 'shadowsocks', 'openvpn')),
    server_address          TEXT NOT NULL,       -- 127.0.0.1 در فاز ۱
    server_port             INTEGER NOT NULL,    -- 10801, 10802, ... در فاز ۱
    uuid                    TEXT,                -- UUID برای VLESS / لاگین کلاینت
    password                TEXT,                -- پسورد یا رمز عبور اشتراکی
    network_transport       TEXT NOT NULL DEFAULT 'tcp' CHECK(network_transport IN ('tcp', 'ws', 'grpc', 'httpupgrade', 'quic')),
    tls_enabled             INTEGER NOT NULL DEFAULT 0,
    tls_sni                 TEXT,
    reality_public_key      TEXT,
    reality_short_id        TEXT,
    min_tier                TEXT NOT NULL CHECK(min_tier IN ('Sentra Lite', 'Sentra Pro', 'Sentra Flow+')),
    mode_category           TEXT NOT NULL CHECK(mode_category IN ('Hydra', 'Shadow', 'Stealth', 'Pulse')),
    country_code            TEXT NOT NULL DEFAULT 'XX',
    is_active               INTEGER NOT NULL DEFAULT 1,
    weight                  INTEGER NOT NULL DEFAULT 1,
    created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_outbounds_mode ON outbounds(mode_category);
CREATE INDEX IF NOT EXISTS idx_outbounds_min_tier ON outbounds(min_tier);

-- ============================================================================
-- 5. جدول لاگ‌های تجمیعی مصرف ترافیک (TRAFFIC_LOGS)
-- ============================================================================
CREATE TABLE IF NOT EXISTS traffic_logs (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    subscription_id         INTEGER NOT NULL,
    outbound_id             INTEGER,
    bytes_sent              BIGINT NOT NULL DEFAULT 0,
    bytes_received          BIGINT NOT NULL DEFAULT 0,
    recorded_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE,
    FOREIGN KEY (outbound_id) REFERENCES outbounds(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_traffic_logs_sub ON traffic_logs(subscription_id);
CREATE INDEX IF NOT EXISTS idx_traffic_logs_recorded ON traffic_logs(recorded_at);

-- ============================================================================
-- 6. جدول تیکت‌های پشتیبانی کاربران (SUPPORT_TICKETS)
-- ============================================================================
CREATE TABLE IF NOT EXISTS support_tickets (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_number           TEXT NOT NULL UNIQUE,
    user_id                 INTEGER NOT NULL,
    subscription_id         INTEGER,
    category                TEXT NOT NULL DEFAULT 'connection' CHECK(category IN ('connection', 'billing', 'device_setup', 'performance', 'other')),
    subject                 TEXT NOT NULL,
    description             TEXT NOT NULL,
    priority                TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low', 'medium', 'high', 'urgent')),
    status                  TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'awaiting_user', 'investigating', 'resolved', 'closed')),
    created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_tickets_user_id ON support_tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON support_tickets(status);
```

---

## ۲. قراردادهای رسمی REST API (نسخه ۱)

آدرس پایه سرور در محیط تست محلی: `http://localhost:8080/api/v1`

---

### ۲.۱. تبادل کد ۸ رقمی ورود اپلیکیشن (`POST /api/v1/auth/exchange-code`)
کاربر در ربات تلگرام روی دکمه «دریافت کد ورود اپلیکیشن» کلیک می‌کند. ربات یک کد تصادفی ۸ رقمی (مثلاً `48291047`) تولید کرده و در جدول `users` با انقضای ۵ دقیقه‌ای ثبت می‌کند. سپس کاربر این کد را داخل برنامه سنترا وارد می‌کند.

- **مسیر:** `/api/v1/auth/exchange-code`
- **روش:** `POST`
- **هدرها:** `Content-Type: application/json`
- **بدنه درخواست (JSON):**
```json
{
  "code": "48291047",
  "device_identifier": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "device_name": "Alice Windows PC",
  "os": "windows",
  "client_version": "1.0.0"
}
```

- **پاسخ موفق (200 OK):**
```json
{
  "success": true,
  "token_type": "Bearer",
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expires_in": 2592000,
  "user": {
    "id": 1,
    "telegram_id": 100000001,
    "username": "tester_lite",
    "first_name": "Alice"
  },
  "subscription": {
    "tier": "Sentra Lite",
    "token": "token_lite_sandbox_001",
    "status": "active",
    "remaining_bytes": 9636413440,
    "max_concurrent_devices": 1,
    "active_devices_count": 1,
    "expires_at": "2026-12-17T10:00:00Z"
  }
}
```

- **خطای تعداد بیش از حد دستگاه (403 Forbidden):**
```json
{
  "success": false,
  "error": "DEVICE_LIMIT_EXCEEDED",
  "message": "تعداد دستگاه‌های همزمان متصل به سقف مجاز این اشتراک (۱ دستگاه) رسیده است. جهت اتصال دستگاه جدید، یکی از دستگاه‌های قبلی را حذف یا اشتراک خود را ارتقا دهید."
}
```

---

### ۲.۲. دریافت کانفیگ هوشمند کلاینت (`GET /api/v1/client/config`)
کلاینت سنترا در زمان شروع کار یا بعد از ورود، این درخواست را ارسال کرده و بسته به پلن کاربر (`Lite`, `Pro`, `Flow+`)، لیست سرورهای مجاز، پارامترهای DNS و ماژول‌های فعال را دریافت می‌کند.

- **مسیر:** `/api/v1/client/config`
- **روش:** `GET`
- **هدرهای مجاز:**
  * `Authorization: Bearer <jwt_access_token>` یا
  * `X-Subscription-Token: <subscription_token>`
- **پاسخ موفق (200 OK):**
```json
{
  "success": true,
  "tier": "Sentra Flow+",
  "features": {
    "allow_tun_mode": true,
    "allow_fakeip": true,
    "allow_mode_selection": true,
    "active_modes": [
      "Sentra Auto",
      "Sentra Hydra",
      "Sentra Shadow",
      "Sentra Stealth",
      "Sentra Pulse"
    ]
  },
  "dns_policy": {
    "fakeip_pool": "198.18.0.0/15",
    "strategy": "ipv4_only",
    "remote_doh": "https://1.1.1.1/dns-query",
    "local_dns": "local"
  },
  "routing_rules": {
    "bypass_iran_domains": true,
    "bypass_private_ips": true
  },
  "nodes": [
    {
      "id": 1,
      "tag": "Sentra Hydra",
      "category": "Hydra",
      "protocol": "socks",
      "server": "127.0.0.1",
      "port": 10801,
      "country": "US",
      "ping_probe_url": "https://cp.cloudflare.com/generate_204"
    },
    {
      "id": 2,
      "tag": "Sentra Shadow",
      "category": "Shadow",
      "protocol": "socks",
      "server": "127.0.0.1",
      "port": 10802,
      "country": "DE",
      "ping_probe_url": "https://cp.cloudflare.com/generate_204"
    },
    {
      "id": 3,
      "tag": "Sentra Stealth",
      "category": "Stealth",
      "protocol": "http",
      "server": "127.0.0.1",
      "port": 10803,
      "country": "NL",
      "ping_probe_url": "https://cp.cloudflare.com/generate_204"
    },
    {
      "id": 4,
      "tag": "Sentra Pulse",
      "category": "Pulse",
      "protocol": "socks",
      "server": "127.0.0.1",
      "port": 10804,
      "country": "SG",
      "ping_probe_url": "https://cp.cloudflare.com/generate_204"
    }
  ]
}
```

---

### ۲.۳. دریافت سابسکریپشن V2Ray بر پایه توکن (`GET /api/v1/sub/{token}`)
سازگار با اپلیکیشن‌های عمومی نظیر v2rayN، Sing-box، Clash و Streisand. نودهای منطبق بر سطح اشتراک به شکل لینک‌های Base64 رمزگذاری شده برگردانده می‌شوند.

- **مسیر:** `/api/v1/sub/{token}`
- **روش:** `GET`
- **هدرهای پاسخ:**
  * `Content-Type: text/plain; charset=utf-8`
  * `Subscription-Userinfo: upload=5368709120; download=107374182400; total=1099511627776; expire=1826458800`
- **محتوای خروجی Base64 (شامل نودهای فعال متناسب با پلن):**
```text
c29ja3M6Ly8xMjcuMC4wLjE6MTA4MDEjU2VudHJhJTIwSHlkcmEKc29ja3M6Ly8xMjcuMC4wLjE6MTA4MDIjU2VudHJhJTIwU2hhZG93Cmh0dHA6Ly8xMjcuMC4wLjE6MTA4MDMjU2VudHJhJTIwU3RlYWx0aApzb2NrczovLzEyNy4wLjAuMToxMDgwNCMTZW50cmElMjBQdWxzZQ==
```

---

### ۲.۴. دریافت پروفایل کلاینت OpenVPN (`GET /api/v1/ovpn/{token}`)
برای دستگاه‌هایی که از پروتکل استاندارد OpenVPN استفاده می‌کنند یا به عنوان پروتکل پشتیبان در شرایط اختلال کامل.

- **مسیر:** `/api/v1/ovpn/{token}`
- **روش:** `GET`
- **هدرهای پاسخ:**
  * `Content-Type: application/x-openvpn-profile`
  * `Content-Disposition: attachment; filename="sentra-client.ovpn"`
- **محتوا:** ساختار استاندارد `.ovpn` همراه با گواهی‌های اینلاین `<ca>`, `<cert>`, `<key>`, `<tls-crypt>` و تنظیمات مسیریابی بدون نشت DNS.

---

### ۲.۵. ثبت ضربان قلب و مصرف ترافیک (`POST /api/v1/client/heartbeat`)
کلاینت هر ۲ دقیقه یک بار جهت تایید زنده بودن نشست دستگاه و همگام‌سازی ترافیک مصرفی این درخواست را فراخوانی می‌کند.

- **مسیر:** `/api/v1/client/heartbeat`
- **روش:** `POST`
- **هدر:** `Authorization: Bearer <jwt_access_token>`
- **بدنه درخواست:**
```json
{
  "device_identifier": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "delta_upload_bytes": 1048576,
  "delta_download_bytes": 15728640,
  "active_node_id": 1
}
```
- **پاسخ (200 OK):**
```json
{
  "status": "synced",
  "remaining_bytes": 986751959040,
  "should_disconnect": false
}
```
*(اگر `remaining_bytes <= 0` یا اشتراک منقضی شده باشد، سرور مقدار `"should_disconnect": true` ارسال می‌کند تا کلاینت فوراً ترافیک را قطع کند).*
