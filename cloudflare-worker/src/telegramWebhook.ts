import {
  auditOutboundSecurity,
  parseOutboundInput,
  parseSubscriptionPayload,
} from './outboundAnalyzer.ts';
import {
  constantTimeEquals,
  generateNumericCode,
  generateSubscriptionToken,
  validateExternalHttpsUrl,
  verifyPassword,
} from './security.ts';
import {
  generateWireguardGamingProfile,
  tierHasGaming,
  tierHasStaticIp,
} from './singboxCompiler.ts';
import type { Env, SubscriptionRow, UserRow } from './types.ts';

interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: { id: number; type: string };
  text?: string;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface BotStateRow {
  telegram_id: number;
  state_type: string;
  payload_json: string;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatGb(bytes: number): string {
  return (Math.max(0, bytes) / (1024 * 1024 * 1024)).toFixed(2);
}

async function tgApi(
  env: Env,
  method: string,
  payload: Record<string, unknown>
): Promise<void> {
  if (!env.TELOXIDE_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${env.TELOXIDE_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function tgSendMessage(
  env: Env,
  chatId: number,
  text: string,
  replyMarkup?: Record<string, unknown>
): Promise<void> {
  await tgApi(env, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

async function tgSendTextDocument(
  env: Env,
  chatId: number,
  filename: string,
  content: string,
  caption: string
): Promise<void> {
  if (!env.TELOXIDE_TOKEN) return;
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', caption);
  form.append('parse_mode', 'HTML');
  form.append('document', new Blob([content], { type: 'text/plain; charset=utf-8' }), filename);
  await fetch(`https://api.telegram.org/bot${env.TELOXIDE_TOKEN}/sendDocument`, {
    method: 'POST',
    body: form,
  });
}

function buildMainKeyboard(isRegistered: boolean, isAdmin: boolean): Record<string, unknown> {
  const firstRow = isRegistered
    ? [{ text: '👤 حساب کاربری' }]
    : [{ text: '📝 ثبت‌نام / ورود' }];

  const rows: Array<Array<{ text: string }>> = [
    firstRow,
    [{ text: '🔑 دریافت کانفیگ و کد اتصال' }, { text: '🍏 دریافت کانفیگ iOS' }],
    [{ text: '🤝 اهدای اوتباند (حمایت از Sentra)' }, { text: '📥 دانلود اپلیکیشن Sentra Connect' }],
  ];
  if (isAdmin) {
    rows.push([{ text: '🛡 پنل مدیریت اوتباندها' }]);
  }
  return {
    keyboard: rows,
    resize_keyboard: true,
  };
}

async function hasActiveGamingOutbounds(db: D1Database): Promise<boolean> {
  const donated = await db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM donated_outbounds
       WHERE status = 'active' AND (allow_gaming = 1 OR assigned_tier = 'gaming')`
    )
    .first<{ cnt: number }>();
  if ((donated?.cnt || 0) > 0) return true;

  const core = await db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM outbounds
       WHERE is_active = 1 AND server_address != '127.0.0.1' AND mode_category = 'gaming'`
    )
    .first<{ cnt: number }>();
  return (core?.cnt || 0) > 0;
}

async function getUserAndSubByTelegramId(
  db: D1Database,
  telegramId: number
): Promise<{ user: UserRow; sub: SubscriptionRow | null } | null> {
  const user = await db
    .prepare('SELECT * FROM users WHERE telegram_id = ? LIMIT 1')
    .bind(telegramId)
    .first<UserRow>();
  if (!user) return null;

  const sub = await db
    .prepare('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 1')
    .bind(user.id)
    .first<SubscriptionRow>();
  return { user, sub: sub || null };
}

async function setBotState(
  db: D1Database,
  telegramId: number,
  stateType: string,
  payload: Record<string, unknown> = {}
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO telegram_states (telegram_id, state_type, payload_json, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(telegram_id) DO UPDATE SET
         state_type = excluded.state_type,
         payload_json = excluded.payload_json,
         updated_at = CURRENT_TIMESTAMP`
    )
    .bind(telegramId, stateType, JSON.stringify(payload))
    .run();
}

async function getBotState(db: D1Database, telegramId: number): Promise<BotStateRow | null> {
  return (
    (await db
      .prepare('SELECT * FROM telegram_states WHERE telegram_id = ? LIMIT 1')
      .bind(telegramId)
      .first<BotStateRow>()) || null
  );
}

async function clearBotState(db: D1Database, telegramId: number): Promise<void> {
  await db.prepare('DELETE FROM telegram_states WHERE telegram_id = ?').bind(telegramId).run();
}

async function insertOfficialOutboundD1(
  db: D1Database,
  parsed: Awaited<ReturnType<typeof parseOutboundInput>>,
  allocationMode: string
): Promise<{ inserted: boolean; duplicate: boolean }> {
  const existing = await db
    .prepare('SELECT id FROM donated_outbounds WHERE fingerprint_sha256 = ? LIMIT 1')
    .bind(parsed.fingerprint_sha256)
    .first<{ id: number }>();
  if (existing) {
    return { inserted: false, duplicate: true };
  }

  const allowWeb = ['free_only', 'both', 'all', 'auto'].includes(allocationMode) ? 1 : 0;
  const allowDownload = ['free_only', 'both', 'all', 'auto'].includes(allocationMode) ? 1 : 0;
  const allowGaming = ['gaming_only', 'all'].includes(allocationMode) ? 1 : 0;
  const allowStatic = ['static_only', 'both', 'all'].includes(allocationMode) ? 1 : 0;
  const assignedTier =
    allocationMode === 'gaming_only'
      ? 'gaming'
      : allocationMode === 'static_only'
      ? 'static_ip'
      : 'web_browsing';

  await db
    .prepare(
      `INSERT INTO donated_outbounds (
         donor_user_id, tag, protocol, server_address, server_port, config_json,
         latency_ms, speed_mbps, assigned_tier, health_score, status, fail_count,
         raw_link, fingerprint_sha256, is_official, label, country_code, country_name,
         allow_web, allow_download, allow_gaming, allow_static_ip, allocation_mode,
         last_online_at, last_checked_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    )
    .bind(
      null,
      parsed.tag,
      parsed.protocol,
      parsed.server_address,
      parsed.server_port,
      JSON.stringify(parsed.config_json),
      80,
      15.0,
      assignedTier,
      100,
      parsed.raw_link,
      parsed.fingerprint_sha256,
      parsed.tag,
      parsed.country_code,
      parsed.country_name,
      allowWeb,
      allowDownload,
      allowGaming,
      allowStatic,
      allocationMode
    )
    .run();

  return { inserted: true, duplicate: false };
}

async function handleAdminOutboundSubmission(
  env: Env,
  chatId: number,
  text: string,
  allocationMode: string
): Promise<void> {
  const trimmed = text.trim();

  // Subscription URL support (force-imports all parseable nodes regardless of ping)
  if (/^https?:\/\//i.test(trimmed)) {
    let validUrl: URL;
    try {
      validUrl = validateExternalHttpsUrl(trimmed);
    } catch (err) {
      await tgSendMessage(
        env,
        chatId,
        `❌ ${escapeHtml(err instanceof Error ? err.message : 'آدرس سابسکریپشن نامعتبر است.')}`
      );
      return;
    }

    const resp = await fetch(validUrl.toString(), {
      headers: { 'User-Agent': 'SentraCore/2.0 (Cloudflare-Worker)' },
    });
    if (!resp.ok) {
      await tgSendMessage(env, chatId, `❌ خطا در دریافت سابسکریپشن (کد HTTP ${resp.status}).`);
      return;
    }

    const body = await resp.text();
    const { nodes, skipped } = await parseSubscriptionPayload(body);
    if (nodes.length === 0) {
      await tgSendMessage(env, chatId, '❌ هیچ نود معتبری در این لینک سابسکریپشن یافت نشد.');
      return;
    }

    let added = 0;
    let duplicates = 0;
    for (const node of nodes.slice(0, 100)) {
      const res = await insertOfficialOutboundD1(env.DB, node, allocationMode);
      if (res.inserted) added += 1;
      else if (res.duplicate) duplicates += 1;
    }

    const category =
      allocationMode === 'gaming_only'
        ? 'gaming'
        : allocationMode === 'static_only'
        ? 'static_ip'
        : 'web_browsing';

    await env.DB.prepare(
      `INSERT INTO subscription_sources (category, sub_url, tag, total_nodes, healthy_nodes, last_sync_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
    )
      .bind(category, validUrl.toString(), `Sub (${allocationMode})`, nodes.length, added)
      .run();

    const gamingNote =
      allocationMode === 'gaming_only' || allocationMode === 'all'
        ? '\n\n🎮 <b>بخش گیمینگ به صورت خودکار در کل اکوسیستم فعال شد!</b>'
        : '';

    await tgSendMessage(
      env,
      chatId,
      `✅ <b>سابسکریپشن با موفقیت پردازش و ثبت شد</b>\n\n` +
        `🔹 نودهای اضافه شده: <b>${added}</b>\n` +
        `♻️ نودهای تکراری (SHA-256): <b>${duplicates}</b>\n` +
        `⚠️ خطوط نامعتبر: <b>${skipped}</b>\n` +
        `🎯 تخصیص: <code>${escapeHtml(allocationMode)}</code>${gamingNote}`
    );
    return;
  }

  // Single proxy URI or raw Sing-box JSON
  let parsed: Awaited<ReturnType<typeof parseOutboundInput>>;
  try {
    parsed = await parseOutboundInput(trimmed);
  } catch (err) {
    await tgSendMessage(
      env,
      chatId,
      `❌ ${escapeHtml(err instanceof Error ? err.message : 'لینک نامعتبر است.')}`
    );
    return;
  }

  const audit = auditOutboundSecurity(parsed.protocol, parsed.config_json);
  if (!audit.passed) {
    await tgSendMessage(
      env,
      chatId,
      `🚫 <b>رد امنیتی اوتباند:</b> ${escapeHtml(audit.reason || 'پروتکل ناامن')}`
    );
    return;
  }

  const res = await insertOfficialOutboundD1(env.DB, parsed, allocationMode);
  if (res.duplicate) {
    await tgSendMessage(
      env,
      chatId,
      '⚠️ این نود با اثرانگشت SHA-256 یکسان قبلاً در دیتابیس ثبت شده است.'
    );
    return;
  }

  const gamingNote =
    allocationMode === 'gaming_only' || allocationMode === 'all'
      ? '\n\n🎮 <b>بخش گیمینگ در کل اکوسیستم (ربات و اپلیکیشن‌ها) فعال شد!</b>'
      : '';

  await tgSendMessage(
    env,
    chatId,
    `✅ <b>اوتباند رسمی با موفقیت اضافه شد</b>\n\n` +
      `🏷 برچسب: <b>${escapeHtml(parsed.tag)}</b>\n` +
      `📡 پروتکل: <code>${escapeHtml(parsed.protocol)}</code>\n` +
      `🌍 کشور: ${escapeHtml(parsed.country_name)}\n` +
      `🔐 اثرانگشت: <code>${parsed.fingerprint_sha256.slice(0, 16)}...</code>\n` +
      `🎯 تخصیص: <code>${escapeHtml(allocationMode)}</code>${gamingNote}`
  );
}

async function handleCallbackQuery(env: Env, q: TelegramCallbackQuery): Promise<void> {
  const chatId = q.message?.chat.id || q.from.id;
  const telegramId = q.from.id;
  const isAdmin = Boolean(env.ADMIN_CHAT_ID && String(telegramId) === String(env.ADMIN_CHAT_ID).trim());
  const data = q.data || '';

  await tgApi(env, 'answerCallbackQuery', { callback_query_id: q.id });

  if (data === 'auth_register_new') {
    const existing = await getUserAndSubByTelegramId(env.DB, telegramId);
    if (existing) {
      await tgSendMessage(
        env,
        chatId,
        `✅ حساب شما از قبل فعال است.\n🆔 شناسه یکتا: <code>${escapeHtml(existing.user.user_uuid)}</code>`,
        buildMainKeyboard(true, isAdmin)
      );
      return;
    }

    const userUuid = crypto.randomUUID();
    const token = generateSubscriptionToken();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const inserted = await env.DB.prepare(
      `INSERT INTO users (user_uuid, telegram_id, username, first_name, last_name, role, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`
    )
      .bind(
        userUuid,
        telegramId,
        q.from.username || null,
        q.from.first_name || 'کاربر سنترا',
        q.from.last_name || null,
        isAdmin ? 'admin' : 'user'
      )
      .run();

    const userId = inserted.meta.last_row_id;
    await env.DB.prepare(
      `INSERT INTO subscriptions (user_id, tier, token, status, traffic_limit_bytes, max_concurrent_devices, expires_at)
       VALUES (?, 'Sentra Lite', ?, 'active', ?, 3, ?)`
    )
      .bind(userId, token, 10 * 1024 * 1024 * 1024, expiresAt)
      .run();

    await tgSendMessage(
      env,
      chatId,
      `🎉 <b>ثبت‌نام شما با موفقیت انجام شد!</b>\n\n` +
        `🆔 <b>کد شناسایی یکتا:</b> <code>${escapeHtml(userUuid)}</code>\n` +
        `💎 <b>پلن فعال:</b> Sentra Lite (۱۰ گیگابایت)\n\n` +
        `از این پس می‌توانید وضعیت اشتراک و حجم مصرفی خود را از دکمه «👤 حساب کاربری» مشاهده کنید.`,
      buildMainKeyboard(true, isAdmin)
    );
    return;
  }

  if (data === 'auth_login_app') {
    await setBotState(env.DB, telegramId, 'awaiting_login_username');
    await tgSendMessage(
      env,
      chatId,
      '🔐 <b>ورود با حساب اپلیکیشن Sentra</b>\n\nلطفاً <b>نام کاربری (Username)</b> حساب خود در اپلیکیشن را ارسال کنید:'
    );
    return;
  }

  if (data.startsWith('ios_mode_')) {
    const mode = data.slice('ios_mode_'.length);
    const record = await getUserAndSubByTelegramId(env.DB, telegramId);
    if (!record || !record.sub) {
      await tgSendMessage(env, chatId, '❌ لطفاً ابتدا از منوی اصلی ثبت‌نام یا ورود انجام دهید.');
      return;
    }

    if (mode === 'gaming') {
      const gamingLive = await hasActiveGamingOutbounds(env.DB);
      if (!gamingLive) {
        await tgSendMessage(
          env,
          chatId,
          '🎮 <b>بخش گیمینگ به‌زودی راه‌اندازی می‌شود!</b>\n\nبه‌محض افزودن سرور اختصاصی گیمینگ، کانفیگ WireGuard کم‌تاخیر iOS به صورت خودکار فعال خواهد شد.'
        );
        return;
      }
      if (!tierHasGaming(record.sub.tier)) {
        await tgSendMessage(
          env,
          chatId,
          '🔒 دسترسی به کانفیگ گیمینگ WireGuard نیازمند اشتراک گیمینگ یا ویژه است.'
        );
        return;
      }
      const serverHost = env.PUBLIC_BASE_URL
        ? new URL(env.PUBLIC_BASE_URL).hostname
        : 'vpn.sentra.local';
      const wg = await generateWireguardGamingProfile({
        subscription: record.sub,
        serverHost,
        serverPublicKey: env.WIREGUARD_SERVER_PUBLIC_KEY || 'REPLACE_SERVER_WG_PUBLIC_KEY',
        port: Number(env.WIREGUARD_PORT || 51820),
        keySalt: env.WIREGUARD_KEY_SALT || 'sentra-wg-salt',
      });
      await tgSendTextDocument(
        env,
        chatId,
        wg.filename,
        wg.config,
        `🍏 <b>کانفیگ اختصاصی WireGuard گیمینگ (iOS)</b>\n\n` +
          `🔹 پروتکل: <b>WireGuard UDP (MTU 1280)</b>\n` +
          `🔹 پلن: <b>${escapeHtml(record.sub.tier)}</b>\n\n` +
          `فایل بالا را با اپلیکیشن رسمی WireGuard در iOS باز و فعال کنید.`
      );
      return;
    }

    if (mode === 'static_ip' && !tierHasStaticIp(record.sub.tier)) {
      await tgSendMessage(env, chatId, '🔒 حالت آی‌پی ثابت مخصوص پلن‌های ویژه است.');
      return;
    }

    const baseUrl = (env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
    await tgSendMessage(
      env,
      chatId,
      `🍏 <b>پروفایل iOS (${escapeHtml(mode)}) آماده است</b>\n\n` +
        `می‌توانید از طریق اپلیکیشن‌های سازگار با Sing-box 1.14+ (مانند SFI / Streisand / Hiddify) اشتراک خود را ایمپورت کنید.\n` +
        (baseUrl ? `لینک اشتراک (SFI): <code>${escapeHtml(baseUrl)}/sub/${escapeHtml(record.sub.token)}?format=singbox&amp;mode=${escapeHtml(mode)}</code>` : '')
    );
    return;
  }

  if (data.startsWith('adm_ob_alloc_') && isAdmin) {
    const alloc = data.slice('adm_ob_alloc_'.length);
    await setBotState(env.DB, telegramId, 'admin_awaiting_outbound', { allocation: alloc });
    await tgSendMessage(
      env,
      chatId,
      `📥 <b>ارسال اوتباند یا ساب‌لینک (${escapeHtml(alloc)})</b>\n\n` +
        `لینک پروکسی (vless/vmess/trojan/hy2/ss/wg)، کانفیگ JSON سینگ‌باکس یا لینک سابسکریپشن (<code>https://...</code>) را ارسال کنید.`
    );
  }
}

async function handleTextMessage(env: Env, msg: TelegramMessage): Promise<void> {
  const from = msg.from;
  if (!from) return;
  const chatId = msg.chat.id;
  const telegramId = from.id;
  const text = (msg.text || '').trim();
  const isAdmin = Boolean(env.ADMIN_CHAT_ID && String(telegramId) === String(env.ADMIN_CHAT_ID).trim());

  const existing = await getUserAndSubByTelegramId(env.DB, telegramId);
  const isRegistered = Boolean(existing);

  if (text === '/start' || text === '🔙 بازگشت') {
    await clearBotState(env.DB, telegramId);
    const welcome = isRegistered
      ? `👋 خوش آمدید <b>${escapeHtml(existing!.user.first_name)}</b>!\nحساب شما متصل و آماده استفاده است.`
      : `👋 به <b>Sentra Platform</b> خوش آمدید!\n\nبرای شروع، روی دکمه <b>📝 ثبت‌نام / ورود</b> کلیک کنید.`;
    await tgSendMessage(env, chatId, welcome, buildMainKeyboard(isRegistered, isAdmin));
    return;
  }

  // Handle active FSM state stored in D1
  const state = await getBotState(env.DB, telegramId);
  if (state && !text.startsWith('/')) {
    if (state.state_type === 'awaiting_login_username') {
      await setBotState(env.DB, telegramId, 'awaiting_login_password', { username: text });
      await tgSendMessage(env, chatId, '🔑 اکنون <b>رمز عبور (Password)</b> حساب خود را وارد کنید:');
      return;
    }

    if (state.state_type === 'awaiting_login_password') {
      const payload = JSON.parse(state.payload_json || '{}') as { username?: string };
      await clearBotState(env.DB, telegramId);
      const username = (payload.username || '').trim();
      const user = await env.DB.prepare(
        'SELECT * FROM users WHERE lower(username) = lower(?) OR lower(email) = lower(?) LIMIT 1'
      )
        .bind(username, username)
        .first<UserRow>();

      if (!user || !(await verifyPassword(text, user.password_hash))) {
        await tgSendMessage(
          env,
          chatId,
          '❌ نام کاربری یا رمز عبور اشتباه است. لطفاً دوباره تلاش کنید.',
          buildMainKeyboard(isRegistered, isAdmin)
        );
        return;
      }

      await env.DB.prepare(
        'UPDATE users SET telegram_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      )
        .bind(telegramId, user.id)
        .run();

      await tgSendMessage(
        env,
        chatId,
        `✅ <b>ورود موفق!</b>\nحساب <b>${escapeHtml(user.username || user.first_name)}</b> به تلگرام شما متصل شد.`,
        buildMainKeyboard(true, isAdmin)
      );
      return;
    }

    if (state.state_type === 'awaiting_donate_outbound') {
      await clearBotState(env.DB, telegramId);
      try {
        const parsed = await parseOutboundInput(text);
        const audit = auditOutboundSecurity(parsed.protocol, parsed.config_json);
        if (!audit.passed) {
          await tgSendMessage(env, chatId, `🚫 ${escapeHtml(audit.reason || 'پروتکل ناامن')}`);
          return;
        }
        const dup = await env.DB.prepare(
          'SELECT id FROM donated_outbounds WHERE fingerprint_sha256 = ? LIMIT 1'
        )
          .bind(parsed.fingerprint_sha256)
          .first<{ id: number }>();
        if (dup) {
          await tgSendMessage(env, chatId, '⚠️ این سرور قبلاً در سیستم ثبت شده است.');
          return;
        }
        await env.DB.prepare(
          `INSERT INTO donated_outbounds (
             donor_user_id, tag, protocol, server_address, server_port, config_json,
             latency_ms, speed_mbps, assigned_tier, health_score, status, fail_count,
             raw_link, fingerprint_sha256, is_official, label, country_code, country_name,
             allow_web, allow_download, allow_gaming, allow_static_ip, allocation_mode,
             last_online_at, last_checked_at
           ) VALUES (?, ?, ?, ?, ?, ?, 90, 12.0, 'web_browsing', 100, 'active', 0, ?, ?, 0, ?, ?, ?, 1, 1, 0, 0, 'free_only', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
        )
          .bind(
            existing?.user.id ?? null,
            parsed.tag,
            parsed.protocol,
            parsed.server_address,
            parsed.server_port,
            JSON.stringify(parsed.config_json),
            parsed.raw_link,
            parsed.fingerprint_sha256,
            parsed.tag,
            parsed.country_code,
            parsed.country_name
          )
          .run();

        await tgSendMessage(
          env,
          chatId,
          `🤝 <b>سپاس از حمایت شما!</b>\nنود <b>${escapeHtml(parsed.tag)}</b> در کل اکوسیستم سنترا فعال شد.`
        );
      } catch (err) {
        await tgSendMessage(
          env,
          chatId,
          `❌ ${escapeHtml(err instanceof Error ? err.message : 'خطا در ثبت اوتباند.')}`
        );
      }
      return;
    }

    if (state.state_type === 'admin_awaiting_outbound' && isAdmin) {
      const payload = JSON.parse(state.payload_json || '{}') as { allocation?: string };
      await clearBotState(env.DB, telegramId);
      await handleAdminOutboundSubmission(env, chatId, text, payload.allocation || 'auto');
      return;
    }
  }

  if (text === '📝 ثبت‌نام / ورود') {
    await tgSendMessage(
      env,
      chatId,
      '🔐 <b>احراز هویت Sentra</b>\n\nاگر قبلاً داخل اپلیکیشن حساب ساخته‌اید روی «ورود با حساب برنامه» بزنید، در غیر این صورت ثبت‌نام فوری انجام دهید:',
      {
        inline_keyboard: [
          [{ text: '✨ ثبت‌نام جدید (فوری)', callback_data: 'auth_register_new' }],
          [{ text: '🔑 ورود با حساب برنامه', callback_data: 'auth_login_app' }],
        ],
      }
    );
    return;
  }

  if (text === '👤 حساب کاربری') {
    if (!existing || !existing.sub) {
      await tgSendMessage(env, chatId, '❌ ابتدا از گزینه «📝 ثبت‌نام / ورود» حساب خود را فعال کنید.');
      return;
    }
    const used = existing.sub.upload_bytes + existing.sub.download_bytes;
    await tgSendMessage(
      env,
      chatId,
      `👤 <b>حساب کاربری شما</b>\n\n` +
        `🆔 شناسه یکتا: <code>${escapeHtml(existing.user.user_uuid)}</code>\n` +
        `💎 نوع اشتراک: <b>${escapeHtml(existing.sub.tier)}</b>\n` +
        `📊 حجم مصرفی: <b>${formatGb(used)} GB</b> از <b>${formatGb(existing.sub.traffic_limit_bytes)} GB</b>\n` +
        `📅 تاریخ انقضا: <code>${escapeHtml(existing.sub.expires_at.slice(0, 10))}</code>`
    );
    return;
  }

  if (text === '🔑 دریافت کانفیگ و کد اتصال') {
    if (!existing || !existing.sub) {
      await tgSendMessage(env, chatId, '❌ لطفاً ابتدا ثبت‌نام یا ورود انجام دهید.');
      return;
    }
    const otp = generateNumericCode(8);
    const expires = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    await env.DB.prepare(
      'UPDATE users SET auth_code = ?, auth_code_expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    )
      .bind(otp, expires, existing.user.id)
      .run();

    const baseUrl = (env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
    const subLine = baseUrl
      ? `\n🔗 <b>لینک سابسکریپشن Sing-box 1.14+:</b>\n<code>${escapeHtml(baseUrl)}/sub/${escapeHtml(existing.sub.token)}?format=singbox</code>`
      : '';

    await tgSendMessage(
      env,
      chatId,
      `🔑 <b>کد ورود ۸ رقمی اپلیکیشن (اعتبار ۵ دقیقه):</b>\n<code>${otp}</code>${subLine}`
    );
    return;
  }

  if (text === '🍏 دریافت کانفیگ iOS') {
    if (!existing || !existing.sub) {
      await tgSendMessage(env, chatId, '❌ لطفاً ابتدا ثبت‌نام یا ورود انجام دهید.');
      return;
    }
    const gamingLive = await hasActiveGamingOutbounds(env.DB);
    const canStatic = tierHasStaticIp(existing.sub.tier);
    const canGaming = tierHasGaming(existing.sub.tier);

    const buttons: Array<Array<{ text: string; callback_data: string }>> = [
      [
        { text: '🌐 وب‌گردی (رایگان)', callback_data: 'ios_mode_web_browsing' },
        { text: '📥 دانلود (رایگان)', callback_data: 'ios_mode_download' },
      ],
    ];
    if (gamingLive && canGaming) {
      buttons.push([{ text: '🎮 گیمینگ (WireGuard)', callback_data: 'ios_mode_gaming' }]);
    } else {
      buttons.push([{ text: '🎮 گیمینگ (به‌زودی)', callback_data: 'ios_mode_gaming' }]);
    }
    if (canStatic) {
      buttons.push([{ text: '💎 آی‌پی ثابت اختصاصی', callback_data: 'ios_mode_static_ip' }]);
    }

    await tgSendMessage(env, chatId, '🍏 <b>انتخاب حالت کانفیگ iOS:</b>', {
      inline_keyboard: buttons,
    });
    return;
  }

  if (text === '🤝 اهدای اوتباند (حمایت از Sentra)') {
    await setBotState(env.DB, telegramId, 'awaiting_donate_outbound');
    await tgSendMessage(
      env,
      chatId,
      '🤝 لینک پروکسی خود (vless/vmess/trojan/hy2/ss/wg) را ارسال کنید تا پس از بررسی امنیتی و اثرانگشت در کل اکوسیستم فعال شود:'
    );
    return;
  }

  if (text === '🛡 پنل مدیریت اوتباندها' && isAdmin) {
    await tgSendMessage(
      env,
      chatId,
      '🛡 <b>پنل مدیریت اوتباندها (Serverless D1)</b>\n\nبخش هدف برای افزودن نود یا ساب‌لینک را انتخاب کنید:',
      {
        inline_keyboard: [
          [{ text: '🌐 بخش رایگان (وب‌گردی + دانلود)', callback_data: 'adm_ob_alloc_free_only' }],
          [{ text: '🎮 بخش گیمینگ (فعال‌سازی خودکار گیمینگ)', callback_data: 'adm_ob_alloc_gaming_only' }],
          [{ text: '💎 بخش آی‌پی ثابت (ترید و جمنای)', callback_data: 'adm_ob_alloc_static_only' }],
          [{ text: '🔥 کل اکوسیستم (همه حالت‌ها)', callback_data: 'adm_ob_alloc_all' }],
        ],
      }
    );
    return;
  }

  await tgSendMessage(
    env,
    chatId,
    'از دکمه‌های منوی پایین برای ادامه استفاده کنید.',
    buildMainKeyboard(isRegistered, isAdmin)
  );
}

/**
 * Cloudflare Worker Webhook Handler for POST /api/v1/telegram/webhook.
 * Enforces X-Telegram-Bot-Api-Secret-Token verification when TELEGRAM_WEBHOOK_SECRET is configured.
 */
export async function handleTelegramWebhook(
  request: Request,
  env: Env
): Promise<Response> {
  if (env.TELEGRAM_WEBHOOK_SECRET) {
    const incomingSecret = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
    const valid = await constantTimeEquals(incomingSecret, env.TELEGRAM_WEBHOOK_SECRET);
    if (!valid) {
      return new Response(JSON.stringify({ ok: false, error: 'Unauthorized webhook secret' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid JSON update' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    if (update.callback_query) {
      await handleCallbackQuery(env, update.callback_query);
    } else if (update.message) {
      await handleTextMessage(env, update.message);
    }
  } catch (err) {
    console.error('[Sentra Webhook Error]', err);
  }

  // Always return 200 OK to Telegram so updates are not retried infinitely
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
