use crate::bot::keyboards::{
    support_ticket_inline_keyboard, upgrade_plans_inline_keyboard, user_main_keyboard,
};
use crate::compiler;
use crate::db::{DbPool, Repository};
use teloxide::prelude::*;
use teloxide::types::{InputFile, ParseMode};

pub async fn handle_start(
    bot: &Bot,
    msg: &Message,
    pool: &DbPool,
    admin_chat_id: i64,
) -> anyhow::Result<()> {
    let telegram_user = match msg.from.as_ref() {
        Some(u) => u,
        None => return Ok(()),
    };

    let user = Repository::get_or_create_user(
        pool,
        telegram_user.id.0 as i64,
        telegram_user.username.as_deref(),
        &telegram_user.first_name,
        telegram_user.last_name.as_deref(),
    )
    .await?;

    let sub = Repository::create_or_ensure_lite_subscription(pool, user.id).await?;
    let is_admin_user = admin_chat_id != 0 && (telegram_user.id.0 as i64 == admin_chat_id);

    let mut text = format!(
        r#"👋 درود <b>{}</b> گرامی، به پلتفرم هوشمند ضدسانسور <b>سنترا (Sentra)</b> خوش آمدید!

🛡 <b>مشخصات سرویس فعال شما:</b>
• سطح اشتراک: <code>{}</code>
• سقف حجم ماهیانه: <code>10 گیگابایت</code>
• پروتکل پیش‌فرض: <code>Sing-box v1.10+ (TUN Mode)</code>
• وضعیت شبکه: <b>🟢 پایدار و فعال</b>

⚡ برای اتصال، دکمه <b>«🔑 دریافت کانفیگ و کد اتصال»</b> را بزنید یا جهت استفاده تخصصی از <b>Google Flow و Gemini</b> پلن خود را ارتقا دهید."#,
        user.first_name, sub.tier
    );

    if is_admin_user {
        text.push_str("\n\n👑 <i>دسترسی مدیر کل فعال است. برای ورود به پنل ادمین دستور /admin را ارسال کنید.</i>");
    }

    bot.send_message(msg.chat.id, text)
        .parse_mode(ParseMode::Html)
        .reply_markup(user_main_keyboard())
        .await?;

    Ok(())
}

pub async fn handle_free_account(bot: &Bot, msg: &Message, pool: &DbPool) -> anyhow::Result<()> {
    let telegram_user = match msg.from.as_ref() {
        Some(u) => u,
        None => return Ok(()),
    };

    let user = Repository::get_or_create_user(
        pool,
        telegram_user.id.0 as i64,
        telegram_user.username.as_deref(),
        &telegram_user.first_name,
        telegram_user.last_name.as_deref(),
    )
    .await?;

    let sub = Repository::create_or_ensure_lite_subscription(pool, user.id).await?;
    let code = Repository::generate_auth_code(pool, user.id).await?;

    let remaining_gb = ((sub.traffic_limit_bytes - (sub.upload_bytes + sub.download_bytes)).max(0)) as f64
        / (1024.0 * 1024.0 * 1024.0);

    let text = format!(
        r#"🎁 <b>اشتراک رایگان Sentra Lite شما صادر شد:</b>

• شناسه کاربر: <code>{}</code>
• توکن اتصال: <code>{}</code>
• حجم باقیمانده: <b>{:.2} گیگابایت</b>
• سقف سرعت: <code>10 Mbps</code>
• کد ۸ رقمی اپلیکیشن: <b><code>{}</code></b>
• تاریخ انقضا: <code>{}</code>

💡 <i>کد بالا را داخل نرم‌افزار Sentra Connect وارد کنید تا تانل ایمن فوراً فعال شود.</i>"#,
        user.id,
        sub.token,
        remaining_gb,
        code,
        sub.expires_at.format("%Y-%m-%d %H:%M UTC")
    );

    bot.send_message(msg.chat.id, text)
        .parse_mode(ParseMode::Html)
        .reply_markup(user_main_keyboard())
        .await?;

    Ok(())
}

pub async fn handle_upgrade_prompt(bot: &Bot, msg: &Message) -> anyhow::Result<()> {
    let text = r#"⚡ <b>تعرفه‌ها و پلن‌های ضدسانسور سنترا:</b>

۱. <b>Sentra Lite (رایگان):</b>
• ۱۰ گیگابایت ماهیانه | ۱ دستگاه همزمان | سرعت ۱۰ مگابیت

۲. <b>Sentra Pro (حرفه‌ای):</b>
• ۱۵۰ گیگابایت ماهیانه | ۳ دستگاه همزمان | سرعت ۱۰۰ مگابیت+
• دسترسی به نودهای Shadow و Pulse

۳. <b>Sentra Flow+ (اختصاصی هوش مصنوعی):</b>
• حجم نامحدود (سقف منصفانه ۱ ترابایت) | ۱۰ دستگاه همزمان | سرعت گیگابیتی
• <b>مجهز به IP مسکونی ثابت آمریکا (US Residential IP)</b>
• ۱۰۰٪ تضمین‌شده برای کار بدون خطای ریجن با <b>Google Flow</b>، <b>Gemini</b> و <b>Claude</b>

🧪 <i>جهت تست توسعه در محیط لوکال، روی دکمه شبیه‌ساز پرداخت زیر کلیک کنید:</i>"#;

    bot.send_message(msg.chat.id, text)
        .parse_mode(ParseMode::Html)
        .reply_markup(upgrade_plans_inline_keyboard())
        .await?;

    Ok(())
}

pub async fn handle_payment_simulation(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
) -> anyhow::Result<()> {
    let telegram_id = q.from.id.0 as i64;

    let user = Repository::get_or_create_user(
        pool,
        telegram_id,
        q.from.username.as_deref(),
        &q.from.first_name,
        q.from.last_name.as_deref(),
    )
    .await?;

    let sub = Repository::upgrade_user_subscription(pool, user.id, "Sentra Flow+").await?;

    bot.answer_callback_query(q.id.clone())
        .text("✅ شبیه‌ساز پرداخت موفق! حساب شما به Sentra Flow+ ارتقا یافت.")
        .await?;

    let confirmation_text = format!(
        r#"🎉 <b>تراکنش تستی با موفقیت تایید شد!</b>

👑 <b>اشتراک شما به پلن ویژه {} ارتقا یافت.</b>
• توکن اشتراک: <code>{}</code>
• سقف حجم جدید: <b>۱ ترابایت (نامحدود)</b>
• سقف دستگاه همزمان: <b>۱۰ دستگاه</b>
• آی‌پی اختصاصی: <b>US Residential Static IP (آمریکا)</b>
• تاریخ انقضای جدید: <code>{}</code>

اکنون نرم‌افزار Sentra Connect و لینک‌های سابسکریپشن شما به بالاترین پهنای باند و تمام پروتکل‌ها دسترسی دارند."#,
        sub.tier,
        sub.token,
        sub.expires_at.format("%Y-%m-%d %H:%M UTC")
    );

    if let Some(msg) = &q.message {
        bot.send_message(msg.chat().id, confirmation_text)
            .parse_mode(ParseMode::Html)
            .reply_markup(user_main_keyboard())
            .await?;
    }

    Ok(())
}

pub async fn handle_get_config_and_links(
    bot: &Bot,
    msg: &Message,
    pool: &DbPool,
    base_url: &str,
) -> anyhow::Result<()> {
    let telegram_user = match msg.from.as_ref() {
        Some(u) => u,
        None => return Ok(()),
    };

    let user = Repository::get_or_create_user(
        pool,
        telegram_user.id.0 as i64,
        telegram_user.username.as_deref(),
        &telegram_user.first_name,
        telegram_user.last_name.as_deref(),
    )
    .await?;

    let sub = Repository::create_or_ensure_lite_subscription(pool, user.id).await?;
    let code = Repository::generate_auth_code(pool, user.id).await?;

    let sub_url = format!("{}/api/v1/sub/{}", base_url, sub.token);

    // Output 1 & 2: Text with 8-digit App Login Code and V2Ray subscription URL
    let text = format!(
        r#"🔑 <b>اطلاعات ورود و اتصال ۳ گانه شما:</b>

۱️⃣ <b>کد ۸ رقمی ورود به اپلیکیشن Sentra Connect:</b>
👉 <b><code>{}</code></b> 👈
<i>(کد را داخل برنامه ویندوز یا اندروید وارد کنید تا نرم‌افزار بدون تنظیم دستی متصل شود).</i>

۲️⃣ <b>لینک سابسکریپشن هوشمند V2Ray / Sing-box / Clash:</b>
<code>{}</code>

۳️⃣ <b>فایل پیکربندی OpenVPN (.ovpn):</b>
<i>فایل پروفایل اختصاصی OpenVPN شما پیوست شد 👇</i>"#,
        code, sub_url
    );

    bot.send_message(msg.chat.id, text)
        .parse_mode(ParseMode::Html)
        .reply_markup(user_main_keyboard())
        .await?;

    // Output 3: Generate and send the actual test .ovpn file as document
    let ovpn_content = compiler::generate_ovpn_profile(&sub);
    let ovpn_file = InputFile::memory(ovpn_content.into_bytes())
        .file_name(format!("sentra-{}.ovpn", &sub.token[..8]));

    bot.send_document(msg.chat.id, ovpn_file)
        .caption("🛡 پروفایل OpenVPN سنترا (رمزنگاری AES-256-GCM و tls-crypt)")
        .await?;

    Ok(())
}

pub async fn handle_subscription_status(
    bot: &Bot,
    msg: &Message,
    pool: &DbPool,
) -> anyhow::Result<()> {
    let telegram_user = match msg.from.as_ref() {
        Some(u) => u,
        None => return Ok(()),
    };

    let user = Repository::get_or_create_user(
        pool,
        telegram_user.id.0 as i64,
        telegram_user.username.as_deref(),
        &telegram_user.first_name,
        telegram_user.last_name.as_deref(),
    )
    .await?;

    let sub = Repository::create_or_ensure_lite_subscription(pool, user.id).await?;
    let used_gb = (sub.upload_bytes + sub.download_bytes) as f64 / (1024.0 * 1024.0 * 1024.0);
    let total_gb = sub.traffic_limit_bytes as f64 / (1024.0 * 1024.0 * 1024.0);
    let remaining_gb = (total_gb - used_gb).max(0.0);

    let text = format!(
        r#"📊 <b>گزارش مصرف و وضعیت ترافیک حساب:</b>

• سطح اشتراک: <b>{}</b>
• وضعیت سرویس: <code>{}</code>
• مصرف تا این لحظه: <b>{:.2} GB</b>
• حجم باقیمانده: <b>{:.2} GB</b> از {:.0} GB
• سقف دستگاه‌های همزمان: <b>{} دستگاه</b>
• تاریخ اعتبار: <code>{}</code>

💬 <i>اگر در اتصال یا استفاده از سرویس‌های هوش مصنوعی با مشکلی مواجه شده‌اید، نوع تیکت پشتیبانی را از گزینه‌های زیر انتخاب نمایید:</i>"#,
        sub.tier,
        sub.status,
        used_gb,
        remaining_gb,
        total_gb,
        sub.max_concurrent_devices,
        sub.expires_at.format("%Y-%m-%d %H:%M UTC")
    );

    bot.send_message(msg.chat.id, text)
        .parse_mode(ParseMode::Html)
        .reply_markup(support_ticket_inline_keyboard())
        .await?;

    Ok(())
}

pub async fn handle_ticket_callback(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
    category: &str,
) -> anyhow::Result<()> {
    let telegram_id = q.from.id.0 as i64;
    let user = Repository::get_or_create_user(
        pool,
        telegram_id,
        q.from.username.as_deref(),
        &q.from.first_name,
        q.from.last_name.as_deref(),
    )
    .await?;

    let (cat_title, desc) = match category {
        "speed" => ("افت سرعت", "کاربر گزارش افت سرعت یا کندی دانلود ثبت کرد."),
        "disconnect" => ("قطعی اتصال", "کاربر گزارش قطع مکرر ارتباط تانل ثبت کرد."),
        "ai" => ("هوش مصنوعی", "کاربر درخواست راهنمایی رفع خطای ریجن Google Flow / Gemini ثبت کرد."),
        _ => ("عمومی", "پیام پشتیبانی عمومی از ربات تلگرام."),
    };

    let ticket_num = Repository::create_support_ticket(
        pool,
        user.id,
        category,
        cat_title,
        desc,
    )
    .await?;

    bot.answer_callback_query(q.id.clone())
        .text("✅ تیکت پشتیبانی شما با موفقیت ثبت شد.")
        .await?;

    let reply = format!(
        r#"📨 <b>تیکت پشتیبانی شما ثبت گردید:</b>

• شماره تیکت: <code>{}</code>
• موضوع: <b>{}</b>
• وضعیت: <b>در صف رسیدگی کارشناس کشیک</b>

پاسخ کارشناسان سنترا مستقیماً از طریق همین ربات برای شما ارسال خواهد شد."#,
        ticket_num, cat_title
    );

    if let Some(msg) = &q.message {
        bot.send_message(msg.chat().id, reply)
            .parse_mode(ParseMode::Html)
            .reply_markup(user_main_keyboard())
            .await?;
    }

    Ok(())
}
