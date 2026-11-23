use crate::models::{AppRelease, Outbound, UserDevice};
use teloxide::types::{
    InlineKeyboardButton, InlineKeyboardMarkup, KeyboardButton, KeyboardMarkup,
};

/// Main persistent reply keyboard for users (100% button-driven UI)
pub fn user_main_keyboard_with_admin(is_admin: bool) -> KeyboardMarkup {
    let mut rows = vec![
        vec![
            KeyboardButton::new("📥 دانلود اپلیکیشن (ویندوز / اندروید)"),
            KeyboardButton::new("👤 حساب کاربری و وضعیت اشتراک"),
        ],
        vec![
            KeyboardButton::new("🔗 تایید حساب و باز کردن بخش دانلود"),
            KeyboardButton::new("🎁 اهدای کانفیگ (کمک به شبکه)"),
        ],
        vec![
            KeyboardButton::new("💬 پشتیبانی و راهنما"),
            KeyboardButton::new("🔑 بازیابی رمز عبور"),
        ],
    ];

    if is_admin {
        rows.push(vec![KeyboardButton::new("🛠 پنل مدیریت (ادمین)")]);
    }

    KeyboardMarkup::new(rows).resize_keyboard()
}

/// Main persistent reply keyboard for normal users
pub fn user_main_keyboard() -> KeyboardMarkup {
    user_main_keyboard_with_admin(false)
}

/// Admin Panel persistent reply keyboard (100% button-driven UI)
#[allow(dead_code)]
pub fn admin_main_keyboard() -> KeyboardMarkup {
    KeyboardMarkup::new(vec![
        vec![
            KeyboardButton::new("📊 آمار لحظه‌ای سرور و کاربران"),
            KeyboardButton::new("🌐 مدیریت اوتباندها و نودها"),
        ],
        vec![
            KeyboardButton::new("👥 مدیریت کاربران"),
            KeyboardButton::new("📦 انتشار نسخه جدید (ویندوز و اندروید)"),
        ],
        vec![
            KeyboardButton::new("📢 ارسال پیام همگانی"),
            KeyboardButton::new("🔙 بازگشت به منوی کاربر"),
        ],
    ])
    .resize_keyboard()
}

/// General cancellation inline keyboard (shown on all awaiting states)
pub fn cancel_inline_keyboard() -> InlineKeyboardMarkup {
    InlineKeyboardMarkup::new(vec![
        vec![InlineKeyboardButton::callback("❌ انصراف", "cancel_state")],
    ])
}

/// Inline keyboard for iOS OpenVPN Connection Mode selection
pub fn ios_modes_inline_keyboard(tier: &str) -> InlineKeyboardMarkup {
    let static_label = if tier == "Sentra Lite" {
        "🔒 ۴. آی‌پی ثابت ترید/جمنای (قفل - نیاز به اشتراک ویژه)"
    } else {
        "🌐 ۴. آی‌پی ثابت ترید/جمنای (آمریکا - فعال)"
    };

    InlineKeyboardMarkup::new(vec![
        vec![InlineKeyboardButton::callback(
            "🌐 ۱. وب‌گردی (سهمیه ۲ گیگابایت روزانه)",
            "ios_mode_web_browsing",
        )],
        vec![InlineKeyboardButton::callback(
            "⚡ ۲. دانلود (سهمیه ۳ گیگابایت روزانه)",
            "ios_mode_download",
        )],
        vec![InlineKeyboardButton::callback(
            "🎮 ۳. گیمینگ (کاهش پینگ - به‌زودی)",
            "ios_mode_gaming",
        )],
        vec![InlineKeyboardButton::callback(
            static_label,
            "ios_mode_static_ip",
        )],
    ])
}

/// Inline keyboard for iOS Protocol selection (IKEv2 vs OpenVPN UDP/TCP)
pub fn ios_protocol_choice_keyboard(mode: &str) -> InlineKeyboardMarkup {
    InlineKeyboardMarkup::new(vec![
        vec![InlineKeyboardButton::callback(
            "⚡️ اتصال سریع IKEv2 (پیشنهادی - بدون نیاز به برنامه)",
            format!("ios_proto_ikev2_{}", mode),
        )],
        vec![InlineKeyboardButton::callback(
            "🛡 پروتکل OpenVPN (UDP - پرسرعت)",
            format!("ios_proto_ovpn_udp_{}", mode),
        )],
        vec![InlineKeyboardButton::callback(
            "🛡 پروتکل OpenVPN (TCP - پایداری پورت 443)",
            format!("ios_proto_ovpn_tcp_{}", mode),
        )],
        vec![InlineKeyboardButton::callback(
            "🔙 بازگشت به انتخاب حالت",
            "ios_sub_back_to_modes",
        )],
    ])
}

/// Inline keyboard for Plan Upgrade & Payment Simulation
#[allow(dead_code)]
pub fn upgrade_plans_inline_keyboard() -> InlineKeyboardMarkup {
    InlineKeyboardMarkup::new(vec![
        vec![InlineKeyboardButton::callback(
            "💳 شبیه‌سازی پرداخت موفق (تست توسعه) - ارتقا آنی به Flow+",
            "sim_pay_success",
        )],
        vec![
            InlineKeyboardButton::callback("⚡ پلن Pro (۱۵۰ گیگ)", "plan_info_pro"),
            InlineKeyboardButton::callback("🚀 پلن Flow+ (IP مسکونی آمریکا)", "plan_info_flow"),
        ],
    ])
}

/// Glass / Inline Dashboard Keyboard for Admin Panel
pub fn admin_dashboard_inline_keyboard() -> InlineKeyboardMarkup {
    InlineKeyboardMarkup::new(vec![
        vec![
            InlineKeyboardButton::callback("📊 آمار لحظه‌ای سیستم", "adm_action_stats"),
            InlineKeyboardButton::callback("🔍 جستجو و مدیریت کاربر", "adm_action_search"),
        ],
        vec![
            InlineKeyboardButton::callback("🌐 مدیریت اوتباندها و نودها", "adm_action_official_outbounds"),
            InlineKeyboardButton::callback("📤 آپلود / بروزرسانی اپلیکیشن", "adm_action_upload_app"),
        ],
        vec![
            InlineKeyboardButton::callback("📢 پیام همگانی (Broadcast)", "adm_action_broadcast"),
            InlineKeyboardButton::callback("🔄 نودهای پیش‌فرض سیستم", "adm_action_outbounds"),
        ],
        vec![
            InlineKeyboardButton::callback("🩺 تست سلامت ۶ لایه", "adm_action_health"),
            InlineKeyboardButton::callback("👤 بازگشت به منوی کاربری", "adm_action_return"),
        ],
    ])
}

/// Inline keyboard for the Official Outbounds Management Hub
pub fn admin_official_outbounds_hub_keyboard() -> InlineKeyboardMarkup {
    InlineKeyboardMarkup::new(vec![
        vec![
            InlineKeyboardButton::callback("➕ افزودن لینک تکی", "adm_ob_add_single"),
            InlineKeyboardButton::callback("📥 افزودن سابلینک", "adm_ob_add_sublink"),
        ],
        vec![
            InlineKeyboardButton::callback("⚡ ساخت خودکار WARP", "adm_warp_generate"),
            InlineKeyboardButton::callback("📋 لیست و حذف نودها", "adm_ob_list_all"),
        ],
        vec![
            InlineKeyboardButton::callback("⚙️ تنظیم دسترسی رایگان یا آی‌پی ثابت", "adm_ob_alloc_settings"),
        ],
        vec![
            InlineKeyboardButton::callback("🔙 بازگشت به پنل مدیریت", "adm_back_main"),
        ],
    ])
}

/// Inline keyboard for selecting target allocation for new official outbound
pub fn admin_select_outbound_target_keyboard() -> InlineKeyboardMarkup {
    InlineKeyboardMarkup::new(vec![
        vec![
            InlineKeyboardButton::callback("🌐 فقط بخش رایگان (وب‌گردی / دانلود)", "adm_ob_alloc_free_only"),
        ],
        vec![
            InlineKeyboardButton::callback("💎 فقط بخش آی‌پی ثابت (ترید و جمنای)", "adm_ob_alloc_static_only"),
        ],
        vec![
            InlineKeyboardButton::callback("🎮 بخش گیمینگ و ضدتحریم (WireGuard / TUIC / Hysteria 2)", "adm_ob_alloc_gaming"),
        ],
        vec![
            InlineKeyboardButton::callback("⚡️ هر دو بخش (رایگان + آی‌پی ثابت همزمان)", "adm_ob_alloc_both"),
        ],
        vec![
            InlineKeyboardButton::callback("🤖 تشخیص هوشمند خودکار (بر اساس تست جمنای و سرعت)", "adm_ob_alloc_auto"),
        ],
        vec![
            InlineKeyboardButton::callback("🔙 انصراف و بازگشت", "adm_action_official_outbounds"),
        ],
    ])
}

/// Action buttons for an individual official outbound card
pub fn admin_official_outbound_actions_keyboard(outbound_id: i64, is_active: bool, category: &str) -> InlineKeyboardMarkup {
    let toggle_label = if is_active { "⏸ غیرفعال‌سازی" } else { "▶️ فعال‌سازی" };
    InlineKeyboardMarkup::new(vec![
        vec![
            InlineKeyboardButton::callback("🔄 تست کیفیت و پینگ", format!("adm_ob_ping_{}", outbound_id)),
            InlineKeyboardButton::callback(toggle_label, format!("adm_ob_toggle_{}", outbound_id)),
        ],
        vec![
            InlineKeyboardButton::callback("🔀 تغییر تخصیص دسترسی", format!("adm_ob_realloc_{}", outbound_id)),
            InlineKeyboardButton::callback("🧪 تست جمنای و ترید", format!("adm_ob_gemini_{}", outbound_id)),
        ],
        vec![
            InlineKeyboardButton::callback("🗑 حذف نود", format!("adm_ob_del_{}", outbound_id)),
            InlineKeyboardButton::callback("🔙 بازگشت به لیست", format!("adm_ob_list_{}", category)),
        ],
    ])
}

/// Keyboard for switching node allocation
pub fn admin_outbound_reallocation_keyboard(outbound_id: i64) -> InlineKeyboardMarkup {
    InlineKeyboardMarkup::new(vec![
        vec![
            InlineKeyboardButton::callback("🌐 فقط بخش رایگان (وب / دانلود)", format!("adm_set_alloc_{}_free_only", outbound_id)),
        ],
        vec![
            InlineKeyboardButton::callback("💎 فقط بخش آی‌پی ثابت (ترید و جمنای)", format!("adm_set_alloc_{}_static_only", outbound_id)),
        ],
        vec![
            InlineKeyboardButton::callback("🎮 بخش گیمینگ و ضدتحریم", format!("adm_set_alloc_{}_gaming", outbound_id)),
        ],
        vec![
            InlineKeyboardButton::callback("⚡️ هر دو بخش (رایگان + آی‌پی ثابت)", format!("adm_set_alloc_{}_both", outbound_id)),
        ],
        vec![
            InlineKeyboardButton::callback("🤖 تشخیص هوشمند خودکار", format!("adm_set_alloc_{}_auto", outbound_id)),
        ],
        vec![
            InlineKeyboardButton::callback("🔙 انصراف", "adm_action_official_outbounds"),
        ],
    ])
}

/// Inline keyboard for selecting target action for new app release in Admin panel
pub fn admin_app_release_inline_keyboard() -> InlineKeyboardMarkup {
    InlineKeyboardMarkup::new(vec![
        vec![
            InlineKeyboardButton::callback("🖥 ثبت فایل نصب ویندوز (.exe)", "adm_rel_upload_win"),
            InlineKeyboardButton::callback("📱 ثبت فایل نصب اندروید (.apk)", "adm_rel_upload_apk"),
        ],
        vec![
            InlineKeyboardButton::callback("🔗 ثبت لینک GitHub Release", "adm_rel_set_github"),
            InlineKeyboardButton::callback("📋 مشاهده وضعیت آخرین نسخه", "adm_rel_view_current"),
        ],
        vec![
            InlineKeyboardButton::callback("🔙 بازگشت به پنل مدیریت", "adm_back_main"),
        ],
    ])
}

pub const GITHUB_RELEASE_WINDOWS_URL: &str = "https://github.com/parsa904/SentraVpn/releases/latest/download/SentraVPN-Windows-Setup.exe";
pub const GITHUB_RELEASE_ANDROID_URL: &str = "https://github.com/parsa904/SentraVpn/releases/latest/download/SentraVPN-Android.apk";
pub const GITHUB_RELEASE_PAGE_URL: &str = "https://github.com/parsa904/SentraVpn/releases/latest";

/// Inline keyboard for downloading the Sentra Connect client apps
pub fn download_app_inline_keyboard(release: Option<&AppRelease>) -> InlineKeyboardMarkup {
    let win_url = release
        .and_then(|r| r.windows_github_url.as_deref())
        .unwrap_or(GITHUB_RELEASE_WINDOWS_URL);
    let android_url = release
        .and_then(|r| r.android_github_url.as_deref())
        .unwrap_or(GITHUB_RELEASE_ANDROID_URL);

    let win_valid_url = url::Url::parse(win_url)
        .unwrap_or_else(|_| url::Url::parse(GITHUB_RELEASE_WINDOWS_URL).unwrap());
    let android_valid_url = url::Url::parse(android_url)
        .unwrap_or_else(|_| url::Url::parse(GITHUB_RELEASE_ANDROID_URL).unwrap());
    let page_valid_url = url::Url::parse(GITHUB_RELEASE_PAGE_URL)
        .unwrap_or_else(|_| url::Url::parse("https://github.com/parsa904/SentraVpn").unwrap());

    InlineKeyboardMarkup::new(vec![
        vec![
            InlineKeyboardButton::url("🖥 دانلود مستقیم ویندوز (.exe)", win_valid_url),
            InlineKeyboardButton::url("📱 دانلود مستقیم اندروید (.apk)", android_valid_url),
        ],
        vec![
            InlineKeyboardButton::callback("📥 دریافت فایل در تلگرام (ویندوز)", "dl_app_windows"),
            InlineKeyboardButton::callback("📥 دریافت فایل در تلگرام (اندروید)", "dl_app_android"),
        ],
        vec![
            InlineKeyboardButton::url("🔗 صفحه رسمی انتشار در گیت‌هاب", page_valid_url),
        ],
    ])
}

/// Action buttons for a specific user card in Admin panel
pub fn admin_user_card_inline_keyboard(user_id: i64, is_suspended: bool) -> InlineKeyboardMarkup {
    let block_btn_label = if is_suspended {
        "✅ رفع مسدودیت کاربر"
    } else {
        "🚫 مسدود کردن کاربر"
    };

    InlineKeyboardMarkup::new(vec![
        vec![
            InlineKeyboardButton::callback("➕ ارتقا به Pro (۳۰ روزه)", format!("adm_up_pro_{}", user_id)),
            InlineKeyboardButton::callback("➕ ارتقا به Flow+ (۳۰ روزه)", format!("adm_up_flow_{}", user_id)),
        ],
        vec![
            InlineKeyboardButton::callback("🔄 ریست حجم روزانه کاربر", format!("adm_rst_quota_{}", user_id)),
            InlineKeyboardButton::callback("🔄 ریست حجم آی‌پی ثابت (۳۰ گیگ)", format!("adm_rst_static_{}", user_id)),
        ],
        vec![
            InlineKeyboardButton::callback("📱 پاکسازی دستگاه‌های کاربر", format!("adm_clr_dev_{}", user_id)),
            InlineKeyboardButton::callback(block_btn_label, format!("adm_toggle_ban_{}", user_id)),
        ],
        vec![
            InlineKeyboardButton::callback("🔙 بازگشت به پنل مدیریت", "adm_back_main"),
        ],
    ])
}

/// Verification keyboard for manual payment receipt review
#[allow(dead_code)]
pub fn payment_receipt_inline_keyboard(user_id: i64) -> InlineKeyboardMarkup {
    InlineKeyboardMarkup::new(vec![
        vec![
            InlineKeyboardButton::callback("✅ تایید و فعال‌سازی ۳۰ روزه Pro", format!("rcpt_approve_pro_{}", user_id)),
        ],
        vec![
            InlineKeyboardButton::callback("✅ تایید و فعال‌سازی ۳۰ روزه Flow+", format!("rcpt_approve_flow_{}", user_id)),
        ],
        vec![
            InlineKeyboardButton::callback("❌ رد رسید پرداخت", format!("rcpt_reject_{}", user_id)),
        ],
    ])
}

/// Inline keyboard for Financial Donation Review in Admin chat
pub fn donation_review_inline_keyboard(donation_id: i64, qualifies_for_pro: bool) -> InlineKeyboardMarkup {
    let approve_label = if qualifies_for_pro {
        "✅ [تایید حمایت مالی + ۳۰ روز اشتراک Pro]"
    } else {
        "✅ [تایید حمایت مالی]"
    };

    InlineKeyboardMarkup::new(vec![
        vec![
            InlineKeyboardButton::callback(approve_label, format!("donate_approve_{}", donation_id)),
        ],
        vec![
            InlineKeyboardButton::callback("❌ [رد رسید حمایت مالی]", format!("donate_reject_{}", donation_id)),
        ],
    ])
}

/// Inline keyboard for toggling outbounds in Admin panel
pub fn admin_outbounds_inline_keyboard(outbounds: &[Outbound]) -> InlineKeyboardMarkup {
    let mut rows = Vec::new();
    for ob in outbounds {
        let status_icon = if ob.is_active == 1 { "🟢 فعال" } else { "🔴 غیرفعال" };
        let button_text = format!("{} | {} ({})", status_icon, ob.tag, ob.min_tier);
        let callback_data = format!("toggle_ob_{}", ob.id);
        rows.push(vec![InlineKeyboardButton::callback(button_text, callback_data)]);
    }
    InlineKeyboardMarkup::new(rows)
}

/// Inline keyboard for quick support ticket creation
#[allow(dead_code)]
pub fn support_ticket_inline_keyboard() -> InlineKeyboardMarkup {
    InlineKeyboardMarkup::new(vec![
        vec![
            InlineKeyboardButton::callback("⚡ گزارش کندی سرعت", "ticket_speed"),
            InlineKeyboardButton::callback("🔌 قطعی اتصال تانل", "ticket_disconnect"),
        ],
        vec![
            InlineKeyboardButton::callback("🤖 راهنمایی Google Flow / Gemini", "ticket_ai"),
            InlineKeyboardButton::callback("💬 ارتباط با کارشناس شبکه", "ticket_general"),
        ],
    ])
}

/// Admin manual user tier upgrade keyboard
#[allow(dead_code)]
pub fn admin_tier_change_inline_keyboard(target_user_id: i64) -> InlineKeyboardMarkup {
    InlineKeyboardMarkup::new(vec![
        vec![
            InlineKeyboardButton::callback("تغییر به Lite", format!("set_tier_{}_lite", target_user_id)),
            InlineKeyboardButton::callback("تغییر به Pro", format!("set_tier_{}_pro", target_user_id)),
            InlineKeyboardButton::callback("تغییر به Flow+", format!("set_tier_{}_flow", target_user_id)),
        ],
    ])
}

/// Inline keyboard for managing connected devices (Max 3 Devices)
pub fn user_devices_inline_keyboard(devices: &[UserDevice]) -> InlineKeyboardMarkup {
    let mut rows = Vec::new();
    for dev in devices {
        let platform_icon = match dev.platform.to_lowercase().as_str() {
            "windows" => "💻",
            "android" => "📱",
            "ios" => "🍏",
            "darwin" | "macos" => "🍎",
            "linux" => "🐧",
            _ => "📟",
        };
        let label = format!("❌ حذف: {} {} ({})", platform_icon, dev.device_name, dev.platform);
        let callback_data = format!("del_dev_{}", dev.id);
        rows.push(vec![InlineKeyboardButton::callback(label, callback_data)]);
    }

    rows.push(vec![
        InlineKeyboardButton::callback("🔄 به‌روزرسانی لیست", "manage_devices"),
        InlineKeyboardButton::callback("🔙 بازگشت به وضعیت", "back_to_status"),
    ]);

    InlineKeyboardMarkup::new(rows)
}

/// Keyboard for subscription status message with Manage Devices button
pub fn subscription_status_inline_keyboard(devices_count: usize) -> InlineKeyboardMarkup {
    InlineKeyboardMarkup::new(vec![
        vec![InlineKeyboardButton::callback(
            format!("📱 مدیریت دستگاه‌های متصل ({}/3)", devices_count),
            "manage_devices",
        )],
        vec![
            InlineKeyboardButton::callback("⚡ تیکت پشتیبانی", "ticket_general"),
            InlineKeyboardButton::callback("💳 ارتقا اشتراک", "sim_pay_success"),
        ],
    ])
}

/// Inline keyboard for password reset menu
pub fn password_reset_inline_keyboard() -> InlineKeyboardMarkup {
    InlineKeyboardMarkup::new(vec![
        vec![InlineKeyboardButton::callback(
            "🔢 دریافت کد بازیابی ۶ رقمی (برای اپلیکیشن)",
            "pwd_reset_get_code",
        )],
        vec![InlineKeyboardButton::callback(
            "🔐 تنظیم مستقیم رمز عبور جدید در ربات",
            "pwd_reset_set_direct",
        )],
        vec![InlineKeyboardButton::callback(
            "🚫 لغو کدهای بازیابی فعال",
            "pwd_reset_cancel",
        )],
    ])
}

/// Alert inline keyboard sent with password reset code
pub fn password_reset_alert_keyboard() -> InlineKeyboardMarkup {
    InlineKeyboardMarkup::new(vec![
        vec![InlineKeyboardButton::callback(
            "🚫 من درخواست ندادهام (ابطال فوری کد)",
            "pwd_reset_cancel",
        )],
    ])
}
