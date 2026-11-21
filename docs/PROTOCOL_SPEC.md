# مشخصات فنی هسته شبکه، پروتکل‌ها و پیکربندی Sing-box و پروتکل‌های کلاینت (`docs/PROTOCOL_SPEC.md`)

**نگارش:** ۳.۰.۰  
**معماری هسته سرور:** پل ارتباطی سمت سرور (Server-Side Bridge) با Sing-box v1.10+ و ۳ کارت شبکه مجازی (`tun-web`, `tun-dl`, `tun-static`)  
**پروتکل‌های خروجی کلاینت:** ایزولاسیون ۱۰۰٪ اوتباندهای V2Ray/sing-box؛ ارائه انحصاری ۴ پروتکل امن کاربرپسند:
1. `openvpn_udp` (سرعت بالا بر بستر UDP)
2. `openvpn_tcp` (پایداری بالا روی پورت 443 در اختلالات شدید)
3. `stealth` (OpenVPN پوشانده‌شده داخل تانل رمزنگاری TLS 1.3 / stunnel برای عبور از DPI شدید)
4. `ikev2` (رمزنگاری IPsec فوق‌سریع بومی سیستم‌عامل بدون نیاز به نرم‌افزار جانبی با پشتیبانی از Apple `.mobileconfig`)

---

## ۱. مشخصات ۴ حالت اتصال رسمی سنترا (Single Source of Truth)

به منظور تطبیق دقیق با نیازهای کاربران و بهینه‌سازی منابع سرور، سیستم اتصالات سنترا بر پایه **۴ حالت اتصال استاندارد** تعریف شده است:

```text
                                +-----------------------------+
                                |      SENTRA CONNECTION      |
                                |     ۴ حالت اتصال اختصاصی    |
                                +-----------------------------+
                                               |
         +------------------+------------------+------------------+
         |                  |                  |                  |
         v                  v                  v                  v
 +----------------+ +----------------+ +----------------+ +----------------+
 |  WEB BROWSING  | |    DOWNLOAD    | |     GAMING     | |   STATIC IP    |
 |  WS + Fragment | |   Hysteria 2   | | UDP Optimized  | | US Residential |
 | (سهمیه ۲G/روز) | | (سهمیه ۳G/روز) | | (به‌زودی)      | | (ترید و جمنای) |
 +----------------+ +----------------+ +----------------+ +----------------+
```

### ۱.۱. وب‌گردی (`web_browsing`)
- **سطح دسترسی:** فعال برای تمامی کاربران (پلن رایگان `Sentra Lite` و پلن‌های تجاری `Pro` و `Flow+`).
- **محدودیت حجم روزانه:** **۲ گیگابایت (2048 MB)** سهمیه روزانه رایگان که هر ۲۴ ساعت به صورت خودکار ریست می‌شود.
- **استک فنی سرور:** هدایت پکت‌ها از ورودی `tun-web` (`10.10.0.1/30`) به بهترین نود رسمی و اهدایی VLESS/Trojan.
- **پورت‌های کلاینت:** پورت `1194` (UDP) و `443` (TCP / Stealth).

### ۱.۲. دانلود (`download`)
- **سطح دسترسی:** فعال برای تمام کاربران (`Sentra Lite` و بالاتر).
- **محدودیت حجم روزانه:** **۳ گیگابایت (3072 MB)** سهمیه روزانه برای کاربران رایگان `Sentra Lite`.
- **استک فنی سرور:** هدایت پکت‌ها از ورودی `tun-dl` (`10.10.1.1/30`) به اوتباندهای Hysteria 2 با کنترل ازدحام Brutal.
- **پورت‌های کلاینت:** پورت `1195` (UDP) و `2053` (TCP).

### ۱.۳. گیمینگ (`gaming`)
- **سطح دسترسی و وضعیت:** در حال حاضر غیرفعال (`coming_soon`) برای تمامی کاربران.
- **نمایش در رابط کاربری:** کارت غیرقابل انتخاب و خاکستری با برچسب مشخص **«به‌زودی اضافه می‌شود»**.

### ۱.۴. آی‌پی ثابت مسکونی (`static_ip`)
- **سطح دسترسی:** **قفل (`locked`) برای کاربران پلن رایگان (`Sentra Lite`)**؛ صرفاً قابل استفاده برای کاربران اشتراک ویژه (`Sentra Pro` و `Sentra Flow+`).
- **سقف مصرف ماهانه:** ۳۰ گیگابایت (30720 MB) در هر دوره ۳۰ روزه.
- **استک فنی سرور:** هدایت پکت‌ها از ورودی `tun-static` (`10.10.2.1/30`) منحصراً به اوتباند رسمی آمریکا (`is_official = 1`).
- **پورت‌های کلاینت:** پورت `1196` (UDP) و `2083` (TCP).
- **الزامات ضد نشت:** تزریق اجباری `block-outside-dns`، فیلتر و مسدودسازی کامل IPv6 و مسیریابی پیش‌فرض `redirect-gateway def1`.

---

## ۲. معماری پل ارتباطی سرور (`Server-Side Bridge`)

جهت حفظ کامل امنیت سرورها و عدم افشای آدرس‌های اوتباند، کلاینت‌ها هرگز به صورت مستقیم به V2Ray یا sing-box متصل نمی‌شوند. تمام اوتباندهای ثبت‌شده توسط ادمین و کاربران اهدایی در فایل `/etc/sing-box/bridge-config.json` تجمیع شده و پل ارتباطی ۳ ورودی TUN را با ۳ دسته اوتباند برقرار می‌کند:

```json
{
  "inbounds": [
    {
      "type": "tun",
      "tag": "tun-web",
      "interface_name": "tun-web",
      "inet4_address": "10.10.0.1/30",
      "auto_route": false,
      "strict_route": false,
      "stack": "system"
    },
    {
      "type": "tun",
      "tag": "tun-dl",
      "interface_name": "tun-dl",
      "inet4_address": "10.10.1.1/30",
      "auto_route": false,
      "strict_route": false,
      "stack": "system"
    },
    {
      "type": "tun",
      "tag": "tun-static",
      "interface_name": "tun-static",
      "inet4_address": "10.10.2.1/30",
      "auto_route": false,
      "strict_route": false,
      "stack": "system"
    }
  ],
  "route": {
    "rules": [
      { "inbound": ["tun-web"], "outbound": "out-web-node" },
      { "inbound": ["tun-dl"], "outbound": "out-dl-node" },
      { "inbound": ["tun-static"], "outbound": "out-static-node" }
    ]
  }
}
```

---

## ۳. مشخصات ۴ پروتکل ارائه‌شده به کلاینت‌ها

| پروتکل | لایه انتقال | پورت‌ها (وب / دانلود / آی‌پی ثابت) | سازگاری پلتفرم‌ها | کاربرد اصلی |
| :--- | :--- | :--- | :--- | :--- |
| **`openvpn_udp`** | UDP | 1194 / 1195 / 1196 | ویندوز، اندروید، مک، iOS | سرعت حداکثری و استریم روان |
| **`openvpn_tcp`** | TCP | 443 / 2053 / 2083 | ویندوز، اندروید، مک، iOS | پایداری بالا در اختلالات شدید و فیلترینگ پکت‌های UDP |
| **`stealth`** | TLS 1.3 + TCP | لوکال 11940 -> سرور 443 | ویندوز، اندروید، لینوکس | عبور از شدیدترین دیوارهای آتش بازرسی عمیق پاکت (DPI) |
| **`ikev2`** | IPsec / UDP 500, 4500 | پورت استاندارد IPsec | ویندوز، iOS، مک، اندروید نیتیو | اتصال بومی با پروفایل `.mobileconfig` بدون نیاز به برنامه |

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
---

## ۴. مشخصات پروفایل OpenVPN اختصاصی iOS (OpenVPN Connect 3.x+ Specification)

جهت پشتیبانی کامل از کاربران سیستم‌عامل‌های **iOS (آیفون و آیپد)** و **macOS** بدون نیاز به نصب کلاینت‌های متفرقه، پلتفرم سنترا از پروتکل استاندارد **OpenVPN** بهره می‌برد.

### ۴.۱. پارامترهای پروتکل و رمزنگاری
- **پروتکل لایه ۴:** UDP (جهت حداقل تاخیر زمانی و عملکرد روان روی شبکه سلولار).
- **پورت‌های شنود اختصاصی بر اساس حالت:**
  * وب‌گردی (web_browsing): پورت 1194
  * دانلود (download): پورت 1195
  * آی‌پی ثابت مسکونی (static_ip): پورت 1196
- **الگوریتم رمزنگاری:** AES-256-GCM همراه با درهم‌سازی SHA256.
- **لایه‌ی حفاظتی Handshake:** کلید استاتیک امنیتی <tls-crypt> برای ممانعت از شناسایی پروتکل OpenVPN توسط فیلترشکن‌شکن‌ها و DPI.
- **احراز اصالت و دسترسی:** استفاده از گواهی‌های استاندارد X.509 (<ca>, <cert>, <key>) با احراز هویت کاربری (uth-user-pass) متصل به توکن یکتای اشتراک کاربر.

### ۴.۲. اعمال قوانین سهمیه و سطوح دسترسی در سرور OpenVPN
1. **کنترل سهمیه روزانه رایگان:** در حالت‌های وب‌گردی (سقف ۲ گیگابایت) و دانلود (سقف ۳ گیگابایت) برای کاربران Sentra Lite، اسکریپت تایید نشست (Auth Plugin / Webhook) مصرف روزانه را استعلام کرده و پس از اتمام سهمیه، اتصال جدید را تا ریست ۲۴ ساعته بعدی معلق می‌کند.
2. **قفل آی‌پی ثابت:** دسترسی به پروفایل آی‌پی ثابت صرفاً برای توکن‌های دارای سطح اشتراک Sentra Pro و Sentra Flow+ مجاز است.
3. **سازگاری ۱۰۰٪ با اپ رسمی OpenVPN Connect:** کلیه اطلاعات لازم (از جمله گواهی‌ها، ریموت و دستورالعمل‌های مسیریابی) به صورت Inline در قالب یک فایل منفرد با پسوند .ovpn صادر می‌شود تا کاربر تنها با یک کلیک و انتخاب Share به نرم‌افزار رسمی متصل گردد.
