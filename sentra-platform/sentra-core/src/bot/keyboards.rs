use crate::models::Outbound;
use teloxide::types::{
    InlineKeyboardButton, InlineKeyboardMarkup, KeyboardButton, KeyboardMarkup,
};

/// Main persistent reply keyboard for normal users
pub fn user_main_keyboard() -> KeyboardMarkup {
    KeyboardMarkup::new(vec![
        vec![
            KeyboardButton::new("🎁 دریافت اشتراک رایگان (Sentra Lite)"),
            KeyboardButton::new("⚡ ارتقا به پلن ویژه (Sentra Pro / Flow+)"),
        ],
        vec![
            KeyboardButton::new("🔑 دریافت کانفیگ و کد اتصال"),
            KeyboardButton::new("📊 وضعیت اشتراک و تیکت پشتیبانی"),
        ],
    ])
    .resize_keyboard()
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

/// Hidden Admin Menu persistent reply keyboard
pub fn admin_main_keyboard() -> KeyboardMarkup {
    KeyboardMarkup::new(vec![
        vec![
            KeyboardButton::new("📊 آمار و تفکیک کاربران"),
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
