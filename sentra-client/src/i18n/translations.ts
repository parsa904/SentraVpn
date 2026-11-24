export type Language = 'en' | 'fa';

export const LANG_STORAGE_KEY = 'sentra_lang_v1';

export function getInitialLanguage(): Language {
  try {
    const saved = localStorage.getItem(LANG_STORAGE_KEY);
    if (saved === 'en' || saved === 'fa') return saved;
  } catch {
    // ignore storage errors
  }
  return 'en';
}

export function applyDocumentLanguage(lang: Language): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.lang = lang;
  root.dir = lang === 'fa' ? 'rtl' : 'ltr';
  try {
    localStorage.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    // ignore storage errors
  }
}

export const translations = {
  en: {
    brand: 'Sentra',
    splashChecking: 'Loading...',
    splashSyncing: 'Syncing servers...',

    // Auth (clean, zero marketing copy)
    signIn: 'Sign In',
    signUp: 'Sign Up',
    telegramCode: 'Telegram Code',
    username: 'Username',
    password: 'Password',
    telegramCodeLabel: '8-digit Telegram code',
    continueBtn: 'Continue',
    connectingServer: 'Connecting...',
    authMethodAria: 'Authentication method',
    getCodeFromBot: 'Get code from',
    authFailed: 'Authentication failed.',
    otpFailed: 'Code verification failed.',

    // Navigation
    mainMenuAria: 'Main navigation',
    mobileNavAria: 'Mobile navigation',
    navHome: 'Home',
    navHomeShort: 'Home',
    navProfiles: 'Servers & Profiles',
    navProfilesShort: 'Servers',
    navDonate: 'Donate Outbound',
    navDonateShort: 'Donate',
    navSettings: 'Settings',
    navSettingsShort: 'Settings',
    navLogs: 'Logs',
    navLogsShort: 'Logs',
    lightMode: 'Light Mode',
    darkMode: 'Dark Mode',
    signOut: 'Sign Out',

    // Top bar
    activePlan: 'Plan',
    syncing: 'Syncing...',
    volume: 'Usage',
    refresh: 'Refresh',
    addConfig: 'Add Config',
    refreshAria: 'Refresh servers and account',
    addConfigAria: 'Add personal config',
    devicesRatio: '{used} / {max} devices',
    retry: 'Retry',

    // Update Banner
    updateAvailable: 'Update available',
    updateVersion: 'Version {version} is ready',
    downloadUpdate: 'Download',
    dismissUpdate: 'Dismiss update notification',

    // Home
    connectionModeAria: 'Connection mode',
    modeWeb: 'Web',
    modeDownload: 'Download',
    modeStaticIp: 'Static IP',
    connect: 'Connect',
    connecting: 'Connecting',
    disconnect: 'Disconnect',
    statusConnected: 'Connected',
    statusConnecting: 'Connecting...',
    statusDisconnected: 'Disconnected',
    statusError: 'Connection Failed',
    connectAria: 'Connect VPN',
    disconnectAria: 'Disconnect VPN',
    testActivePingAria: 'Test active server latency',
    autoSelect: 'Auto Select',
    autoFastestSub: 'Fastest healthy server',
    noServerSelected: 'No server selected',
    selectServerHint: 'Select a server in Servers & Profiles',
    changeServer: 'Servers',
    timeout: 'Timeout',

    // Servers & Profiles
    serversTitle: 'Servers',
    testAll: 'Test All',
    testingAll: 'Testing...',
    searchServersPlaceholder: 'Search servers, countries, or protocols...',
    searchServersAria: 'Search servers',
    filterAll: 'All',
    officialServer: 'Official',
    communityServer: 'Community',
    autoCardTitle: 'Auto',
    autoCardDesc: 'Tests active servers and picks the lowest latency',
    autoResolved: 'Fastest: {name}',
    autoTesting: 'Finding fastest server...',
    noServersTitle: 'No active servers yet',
    noServersSearchTitle: 'No matching servers',
    noServersDesc: 'Refresh to load active servers.',
    noServersSearchDesc: 'Try a different search term or protocol filter.',
    syncNow: 'Sync Servers',
    personalConfigsTitle: 'Profiles',
    addFromClipboard: 'Add Config',
    noPersonalTitle: 'No personal profiles',
    noPersonalDesc: 'Supports VLESS, VMess, Trojan, Shadowsocks, Hysteria2, TUIC, WireGuard, and subscription URLs.',
    publishDonated: 'Donate for Free Pro',
    deleteConfigAria: 'Delete {name}',
    pingNodeAria: 'Test latency for {name}',
    personalCountry: 'Custom',

    // Donate Outbound
    donateTitle: 'Donate Outbound',
    donateDesc: 'Share a working proxy config with the network. After verification, 7 to 30 days of Pro are added to your account.',
    quickPickPersonal: 'From your profiles:',
    configUriLabel: 'Config URI',
    pasteClipboard: 'Paste',
    clipboardError: 'Clipboard unavailable. Paste manually.',
    serverNameOptional: 'Server Name (optional)',
    serverNamePlaceholder: 'e.g. Frankfurt Fast',
    noteOptional: 'Note (optional)',
    notePlaceholder: 'e.g. Monthly validity, unlimited traffic',
    submitDonation: 'Submit for Review',
    submittingDonation: 'Testing & Submitting...',
    donationSubmittedDefault: 'Submitted for admin review.',
    donationSubmitError: 'Submission failed.',
    donationUriRequired: 'Enter a valid proxy URI.',
    donationUriUnsupported: 'Unsupported protocol URI.',
    myDonationsTitle: 'My Donations',
    refreshStatus: 'Refresh',
    noDonationsTitle: 'No donations yet',
    noDonationsDesc: 'Your submitted configs and reward status will appear here.',
    statusApproved: 'Approved',
    statusApprovedDays: 'Approved (+{days}d Pro)',
    statusRejected: 'Rejected',
    statusPending: 'Pending Review',

    // Settings
    languageTitle: 'Language',
    languageDesc: 'Switch interface language and layout direction',
    langEnglish: 'English',
    langPersian: 'فارسی (Persian)',
    appearanceTitle: 'Appearance',
    appearanceDesc: 'Switch between Dark and Light themes',
    routingTitle: 'Routing & Network',
    routeTunnelTitle: 'Tunnel (TUN)',
    routeTunnelDesc: 'Route all system traffic through the VPN tunnel',
    routeSysProxyTitle: 'System Proxy',
    routeSysProxyDesc: 'Configure system HTTP/SOCKS proxy automatically',
    routeLocalProxyTitle: 'Local Proxy',
    routeLocalProxyDesc: 'Expose local SOCKS5/HTTP ports only',
    splitTunnelTitle: 'Split Tunneling (.ir Bypass)',
    splitTunnelDesc: 'Route domestic Iranian sites and banks directly',
    splitTunnelAria: 'Toggle Split Tunneling',
    killSwitchTitle: 'Kill-Switch',
    killSwitchDesc: 'Prevent IP leaks if the tunnel drops unexpectedly',
    killSwitchAria: 'Toggle Kill-Switch',
    warpTitle: 'Cloudflare WARP',
    warpDesc: 'Reduce captchas and improve service reachability',
    warpStaticDisabled: 'Disabled automatically in Static IP mode',
    warpAria: 'Toggle Cloudflare WARP',
    customDnsTitle: 'Custom DNS',
    customDnsDesc: 'DoH URL or IPv4 server (e.g. 1.1.1.1)',
    devicesTitle: 'Connected Devices',
    noDevicesText: 'No active devices synced yet.',
    remove: 'Remove',
    removeDeviceAria: 'Remove device {name}',
    telegramLinkTitle: 'Telegram Link',
    telegramLinkDesc: 'Link your account to receive notifications and manage plans',
    getLinkCode: 'Get Link Code',
    loadingCode: 'Loading...',
    sendCommandToBot: 'Send this command to the bot:',
    copyCommand: 'Copy',
    copied: 'Copied',
    accountTitle: 'Account',
    signedInAs: 'Signed in as {username}',
    sessionSaved: 'Session active on this device',

    // Logs
    logsTitle: 'Logs',
    copy: 'Copy',
    clear: 'Clear',
    noLogs: 'No log entries yet.',

    // Modals
    addModalTitle: 'Add Profile or Subscription',
    addModalDesc: 'Supports vless://, vmess://, trojan://, ss://, hy2://, tuic://, wireguard://, or subscription URLs.',
    addModalUriLabel: 'Config URI or Subscription URL',
    addModalNameLabel: 'Name (optional)',
    addModalNamePlaceholder: 'Uses link name if empty',
    cancel: 'Cancel',
    addBtn: 'Add',
    closeModalAria: 'Close dialog',
    invalidLink: 'Invalid configuration link.',

    donateModalTitle: 'Donate Outbound',
    donateModalDesc: 'This config will be verified and sent for review. Approved configs award 7–30 days of Pro.',
    donateModalNoteLabel: 'Note (optional)',
    donateModalNotePlaceholder: 'e.g. Dedicated Germany node, 1 month',
    donateModalSubmit: 'Submit',
    donateModalSubmitting: 'Submitting...',

    // Dynamic feedback & toasts
    selectServerFirst: 'Select a server or choose Auto Select first.',
    noHealthyServerFound: 'No reachable server responded to latency check.',
    autoSelectedToast: 'Auto selected fastest server: {name} ({ms} ms)',
    serverSelectedToast: 'Selected {name}',
    configAddedToast: 'Added {name}',
    configDeletedToast: 'Profile removed.',
    deviceRemovedToast: 'Device removed.',
    sessionExpiredNotice: 'Session expired. Please sign in again.',
    modeChangeFailed: 'Failed to change mode.',
    connectFailed: 'Connection failed.',
    signInRequired: 'Please sign in first.',
  },
  fa: {
    brand: 'Sentra',
    splashChecking: 'در حال بارگذاری...',
    splashSyncing: 'همگام‌سازی سرورها...',

    // Auth (clean, zero marketing copy)
    signIn: 'ورود',
    signUp: 'ثبت‌نام',
    telegramCode: 'کد تلگرام',
    username: 'نام کاربری',
    password: 'رمز عبور',
    telegramCodeLabel: 'کد ۸ رقمی تلگرام',
    continueBtn: 'ادامه',
    connectingServer: 'در حال ارتباط...',
    authMethodAria: 'روش احراز هویت',
    getCodeFromBot: 'دریافت کد از',
    authFailed: 'احراز هویت ناموفق بود.',
    otpFailed: 'تایید کد ناموفق بود.',

    // Navigation
    mainMenuAria: 'منوی اصلی',
    mobileNavAria: 'ناوبری موبایل',
    navHome: 'خانه',
    navHomeShort: 'خانه',
    navProfiles: 'سرورها و پروفایل‌ها',
    navProfilesShort: 'سرورها',
    navDonate: 'اهدای اوتباند',
    navDonateShort: 'اهدا',
    navSettings: 'تنظیمات',
    navSettingsShort: 'تنظیمات',
    navLogs: 'گزارش‌ها',
    navLogsShort: 'گزارش‌ها',
    lightMode: 'حالت روشن',
    darkMode: 'حالت تاریک',
    signOut: 'خروج',

    // Top bar
    activePlan: 'طرح',
    syncing: 'همگام‌سازی...',
    volume: 'مصرف',
    refresh: 'بروزرسانی',
    addConfig: 'افزودن کانفیگ',
    refreshAria: 'بروزرسانی سرورها و حساب',
    addConfigAria: 'افزودن کانفیگ شخصی',
    devicesRatio: '{used} از {max} دستگاه',
    retry: 'تلاش مجدد',

    // Update Banner
    updateAvailable: 'نسخه جدید موجود است',
    updateVersion: 'نسخه {version} آماده دانلود است',
    downloadUpdate: 'دانلود',
    dismissUpdate: 'بستن اعلان بروزرسانی',

    // Home
    connectionModeAria: 'حالت اتصال',
    modeWeb: 'وب‌گردی',
    modeDownload: 'دانلود',
    modeStaticIp: 'آی‌پی ثابت',
    connect: 'اتصال',
    connecting: 'در حال اتصال',
    disconnect: 'قطع اتصال',
    statusConnected: 'متصل',
    statusConnecting: 'در حال اتصال...',
    statusDisconnected: 'قطع',
    statusError: 'خطا در اتصال',
    connectAria: 'اتصال VPN',
    disconnectAria: 'قطع اتصال VPN',
    testActivePingAria: 'تست پینگ سرور فعال',
    autoSelect: 'انتخاب خودکار',
    autoFastestSub: 'سریع‌ترین سرور سالم',
    noServerSelected: 'سروری انتخاب نشده',
    selectServerHint: 'یک سرور از بخش سرورها انتخاب کنید',
    changeServer: 'سرورها',
    timeout: 'تایم‌اوت',

    // Servers & Profiles
    serversTitle: 'سرورها',
    testAll: 'تست همه',
    testingAll: 'در حال تست...',
    searchServersPlaceholder: 'جستجوی سرور، کشور یا پروتکل...',
    searchServersAria: 'جستجوی سرورها',
    filterAll: 'همه',
    officialServer: 'رسمی',
    communityServer: 'کاربران',
    autoCardTitle: 'انتخاب خودکار (Auto)',
    autoCardDesc: 'تست همه نودهای فعال و انتخاب کم‌تاخیرترین سرور سالم',
    autoResolved: 'سریع‌ترین: {name}',
    autoTesting: 'در حال یافتن سریع‌ترین سرور...',
    noServersTitle: 'سرور فعالی دریافت نشده',
    noServersSearchTitle: 'سروری یافت نشد',
    noServersDesc: 'برای دریافت سرورهای فعال روی بروزرسانی بزنید.',
    noServersSearchDesc: 'عبارت جستجو یا فیلتر پروتکل را تغییر دهید.',
    syncNow: 'همگام‌سازی',
    personalConfigsTitle: 'پروفایل‌های شخصی',
    addFromClipboard: 'افزودن کانفیگ',
    noPersonalTitle: 'پروفایل شخصی وجود ندارد',
    noPersonalDesc: 'پشتیبانی از VLESS، VMess، Trojan، Shadowsocks، Hysteria2، TUIC، WireGuard و لینک اشتراک.',
    publishDonated: 'اهدا برای اشتراک رایگان',
    deleteConfigAria: 'حذف {name}',
    pingNodeAria: 'تست پینگ {name}',
    personalCountry: 'شخصی',

    // Donate Outbound
    donateTitle: 'اهدای اوتباند',
    donateDesc: 'کانفیگ سالم خود را به شبکه اهدا کنید. پس از تایید، ۷ تا ۳۰ روز اشتراک Pro به حساب شما اضافه می‌شود.',
    quickPickPersonal: 'انتخاب از پروفایل‌های شما:',
    configUriLabel: 'لینک کانفیگ (URI)',
    pasteClipboard: 'چسباندن',
    clipboardError: 'دسترسی به کلیپ‌بورد ممکن نیست؛ دستی وارد کنید.',
    serverNameOptional: 'نام سرور (اختیاری)',
    serverNamePlaceholder: 'مثلاً: Frankfurt Fast',
    noteOptional: 'توضیحات (اختیاری)',
    notePlaceholder: 'مثلاً: اعتبار ماهانه، ترافیک نامحدود',
    submitDonation: 'ارسال برای بررسی',
    submittingDonation: 'در حال تست و ارسال...',
    donationSubmittedDefault: 'برای بررسی ادمین ارسال شد.',
    donationSubmitError: 'ارسال ناموفق بود.',
    donationUriRequired: 'لینک کانفیگ معتبر وارد کنید.',
    donationUriUnsupported: 'پروتکل لینک پشتیبانی نمی‌شود.',
    myDonationsTitle: 'اوتباندهای اهدایی من',
    refreshStatus: 'بروزرسانی',
    noDonationsTitle: 'هنوز اوتباندی اهدا نکرده‌اید',
    noDonationsDesc: 'وضعیت بررسی و پاداش کانفیگ‌های ارسالی در اینجا نمایش داده می‌شود.',
    statusApproved: 'تایید شده',
    statusApprovedDays: 'تایید شده (+{days} روز Pro)',
    statusRejected: 'رد شده',
    statusPending: 'در انتظار بررسی',

    // Settings
    languageTitle: 'زبان برنامه (Language)',
    languageDesc: 'تغییر آنی زبان و جهت چیدمان رابط کاربری',
    langEnglish: 'English',
    langPersian: 'فارسی (Persian)',
    appearanceTitle: 'ظاهر برنامه',
    appearanceDesc: 'تغییر بین پوسته تاریک و روشن',
    routingTitle: 'مسیریابی و شبکه',
    routeTunnelTitle: 'تونل (TUN)',
    routeTunnelDesc: 'عبور کل ترافیک سیستم از تونل VPN',
    routeSysProxyTitle: 'پروکسی سیستم',
    routeSysProxyDesc: 'تنظیم خودکار پروکسی سیستم',
    routeLocalProxyTitle: 'پروکسی محلی',
    routeLocalProxyDesc: 'فقط پورت‌های محلی SOCKS5/HTTP',
    splitTunnelTitle: 'مسیریابی هوشمند ایران (Split Tunneling)',
    splitTunnelDesc: 'عبور مستقیم سایت‌ها و بانک‌های داخلی (.ir)',
    splitTunnelAria: 'تغییر Split Tunneling',
    killSwitchTitle: 'محافظ قطع ناگهانی (Kill-Switch)',
    killSwitchDesc: 'جلوگیری از نشت آی‌پی در صورت قطعی تونل',
    killSwitchAria: 'تغییر Kill-Switch',
    warpTitle: 'Cloudflare WARP',
    warpDesc: 'کاهش کپچا و بهبود دسترسی به سرویس‌ها',
    warpStaticDisabled: 'در حالت آی‌پی ثابت به‌صورت خودکار خاموش است',
    warpAria: 'تغییر Cloudflare WARP',
    customDnsTitle: 'DNS اختصاصی',
    customDnsDesc: 'آدرس DoH یا سرور IPv4 (مثلاً 1.1.1.1)',
    devicesTitle: 'دستگاه‌های متصل',
    noDevicesText: 'اطلاعات دستگاه‌ها هنوز دریافت نشده است.',
    remove: 'حذف',
    removeDeviceAria: 'حذف دستگاه {name}',
    telegramLinkTitle: 'اتصال به تلگرام',
    telegramLinkDesc: 'دریافت اعلان‌ها و مدیریت اشتراک در ربات تلگرام',
    getLinkCode: 'دریافت کد اتصال',
    loadingCode: 'در حال دریافت...',
    sendCommandToBot: 'دستور زیر را برای ربات ارسال کنید:',
    copyCommand: 'کپی',
    copied: 'کپی شد',
    accountTitle: 'حساب کاربری',
    signedInAs: 'وارد شده با {username}',
    sessionSaved: 'نشست فعال روی این دستگاه',

    // Logs
    logsTitle: 'گزارش‌ها',
    copy: 'کپی',
    clear: 'پاک‌سازی',
    noLogs: 'هنوز گزارشی ثبت نشده است.',

    // Modals
    addModalTitle: 'افزودن پروفایل یا اشتراک',
    addModalDesc: 'پشتیبانی از vless://، vmess://، trojan://، ss://، hy2://، tuic://، wireguard:// یا لینک اشتراک.',
    addModalUriLabel: 'لینک کانفیگ یا Subscription URL',
    addModalNameLabel: 'نام دلخواه (اختیاری)',
    addModalNamePlaceholder: 'در صورت خالی بودن از نام لینک استفاده می‌شود',
    cancel: 'انصراف',
    addBtn: 'افزودن',
    closeModalAria: 'بستن پنجره',
    invalidLink: 'لینک کانفیگ نامعتبر است.',

    donateModalTitle: 'اهدای اوتباند',
    donateModalDesc: 'این کانفیگ تست و برای تایید ارسال می‌شود. پس از تایید ۷ تا ۳۰ روز اشتراک Pro دریافت می‌کنید.',
    donateModalNoteLabel: 'توضیحات (اختیاری)',
    donateModalNotePlaceholder: 'مثلاً: سرور آلمان، اعتبار ۱ ماهه',
    donateModalSubmit: 'ارسال',
    donateModalSubmitting: 'در حال ارسال...',

    // Dynamic feedback & toasts
    selectServerFirst: 'ابتدا یک سرور یا انتخاب خودکار را برگزینید.',
    noHealthyServerFound: 'هیچ سرور سالمی به تست پینگ پاسخ نداد.',
    autoSelectedToast: 'سریع‌ترین سرور انتخاب شد: {name} ({ms} ms)',
    serverSelectedToast: 'سرور «{name}» انتخاب شد',
    configAddedToast: 'کانفیگ «{name}» اضافه شد',
    configDeletedToast: 'پروفایل حذف شد.',
    deviceRemovedToast: 'دستگاه حذف شد.',
    sessionExpiredNotice: 'نشست کاربری منقضی شده است. دوباره وارد شوید.',
    modeChangeFailed: 'تغییر حالت اتصال ناموفق بود.',
    connectFailed: 'برقراری اتصال ناموفق بود.',
    signInRequired: 'ابتدا وارد حساب کاربری شوید.',
  },
} as const;

export type TranslationKey = keyof typeof translations.en;

export function t(
  lang: Language,
  key: TranslationKey,
  params?: Record<string, string | number>
): string {
  const dict = translations[lang] ?? translations.en;
  let value: string = dict[key] ?? translations.en[key];
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      value = value.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return value;
}
