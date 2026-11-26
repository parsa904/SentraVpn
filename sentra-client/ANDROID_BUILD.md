# راهنمای جامع ساخت و بیلد نسخه اندروید سنترا کانکت (`Sentra Connect Android`)

این مستند راهنمای گام‌به‌گام راه‌اندازی، کامپایل و استخراج فایل خروجی **APK** نرم‌افزار **Sentra Connect** برای سیستم‌عامل اندروید با استفاده از **Tauri v2 Mobile**، سرویس بومی **Kotlin `VpnService`** و هسته شبکه **`libbox.aar`** (موتور Sing-box v1.10+) است.

---

## ۱. معماری نسخه اندروید (Architecture Overview)

در نسخه اندروید، معماری هیبریدی با مرزبندی‌های زیر پیاده‌سازی شده است:

```text
+-------------------------------------------------------------------+
|               Sentra Connect UI (HTML + Tailwind + TS)            |
|                     (Shared with Desktop Client)                  |
+-------------------------------------------------------------------+
                                  |
                                  | (Tauri IPC Bridge)
                                  v
+-------------------------------------------------------------------+
|               Rust Native Core (src-tauri/src/)                   |
|     - auth.rs (8-digit OTP & Session) [Shared]                    |
|     - vpn_manager.rs (Config Compiler & Dispatcher)               |
|     - tauri-plugin-sentra-vpn (Native Android JNI Bridge)         |
+-------------------------------------------------------------------+
                                  |
                                  | (Android JNI & Plugin API)
                                  v
+-------------------------------------------------------------------+
|               Kotlin VpnService & PlatformInterface               |
|     - SentraVpnPlugin.kt (Permission check & Service launch)      |
|     - SentraVpnService.kt (VpnService + PlatformInterface)        |
|     - openTun(): TUN Virtual Adapter with MTU 1400                |
|     - protect(fd): Loop prevention for outbound sockets           |
|     - Split Tunneling: Bypass for Iranian apps & banks            |
+-------------------------------------------------------------------+
                                  |
                                  | (Go-Mobile CGO Interface)
                                  v
+-------------------------------------------------------------------+
|               Sing-box Mobile Core (libbox.aar)                   |
|     - Full VLESS, Reality, Hysteria 2, ShadowTLS v3 Engines       |
|     - FakeIP DNS (198.18.0.0/15) + urltest Latency Selector       |
+-------------------------------------------------------------------+
```

---

## ۲. پیش‌نیازهای سیستمی و محیط توسعه (Prerequisites)

برای بیلد پروژه اندروید، ابزارهای زیر باید روی سیستم شما نصب و پیکربندی شده باشند:

### ۱. جاوا (JDK 17)
نسخه ۱۷ جاوا (OpenJDK یا Oracle JDK) را نصب کرده و متغیر محیطی `JAVA_HOME` را تنظیم کنید:
```bash
java -version
# باید خروجی شبیه به openjdk version "17.0.x" باشد
```

### ۲. نصب Android SDK و NDK
- از طریق **Android Studio**، بخش **SDK Manager** را باز کرده و موارد زیر را نصب کنید:
  - **Android SDK Platform 34** (Android 14)
  - **Android SDK Build-Tools 34.0.0**
  - **Android NDK** (نگارش `26.1.10909125` یا بالاتر)
  - **Android SDK Command-line Tools**
- متغیرهای محیطی زیر را به سیستم خود اضافه فرمایید:
  ```powershell
  # ویندوز (PowerShell)
  [System.Environment]::SetEnvironmentVariable("ANDROID_HOME", "C:\Users\<YourUser>\AppData\Local\Android\Sdk", "User")
  [System.Environment]::SetEnvironmentVariable("NDK_HOME", "C:\Users\<YourUser>\AppData\Local\Android\Sdk\ndk\26.1.10909125", "User")
  ```

### ۳. نصب تارگت‌های اندروید برای کامپایلر Rust
دستور زیر را در ترمینال اجرا کنید تا تارگت‌های معماری‌های مختلف پردازنده‌های گوشی به Rust اضافه شوند:
```bash
rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android
```

---

## ۳. محل قرار دادن فایل هسته `libbox.aar`

فایل کتابخانه **`libbox.aar`** خروجی کامپایل هسته Sing-box برای اندروید است.

1. فایل `libbox.aar` مربوط به نسخه Sing-box v1.10+ را دانلود یا کامپایل کنید.
2. آن را در مسیر زیر در پروژه قرار دهید:
   ```text
   sentra-client/src-tauri/gen/android/app/libs/libbox.aar
   ```
3. فایل [build.gradle.kts](file:///c:/Users/kziep/OneDrive/Desktop/Project/SentraVpn/sentra-client/src-tauri/gen/android/app/build.gradle.kts) به گونه‌ای پیکربندی شده است که کلیه فایل‌های `.aar` موجود در این پوشه را به طور خودکار شناسایی کرده و داخل بسته نهایی APK قرار می‌دهد:
   ```kotlin
   dependencies {
       implementation(fileTree(mapOf("dir" to "libs", "include" to listOf("*.aar", "*.jar"))))
   }
   ```

> **نکته توسعه بدون هزینه (Zero-cost Sandbox):** پروژه مجهز به اینترفیس‌های کامل `io.nekohasekai.libbox` است. در صورتی که فایل فیزیکی `libbox.aar` هنوز دانلود نشده باشد، پروژه همچنان کامپایل شده و در حالت شبیه‌ساز سندباکس (`Sandbox Mode`) اجرا خواهد شد تا تست‌های UI و سنجه‌ها با موفقیت انجام پذیرند.

---

## ۴. مقداردهی و اجرای پروژه (Initialization & Dev Mode)

### الف) مقداردهی اولیه محیط اندروید توری (فقط برای اولین بار):
اگر پوشه `gen/android` نیاز به بازسازی داشته باشد:
```bash
cd sentra-client
npx @tauri-apps/cli android init
```

### ب) اجرای زنده روی گوشی متصل با کابل USB یا شبیه‌ساز (Dev Mode):
1. دیباگ USB (USB Debugging) را روی گوشی اندرویدی خود فعال کرده و آن را به کامپیوتر متصل کنید.
2. دستور زیر را اجرا فرمایید:
   ```bash
   cd sentra-client
   npm run tauri android dev
   ```
3. **اتصال به سرور مرکزی `sentra-core` (Zero-VPS):**
   کلاینت اندروید به صورت پیش‌فرض و بدون نیاز به هیچ سرور محلی یا `adb reverse`، مستقیماً از طریق HTTPS به Cloudflare Worker روی آدرس `https://sentra-core.kziepr.workers.dev` (مقدار `VITE_API_BASE_URL` در `.env.production`) متصل می‌شود.

---

## ۵. تولید فایل نهایی نصب اندروید (`APK Build`)

برای کامپایل و دریافت فایل نصب مستقل (`.apk`):

```bash
cd sentra-client
npm run tauri android build -- --apk
```

### محل فایل APK خروجی:
پس از اتمام موفقیت‌آمیز بیلد، فایل نصب در مسیر زیر تولید می‌شود:
```text
sentra-client/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk
```
یا در بیلد دیباگ:
```text
sentra-client/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

جهت نصب مستقیم APK روی گوشی متصل:
```bash
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

---

## ۶. جزئیات پیاده‌سازی سرویس بومی `SentraVpnService`

### الف) ایجاد کارت شبکه مجازی (`openTun`):
- آدرس IPv4 پیش‌فرض: `172.19.0.1/30`
- سرور دی‌ان‌اس: `198.18.0.1` (موتور FakeIP در Sing-box)
- سایز پکت (MTU): مقدار استاندارد `1400` بایت جهت تطابق با شبکه‌های همراه ایران (همراه اول و ایرانسل) و جلوگیری از پکت فرگمنتیشن ناخواسته.
- هدایت ترافیک: مسیر کامل `0.0.0.0/0` به داخل تونل.

### ب) جلوگیری از حلقه ترافیک (`protect(fd)`):
- در متد `autoDetectInterfaceControl(fd: Int)`، متد `protect(fd)` از کلاس `VpnService` روی تمام سوکت‌های ورودی و خروجی هسته فراخوانی می‌شود تا ترافیک خود پروتکل‌های VPN (مانند VLESS یا Hysteria 2) دوباره وارد کارت شبکه مجازی نشوند.

### ج) تفکیک ترافیک ایرانی (Split Tunneling):
- اپلیکیشن‌های بانکی و پرمصرف داخلی نظیر دیوار، دیجی‌کالا، اسنپ، همراه کارت، بام، روبیکا، بله و شاپرک از طریق متد `addDisallowedApplication` مستقیماً از ترافیک تانل معاف می‌شوند تا کاربران بدون قطعی و با سرعت داخلی به خدمات بانکی دسترسی داشته باشند.

### د) اعلان دائمی و دکمه قطع اتصال (Foreground Notification):
- سرویس به صورت `startForegroundService` با دسته‌بندی `specialUse` (منطبق بر الزامات Android 14 / targetSdk 34) اجرا می‌شود و در نوار اعلان، وضعیت اتصال و دکمه تک‌کلیکی **«قطع اتصال (Disconnect)»** را نمایش می‌دهد.
