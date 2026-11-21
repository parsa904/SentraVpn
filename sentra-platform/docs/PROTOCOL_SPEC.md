# مشخصات فنی هسته شبکه، پروتکل‌ها و پیکربندی Sing-box (`docs/PROTOCOL_SPEC.md`)

**نگارش:** ۱.۰.۰  
**موتور هسته هدف:** Sing-box v1.10+ (با پرهیز مطلق از کلیدهای Deprecated)  
**معماری ترافیک:** کرنل TUN Mode بدون نشت DNS + FakeIP + تفکیک ترافیک داخلی (Split Tunneling)  

---

## ۱. معرفی ۵ حالت تجاری اتصال سنتra (Commercial Connection Modes)

پلتفرم سنترا ۵ سناریوی اتصال تجاری را بر اساس شرایط اختلال در اینترنت کاربر ارائه می‌دهد:

```text
                               +-----------------------------+
                               |     SENTRA AUTO (urltest)   |
                               |  پایش خودکار تاخیر هر ۱۵ ثانیه  |
                               +-----------------------------+
                                              |
        +------------------+------------------+------------------+
        |                  |                  |                  |
        v                  v                  v                  v
+----------------+ +----------------+ +----------------+ +----------------+
|  SENTRA HYDRA  | |  SENTRA SHADOW | | SENTRA STEALTH | |  SENTRA PULSE  |
|  VLESS+Reality | | ShadowTLS v3 + | |  HTTPUpgrade + | |  Hysteria 2 +  |
|     + smux     | |    SS-2022     | |  TLS Fragment  | |   Salamander   |
| (سرعت بالا و وب) | | (مقاوم در اختلال)| |(عبور از فایروال)| |(اینترنت با پکت‌لاس)|
+----------------+ +----------------+ +----------------+ +----------------+
```

### ۱.۱. حالت `Sentra Auto` (هوشمند و خودکار)
- **مکانیسم:** گروه `urltest` در Sing-box با بررسی مداوم پروب URL سلامت هر ۱۵ ثانیه (`interval: 15s`) و میزان خطای مجاز ۵۰ میلی‌ثانیه (`tolerance: 50`).
- **کاربرد:** بهترین انتخاب برای کاربر عادی. اگر اینترنت دچار نوسان شود یا یک سرور مسدود گردد، در کمتر از ۱۵ ثانیه ترافیک به نزدیک‌ترین و سریع‌ترین پروتکل شیفت می‌یابد.

### ۱.۲. حالت `Sentra Hydra` (چندمسیره و فوق‌سریع)
- **استک فنی:** `VLESS` + `Reality` (uTLS Chrome Fingerprint) + `smux` (Streaming Multiplexing).
- **ویژگی:** برقراری چندین استریم داده روی یک اتصال TCP منفرد؛ کاهش چشمگیر زمان Handshake و پینگ اولیه؛ شبیه‌سازی گواهی‌های TLS وب‌سایت‌های معتبر خارجی جهت جلوگیری از شناسایی توسط هوش مصنوعی فیلترینگ.
- **تست لوکال:** مپ‌شده به پورت لوپ‌بک `127.0.0.1:10801`.

### ۱.۳. حالت `Sentra Shadow` (نفوذناپذیر در شرایط اختلال شدید)
- **استک فنی:** `ShadowTLS v3` به عنوان لایه احراز هویت TLS + `Shadowsocks-2022` به عنوان حامل رمزگذاری بدنه.
- **ویژگی:** بازرسی عمیق پاکت (DPI) در تفکیک ترافیک این حالت از یک نشست امن عادی بانکی ناتوان است. مقاومت بسیار بالا در زمان فیلترینگ گسترده ملی.
- **تست لوکال:** مپ‌شده به پورت لوپ‌بک `127.0.0.1:10802`.

### ۱.۴. حالت `Sentra Stealth` (تکه‌تکه‌سازی پکت و عبور از فایروال سازمانی)
- **استک فنی:** پروتکل حامل `HTTPUpgrade` + فعال‌سازی `TLS Client Hello Fragmentation`.
- **ویژگی:** تقسیم بسته‌های Handshake اولیه به قطعات کوچک (Fragmented Packets) تا فایروال‌های حساس به نام دامنه (SNI Inspection) نتوانند نام سرور را بازخوانی کنند.
- **تست لوکال:** مپ‌شده به پورت لوپ‌بک `127.0.0.1:10803`.

### ۱.۵. حالت `Sentra Pulse` (پروتکل نجات‌دهنده UDP و پکت‌لاس)
- **استک فنی:** `Hysteria 2` مبتنی بر پروتکل اصلاح‌شده QUIC/UDP همراه با الگوریتم کنترل ازدحام اختلاصی `Brutal` + ماسک‌سازی فیلدهای UDP با `Salamander`.
- **ویژگی:** بازدهی فوق‌العاده در خطوط همراه (همراه اول و ایرانسل) که دارای پکت‌لاس شدید (تا ۴۰٪) هستند؛ سرعت دانلود را برخلاف TCP به صفر نمی‌رساند.
- **تست لوکال:** مپ‌شده به پورت لوپ‌بک `127.0.0.1:10804`.

---

## ۲. مشخصات کامل اسکیما Sing-box v1.10+

### ۲.۱. تنظیمات کارت شبکه مجازی (`inbounds.tun`)
- **`interface_name`:** `sentra-tun` (در ویندوز از درایور سازگار با Wintun استفاده می‌شود).
- **`stack`:** مقدار `mixed` (بهترین ترکیب سازگار با کارایی بالا و پایدار در بازگشایی سوکت‌ها).
- **`strict_route`:** `true` (جهت هدایت قطعی تمامی پکت‌های سیستم به داخل تانل و جلوگیری از نشت ترافیک در سطح کارت‌های شبکه دیگر).
- **`auto_route`:** `true`.
- **`sniff` & `sniff_override_destination`:** فعال (`true`) جهت شناسایی دامنه‌های حقیقی در پشت لایه‌های پروتکلی.

### ۲.۲. استراتژی پیشرفته FakeIP و DNS بدون نشت
- **استراتژی IP:** الزام قطعی به `strategy: "ipv4_only"` (پرهیز از درخواست‌های معلق IPv6 که در اپراتورهای ایران باعث کندی اتصال یا نشت ترافیک می‌شوند).
- **محدوده آدرس‌های جعلی (FakeIP Pool):** `198.18.0.0/15` و IPv6 جعلی `fc00::/18`.
- **سرورهای دی‌ان‌اس:**
  1. `dns-fakeip`: نگاشت فوری دامنه به IP موقت در کسری از میلی‌ثانیه برای اپلیکیشن‌های سیستم‌عامل.
  2. `dns-remote`: سرور امن DNS over HTTPS (`https://1.1.1.1/dns-query`) با عبور از تانل رمزشده سنترا.
  3. `dns-direct`: دی‌ان‌اس محلی سیستم (`local`) برای تفکیک سایت‌های ایرانی.

### ۲.۳. تفکیک ترافیک هوشمند (Split Tunneling)
- **ترافیک مستقیم (Bypass / Direct):**
  * کلیه دامنه‌های دارای پسوند `.ir`
  * آدرس‌های IP خصوصی شبکه محلی (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`)
  * ترافیک داخلی بانک‌ها و درگاه‌های پرداختی شاپرک
- **ترافیک رمزگذاری‌شده (Proxied):** کلیه ترافیک‌های بین‌المللی و سرویس‌های مسدودشده.

---

## ۳. قالب مرجع پیکربندی کلاینت (`sing-box.json`)

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
        "strategy": "ipv4_only",
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
        "domain_suffix": [
          ".ir",
          ".gov.ir",
          ".co.ir",
          "shaparak.ir"
        ],
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
      "interval": "15s",
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
        "ip_is_private": true,
        "outbound": "direct"
      },
      {
        "domain_suffix": [
          ".ir",
          ".gov.ir",
          ".co.ir",
          "shaparak.ir",
          "divar.ir",
          "digikala.com",
          "snapp.ir"
        ],
        "outbound": "direct"
      },
      {
        "clash_mode": "Direct",
        "outbound": "direct"
      },
      {
        "clash_mode": "Global",
        "outbound": "Sentra Select"
      }
    ],
    "final": "Sentra Select"
  }
}
```

---

## ۴. دستورالعمل صحت‌سنجی فاز ۱ (Local Sandbox Test Suite)

1. **بررسی سینتکس کانفیگ با موتور محلی Sing-box:**
   ```bash
   sing-box check -c sing-box.json
   ```
2. **برقراری لیسنرهای محلی Mock Proxy:**
   اسکریپت پایتون یا تسک پس‌زمینه Rust جهت باز نگه داشتن پورت‌های `10801` تا `10804` برای شبیه‌سازی دقیق خروجی‌ها.
3. **تست بدون نشت ترافیک محلی:**
   در زمان اجرای تست درایور TUN، بازکردن دامنه‌های داخلی (مانند سایت‌های بانکی یا پینگ آدرس‌های `10.x.x.x`) از مسیر `direct` عبور کرده و سایر درخواست‌ها به گروه `urltest` ارسال می‌گردند.
