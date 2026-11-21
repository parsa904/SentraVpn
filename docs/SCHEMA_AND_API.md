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
    user_uuid               TEXT NOT NULL UNIQUE, -- شناسه جهانی یکتا برای اتصال در تمامی کلاینت‌ها
    telegram_id             BIGINT UNIQUE,        -- شناسه تلگرام (اختیاری جهت پشتیبانی از ثبت‌نام مستقیم در اپ)
    username                TEXT UNIQUE,          -- نام کاربری جهت ورود مستقیم با پسورد
    password_hash           TEXT,                 -- هش ایمن پسورد با الگوریتم صنعتی Argon2id
    first_name              TEXT NOT NULL,
    last_name               TEXT,
    role                    TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user', 'admin', 'reseller')),
    status                  TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'suspended', 'banned')),
    auth_code               TEXT,                 -- کد ۸ رقمی تلگرام برای ورود سریع (OTP)
    auth_code_expires_at    DATETIME,             -- تاریخ انقضای ۵ دقیقه‌ای کد ورود
    link_code               TEXT,                 -- کد موقت ۶ رقمی برای ادغام حساب اپلیکیشن و تلگرام
    link_code_expires_at    DATETIME,             -- تاریخ انقضای ۵ دقیقه‌ای کد اتصال
    outbound_reward_banned  INTEGER NOT NULL DEFAULT 0, -- محرومیت از دریافت پاداش اوتباند به دلیل تخلف خاموشی زیر ۷ روز
    created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_uuid ON users(user_uuid);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_users_auth_code ON users(auth_code);
CREATE INDEX IF NOT EXISTS idx_users_link_code ON users(link_code);

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
    web_browsing_used_mb    BIGINT NOT NULL DEFAULT 0,  -- مصرف روزانه وب‌گردی (سقف 2048 MB برای Lite، نامحدود برای Pro)
    download_used_mb        BIGINT NOT NULL DEFAULT 0,  -- مصرف روزانه دانلود (سقف 3072 MB برای Lite، نامحدود برای Pro)
    static_ip_used_mb       BIGINT NOT NULL DEFAULT 0,  -- مصرف ماهانه آی‌پی ثابت اختصاصی (سقف 30,720 MB برای Pro/Flow+)
    last_quota_reset        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, -- تاریخ آخرین ریست ۲۴ ساعته بر اساس افق تهران
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
    tag                     TEXT NOT NULL,       -- 'Sentra Web Browsing', 'Sentra Download', 'Sentra Static IP US'
    protocol                TEXT NOT NULL CHECK(protocol IN ('socks', 'http', 'vless', 'vmess', 'trojan', 'hysteria2', 'shadowsocks', 'openvpn')),
    mode_category           TEXT NOT NULL DEFAULT 'all' CHECK(mode_category IN ('web_browsing', 'download', 'gaming', 'static_ip', 'all')), -- تفکیک ۴ حالت تجاری
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
-- 4.1. جدول سرورهای اهدایی جامعه کاربری و اوتباندهای رسمی ادمین (DONATED_OUTBOUNDS)
-- ============================================================================
CREATE TABLE IF NOT EXISTS donated_outbounds (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    donor_user_id           INTEGER,             -- شناسه کاربری اهداکننده (برای اوتباند رسمی NULL است)
    tag                     TEXT NOT NULL,       -- نام نمایشی کانفیگ
    protocol                TEXT NOT NULL,       -- vless, vmess, trojan, hysteria2, shadowsocks
    server_address          TEXT NOT NULL,       -- آدرس IP یا دامنه سرور
    server_port             INTEGER NOT NULL,    -- پورت اتصال
    config_json             TEXT NOT NULL,       -- شیء استاندارد کانفیگ سینگ‌باکس
    latency_ms              BIGINT NOT NULL DEFAULT 9999, -- تاخیر شبکه TCP Handshake
    speed_mbps              REAL NOT NULL DEFAULT 0.0,   -- بنچمارک تخمینی سرعت
    assigned_tier           TEXT NOT NULL DEFAULT 'web_browsing' CHECK(assigned_tier IN ('web_browsing', 'download', 'static_ip', 'rejected')),
    health_score            INTEGER NOT NULL DEFAULT 100, -- امتیاز سلامت (۰ تا ۱۰۰)
    status                  TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('pending', 'active', 'inactive', 'rejected')),
    fail_count              INTEGER NOT NULL DEFAULT 0,  -- تعداد خطاهای متوالی در تست دوره‌ای
    reward_granted          INTEGER NOT NULL DEFAULT 0,  -- رزرو شده
    raw_link                TEXT,                -- لینک خام ارسالی
    rejection_reason        TEXT,                -- علت رد در تست یا اسکن SSRF
    declared_or_detected_gb BIGINT NOT NULL DEFAULT 0, -- ظرفیت تاییدشده اوتباند
    bytes_served            BIGINT NOT NULL DEFAULT 0, -- مجموع بایت‌های واقعی خدمت‌رسانی به کاربران
    first_used_at           DATETIME,            -- زمان اولین عبور ترافیک واقعی
    monthly_reward_granted  INTEGER NOT NULL DEFAULT 0, -- وضعیت اعطای ۳۰ روز اشتراک Pro
    fingerprint_sha256      TEXT,                -- انگشت‌نگاری عمیق SHA-256 از ترکیب آی‌پی، پورت، پروتکل و سکرت
    offline_since           DATETIME,            -- زمان شروع خاموشی جهت اعمال مهلت ۲ ساعته
    clawback_executed       INTEGER NOT NULL DEFAULT 0, -- آیا پس‌گرفتن پاداش اجرا شده است؟
    is_official             INTEGER NOT NULL DEFAULT 0, -- ۱: نود رسمی ادمین، ۰: نود اهدایی کاربر
    label                   TEXT,                -- برچسب سفارشی نود رسمی (مانند US-Static-01 یا DE-Download-01)
    last_checked_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (donor_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_donated_status ON donated_outbounds(status);
CREATE INDEX IF NOT EXISTS idx_donated_assigned_tier ON donated_outbounds(assigned_tier);
CREATE INDEX IF NOT EXISTS idx_donated_server ON donated_outbounds(server_address, server_port);
CREATE INDEX IF NOT EXISTS idx_donated_is_official ON donated_outbounds(is_official);
CREATE UNIQUE INDEX IF NOT EXISTS idx_donated_fingerprint ON donated_outbounds(fingerprint_sha256);

-- ============================================================================
-- 4.2. جدول حمایت‌های مالی (DONATIONS)
-- ============================================================================
CREATE TABLE IF NOT EXISTS donations (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id                 INTEGER NOT NULL,
    amount                  BIGINT NOT NULL,     -- مبلغ حمایت مالی به تومان
    receipt_file_id         TEXT NOT NULL,       -- شناسه فایل تصویر فیش در تلگرام
    file_unique_id          TEXT,                -- شناسه یکتای جهانی فایل تلگرام برای Anti-Replay
    image_sha256            TEXT,                -- هش یکتای SHA-256 فیش ارسالی
    status                  TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
    subscription_granted    INTEGER NOT NULL DEFAULT 0, -- آیا پاداش ۳۰ روزه Pro داده شد؟ (مبالغ > 2*PRO_PRICE)
    created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_donations_user_id ON donations(user_id);
CREATE INDEX IF NOT EXISTS idx_donations_status ON donations(status);
CREATE INDEX IF NOT EXISTS idx_donations_file_unique_id ON donations(file_unique_id);
CREATE INDEX IF NOT EXISTS idx_donations_image_sha256 ON donations(image_sha256);

-- ============================================================================
-- 4.3. جدول کنترل نرخ ثبت‌نام آی‌پی (IP_REGISTRATIONS)
-- ============================================================================
CREATE TABLE IF NOT EXISTS ip_registrations (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    ip                      TEXT NOT NULL,       -- آدرس IP کلاینت ثبت‌نام‌کننده
    created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ip_registrations_lookup ON ip_registrations(ip, created_at);

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

-- ============================================================================
-- 8. جدول نسخه‌های رسمی اپلیکیشن کلاینت (APP_RELEASES)
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
```

---

## ۲. قراردادهای رسمی REST API (نسخه ۱)

آدرس پایه سرور در محیط تست محلی: `http://localhost:8080/api/v1`

---

### ۲.۰.۱. ثبت‌نام مستقیم کاربر جدید (`POST /api/v1/auth/register`)
ثبت‌نام مستقیم و آنی در اپلیکیشن کلاینت ویندوز یا اندروید بدون وابستگی به تلگرام با فعال‌سازی خودکار اشتراک رایگان Sentra Lite و ثبت دستگاه جاری.

- **مسیر:** `/api/v1/auth/register`
- **روش:** `POST`
- **هدرها:** `Content-Type: application/json`
- **بدنه درخواست (JSON):**
```json
{
  "username": "sentra_fan",
  "password": "StrongPassword123",
  "device_identifier": "sentra-pc-4f81c9a0",
  "device_name": "Windows PC",
  "os": "windows",
  "client_version": "1.0.0"
}
```
- **پاسخ موفق (201 Created):**
```json
{
  "success": true,
  "access_token": "jwt_sentra_token_uuid",
  "token_type": "Bearer",
  "user": {
    "id": 12,
    "user_uuid": "550e8400-e29b-41d4-a716-446655440000",
    "telegram_id": null,
    "username": "sentra_fan",
    "first_name": "sentra_fan",
    "role": "user"
  },
  "subscription": {
    "tier": "Sentra Lite",
    "token": "token_uuid",
    "status": "active",
    "remaining_bytes": 10737418240,
    "max_concurrent_devices": 3,
    "expires_at": "2026-12-19T20:00:00Z"
  }
}
```

---

### ۲.۰.۲. ورود با نام کاربری و رمز عبور (`POST /api/v1/auth/login`)
ورود دائمی کاربر ثبت‌نام‌شده با اعتبارسنجی هش `bcrypt` و ثبت نشست دستگاه جدید (با رعایت سقف ۳ دستگاه).

- **مسیر:** `/api/v1/auth/login`
- **روش:** `POST`
- **بدنه درخواست (JSON):**
```json
{
  "username": "sentra_fan",
  "password": "StrongPassword123",
  "device_identifier": "sentra-pc-4f81c9a0",
  "os": "windows"
}
```

---

### ۲.۰.۳. تولید کد ۶ رقمی اتصال به تلگرام (`POST /api/v1/auth/link-token`)
تولید کد موقت ۶ رقمی (معتبر به مدت ۵ دقیقه) برای ادغام حساب کاربری اپلیکیشن با ربات تلگرام از طریق دستور `/link 123456`.

- **مسیر:** `/api/v1/auth/link-token`
- **روش:** `POST`
- **هدرها:** `Authorization: Bearer <access_token>` یا `X-Subscription-Token: <token>`
- **پاسخ موفق (200 OK):**
```json
{
  "success": true,
  "link_code": "849201",
  "expires_in_seconds": 300,
  "instructions": "این کد ۶ رقمی را ظرف ۵ دقیقه در ربات تلگرام با دستور /link وارد فرمایید."
}
```

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

---

### ۲.۲. دریافت کاتالوگ حالت‌های اتصال (`GET /api/v1/client/modes`)
کلاینت دسکتاپ، اندروید یا ربات تلگرام این درخواست را برای دریافت مشخصات ۴ حالت اتصال، وضعیت قفل بودن بر اساس سطح اشتراک، برچسب به‌زودی و سهمیه باقیمانده روزانه ارسال می‌کند.

- **مسیر:** `/api/v1/client/modes`
- **روش:** `GET`
- **هدر اختیاری:** `Authorization: Bearer <token>` یا کوئری پارامتر `?token=<subscription_token>`
- **نمونه پاسخ موفق (200 OK):**
```json
{
  "success": true,
  "modes": [
    {
      "id": "web_browsing",
      "title": "وب‌گردی",
      "description": "مرور روزمره وب و شبکه‌های اجتماعی (۲ گیگابایت سهمیه روزانه)",
      "protocol": "WS + Fragment",
      "speed": "متوسط",
      "security": "کم",
      "is_locked": false,
      "is_coming_soon": false,
      "daily_quota_mb": 2048,
      "daily_used_mb": 420,
      "allowed_tiers": ["Sentra Lite", "Sentra Pro", "Sentra Flow+"]
    },
    {
      "id": "download",
      "title": "دانلود",
      "description": "انتقال فایل فوق‌سریع بر بستر Hysteria 2 (۳ گیگابایت روزانه)",
      "protocol": "Hysteria 2",
      "speed": "حداکثر",
      "security": "متوسط",
      "is_locked": false,
      "is_coming_soon": false,
      "daily_quota_mb": 3072,
      "daily_used_mb": 1150,
      "allowed_tiers": ["Sentra Lite", "Sentra Pro", "Sentra Flow+"]
    },
    {
      "id": "gaming",
      "title": "گیمینگ",
      "description": "کاهش پینگ و تثبیت جیتر (به‌زودی اضافه می‌شود)",
      "protocol": "UDP Optimized",
      "speed": "تاخیر فوق‌کم",
      "security": "بالا",
      "is_locked": false,
      "is_coming_soon": true,
      "daily_quota_mb": 0,
      "daily_used_mb": 0,
      "allowed_tiers": ["Sentra Lite", "Sentra Pro", "Sentra Flow+"]
    },
    {
      "id": "static_ip",
      "title": "آی‌پی ثابت",
      "description": "مسیریابی مسکونی تمیز آمریکا برای صرافی‌های ترید و جمنای (Google Gemini)",
      "protocol": "Residential VLESS Reality",
      "speed": "بالا",
      "security": "حداکثر",
      "is_locked": true,
      "is_coming_soon": false,
      "daily_quota_mb": 0,
      "daily_used_mb": 0,
      "allowed_tiers": ["Sentra Pro", "Sentra Flow+"]
    }
  ]
}
```

### ۲.۳. دریافت کانفیگ چندپروتکلی کلاینت (`POST /api/v1/client/config`)
کلاینت سنترا برای برقراری اتصال امن، این اندپوینت را فراخوانی می‌کند. هیچ‌گونه آدرس یا جزییات V2Ray/sing-box به کاربر ارسال نشده و ارتباط از طریق یکی از ۴ پروتکل امن (`openvpn_udp`، `openvpn_tcp`، `stealth`، `ikev2`) برقرار می‌گردد.

- **مسیر:** `/api/v1/client/config`
- **روش:** `POST`
- **بدنه درخواست (JSON):**
```json
{
  "token": "token_lite_sandbox_001",
  "device_id": "desktop-client-001",
  "os": "windows",
  "mode": "web_browsing",
  "protocol": "openvpn_udp"
}
```

- **پاسخ موفق چندپروتکلی (200 OK):**
```json
{
  "success": true,
  "protocol": "openvpn_udp",
  "mode": "web_browsing",
  "remote_host": "127.0.0.1",
  "remote_port": 1194,
  "auth_username": "token_lite_sandbox_001",
  "auth_password": "token_lite_sandbox_001",
  "ovpn_config": "# Sentra Platform - OpenVPN Client Profile\nclient\ndev tun\nproto udp\nremote 127.0.0.1 1194\n...",
  "stunnel": null,
  "ikev2": null
}
```

در حالت `stealth`:
```json
{
  "success": true,
  "protocol": "stealth",
  "mode": "web_browsing",
  "remote_host": "127.0.0.1",
  "remote_port": 11940,
  "auth_username": "token_lite_sandbox_001",
  "auth_password": "token_lite_sandbox_001",
  "ovpn_config": "# Sentra OpenVPN Stealth Profile\nremote 127.0.0.1 11940\n...",
  "stunnel": {
    "host": "vpn.sentravpn.com",
    "port": 443,
    "sni": "web_browsing.sentravpn.com"
  },
  "ikev2": null
}
```

در حالت `ikev2`:
```json
{
  "success": true,
  "protocol": "ikev2",
  "mode": "web_browsing",
  "remote_host": "vpn.sentravpn.com",
  "remote_port": 500,
  "auth_username": "token_lite_sandbox_001",
  "auth_password": "token_lite_sandbox_001",
  "ovpn_config": "...",
  "stunnel": null,
  "ikev2": {
    "server_host": "vpn.sentravpn.com",
    "remote_id": "vpn.sentravpn.com",
    "eap_username": "token_lite_sandbox_001",
    "eap_password": "token_lite_sandbox_001",
    "ca_cert": "-----BEGIN CERTIFICATE-----\n...",
    "mobileconfig": "<?xml version=\"1.0\" encoding=\"UTF-8\"?>..."
  }
}
```

---

### ۲.۴. اندپوینت‌های احراز هویت و اکانتینگ داخلی سرور IKEv2
- `POST /api/internal/ikev2/auth`: بررسی اعتبار توکن اشتراک و سهمیه ۳۰ گیگابایت در حالت آی‌پی ثابت.
- `POST /api/internal/ikev2/accounting`: ثبت دلتای مصرف حجم آپلود و دانلود و صدور فرمان قطع نشست در صورت اتمام سهمیه یا الگوی مصرف نامتعارف.
- `GET /api/v1/mobileconfig/:token?mode=web_browsing`: صدور فایل آماده `.mobileconfig` برای نصب مستقیم در سافاری iOS.
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

### ۲.۵. ثبت ضربان قلب، کنترل اعتبار نشست و سهمیه روزانه (`POST /api/v1/client/heartbeat`)
کلاینت هر ۶۰ ثانیه جهت تایید زنده بودن نشست دستگاه، بررسی عدم حذف دستگاه از لیست مجاز، رصد الگوی ناهنجاری و همگام‌سازی دقیق ترافیک مصرفی این اندپوینت را فراخوانی می‌کند.

- **مسیر:** `/api/v1/client/heartbeat`
- **روش:** `POST`
- **هدر:** `X-Subscription-Token: <token>` یا `Authorization: Bearer <jwt_access_token>`
- **بدنه درخواست:**
```json
{
  "device_id": "sentra-pc-3f8a12bc",
  "mode": "web_browsing",
  "delta_upload_bytes": 1048576,
  "delta_download_bytes": 5242880
}
```
- **پاسخ ادامه تانل (200 OK - Continue):**
```json
{
  "action": "continue",
  "remaining_bytes": 986751959040,
  "web_browsing_used_mb": 420,
  "download_used_mb": 1150,
  "static_ip_used_mb": 2048,
  "static_ip_remaining_mb": 28672
}
```
- **پاسخ قطع فوری تانل (200 OK - Disconnect):**
*(در صورتی که دستگاه حذف شده باشد `DEVICE_REVOKED`، سهمیه روزانه تمام شده باشد `QUOTA_EXCEEDED`، سقف ۳۰ گیگابایت آی‌پی ثابت تمام شده باشد `STATIC_IP_QUOTA_EXCEEDED`، یا اکانت تعلیق شده باشد `ACCOUNT_SUSPENDED`)*:
```json
{
  "action": "disconnect",
  "code": "STATIC_IP_QUOTA_EXCEEDED",
  "message": "سقف حجم ۳۰ گیگابایت آی‌پی ثابت اختصاصی شما به پایان رسید. دسترسی وب‌گردی و دانلود شما همچنان فعال و نامحدود است."
}
```

---

### ۲.۶. دریافت پروفایل استاندارد OpenVPN برای iOS و مک (`GET /api/v1/ovpn/:token`)
این اندپوینت پروفایل واقعی با پسوند `.ovpn` دارای امضای دیجیتال، کلید ایستای `tls-crypt` و متصل به توکن کاربر را جهت ایمپورت مستقیم در اپلیکیشن **OpenVPN Connect** صادر می‌کند.

- **مسیر:** `/api/v1/ovpn/:token`
- **روش:** `GET`
- **پارامتر اختیاری کوئری:** `?mode=web_browsing` یا `?mode=download` یا `?mode=static_ip`
- **قوانین و کنترل دسترسی:**
  * در صورت انتخاب `mode=gaming`، خطای 400 با پیام «حالت گیمینگ به‌زودی اضافه می‌شود» برمی‌گردد.
  * در صورت انتخاب `mode=static_ip` توسط کاربر `Sentra Lite`، خطای 403 Forbidden بازگردانده می‌شود.
  * در صورت مصرف بیش از ۳۰ گیگابایت سهمیه آی‌پی ثابت در ماه (`static_ip_used_mb >= 30,720`)، خطای 402 Payment Required برمی‌گردد.
  * در صورت اتمام سهمیه روزانه ۲ گیگابایت وب‌گردی یا ۳ گیگابایت دانلود برای کاربران پلن رایگان، خطای 429 با پیام اتمام سهمیه روزانه برمی‌گردد.
- **نمونه خروجی:** فایل با هدر `Content-Type: application/x-openvpn-profile` و پیوست `sentra-client.ovpn`.

---

### ۲.۶.۱. اندپوینت‌های احراز هویت و حسابداری دیمن OpenVPN (`POST /api/internal/openvpn/auth` و `accounting`)
این دو اندپوینت به صورت محلی یا شبکه‌ای توسط پلاگین احراز هویت سرور OpenVPN فراخوانی می‌شوند تا سقف ۳۰ گیگابایت ماهانه آی‌پی ثابت و وضعیت نشست دستگاه اعمال گردد:

- **احراز هویت:** `POST /api/internal/openvpn/auth`
  * ورودی: `{ "username": "token_str", "password": "...", "mode": "static_ip" }`
  * پاسخ: `{ "status": "ok", "user_id": 1, "tier": "Sentra Pro", "mode": "static_ip" }`
- **حسابداری ترافیک و قطع خودکار:** `POST /api/internal/openvpn/accounting`
  * ورودی: `{ "token": "token_str", "bytes_sent": 1048576, "bytes_received": 5242880, "mode": "static_ip" }`
  * خروجی در صورت عبور از ۳۰ گیگابایت: `{ "action": "disconnect", "code": "STATIC_IP_QUOTA_EXCEEDED", "message": "..." }`

---

### ۲.۷. مدیریت دستگاه‌های متصل کاربر (`GET /api/v1/client/devices` و `POST /api/v1/client/devices/remove`)
جهت اعمال و مدیریت قانون **حداکثر ۳ دستگاه هم‌زمان (Max 3 Devices)** برای هر اشتراک:

#### الف) دریافت لیست دستگاه‌ها (`GET /api/v1/client/devices`)
- **مسیر:** `/api/v1/client/devices`
- **روش:** `GET`
- **هدرها یا کوئری:** `X-Subscription-Token: <token>` یا `?token=<token>`
- **پاسخ موفق (200 OK):**
```json
{
  "success": true,
  "count": 2,
  "max_allowed": 3,
  "devices": [
    {
      "id": 1,
      "device_id": "sentra-pc-3f8a12bc",
      "device_name": "Windows PC",
      "platform": "windows",
      "last_active_at": "2026-11-19T01:15:00Z",
      "created_at": "2026-11-18T10:00:00Z"
    },
    {
      "id": 2,
      "device_id": "sentra-android-9912",
      "device_name": "Samsung Galaxy",
      "platform": "android",
      "last_active_at": "2026-11-19T01:20:00Z",
      "created_at": "2026-11-18T14:30:00Z"
    }
  ]
}
```

#### ب) حذف دستگاه جهت آزادسازی فضا (`POST /api/v1/client/devices/remove`)
- **مسیر:** `/api/v1/client/devices/remove`
- **روش:** `POST`
- **هدرها یا کوئری:** `X-Subscription-Token: <token>` یا `?token=<token>`
- **بدنه درخواست:**
```json
{
  "device_id": "sentra-android-9912"
}
```
- **پاسخ:**
```json
{
  "success": true,
  "message": "دستگاه با موفقیت حذف گردید."
}
```

---

### ۲.۸. گزارش تله‌متری و پایش ناهنجاری مصرف ترافیک (`POST /api/v1/client/telemetry`)
کلاینت دلتای حجم مصرف‌شده را گزارش می‌دهد. ناظر پنجره لغزان (`Sliding Window Monitor`) در صورت عبور از ۵ گیگابایت در ۱۵ دقیقه یا ۲۰ گیگابایت در ۱ ساعت اکانت را تعلیق و هشدار ادمین تلگرام را فعال می‌کند.

- **مسیر:** `/api/v1/client/telemetry`
- **روش:** `POST`
- **بدنه درخواست:**
```json
{
  "token": "d7a421f8-98e3-4f51-b0e2-881249fa6b21",
  "bytes_delta": 524288000,
  "device_id": "sentra-pc-3f8a12bc"
}
```
- **پاسخ در حالت عادی (200 OK):**
```json
{
  "success": true,
  "status": "normal"
}
```
- **پاسخ در صورت تشخیص الگوی مشکوک (403 Forbidden):**
```json
{
  "code": "ACCOUNT_SUSPENDED",
  "message": "حساب شما به دلیل الگوی مصرف ترافیک غیرعادی موقتاً متوقف شده است. لطفاً با پشتیبانی در ارتباط باشید."
}
```

---

### ۲.۹. خطاهای استاندارد امنیتی و کنترل ترافیک (Security Error Codes)

| کد خطا (`code`) | وضعیت HTTP | پیام و شرایط رخداد |
| :--- | :--- | :--- |
| `MAX_DEVICES_REACHED` | 403 Forbidden | سقف مجاز اتصال هم‌زمان ۳ دستگاه برای این اشتراک تکمیل شده است. کاربر باید یک دستگاه قدیمی را حذف کند. |
| `ACCOUNT_SUSPENDED` | 403 Forbidden | حساب کاربری یا اشتراک به دلیل الگوی ترافیک غیرعادی مسدود شده است. |
| `DAILY_QUOTA_EXCEEDED` | 429 Too Many Requests | سقف سهمیه رایگان روزانه (۲ گیگابایت وب‌گردی یا ۳ گیگابایت دانلود) پایان یافته است. |
| `TOO_MANY_REQUESTS` | 429 Too Many Requests | بیش از ۵ تلاش ناموفق در ۱۰ دقیقه برای ورود کد ۸ رقمی. مسدودیت ۱۵ دقیقه‌ای اعمال شد. |
| `SUBSCRIPTION_EXPIRED` | 403 Forbidden | اشتراک کاربر منقضی شده است. |

---

### ۲.۱۰. بررسی نسخه کلاینت و اعلان به‌روزرسانی (`GET /api/v1/client/version`)
کلاینت هنگام باز شدن برنامه یا به صورت دوره‌ای این اندپوینت را فراخوانی می‌کند تا با اتصال مستقیم به جدول `app_releases`، در صورت انتشار نسخه جدیدتر توسط مدیر در ربات تلگرام، به کاربر اطلاع دهد.

- **مسیر:** `/api/v1/client/version`
- **روش:** `GET`
- **پارامترهای Query اختیاری:**
  - `platform`: پلتفرم درخواستی (`windows` یا `android` - پیش‌فرض: `windows`)
- **نمونه پاسخ موفق (200 OK):**
```json
{
  "latest_version": "0.1.0",
  "min_supported_version": "1.0.0",
  "platform": "windows",
  "file_name": "SentraConnect-Setup.exe",
  "file_size_mb": 24.5,
  "download_url": "https://t.me/SentraVpnBot",
  "release_notes": "نسخه اولیه با پشتیبانی از حالت رایگان و سوییچ هوشمند",
  "release_date": "2026-11-20",
  "mandatory": false
}
```

---

## ۳. جریان انتشار و دانلود مستقیم اپلیکیشن (Release & Distribution Flow)

### ۳.۱. پنل مدیریت تلگرام (Admin Release Pipeline)
۱. **فراخوانی منو:** مدیر در `/admin` دکمه `[📤 آپلود / بروزرسانی اپلیکیشن]` را لمس می‌کند.
۲. **انتخاب پلتفرم:** گزینه `[🪟 آپلود نسخه ویندوز (.exe)]` یا `[🤖 آپلود نسخه اندروید (.apk)]` انتخاب می‌شود.
۳. **ثبت مشخصات نسخه:** مدیر شماره نسخه و خلاصه تغییرات را ارسال می‌کند (مثلاً `0.1.0 - نسخه اولیه با پشتیبانی از حالت رایگان`).
۴. **ارسال فایل باینری:** فایل نصبی به عنوان Document به ربات فرستاده می‌شود.
۵. **اعتبارسنجی و ذخیره‌سازی:** ربات پسوند فایل (`.exe`/`.msi` برای ویندوز یا `.apk` برای اندروید) را بررسی کرده و رکورد را با `telegram_file_id` در جدول `app_releases` ذخیره می‌کند.

### ۳.۲. توزیع و دانلود در سمت کاربر (User Direct Download)
۱. در منوی اصلی ربات، کاربر دکمه **`📥 دانلود اپلیکیشن Sentra Connect`** را لمس می‌کند.
۲. منوی انتخاب سیستم‌عامل شامل ویندوز، اندروید و آیفون نمایش داده می‌شود.
۳. در صورت انتخاب ویندوز یا اندروید:
   - اگر نسخه در دیتابیس ثبت شده باشد، ربات فایل را بلافاصله با `InputFile::file_id(...)` بدون مصرف پهنای باند سرور برای کاربر ارسال می‌کند.
   - اگر هنوز آپلود نشده باشد، پیام محترمانه در حال آماده‌سازی نمایش داده می‌شود.
۴. در صورت انتخاب آیفون، کاربر مستقیماً به بخش دریافت اشتراک OpenVPN و راهنمای اتصال iOS هدایت می‌شود.
