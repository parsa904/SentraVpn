use crate::models::{Outbound, UserDevice};
use teloxide::types::{
    InlineKeyboardButton, InlineKeyboardMarkup, KeyboardButton, KeyboardMarkup,
};

/// Main persistent reply keyboard for users:
/// - Unregistered first-time users see a large full-width "📝 ثبت نام" button as the very first option.
/// - Registered users see a large full-width "👤 حساب کاربری" button in that spot.
pub fn user_main_keyboard_for_user(is_registered: bool, is_admin: bool) -> KeyboardMarkup {
    let primary_top_button = if is_registered {
        KeyboardButton::new("👤 حساب کاربری")
    } else {
        KeyboardButton::new("📝 ثبت نام")
    };

    let mut rows = vec![
        vec![primary_top_button],
        vec![
            KeyboardButton::new("📥 دانلود اپلیکیشن Sentra Connect"),
        ],
        vec![
            KeyboardButton::new("⚡ ارتقا به پلن ویژه (Sentra Pro / Flow+)"),
            KeyboardButton::new("🔑 دریافت کانفیگ و کد اتصال"),
        ],
        vec![
            KeyboardButton::new("🍏 دریافت اشتراک iOS"),
            KeyboardButton::new("🤝 اهدای اوتباند (حمایت از Sentra)"),
        ],
        vec![
            KeyboardButton::new("🔗 اتصال حساب اپلیکیشن"),
            KeyboardButton::new("💖 حمایت مالی از توسعه Sentra"),
        ],
        vec![
            KeyboardButton::new("📊 وضعیت اشتراک و تیکت پشتیبانی"),
        ],
    ];

    if is_admin {
        rows.push(vec![KeyboardButton::new("🛠 پنل مدیریت")]);
    }

    KeyboardMarkup::new(rows).resize_keyboard()
}

/// Main persistent reply keyboard for registered users (with optional Admin panel button)
pub fn user_main_keyboard_with_admin(is_admin: bool) -> KeyboardMarkup {
    user_main_keyboard_for_user(true, is_admin)
}

/// Main persistent reply keyboard for normal registered users
pub fn user_main_keyboard() -> KeyboardMarkup {
    user_main_keyboard_for_user(true, false)
}

/// Inline keyboard shown when an unregistered user taps "📝 ثبت نام"
pub fn auth_choice_inline_keyboard() -> InlineKeyboardMarkup {
    InlineKeyboardMarkup::new(vec![
        vec![
            InlineKeyboardButton::callback("🆕 ثبت نام", "auth_register_new"),
            InlineKeyboardButton::callback("🔐 ورود با حساب برنامه", "auth_login_app"),
        ],
        vec![InlineKeyboardButton::callback("🔙 بازگشت", "user_back_main")],
    ])
}

/// Inline keyboard shown after a failed credential login attempt
pub fn auth_retry_inline_keyboard() -> InlineKeyboardMarkup {
    InlineKeyboardMarkup::new(vec![
        vec![
            InlineKeyboardButton::callback("🔄 تلاش مجدد ورود", "auth_login_app"),
            InlineKeyboardButton::callback("🆕 ثبت نام جدید", "auth_register_new"),
        ],
        vec![InlineKeyboardButton::callback("🔙 بازگشت", "user_back_main")],
    ])
}

/// Inline keyboard for the "👤 حساب کاربری" profile/usage card
pub fn user_account_inline_keyboard(devices_count: usize) -> InlineKeyboardMarkup {
    InlineKeyboardMarkup::new(vec![
        vec![InlineKeyboardButton::callback(
            format!("📱 مدیریت دستگاه‌های متصل ({}/3)", devices_count),
            "manage_devices",
        )],
        vec![
            InlineKeyboardButton::callback("🔑 کد ورود اپلیکیشن", "account_get_app_code"),
            InlineKeyboardButton::callback("⚡ ارتقا اشتراک", "account_upgrade_menu"),
        ],
        vec![InlineKeyboardButton::callback("🔙 بازگشت", "user_back_main")],
    ])
}

/// Reusable inline Back button returning to the user's main menu and clearing active states
pub fn back_to_main_inline_keyboard() -> InlineKeyboardMarkup {
    InlineKeyboardMarkup::new(vec![vec![InlineKeyboardButton::callback(
        "🔙 بازگشت",
        "user_back_main",
    )]])
}

/// Reusable inline Back button returning to the Admin dashboard and clearing active admin states
pub fn back_to_admin_inline_keyboard() -> InlineKeyboardMarkup {
    InlineKeyboardMarkup::new(vec![vec![InlineKeyboardButton::callback(
        "🔙 بازگشت",
        "adm_back_main",
    )]])
}

/// Reusable inline Cancel & Back button targeting a specific callback step
pub fn cancel_and_back_inline_keyboard(callback_data: &str) -> InlineKeyboardMarkup {
    InlineKeyboardMarkup::new(vec![vec![InlineKeyboardButton::callback(
        "🔙 بازگشت",
        callback_data.to_string(),
    )]])
}

/// Smart entitlement-aware inline keyboard for iOS config selection:
/// - Free / Lite users see the free configs (Web Browsing + Download).
/// - When Gaming is NOT yet activated in DB (gaming_enabled == false), a visible
///   "🎮 گیمینگ کم‌پینگ (به‌زودی)" button is shown; clicking it displays a Coming Soon alert.
/// - Once an admin adds an active Gaming outbound (gaming_enabled == true), Gaming
///   activates ecosystem-wide and unlocks WireGuard (.conf) for Gaming / Pro / Flow+ users.
/// - Users who purchased Static IP (or Pro/Flow+) automatically unlock Static IP configs.
pub fn ios_modes_inline_keyboard(tier: &str, gaming_enabled: bool) -> InlineKeyboardMarkup {
    let has_static = crate::compiler::tier_has_static_ip(tier);
    let has_gaming = crate::compiler::tier_has_gaming(tier);

    let mut rows = vec![
        vec![InlineKeyboardButton::callback(
            "🌐 وب‌گردی روزمره (رایگان)",
            "ios_mode_web_browsing",
        )],
        vec![InlineKeyboardButton::callback(
            "⚡ دانلود پرسرعت (رایگان)",
            "ios_mode_download",
        )],
    ];

    if !gaming_enabled {
        rows.push(vec![InlineKeyboardButton::callback(
            "🎮 گیمینگ کم‌پینگ (به‌زودی)",
            "ios_mode_gaming",
        )]);
    } else if has_gaming {
        rows.push(vec![InlineKeyboardButton::callback(
            "🎮 گیمینگ کم‌پینگ (پروتکل WireGuard)",
            "ios_mode_gaming",
        )]);
    }

    if has_static {
        rows.push(vec![InlineKeyboardButton::callback(
            "💎 آی‌پی ثابت اختصاصی (ترید و جمنای)",
            "ios_mode_static_ip",
        )]);
    }

    if !has_static || (gaming_enabled && !has_gaming) {
        let upgrade_label = if gaming_enabled {
            "⚡ خرید / ارتقا به گیمینگ یا آی‌پی ثابت"
        } else {
            "⚡ خرید / ارتقا به آی‌پی ثابت یا پلن ویژه"
        };
        rows.push(vec![InlineKeyboardButton::callback(
            upgrade_label,
            "account_upgrade_menu",
        )]);
    }

    rows.push(vec![InlineKeyboardButton::callback(
        "🔙 بازگشت",
        "user_back_main",
    )]);

    InlineKeyboardMarkup::new(rows)
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
pub fn upgrade_plans_inline_keyboard() -> InlineKeyboardMarkup {
    InlineKeyboardMarkup::new(vec![
        vec![InlineKeyboardButton::callback(
            "💳 شبیه‌سازی پرداخت موفق (تست توسعه) - ارتقا آنی به Flow+",
            "sim_pay_success",
        )],
        vec![
            InlineKeyboardButton::callback("🎮 پلن گیمینگ (WireGuard iOS + پینگ کم)", "plan_info_gaming"),
            InlineKeyboardButton::callback("💎 پلن آی‌پی ثابت (ترید و جمنای)", "plan_info_static"),
        ],
        vec![
            InlineKeyboardButton::callback("⚡ پلن Pro (گیمینگ + آی‌پی ثابت)", "plan_info_pro"),
            InlineKeyboardButton::callback("🚀 پلن Flow+ (کامل + IP مسکونی)", "plan_info_flow"),
        ],
        vec![InlineKeyboardButton::callback("🔙 بازگشت", "user_back_main")],
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
            InlineKeyboardButton::callback("➕ افزودن اوتباند جدید (رسمی)", "adm_ob_add_start"),
        ],
        vec![
            InlineKeyboardButton::callback("⚡️ تولید و شارژ خودکار اکانت WARP", "adm_warp_generate"),
        ],
        vec![
            InlineKeyboardButton::callback("🌐 لیست نودهای وب‌گردی", "adm_ob_list_web_browsing"),
            InlineKeyboardButton::callback("📥 لیست نودهای دانلود", "adm_ob_list_download"),
        ],
        vec![
            InlineKeyboardButton::callback("🎮 لیست نودهای گیمینگ", "adm_ob_list_gaming"),
            InlineKeyboardButton::callback("🔒 لیست نودهای آی‌پی ثابت", "adm_ob_list_static_ip"),
        ],
        vec![
            InlineKeyboardButton::callback("🔙 بازگشت به داشبورد ادمین", "adm_back_main"),
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
            InlineKeyboardButton::callback("🎮 فقط بخش گیمینگ (فعال‌سازی گیمینگ در کل سیستم)", "adm_ob_alloc_gaming_only"),
        ],
        vec![
            InlineKeyboardButton::callback("💎 فقط بخش آی‌پی ثابت (ترید و جمنای)", "adm_ob_alloc_static_only"),
        ],
        vec![
            InlineKeyboardButton::callback("⚡️ بخش رایگان + آی‌پی ثابت همزمان", "adm_ob_alloc_both"),
        ],
        vec![
            InlineKeyboardButton::callback("🔥 کل اکوسیستم (رایگان + آی‌پی ثابت + گیمینگ)", "adm_ob_alloc_all"),
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
            InlineKeyboardButton::callback("🎮 فقط بخش گیمینگ (فعال‌سازی گیمینگ)", format!("adm_set_alloc_{}_gaming_only", outbound_id)),
        ],
        vec![
            InlineKeyboardButton::callback("💎 فقط بخش آی‌پی ثابت (ترید و جمنای)", format!("adm_set_alloc_{}_static_only", outbound_id)),
        ],
        vec![
            InlineKeyboardButton::callback("⚡️ بخش رایگان + آی‌پی ثابت", format!("adm_set_alloc_{}_both", outbound_id)),
        ],
        vec![
            InlineKeyboardButton::callback("🔥 کل اکوسیستم (رایگان + آی‌پی ثابت + گیمینگ)", format!("adm_set_alloc_{}_all", outbound_id)),
        ],
        vec![
            InlineKeyboardButton::callback("🤖 تشخیص هوشمند خودکار", format!("adm_set_alloc_{}_auto", outbound_id)),
        ],
        vec![
            InlineKeyboardButton::callback("🔙 انصراف", "adm_action_official_outbounds"),
        ],
    ])
}

/// Inline keyboard for selecting target platform for new app release in Admin panel
pub fn admin_app_release_inline_keyboard() -> InlineKeyboardMarkup {
    InlineKeyboardMarkup::new(vec![
        vec![
            InlineKeyboardButton::callback("🪟 آپلود نسخه ویندوز (.exe)", "adm_upload_windows"),
        ],
        vec![
            InlineKeyboardButton::callback("🤖 آپلود نسخه اندروید (.apk)", "adm_upload_android"),
        ],
        vec![
            InlineKeyboardButton::callback("🔙 بازگشت به داشبورد", "adm_back_main"),
        ],
    ])
}

/// Inline keyboard for downloading the Sentra Connect client apps
pub fn download_app_inline_keyboard() -> InlineKeyboardMarkup {
    InlineKeyboardMarkup::new(vec![
        vec![InlineKeyboardButton::callback(
            "🪟 دانلود نسخه ویندوز (Windows 10/11)",
            "dl_app_windows",
        )],
        vec![InlineKeyboardButton::callback(
            "🤖 دانلود نسخه اندروید (Android)",
            "dl_app_android",
        )],
        vec![InlineKeyboardButton::callback(
            "🍏 دریافت کانفیگ آیفون (iOS - OpenVPN / WireGuard)",
            "dl_app_ios",
        )],
        vec![InlineKeyboardButton::callback("🔙 بازگشت", "user_back_main")],
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
            InlineKeyboardButton::callback("🎮 ارتقا به Gaming (۳۰ روزه)", format!("adm_up_gaming_{}", user_id)),
            InlineKeyboardButton::callback("💎 ارتقا به Static IP (۳۰ روزه)", format!("adm_up_static_{}", user_id)),
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
            InlineKeyboardButton::callback("✅ تایید ۳۰ روزه Pro", format!("rcpt_approve_pro_{}", user_id)),
            InlineKeyboardButton::callback("✅ تایید ۳۰ روزه Flow+", format!("rcpt_approve_flow_{}", user_id)),
        ],
        vec![
            InlineKeyboardButton::callback("🎮 تایید ۳۰ روزه Gaming", format!("rcpt_approve_gaming_{}", user_id)),
            InlineKeyboardButton::callback("💎 تایید ۳۰ روزه Static IP", format!("rcpt_approve_static_{}", user_id)),
        ],
        vec![
            InlineKeyboardButton::callback("❌ رد رسید پرداخت", format!("rcpt_reject_{}", user_id)),
        ],
        vec![
            InlineKeyboardButton::callback("🔙 بازگشت", "adm_back_main"),
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
        vec![
            InlineKeyboardButton::callback("🔙 بازگشت", "adm_back_main"),
        ],
    ])
}

/// Hidden Admin Menu persistent reply keyboard
#[allow(dead_code)]
pub fn admin_main_keyboard() -> KeyboardMarkup {
    KeyboardMarkup::new(vec![
        vec![
            KeyboardButton::new("📊 آمار و تفکیک کاربران"),
            KeyboardButton::new("🌐 مدیریت اوتباندها و نودها"),
        ],
        vec![
            KeyboardButton::new("📤 آپلود / بروزرسانی اپلیکیشن"),
            KeyboardButton::new("🔄 وضعیت نودهای خروجی شبکه"),
        ],
        vec![
            KeyboardButton::new("🩺 تست سلامت ۶ لایه سیستم"),
            KeyboardButton::new("👤 بازگشت به منوی کاربری"),
        ],
    ])
    .resize_keyboard()
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
    rows.push(vec![InlineKeyboardButton::callback("🔙 بازگشت", "adm_back_main")]);
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
        vec![InlineKeyboardButton::callback("🔙 بازگشت", "user_back_main")],
    ])
}

/// Admin manual user tier upgrade keyboard
#[allow(dead_code)]
pub fn admin_tier_change_inline_keyboard(target_user_id: i64) -> InlineKeyboardMarkup {
    InlineKeyboardMarkup::new(vec![
        vec![
            InlineKeyboardButton::callback("Lite", format!("set_tier_{}_lite", target_user_id)),
            InlineKeyboardButton::callback("Gaming", format!("set_tier_{}_gaming", target_user_id)),
            InlineKeyboardButton::callback("Static IP", format!("set_tier_{}_static", target_user_id)),
        ],
        vec![
            InlineKeyboardButton::callback("Pro", format!("set_tier_{}_pro", target_user_id)),
            InlineKeyboardButton::callback("Flow+", format!("set_tier_{}_flow", target_user_id)),
        ],
        vec![InlineKeyboardButton::callback("🔙 بازگشت", "adm_back_main")],
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
    rows.push(vec![InlineKeyboardButton::callback(
        "🔙 بازگشت به منوی اصلی",
        "user_back_main",
    )]);

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
        vec![InlineKeyboardButton::callback("🔙 بازگشت", "user_back_main")],
    ])
}

/// Inline keyboard sent to Admin Telegram when a user donates an outbound from the app
pub fn donated_outbound_review_keyboard(outbound_id: i64) -> InlineKeyboardMarkup {
    InlineKeyboardMarkup::new(vec![
        vec![
            InlineKeyboardButton::callback(
                "✅ تایید + ۷ روز اشتراک",
                format!("ob_donate_ok_{}_7", outbound_id),
            ),
            InlineKeyboardButton::callback(
                "✅ تایید + ۱۵ روز اشتراک",
                format!("ob_donate_ok_{}_15", outbound_id),
            ),
        ],
        vec![InlineKeyboardButton::callback(
            "✅ تایید + ۳۰ روز اشتراک",
            format!("ob_donate_ok_{}_30", outbound_id),
        )],
        vec![InlineKeyboardButton::callback(
            "❌ رد کردن",
            format!("ob_donate_rej_{}", outbound_id),
        )],
        vec![InlineKeyboardButton::callback(
            "🔙 بازگشت",
            "adm_back_main",
        )],
    ])
}
