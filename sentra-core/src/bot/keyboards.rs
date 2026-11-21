use crate::models::{Outbound, UserDevice};
use teloxide::types::{
    InlineKeyboardButton, InlineKeyboardMarkup, KeyboardButton, KeyboardMarkup,
};

/// Main persistent reply keyboard for users (with optional Admin panel button)
pub fn user_main_keyboard_with_admin(is_admin: bool) -> KeyboardMarkup {
    let mut rows = vec![
        vec![
            KeyboardButton::new("🎁 دریافت اشتراک رایگان (Sentra Lite)"),
            KeyboardButton::new("⚡ ارتقا به پلن ویژه (Sentra Pro / Flow+)"),
        ],
        vec![
            KeyboardButton::new("📥 دانلود اپلیکیشن Sentra Connect"),
        ],
        vec![
            KeyboardButton::new("🔑 دریافت کانفیگ و کد اتصال"),
            KeyboardButton::new("🍏 دریافت اشتراک iOS (OpenVPN)"),
        ],
        vec![
            KeyboardButton::new("🤝 اهدای اوتباند (حمایت از Sentra)"),
            KeyboardButton::new("🔗 اتصال حساب اپلیکیشن"),
        ],
        vec![
            KeyboardButton::new("💖 حمایت مالی از توسعه Sentra"),
            KeyboardButton::new("📊 وضعیت اشتراک و تیکت پشتیبانی"),
        ],
    ];

    if is_admin {
        rows.push(vec![KeyboardButton::new("🛠 پنل مدیریت")]);
    }

    KeyboardMarkup::new(rows).resize_keyboard()
}

/// Main persistent reply keyboard for normal users
pub fn user_main_keyboard() -> KeyboardMarkup {
    user_main_keyboard_with_admin(false)
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
            InlineKeyboardButton::callback("➕ افزودن اوتباند جدید (رسمی)", "adm_ob_add_start"),
        ],
        vec![
            InlineKeyboardButton::callback("🌐 لیست نودهای وب‌گردی", "adm_ob_list_web_browsing"),
            InlineKeyboardButton::callback("📥 لیست نودهای دانلود", "adm_ob_list_download"),
        ],
        vec![
            InlineKeyboardButton::callback("🔒 لیست نودهای آی‌پی ثابت", "adm_ob_list_static_ip"),
        ],
        vec![
            InlineKeyboardButton::callback("🔙 بازگشت به داشبورد ادمین", "adm_back_main"),
        ],
    ])
}

/// Inline keyboard for selecting target category for new official outbound
pub fn admin_select_outbound_target_keyboard() -> InlineKeyboardMarkup {
    InlineKeyboardMarkup::new(vec![
        vec![
            InlineKeyboardButton::callback("🌐 ۱. وب‌گردی (Web Browsing)", "adm_ob_target_web_browsing"),
        ],
        vec![
            InlineKeyboardButton::callback("📥 ۲. دانلود (Download)", "adm_ob_target_download"),
        ],
        vec![
            InlineKeyboardButton::callback("🔒 ۳. آی‌پی ثابت (Static IP - ترید و جمنای)", "adm_ob_target_static_ip"),
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
            InlineKeyboardButton::callback("🔄 تست مجدد پینگ", format!("adm_ob_ping_{}", outbound_id)),
            InlineKeyboardButton::callback(toggle_label, format!("adm_ob_toggle_{}", outbound_id)),
        ],
        vec![
            InlineKeyboardButton::callback("🗑 حذف نود", format!("adm_ob_del_{}", outbound_id)),
            InlineKeyboardButton::callback("🔙 بازگشت به لیست", format!("adm_ob_list_{}", category)),
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
            "🍏 راهنمای اتصال آیفون (iOS - OpenVPN)",
            "dl_app_ios",
        )],
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
