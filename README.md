# 🛡 پلتفرم سنترا (Sentra Platform) — معماری ۱۰۰٪ Serverless (Zero-VPS)

پلتفرم **Sentra** یک اکوسیستم ماژولار، سبک و کاملاً **بدون سرور (Zero-VPS)** است که با هزینه صفر روی **Cloudflare Workers + Cloudflare D1 + GitHub Actions** اجرا می‌شود. کلاینت‌های کاربر (ویندوز، اندروید و iOS) کانفیگ استاندارد `sing-box 1.14+` را مستقیماً از Cloudflare Worker دریافت کرده و بدون نیاز به هیچ سرور واسط (Bridge VPS)، مستقیماً به نودهای سالم ثبت‌شده در دیتابیس متصل می‌شوند.

---

## 🏗 ساختار پروژه (Monorepo Architecture)

```text
sentra-platform/
├── cloudflare-worker/              # هسته مرکزی Serverless (Cloudflare Workers + D1 + Telegram Webhook)
│   ├── wrangler.toml               # پیکربندی Worker (sentra-core) و دیتابیس D1 (sentra-db)
│   ├── schema.sql                  # اسکیمای کامل D1 (سازگار با wrangler d1 execute بدون PRAGMA/TRIGGER)
│   └── src/
│       ├── index.ts                # نقطه ورود Worker با هدرهای امنیتی و CORS محدود
│       ├── routes.ts               # اندپوینت‌های REST (/health, /sub/:token, /api/v1/client/config, /api/v1/nodes/*)
│       ├── outboundAnalyzer.ts     # پارسر لینک‌ها، استخراج fp، uTLS اجباری Reality و اثرانگشت SHA-256
│       ├── singboxCompiler.ts      # کامپایلر مستقیم کلاینت sing-box 1.14+ (fakeip، rule_actions، Split Tunneling)
│       ├── telegramWebhook.ts      # ربات تلگرام مبتنی بر Webhook با ذخیره وضعیت در D1
│       └── security.ts             # PBKDF2-SHA256، مقایسه امن کلیدها و اعتبارسنجی آدرس‌ها
├── .github/
│   ├── scripts/
│   │   └── quality-check.ts        # موتور مستقل پایش کیفیت نودها (پینگ، جیتر، Gemini و پلتفرم‌های ترید)
│   └── workflows/
│       ├── deploy-cloudflare.yml   # اجرای تست‌ها، به‌روزرسانی D1 (schema.sql) و دیپلوی خودکار Worker
│       └── quality-engine.yml      # اجرای خودکار پایش نودها هر ۲۰ دقیقه در GitHub Actions
├── sentra-client/                  # اپلیکیشن کلاینت دسکتاپ و اندروید (Tauri v2 + Vite + TailwindCSS)
└── docs/                           # مستندات فنی و طراحی محصول
```

---

## 🚀 راه‌اندازی و دیپلوی کاملاً رایگان (Cloudflare + GitHub Actions)

### ۱. تنظیم سکرت‌های Cloudflare Worker (`sentra-core`)
از داخل پوشه `cloudflare-worker` یا پنل Cloudflare Workers مقادیر زیر را ثبت کنید:
- `TELOXIDE_TOKEN` — توکن ربات تلگرام
- `TELEGRAM_WEBHOOK_SECRET` — کلید تصادفی تایید هدر وب‌هوک تلگرام
- `ADMIN_CHAT_ID` — شناسه عددی ادمین اصلی در تلگرام
- `QUALITY_ENGINE_SECRET` — کلید مشترک برای ارتباط امن GitHub Actions با اندپوینت‌های پایش کیفیت
- `WIREGUARD_SERVER_PUBLIC_KEY` و `WIREGUARD_KEY_SALT` — (اختیاری) جهت تولید پروفایل WireGuard گیمینگ iOS

### ۲. تنظیم سکرت‌های GitHub Actions
در بخش **Settings → Secrets and variables → Actions** مخزن گیتهاب:
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `QUALITY_ENGINE_SECRET`
- `SENTRA_WORKER_URL` (پیش‌فرض: `https://sentra-core.kziepr.workers.dev`)

### ۳. دیپلوی خودکار و ثبت Webhook تلگرام
با هر Push به شاخه `main`، ورک‌فلو `deploy-cloudflare.yml` به‌صورت خودکار تست‌ها را اجرا، فایل `schema.sql` را روی دیتابیس D1 اعمال و Worker را دیپلوی می‌کند. سپس یک‌بار Webhook تلگرام را ثبت کنید:

```bash
curl -X POST "https://api.telegram.org/bot<TELOXIDE_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://sentra-core.kziepr.workers.dev/api/v1/telegram/webhook","secret_token":"<TELEGRAM_WEBHOOK_SECRET>"}'
```

---

## 💻 توسعه محلی اپلیکیشن کلاینت (`sentra-client`)

```bash
cd sentra-client
npm install
npm run dev          # پیش‌نمایش رابط کاربری
npm run tauri dev    # اجرای دسکتاپ نیتیو Tauri v2
```

---

## 🌟 ویژگی‌های کلیدی معماری Zero-VPS

- **اتصال مستقیم کلاینت به نودها (`Direct-to-Node`):** هیچ سرور واسط (VPS) در مسیر ترافیک وجود ندارد؛ کلاینت‌ها لیست نودهای سالم (`donated_outbounds` و `outbounds`) را در قالب JSON استاندارد `sing-box 1.14+` می‌گیرند.
- **سازگاری کامل با `sing-box 1.14+`:** استفاده از `type: "fakeip"` داخل `dns.servers`، استفاده از `rule_actions` (`sniff` و `hijack-dns`) به جای `dns-out`، Split Tunneling دامنه‌های `.ir` و بانک‌های ایرانی (`direct`)، تزریق اجباری `utls` برای Reality و حذف کامل کلیدهای منسوخ `independent_cache` و `_sentra_meta`.
- **پایش خودکار کیفیت در GitHub Actions:** هر ۲۰ دقیقه تمام نودها از نظر پینگ، جیتر، امنیت پروتکل، دسترسی به Google Gemini و پلتفرم‌های ترید بررسی و نتیجه به `POST /api/v1/nodes/health-report` ارسال می‌شود.
- **ربات تلگرام Webhook-based:** مدیریت ثبت‌نام/ورود، پروفایل کاربری، بخش گیمینگ (فعال‌سازی خودکار با افزودن نود گیمینگ)، اهدای اوتباند و ایمپورت لینک ساب ادمین بدون نیاز به سرور همیشه روشن.
