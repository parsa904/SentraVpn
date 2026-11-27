import {
  auditOutboundSecurity,
  parseOutboundInput,
  parseSubscriptionPayload,
} from './outboundAnalyzer.ts';
import {
  constantTimeEquals,
  generateNumericCode,
  generateSubscriptionToken,
  sha256Hex,
  validateExternalHttpsUrl,
  verifyPassword,
} from './security.ts';
import {
  generateWireguardGamingProfile,
  tierHasGaming,
  tierHasStaticIp,
} from './singboxCompiler.ts';
import {
  dispatchErrorAlert,
  extractSupportUid,
  formatLogTimestamp,
  getTopicRoutingConfig,
  saveTopicRoute,
  sendDatabaseBackup,
  sendErrorAlert,
  sendMediaToTopic,
  sendToTopic,
  type TopicType,
} from './telegramTopics.ts';
import {
  executeD1Batch,
  getCachedHasActiveGaming,
  invalidateNodesCache,
} from './workerCache.ts';
import type { Env, SubscriptionRow, UserRow } from './types.ts';

interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width?: number;
  height?: number;
}

interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
}

interface TelegramReplyMessage {
  message_id?: number;
  message_thread_id?: number;
  from?: TelegramUser;
  text?: string;
  caption?: string;
}

interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  is_topic_message?: boolean;
  from?: TelegramUser;
  chat: { id: number; type: string; title?: string };
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  reply_to_message?: TelegramReplyMessage;
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

function resolveBotToken(env: Env): string {
  return (env.TELEGRAM_BOT_TOKEN || '').trim();
}

const USER_BTN = {
  ACCOUNT: '👤 حساب کاربری',
  AUTH: '📝 ثبت‌نام / ورود',
  GET_SUB: '🔑 دریافت کانفیگ و کد اتصال',
  IOS_CONFIG: '🍏 دریافت کانفیگ iOS',
  UPGRADE: '💎 ارتقای اشتراک',
  DONATE_OUTBOUND: '🤝 اهدای اوتباند (حمایت از Sentra)',
  GUIDE: '📖 راهنمای اتصال',
  DOWNLOAD_APP: '📥 دانلود اپلیکیشن Sentra Connect',
  SUPPORT: '🎫 پشتیبانی',
  BACK: '🔙 بازگشت',
  CANCEL: '❌ انصراف',
} as const;

const ADMIN_PANEL_BUTTON = '🛠 پنل مدیریت';
const LEGACY_ADMIN_PANEL_BUTTON = '🛡 پنل مدیریت اوتباندها';

type MenuAction =
  | 'account'
  | 'auth'
  | 'get_sub'
  | 'ios_menu'
  | 'upgrade'
  | 'donate_outbound'
  | 'guide'
  | 'download_app'
  | 'support'
  | 'back'
  | 'admin';

function normalizePersianButton(raw: string): string {
  return raw
    .replace(/\u200c/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchMenuAction(rawText: string): MenuAction | null {
  const text = rawText.trim();
  const norm = normalizePersianButton(text);

  if (
    text === '/admin' ||
    text.startsWith('/admin ') ||
    /^\/admin@[A-Za-z0-9_]+(\s|$)/.test(text) ||
    text === ADMIN_PANEL_BUTTON ||
    text === LEGACY_ADMIN_PANEL_BUTTON ||
    norm === '🛠 پنل مدیریت' ||
    norm === 'پنل مدیریت'
  ) {
    return 'admin';
  }
  if (
    text === USER_BTN.BACK ||
    text === USER_BTN.CANCEL ||
    norm === '🔙 بازگشت' ||
    norm === 'بازگشت' ||
    norm === '🔙 بازگشت به منوی اصلی' ||
    norm === 'بازگشت به منوی اصلی' ||
    norm === '❌ انصراف' ||
    norm === 'انصراف'
  ) {
    return 'back';
  }
  if (
    text === USER_BTN.AUTH ||
    norm === '📝 ثبت نام / ورود' ||
    norm === 'ثبت نام / ورود'
  ) {
    return 'auth';
  }
  if (
    text === USER_BTN.ACCOUNT ||
    norm === '👤 حساب کاربری' ||
    norm === 'حساب کاربری' ||
    norm === 'وضعیت حساب' ||
    norm === '📊 وضعیت حساب' ||
    norm === '📊 وضعیت اشتراک'
  ) {
    return 'account';
  }
  if (
    text === USER_BTN.GET_SUB ||
    norm === '🔑 دریافت کانفیگ و کد اتصال' ||
    norm === 'دریافت لینک اشتراک' ||
    norm === '🔗 دریافت لینک اشتراک' ||
    norm === 'دریافت کانفیگ'
  ) {
    return 'get_sub';
  }
  if (
    text === USER_BTN.IOS_CONFIG ||
    norm === '🍏 دریافت کانفیگ iOS' ||
    norm === 'دریافت کانفیگ iOS'
  ) {
    return 'ios_menu';
  }
  if (
    text === USER_BTN.UPGRADE ||
    norm === '💎 ارتقای اشتراک' ||
    norm === 'ارتقای اشتراک' ||
    norm === 'خرید اشتراک' ||
    norm === '💎 خرید / ارتقای اشتراک'
  ) {
    return 'upgrade';
  }
  if (
    text === USER_BTN.DONATE_OUTBOUND ||
    norm === '🤝 اهدای اوتباند (حمایت از Sentra)' ||
    norm === 'اهدای اوتباند' ||
    norm === 'اهدای نود' ||
    norm === '🤝 اهدای نود' ||
    norm === 'اهدای کانفیگ'
  ) {
    return 'donate_outbound';
  }
  if (
    text === USER_BTN.GUIDE ||
    norm === '📖 راهنمای اتصال' ||
    norm === 'راهنمای اتصال' ||
    norm === '📚 راهنمای اتصال'
  ) {
    return 'guide';
  }
  if (
    text === USER_BTN.DOWNLOAD_APP ||
    norm === '📥 دانلود اپلیکیشن Sentra Connect' ||
    norm === 'دانلود اپلیکیشن' ||
    norm === '📥 دانلود اپلیکیشن'
  ) {
    return 'download_app';
  }
  if (
    text === USER_BTN.SUPPORT ||
    norm === '🎫 پشتیبانی' ||
    norm === 'پشتیبانی' ||
    norm === '💬 پشتیبانی' ||
    norm === 'تیکت پشتیبانی'
  ) {
    return 'support';
  }

  return null;
}

function isEnvAdmin(env: Env, telegramId: number): boolean {
  const idStr = String(telegramId);
  const candidates = [
    ...(env.ADMIN_TELEGRAM_ID ? env.ADMIN_TELEGRAM_ID.split(',') : []),
    ...(env.ADMIN_CHAT_ID ? env.ADMIN_CHAT_ID.split(',') : []),
    ...(env.ADMIN_TELEGRAM_IDS ? env.ADMIN_TELEGRAM_IDS.split(',') : []),
  ]
    .map((s) => s.trim())
    .filter(Boolean);
  return candidates.includes(idStr);
}

async function resolveIsAdmin(
  env: Env,
  telegramId: number,
  existingUser?: UserRow | null
): Promise<boolean> {
  if (isEnvAdmin(env, telegramId)) return true;
  if (existingUser) return existingUser.role === 'admin';

  try {
    const row = await env.DB.prepare('SELECT role FROM users WHERE telegram_id = ? LIMIT 1')
      .bind(telegramId)
      .first<{ role: string }>();
    return row?.role === 'admin';
  } catch (err) {
    console.error('[Sentra Admin Check Error]', err);
    return false;
  }
}

interface TelegramApiResponse {
  ok?: boolean;
  error_code?: number;
  description?: string;
}

async function tgApi(
  env: Env,
  method: string,
  payload: Record<string, unknown>
): Promise<boolean> {
  const botToken = resolveBotToken(env);
  if (!botToken) {
    console.error('MISSING TELEGRAM_BOT_TOKEN');
    return false;
  }

  try {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const rawText = await resp.text();
    let parsed: TelegramApiResponse | null = null;
    try {
      parsed = JSON.parse(rawText) as TelegramApiResponse;
    } catch {
      parsed = null;
    }

    if (!resp.ok || !parsed || parsed.ok !== true) {
      const desc = parsed?.description ?? rawText.slice(0, 500);
      console.error('[Telegram API Error]', {
        method,
        http_status: resp.status,
        error_code: parsed?.error_code ?? null,
        description: desc,
      });
      await sendErrorAlert(
        env,
        `Telegram API (${method})`,
        `HTTP ${resp.status} | code=${parsed?.error_code ?? 'unknown'} | ${desc}`
      );
      return false;
    }

    return true;
  } catch (err) {
    console.error('[Telegram API Fetch Error]', method, err);
    await sendErrorAlert(env, `Telegram API Fetch (${method})`, err);
    return false;
  }
}

async function tgSendMessage(
  env: Env,
  chatId: number,
  text: string,
  replyMarkup?: Record<string, unknown>,
  extra?: Record<string, unknown>
): Promise<boolean> {
  return await tgApi(env, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    ...(extra || {}),
  });
}

async function tgEditMessageText(
  env: Env,
  chatId: number,
  messageId: number,
  text: string,
  replyMarkup?: Record<string, unknown>
): Promise<boolean> {
  return await tgApi(env, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

async function tgAnswerCallbackQuery(
  env: Env,
  callbackQueryId: string,
  text?: string
): Promise<boolean> {
  return await tgApi(env, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
  });
}

async function tgSendTextDocument(
  env: Env,
  chatId: number,
  filename: string,
  content: string,
  caption: string
): Promise<boolean> {
  const botToken = resolveBotToken(env);
  if (!botToken) {
    console.error('MISSING TELEGRAM_BOT_TOKEN');
    return false;
  }

  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', caption);
  form.append('parse_mode', 'HTML');
  form.append('document', new Blob([content], { type: 'text/plain; charset=utf-8' }), filename);

  try {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
      method: 'POST',
      body: form,
    });
    const rawText = await resp.text();
    let parsed: TelegramApiResponse | null = null;
    try {
      parsed = JSON.parse(rawText) as TelegramApiResponse;
    } catch {
      parsed = null;
    }
    if (!resp.ok || !parsed || parsed.ok !== true) {
      const desc = parsed?.description ?? rawText.slice(0, 500);
      console.error('[Telegram API Error]', {
        method: 'sendDocument',
        http_status: resp.status,
        error_code: parsed?.error_code ?? null,
        description: desc,
      });
      await sendErrorAlert(
        env,
        'Telegram API (sendDocument)',
        `HTTP ${resp.status} | code=${parsed?.error_code ?? 'unknown'} | ${desc}`
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error('[Telegram API Fetch Error]', 'sendDocument', err);
    await sendErrorAlert(env, 'Telegram API Fetch (sendDocument)', err);
    return false;
  }
}

async function tgSendDocumentByFileId(
  env: Env,
  chatId: number,
  fileId: string,
  caption: string
): Promise<boolean> {
  return await tgApi(env, 'sendDocument', {
    chat_id: chatId,
    document: fileId,
    caption,
    parse_mode: 'HTML',
  });
}

function buildMainKeyboard(isRegistered: boolean, isAdmin: boolean): Record<string, unknown> {
  const accountOrAuthBtn = isRegistered
    ? { text: USER_BTN.ACCOUNT }
    : { text: USER_BTN.AUTH };

  const rows: Array<Array<{ text: string }>> = [
    [accountOrAuthBtn, { text: USER_BTN.GET_SUB }],
    [{ text: USER_BTN.IOS_CONFIG }, { text: USER_BTN.UPGRADE }],
    [{ text: USER_BTN.DONATE_OUTBOUND }, { text: USER_BTN.GUIDE }],
    [{ text: USER_BTN.DOWNLOAD_APP }, { text: USER_BTN.SUPPORT }],
  ];
  if (isAdmin) {
    rows.push([{ text: ADMIN_PANEL_BUTTON }]);
  }
  return {
    keyboard: rows,
    resize_keyboard: true,
  };
}

async function hasActiveGamingOutbounds(
  db: D1Database,
  kv?: KVNamespace
): Promise<boolean> {
  return await getCachedHasActiveGaming(db, kv);
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

/**
 * Ensures the Telegram user exists in `users` and has an initial active subscription
 * in `subscriptions` using the exact columns defined in `schema.sql`.
 */
async function ensureTelegramUserAndSubscription(
  db: D1Database,
  tgUser: TelegramUser,
  isAdmin: boolean
): Promise<{ user: UserRow; sub: SubscriptionRow; isNewUser: boolean }> {
  const existing = await getUserAndSubByTelegramId(db, tgUser.id);
  let user = existing?.user ?? null;
  let isNewUser = false;

  if (!user) {
    const userUuid = crypto.randomUUID();
    let safeUsername: string | null = tgUser.username?.trim() || null;
    if (safeUsername) {
      const taken = await db
        .prepare('SELECT id FROM users WHERE lower(username) = lower(?) LIMIT 1')
        .bind(safeUsername)
        .first<{ id: number }>();
      if (taken) {
        safeUsername = null;
      }
    }

    await db
      .prepare(
        `INSERT INTO users (
           user_uuid, telegram_id, username, email, password_hash,
           first_name, last_name, role, status, outbound_reward_banned
         ) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, 'active', 0)`
      )
      .bind(
        userUuid,
        tgUser.id,
        safeUsername,
        (tgUser.first_name || 'کاربر سنترا').trim() || 'کاربر سنترا',
        tgUser.last_name || null,
        isAdmin ? 'admin' : 'user'
      )
      .run();

    user = await db
      .prepare('SELECT * FROM users WHERE telegram_id = ? LIMIT 1')
      .bind(tgUser.id)
      .first<UserRow>();

    if (!user) {
      throw new Error('Failed to load newly inserted user from D1');
    }
    isNewUser = true;
  } else if (isAdmin && user.role !== 'admin') {
    await db
      .prepare("UPDATE users SET role = 'admin', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(user.id)
      .run();
    user = { ...user, role: 'admin' };
  }

  let sub = existing?.sub ?? null;
  if (!sub) {
    const token = generateSubscriptionToken();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    await db
      .prepare(
        `INSERT INTO subscriptions (
           user_id, tier, token, status,
           upload_bytes, download_bytes, traffic_limit_bytes, speed_limit_bps,
           max_concurrent_devices, web_browsing_used_mb, download_used_mb,
           static_ip_used_mb, expires_at
         ) VALUES (?, 'Sentra Lite', ?, 'active', 0, 0, ?, 0, 3, 0, 0, 0, ?)`
      )
      .bind(user.id, token, 10 * 1024 * 1024 * 1024, expiresAt)
      .run();

    sub = await db
      .prepare('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 1')
      .bind(user.id)
      .first<SubscriptionRow>();

    if (!sub) {
      throw new Error('Failed to load newly inserted subscription from D1');
    }
  }

  return { user, sub, isNewUser };
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
  allocationMode: string,
  kv?: KVNamespace
): Promise<{ inserted: boolean; duplicate: boolean }> {
  const existing = await db
    .prepare('SELECT id FROM donated_outbounds WHERE fingerprint_sha256 = ? LIMIT 1')
    .bind(parsed.fingerprint_sha256)
    .first<{ id: number }>();
  if (existing) {
    return { inserted: false, duplicate: true };
  }

  const allowWeb = ['free_only', 'both', 'all', 'auto', 'web_browsing'].includes(allocationMode) ? 1 : 0;
  const allowDownload = ['free_only', 'both', 'all', 'auto', 'download'].includes(allocationMode) ? 1 : 0;
  const allowGaming = ['gaming_only', 'all', 'gaming'].includes(allocationMode) ? 1 : 0;
  const allowStatic = ['static_only', 'both', 'all', 'static_ip'].includes(allocationMode) ? 1 : 0;
  const assignedTier =
    allocationMode === 'gaming_only' || allocationMode === 'gaming'
      ? 'gaming'
      : allocationMode === 'static_only' || allocationMode === 'static_ip'
      ? 'static_ip'
      : allocationMode === 'download'
      ? 'download'
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

  await invalidateNodesCache(db, kv);
  return { inserted: true, duplicate: false };
}

async function batchInsertOfficialOutboundsD1(
  db: D1Database,
  nodes: Array<Awaited<ReturnType<typeof parseOutboundInput>>>,
  allocationMode: string,
  kv?: KVNamespace
): Promise<{ added: number; duplicates: number }> {
  const limited = nodes.slice(0, 100);
  if (limited.length === 0) return { added: 0, duplicates: 0 };

  const allFps = Array.from(new Set(limited.map((n) => n.fingerprint_sha256).filter(Boolean)));
  const existingFps = new Set<string>();
  if (allFps.length > 0) {
    // Check existing SHA-256 fingerprints in chunks of 50 using unique index
    const lookupStmts: D1PreparedStatement[] = [];
    for (let i = 0; i < allFps.length; i += 50) {
      const chunk = allFps.slice(i, i + 50);
      const placeholders = chunk.map(() => '?').join(', ');
      lookupStmts.push(
        db
          .prepare(
            `SELECT fingerprint_sha256 FROM donated_outbounds WHERE fingerprint_sha256 IN (${placeholders})`
          )
          .bind(...chunk)
      );
    }
    const lookupRes = await executeD1Batch<{ fingerprint_sha256: string }>(db, lookupStmts);
    for (const res of lookupRes) {
      for (const row of res.results || []) {
        if (row.fingerprint_sha256) existingFps.add(String(row.fingerprint_sha256));
      }
    }
  }

  const allowWeb = ['free_only', 'both', 'all', 'auto', 'web_browsing'].includes(allocationMode) ? 1 : 0;
  const allowDownload = ['free_only', 'both', 'all', 'auto', 'download'].includes(allocationMode) ? 1 : 0;
  const allowGaming = ['gaming_only', 'all', 'gaming'].includes(allocationMode) ? 1 : 0;
  const allowStatic = ['static_only', 'both', 'all', 'static_ip'].includes(allocationMode) ? 1 : 0;
  const assignedTier =
    allocationMode === 'gaming_only' || allocationMode === 'gaming'
      ? 'gaming'
      : allocationMode === 'static_only' || allocationMode === 'static_ip'
      ? 'static_ip'
      : allocationMode === 'download'
      ? 'download'
      : 'web_browsing';

  const insertSql = `INSERT INTO donated_outbounds (
       donor_user_id, tag, protocol, server_address, server_port, config_json,
       latency_ms, speed_mbps, assigned_tier, health_score, status, fail_count,
       raw_link, fingerprint_sha256, is_official, label, country_code, country_name,
       allow_web, allow_download, allow_gaming, allow_static_ip, allocation_mode,
       last_online_at, last_checked_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;

  const insertStmts: D1PreparedStatement[] = [];
  let duplicates = 0;

  for (const parsed of limited) {
    if (existingFps.has(parsed.fingerprint_sha256)) {
      duplicates += 1;
      continue;
    }
    existingFps.add(parsed.fingerprint_sha256);
    insertStmts.push(
      db
        .prepare(insertSql)
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
    );
  }

  if (insertStmts.length > 0) {
    await executeD1Batch(db, insertStmts);
    await invalidateNodesCache(db, kv);
  }

  return { added: insertStmts.length, duplicates };
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

    let resp: Response;
    try {
      resp = await fetch(validUrl.toString(), {
        headers: { 'User-Agent': 'SentraCore/2.0 (Cloudflare-Worker)' },
        signal: AbortSignal.timeout(12_000),
      });
    } catch (err) {
      await tgSendMessage(
        env,
        chatId,
        `❌ خطا یا اتمام زمان (Timeout) در دریافت سابسکریپشن:\n<code>${escapeHtml(
          err instanceof Error ? err.message : String(err)
        )}</code>`
      );
      return;
    }
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

    const { added, duplicates } = await batchInsertOfficialOutboundsD1(
      env.DB,
      nodes,
      allocationMode,
      env.SENTRA_KV
    );

    const category =
      allocationMode === 'gaming_only' || allocationMode === 'gaming'
        ? 'gaming'
        : allocationMode === 'static_only' || allocationMode === 'static_ip'
        ? 'static_ip'
        : allocationMode === 'download'
        ? 'download'
        : 'web_browsing';

    await env.DB.prepare(
      `INSERT INTO subscription_sources (category, sub_url, tag, total_nodes, healthy_nodes, last_sync_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
    )
      .bind(category, validUrl.toString(), `Sub (${category})`, nodes.length, added)
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

  const res = await insertOfficialOutboundD1(env.DB, parsed, allocationMode, env.SENTRA_KV);
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

const ADMIN_TIER_CONFIG: Record<string, { tier: string; limitBytes: number; label: string }> = {
  lite: { tier: 'Sentra Lite', limitBytes: 10 * 1024 * 1024 * 1024, label: 'Lite (10GB)' },
  gaming: { tier: 'Sentra Gaming', limitBytes: 100 * 1024 * 1024 * 1024, label: 'Gaming (100GB)' },
  static: {
    tier: 'Sentra Static IP',
    limitBytes: 100 * 1024 * 1024 * 1024,
    label: 'Static IP (100GB)',
  },
  pro: { tier: 'Sentra Pro', limitBytes: 200 * 1024 * 1024 * 1024, label: 'Pro (200GB)' },
  flow: { tier: 'Sentra Flow+', limitBytes: 500 * 1024 * 1024 * 1024, label: 'Flow+ (500GB)' },
};

function buildAdminPanelHomeView(): { text: string; replyMarkup: Record<string, unknown> } {
  return {
    text:
      '🛠 <b>پنل مدیریت Sentra Platform (Cloudflare D1)</b>\n\n' +
      'از منوی زیر بخش مورد نظر را برای مدیریت نودهای رسمی، منابع سابسکریپشن، بررسی نودهای اهدایی و فیش‌های مالی، مدیریت کاربران یا آمار سیستم انتخاب کنید:',
    replyMarkup: {
      inline_keyboard: [
        [
          { text: '➕ افزودن نود رسمی', callback_data: 'adm_add_node' },
          { text: '📋 لیست نودها', callback_data: 'adm_list_nodes' },
        ],
        [
          { text: '🔗 منابع سابسکریپشن', callback_data: 'adm_sub_sources' },
          { text: '👥 کاربران و اشتراک‌ها', callback_data: 'adm_manage_subs' },
        ],
        [
          { text: '📥 نودهای اهدایی (در انتظار)', callback_data: 'adm_pending_nodes' },
          { text: '💳 فیش‌های مالی (در انتظار)', callback_data: 'adm_pending_donations' },
        ],
        [
          { text: '📊 آمار سیستم', callback_data: 'adm_stats' },
          { text: '💾 دریافت بکاپ فوری', callback_data: 'adm_backup_now' },
        ],
        [{ text: '🏠 بازگشت به منوی اصلی', callback_data: 'user_menu_home' }],
      ],
    },
  };
}

const VALID_SUB_SOURCE_CATEGORIES = ['web_browsing', 'download', 'gaming', 'static_ip'] as const;
type SubSourceCategory = (typeof VALID_SUB_SOURCE_CATEGORIES)[number];

async function buildAdminSubSourcesView(
  env: Env
): Promise<{ text: string; replyMarkup: Record<string, unknown> }> {
  const rows = await env.DB.prepare(
    `SELECT id, category, sub_url, tag, total_nodes, healthy_nodes, last_sync_at
     FROM subscription_sources
     ORDER BY id DESC
     LIMIT 10`
  ).all<{
    id: number;
    category: string;
    sub_url: string;
    tag: string | null;
    total_nodes: number;
    healthy_nodes: number;
    last_sync_at: string;
  }>();

  const list = rows.results || [];
  const lines = list.map((s) => {
    const shortUrl = s.sub_url.length > 48 ? `${s.sub_url.slice(0, 48)}...` : s.sub_url;
    return (
      `🔹 <b>#${s.id}</b> [<code>${escapeHtml(s.category)}</code>] — نودها: <b>${s.healthy_nodes}/${s.total_nodes}</b>\n` +
      `   🔗 <code>${escapeHtml(shortUrl)}</code>`
    );
  });

  const deleteButtons: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < list.length; i += 2) {
    const rowBtns: Array<{ text: string; callback_data: string }> = [];
    for (const src of list.slice(i, i + 2)) {
      rowBtns.push({
        text: `🗑 حذف #${src.id} (${src.category})`,
        callback_data: `adm_subsrc_del_${src.id}`,
      });
    }
    deleteButtons.push(rowBtns);
  }

  return {
    text:
      `🔗 <b>مدیریت منابع سابسکریپشن (subscription_sources)</b>\n\n` +
      (lines.length > 0 ? lines.join('\n') : '<i>هیچ منبع سابسکریپشنی هنوز ثبت نشده است.</i>'),
    replyMarkup: {
      inline_keyboard: [
        [{ text: '➕ افزودن لینک سابسکریپشن جدید', callback_data: 'adm_subsrc_add' }],
        ...deleteButtons,
        [
          { text: '🔄 بروزرسانی', callback_data: 'adm_sub_sources' },
          { text: '🔙 بازگشت به پنل مدیریت', callback_data: 'adm_panel_home' },
        ],
      ],
    },
  };
}

function buildAdminAddSubSourceCategoryView(): {
  text: string;
  replyMarkup: Record<string, unknown>;
} {
  return {
    text:
      '🔗 <b>افزودن منبع سابسکریپشن جدید</b>\n\n' +
      'ابتدا دسته‌بندی هدف برای این لینک سابسکریپشن را انتخاب کنید:',
    replyMarkup: {
      inline_keyboard: [
        [
          { text: '🌐 وب‌گردی (web_browsing)', callback_data: 'adm_subsrc_cat_web_browsing' },
          { text: '📥 دانلود (download)', callback_data: 'adm_subsrc_cat_download' },
        ],
        [
          { text: '🎮 گیمینگ (gaming)', callback_data: 'adm_subsrc_cat_gaming' },
          { text: '💎 آی‌پی ثابت (static_ip)', callback_data: 'adm_subsrc_cat_static_ip' },
        ],
        [{ text: '🔙 بازگشت به منابع سابسکریپشن', callback_data: 'adm_sub_sources' }],
      ],
    },
  };
}

async function handleAdminSubSourceSubmission(
  env: Env,
  chatId: number,
  rawUrl: string,
  category: SubSourceCategory
): Promise<void> {
  let validUrl: URL;
  try {
    validUrl = validateExternalHttpsUrl(rawUrl.trim());
  } catch (err) {
    await tgSendMessage(
      env,
      chatId,
      `❌ ${escapeHtml(err instanceof Error ? err.message : 'لینک سابسکریپشن نامعتبر است.')}`,
      { inline_keyboard: [[{ text: '🔙 منابع سابسکریپشن', callback_data: 'adm_sub_sources' }]] }
    );
    return;
  }

  let totalNodes = 0;
  let addedNodes = 0;
  let duplicates = 0;
  let skipped = 0;
  let fetchWarning = '';

  try {
    const resp = await fetch(validUrl.toString(), {
      headers: { 'User-Agent': 'SentraCore/2.0 (Cloudflare-Worker)' },
      signal: AbortSignal.timeout(12_000),
    });
    if (resp.ok) {
      const body = await resp.text();
      const parsedSub = await parseSubscriptionPayload(body);
      totalNodes = parsedSub.nodes.length;
      skipped = parsedSub.skipped;
      const batchRes = await batchInsertOfficialOutboundsD1(
        env.DB,
        parsedSub.nodes,
        category,
        env.SENTRA_KV
      );
      addedNodes = batchRes.added;
      duplicates = batchRes.duplicates;
    } else {
      fetchWarning = `\n⚠️ دریافت اولیه نودها با کد HTTP ${resp.status} مواجه شد، اما منبع در دیتابیس ذخیره گردید.`;
    }
  } catch (err) {
    fetchWarning = `\n⚠️ خطای دریافت اولیه نودها (${escapeHtml(
      err instanceof Error ? err.message : String(err)
    )})؛ منبع ذخیره شد.`;
  }

  await env.DB.prepare(
    `INSERT INTO subscription_sources (category, sub_url, tag, total_nodes, healthy_nodes, last_sync_at)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
  )
    .bind(category, validUrl.toString(), `Source (${category})`, totalNodes, addedNodes)
    .run();

  const gamingNote =
    category === 'gaming' && addedNodes > 0
      ? '\n\n🎮 <b>بخش گیمینگ به صورت خودکار در کل اکوسیستم فعال شد!</b>'
      : '';

  await tgSendMessage(
    env,
    chatId,
    `✅ <b>منبع سابسکریپشن جدید ثبت شد</b>\n\n` +
      `📂 دسته‌بندی: <code>${escapeHtml(category)}</code>\n` +
      `🔗 آدرس: <code>${escapeHtml(validUrl.toString())}</code>\n` +
      `🔹 نودهای ثبت‌شده: <b>${addedNodes}</b> از <b>${totalNodes}</b> (تکراری: ${duplicates} | نامعتبر: ${skipped})${fetchWarning}${gamingNote}`,
    {
      inline_keyboard: [
        [{ text: '🔗 مشاهده لیست منابع', callback_data: 'adm_sub_sources' }],
        [{ text: '🔙 بازگشت به پنل مدیریت', callback_data: 'adm_panel_home' }],
      ],
    }
  );
}

interface PendingNodeRow {
  id: number;
  donor_user_id: number | null;
  tag: string;
  protocol: string;
  server_address: string;
  server_port: number;
  country_name: string;
  created_at: string;
  donor_telegram_id: number | null;
  donor_first_name: string | null;
  donor_username: string | null;
}

async function buildAdminPendingNodesView(
  env: Env
): Promise<{ text: string; replyMarkup: Record<string, unknown> }> {
  const rows = await env.DB.prepare(
    `SELECT
       d.id, d.donor_user_id, d.tag, d.protocol, d.server_address, d.server_port,
       d.country_name, d.created_at,
       u.telegram_id AS donor_telegram_id, u.first_name AS donor_first_name, u.username AS donor_username
     FROM donated_outbounds d
     LEFT JOIN users u ON u.id = d.donor_user_id
     WHERE d.status = 'pending'
     ORDER BY d.id ASC
     LIMIT 5`
  ).all<PendingNodeRow>();

  const list = rows.results || [];
  const lines = list.map((n) => {
    const donor = n.donor_username
      ? `@${escapeHtml(n.donor_username)}`
      : n.donor_first_name
      ? escapeHtml(n.donor_first_name)
      : 'ناشناس';
    return (
      `🔹 <b>نود #${n.id}</b> — <code>${escapeHtml(n.protocol)}</code>\n` +
      `   🏷 ${escapeHtml(n.tag.slice(0, 32))} | 🌍 ${escapeHtml(n.country_name)}\n` +
      `   🌐 <code>${escapeHtml(n.server_address)}:${n.server_port}</code> | 👤 اهداکننده: ${donor}`
    );
  });

  const actionRows: Array<Array<{ text: string; callback_data: string }>> = list.map((n) => [
    { text: `✅ تأیید نود #${n.id}`, callback_data: `adm_node_approve_${n.id}` },
    { text: `❌ رد نود #${n.id}`, callback_data: `adm_node_reject_${n.id}` },
  ]);

  return {
    text:
      `📥 <b>نودهای اهدایی در انتظار تأیید (${list.length})</b>\n\n` +
      (lines.length > 0 ? lines.join('\n\n') : '<i>✅ هیچ نود اهدایی در انتظار تأیید وجود ندارد.</i>'),
    replyMarkup: {
      inline_keyboard: [
        ...actionRows,
        [
          { text: '🔄 بروزرسانی', callback_data: 'adm_pending_nodes' },
          { text: '🔙 بازگشت به پنل مدیریت', callback_data: 'adm_panel_home' },
        ],
      ],
    },
  };
}

interface PendingDonationRow {
  id: number;
  user_id: number;
  amount: number;
  receipt_file_id: string;
  status: string;
  created_at: string;
  telegram_id: number | null;
  username: string | null;
  first_name: string;
}

async function buildAdminPendingDonationsView(
  env: Env
): Promise<{ text: string; replyMarkup: Record<string, unknown> }> {
  const rows = await env.DB.prepare(
    `SELECT
       d.id, d.user_id, d.amount, d.receipt_file_id, d.status, d.created_at,
       u.telegram_id, u.username, u.first_name
     FROM donations d
     JOIN users u ON u.id = d.user_id
     WHERE d.status = 'pending'
     ORDER BY d.id ASC
     LIMIT 5`
  ).all<PendingDonationRow>();

  const list = rows.results || [];
  const lines = list.map((d) => {
    const userLabel = d.username
      ? `${escapeHtml(d.first_name)} (@${escapeHtml(d.username)})`
      : `${escapeHtml(d.first_name)} (ID:${d.telegram_id ?? 'N/A'})`;
    const refPreview = d.receipt_file_id.startsWith('text_ref:')
      ? `کد پیگیری: <code>${escapeHtml(d.receipt_file_id.slice('text_ref:'.length, 60))}</code>`
      : `فایل فیش: <code>${escapeHtml(d.receipt_file_id.slice(0, 24))}...</code>`;
    return (
      `💳 <b>فیش #DON-${d.id}</b> — <b>${d.amount.toLocaleString('en-US')} تومان</b>\n` +
      `   👤 ${userLabel}\n` +
      `   🧾 ${refPreview} | 📅 ${escapeHtml(d.created_at.slice(0, 16))}`
    );
  });

  const actionRows: Array<Array<{ text: string; callback_data: string }>> = list.map((d) => [
    { text: `✅ تأیید #DON-${d.id}`, callback_data: `adm_don_approve_${d.id}` },
    { text: `❌ رد #DON-${d.id}`, callback_data: `adm_don_reject_${d.id}` },
  ]);

  return {
    text:
      `💳 <b>فیش‌های مالی در انتظار تأیید (${list.length})</b>\n\n` +
      (lines.length > 0 ? lines.join('\n\n') : '<i>✅ هیچ فیش مالی در انتظار بررسی وجود ندارد.</i>'),
    replyMarkup: {
      inline_keyboard: [
        ...actionRows,
        [
          { text: '🔄 بروزرسانی', callback_data: 'adm_pending_donations' },
          { text: '🔙 بازگشت به پنل مدیریت', callback_data: 'adm_panel_home' },
        ],
      ],
    },
  };
}

function buildAdminAddNodeView(): { text: string; replyMarkup: Record<string, unknown> } {
  return {
    text:
      '➕ <b>افزودن نود یا ساب‌لینک (Serverless D1)</b>\n\n' +
      'بخش هدف برای تخصیص نود یا لینک سابسکریپشن را انتخاب کنید:',
    replyMarkup: {
      inline_keyboard: [
        [{ text: '🌐 بخش رایگان (وب‌گردی + دانلود)', callback_data: 'adm_ob_alloc_free_only' }],
        [{ text: '🎮 بخش گیمینگ (فعال‌سازی خودکار گیمینگ)', callback_data: 'adm_ob_alloc_gaming_only' }],
        [{ text: '💎 بخش آی‌پی ثابت (ترید و جمنای)', callback_data: 'adm_ob_alloc_static_only' }],
        [{ text: '🔥 کل اکوسیستم (همه حالت‌ها)', callback_data: 'adm_ob_alloc_all' }],
        [{ text: '🔙 بازگشت به پنل مدیریت', callback_data: 'adm_panel_home' }],
      ],
    },
  };
}

async function buildAdminNodesView(
  env: Env
): Promise<{ text: string; replyMarkup: Record<string, unknown> }> {
  const [countsRes, recentRes] = await executeD1Batch<Record<string, unknown>>(env.DB, [
    env.DB.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_cnt,
         SUM(CASE WHEN status = 'active' AND allow_gaming = 1 THEN 1 ELSE 0 END) AS gaming_cnt,
         SUM(CASE WHEN status = 'active' AND allow_static_ip = 1 THEN 1 ELSE 0 END) AS static_cnt
       FROM donated_outbounds`
    ),
    env.DB.prepare(
      `SELECT id, tag, protocol, country_code, status, latency_ms, allocation_mode
       FROM donated_outbounds
       ORDER BY id DESC
       LIMIT 10`
    ),
  ]);

  const counts = (countsRes?.results?.[0] as unknown as
    | { total: number; active_cnt: number | null; gaming_cnt: number | null; static_cnt: number | null }
    | undefined) ?? null;

  const recentRows = ((recentRes?.results || []) as unknown) as Array<{
    id: number;
    tag: string;
    protocol: string;
    country_code: string;
    status: string;
    latency_ms: number;
    allocation_mode: string;
  }>;

  const lines = recentRows.map((n) => {
    const icon = n.status === 'active' ? '🟢' : '🔴';
    return `${icon} <b>#${n.id}</b> <code>${escapeHtml(n.protocol)}</code> | ${escapeHtml(n.tag.slice(0, 28))} (${escapeHtml(n.country_code)}) — <code>${escapeHtml(n.allocation_mode)}</code>`;
  });

  const text =
    `📋 <b>لیست نودهای ثبت‌شده</b>\n\n` +
    `🔹 کل نودها: <b>${counts?.total || 0}</b> (فعال: <b>${counts?.active_cnt || 0}</b>)\n` +
    `🎮 گیمینگ فعال: <b>${counts?.gaming_cnt || 0}</b> | 💎 آی‌پی ثابت: <b>${counts?.static_cnt || 0}</b>\n\n` +
    (lines.length > 0 ? lines.join('\n') : '<i>هیچ نودی هنوز ثبت نشده است.</i>');

  return {
    text,
    replyMarkup: {
      inline_keyboard: [
        [
          { text: '➕ افزودن نود جدید', callback_data: 'adm_add_node' },
          { text: '🔄 بروزرسانی', callback_data: 'adm_list_nodes' },
        ],
        [{ text: '🔙 بازگشت به پنل مدیریت', callback_data: 'adm_panel_home' }],
      ],
    },
  };
}

interface AdminSubSummaryRow {
  id: number;
  user_id: number;
  tier: string;
  token: string;
  status: string;
  upload_bytes: number;
  download_bytes: number;
  traffic_limit_bytes: number;
  expires_at: string;
  telegram_id: number | null;
  username: string | null;
  first_name: string;
}

async function buildAdminSubscriptionsView(
  env: Env
): Promise<{ text: string; replyMarkup: Record<string, unknown> }> {
  const rows = await env.DB.prepare(
    `SELECT
       s.id, s.user_id, s.tier, s.token, s.status,
       s.upload_bytes, s.download_bytes, s.traffic_limit_bytes, s.expires_at,
       u.telegram_id, u.username, u.first_name
     FROM subscriptions s
     JOIN users u ON u.id = s.user_id
     ORDER BY s.id DESC
     LIMIT 8`
  ).all<AdminSubSummaryRow>();

  const list = rows.results || [];
  const lines = list.map((r) => {
    const icon = r.status === 'active' ? '🟢' : '🔴';
    const usedGb = formatGb(r.upload_bytes + r.download_bytes);
    const limitGb = formatGb(r.traffic_limit_bytes);
    const identity = r.username
      ? `@${escapeHtml(r.username)}`
      : r.telegram_id
      ? `ID:${r.telegram_id}`
      : escapeHtml(r.first_name);
    return (
      `${icon} <b>#${r.id}</b> ${identity} — <b>${escapeHtml(r.tier)}</b>\n` +
      `   📊 ${usedGb}/${limitGb} GB | 📅 ${escapeHtml(r.expires_at.slice(0, 10))}`
    );
  });

  const subButtons: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < list.length; i += 2) {
    const rowBtns: Array<{ text: string; callback_data: string }> = [];
    for (const item of list.slice(i, i + 2)) {
      const label = item.username ? `@${item.username}` : `#${item.id} (${item.first_name.slice(0, 10)})`;
      rowBtns.push({ text: `⚙️ ${label}`, callback_data: `adm_sub_view_${item.id}` });
    }
    subButtons.push(rowBtns);
  }

  return {
    text:
      `👥 <b>مدیریت سابسکریپشن‌ها (آخرین اشتراک‌ها)</b>\n\n` +
      (lines.length > 0 ? lines.join('\n') : '<i>هیچ سابسکریپشنی یافت نشد.</i>') +
      `\n\nبرای ویرایش پلن، تمدید یا تغییر وضعیت، روی اشتراک کلیک کنید یا جستجو انجام دهید:`,
    replyMarkup: {
      inline_keyboard: [
        ...subButtons,
        [
          { text: '🔎 جستجوی اشتراک', callback_data: 'adm_sub_search' },
          { text: '🔄 بروزرسانی', callback_data: 'adm_manage_subs' },
        ],
        [{ text: '🔙 بازگشت به پنل مدیریت', callback_data: 'adm_panel_home' }],
      ],
    },
  };
}

async function buildAdminSubscriptionDetailView(
  env: Env,
  subId: number
): Promise<{ text: string; replyMarkup: Record<string, unknown> } | null> {
  const row = await env.DB.prepare(
    `SELECT
       s.id, s.user_id, s.tier, s.token, s.status,
       s.upload_bytes, s.download_bytes, s.traffic_limit_bytes, s.expires_at,
       u.telegram_id, u.username, u.first_name
     FROM subscriptions s
     JOIN users u ON u.id = s.user_id
     WHERE s.id = ?
     LIMIT 1`
  )
    .bind(subId)
    .first<AdminSubSummaryRow>();

  if (!row) return null;

  const usedGb = formatGb(row.upload_bytes + row.download_bytes);
  const limitGb = formatGb(row.traffic_limit_bytes);
  const statusLabel = row.status === 'active' ? '🟢 فعال' : `🔴 ${escapeHtml(row.status)}`;
  const toggleBtnText = row.status === 'active' ? '⏸ غیرفعال‌سازی اشتراک' : '▶️ فعال‌سازی اشتراک';

  return {
    text:
      `⚙️ <b>مدیریت اشتراک #${row.id}</b>\n\n` +
      `👤 کاربر: <b>${escapeHtml(row.first_name)}</b>` +
      (row.username ? ` (@${escapeHtml(row.username)})` : '') +
      `\n🆔 Telegram ID: <code>${row.telegram_id ?? 'N/A'}</code>\n` +
      `💎 پلن فعلی: <b>${escapeHtml(row.tier)}</b>\n` +
      `📌 وضعیت: ${statusLabel}\n` +
      `📊 مصرف: <b>${usedGb} GB</b> از <b>${limitGb} GB</b>\n` +
      `📅 انقضا: <code>${escapeHtml(row.expires_at.slice(0, 10))}</code>\n` +
      `🔑 توکن: <code>${escapeHtml(row.token)}</code>`,
    replyMarkup: {
      inline_keyboard: [
        [
          { text: 'Lite', callback_data: `adm_sub_tier_${row.id}_lite` },
          { text: 'Pro', callback_data: `adm_sub_tier_${row.id}_pro` },
          { text: 'Flow+', callback_data: `adm_sub_tier_${row.id}_flow` },
        ],
        [
          { text: 'Gaming', callback_data: `adm_sub_tier_${row.id}_gaming` },
          { text: 'Static IP', callback_data: `adm_sub_tier_${row.id}_static` },
        ],
        [
          { text: '📅 تمدید +۳۰ روز', callback_data: `adm_sub_ext_${row.id}` },
          { text: '♻️ ریست حجم', callback_data: `adm_sub_rst_${row.id}` },
        ],
        [{ text: toggleBtnText, callback_data: `adm_sub_tgl_${row.id}` }],
        [
          { text: '👥 لیست اشتراک‌ها', callback_data: 'adm_manage_subs' },
          { text: '🔙 پنل مدیریت', callback_data: 'adm_panel_home' },
        ],
      ],
    },
  };
}

async function findSubscriptionForAdmin(db: D1Database, rawQuery: string): Promise<number | null> {
  const q = rawQuery.trim();
  if (!q) return null;

  const cleanHandle = q.replace(/^@/, '');
  const numericVal = /^\d+$/.test(cleanHandle) ? Number(cleanHandle) : null;

  if (numericVal !== null) {
    const byTg = await db
      .prepare(
        `SELECT s.id FROM subscriptions s
         JOIN users u ON u.id = s.user_id
         WHERE u.telegram_id = ?
         ORDER BY s.id DESC LIMIT 1`
      )
      .bind(numericVal)
      .first<{ id: number }>();
    if (byTg) return byTg.id;

    const bySubId = await db
      .prepare('SELECT id FROM subscriptions WHERE id = ? LIMIT 1')
      .bind(numericVal)
      .first<{ id: number }>();
    if (bySubId) return bySubId.id;
  }

  const byToken = await db
    .prepare('SELECT id FROM subscriptions WHERE token = ? LIMIT 1')
    .bind(q)
    .first<{ id: number }>();
  if (byToken) return byToken.id;

  const byUsername = await db
    .prepare(
      `SELECT s.id FROM subscriptions s
       JOIN users u ON u.id = s.user_id
       WHERE lower(u.username) = lower(?)
       ORDER BY s.id DESC LIMIT 1`
    )
    .bind(cleanHandle)
    .first<{ id: number }>();
  return byUsername?.id ?? null;
}

async function buildAdminStatsView(
  env: Env
): Promise<{ text: string; replyMarkup: Record<string, unknown> }> {
  const [
    userStatsRes,
    subStatsRes,
    tierBreakdownRes,
    nodeStatsRes,
    sourceStatsRes,
    pendingStatsRes,
  ] = await executeD1Batch<Record<string, unknown>>(env.DB, [
    env.DB.prepare(
      `SELECT
         COUNT(*) AS total_users,
         SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) AS admin_users,
         SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_users
       FROM users`
    ),
    env.DB.prepare(
      `SELECT
         COUNT(*) AS total_subs,
         SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_subs,
         SUM(upload_bytes + download_bytes) AS total_bytes
       FROM subscriptions`
    ),
    env.DB.prepare(
      `SELECT tier, COUNT(*) AS cnt FROM subscriptions WHERE status = 'active' GROUP BY tier`
    ),
    env.DB.prepare(
      `SELECT
         COUNT(*) AS total_nodes,
         SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_nodes,
         SUM(CASE WHEN is_official = 1 THEN 1 ELSE 0 END) AS official_nodes,
         SUM(CASE WHEN status = 'active' AND allow_gaming = 1 THEN 1 ELSE 0 END) AS gaming_nodes,
         SUM(CASE WHEN status = 'active' AND allow_static_ip = 1 THEN 1 ELSE 0 END) AS static_nodes
       FROM donated_outbounds`
    ),
    env.DB.prepare('SELECT COUNT(*) AS total_sources FROM subscription_sources'),
    env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM donated_outbounds WHERE status = 'pending') AS pending_nodes,
         (SELECT COUNT(*) FROM donations WHERE status = 'pending') AS pending_donations,
         (SELECT COUNT(*) FROM support_tickets WHERE status = 'open') AS open_tickets`
    ),
  ]);

  const userStats = (userStatsRes?.results?.[0] as unknown as
    | { total_users: number; admin_users: number | null; active_users: number | null }
    | undefined) ?? null;
  const subStats = (subStatsRes?.results?.[0] as unknown as
    | { total_subs: number; active_subs: number | null; total_bytes: number | null }
    | undefined) ?? null;
  const tierBreakdown = {
    results: ((tierBreakdownRes?.results || []) as unknown) as Array<{ tier: string; cnt: number }>,
  };
  const nodeStats = (nodeStatsRes?.results?.[0] as unknown as
    | {
        total_nodes: number;
        active_nodes: number | null;
        official_nodes: number | null;
        gaming_nodes: number | null;
        static_nodes: number | null;
      }
    | undefined) ?? null;
  const sourceStats = (sourceStatsRes?.results?.[0] as unknown as
    | { total_sources: number }
    | undefined) ?? null;
  const pendingStats = (pendingStatsRes?.results?.[0] as unknown as
    | { pending_nodes: number; pending_donations: number; open_tickets: number }
    | undefined) ?? null;

  const gamingLive =
    (nodeStats?.gaming_nodes || 0) > 0 || (await hasActiveGamingOutbounds(env.DB, env.SENTRA_KV));
  const tierLines = (tierBreakdown.results || [])
    .map((t) => `   • ${escapeHtml(t.tier)}: <b>${t.cnt}</b>`)
    .join('\n');

  const text =
    `📊 <b>آمار زنده Sentra Platform (Cloudflare D1)</b>\n\n` +
    `👥 <b>کاربران:</b> ${userStats?.total_users || 0} (فعال: ${userStats?.active_users || 0} | ادمین: ${userStats?.admin_users || 0})\n` +
    `🎫 <b>سابسکریپشن‌ها:</b> ${subStats?.total_subs || 0} (فعال: ${subStats?.active_subs || 0})\n` +
    (tierLines ? `${tierLines}\n` : '') +
    `📈 <b>کل ترافیک مصرفی:</b> ${formatGb(subStats?.total_bytes || 0)} GB\n\n` +
    `🌐 <b>نودها و اوتباندها:</b> ${nodeStats?.total_nodes || 0} (سالم/فعال: ${nodeStats?.active_nodes || 0} | رسمی: ${nodeStats?.official_nodes || 0})\n` +
    `   • گیمینگ فعال: <b>${nodeStats?.gaming_nodes || 0}</b> | آی‌پی ثابت: <b>${nodeStats?.static_nodes || 0}</b>\n` +
    `   • منابع سابسکریپشن ثبت‌شده: <b>${sourceStats?.total_sources || 0}</b>\n\n` +
    `⏳ <b>صف بررسی مدیریت:</b> نود اهدایی (${pendingStats?.pending_nodes || 0}) | فیش مالی (${pendingStats?.pending_donations || 0}) | تیکت باز (${pendingStats?.open_tickets || 0})\n` +
    `🎮 <b>وضعیت بخش گیمینگ:</b> ${gamingLive ? 'فعال ✅' : 'به‌زودی ⏳'}`;

  return {
    text,
    replyMarkup: {
      inline_keyboard: [
        [{ text: '🔄 بروزرسانی آمار', callback_data: 'adm_stats' }],
        [
          { text: '🔙 پنل مدیریت', callback_data: 'adm_panel_home' },
          { text: '🏠 منوی اصلی', callback_data: 'user_menu_home' },
        ],
      ],
    },
  };
}

async function sendOrEditView(
  env: Env,
  chatId: number,
  messageId: number | undefined,
  view: { text: string; replyMarkup: Record<string, unknown> }
): Promise<void> {
  if (messageId) {
    const edited = await tgEditMessageText(env, chatId, messageId, view.text, view.replyMarkup);
    if (edited) return;
  }
  await tgSendMessage(env, chatId, view.text, view.replyMarkup);
}

// ==============================================================================
// User Panel View Builders (Shared between Reply Keyboard & Inline Callbacks)
// ==============================================================================

function buildCancelStateInlineMarkup(): Record<string, unknown> {
  return {
    inline_keyboard: [[{ text: '❌ انصراف و بازگشت', callback_data: 'user_cancel_state' }]],
  };
}

function buildUserMenuHomeView(
  user: UserRow | null,
  sub: SubscriptionRow | null,
  isAdmin: boolean
): { text: string; replyMarkup: Record<string, unknown> } {
  const greeting = user
    ? `👋 <b>منوی سریع کاربری Sentra</b>\n\n` +
      `👤 کاربر: <b>${escapeHtml(user.first_name)}</b>\n` +
      `💎 پلن فعال: <b>${escapeHtml(sub?.tier || 'Sentra Lite')}</b>\n\n` +
      `بخش مورد نظر خود را انتخاب کنید:`
    : `👋 <b>به Sentra Platform خوش آمدید!</b>\n\nبرای دسترسی به اشتراک رایگان و کانفیگ‌ها ابتدا ثبت‌نام یا ورود انجام دهید:`;

  const inlineRows: Array<Array<{ text: string; callback_data: string }>> = user
    ? [
        [
          { text: '👤 وضعیت حساب و حجم', callback_data: 'user_account' },
          { text: '🔑 دریافت لینک اشتراک', callback_data: 'user_get_sub' },
        ],
        [
          { text: '🍏 کانفیگ iOS', callback_data: 'user_ios_menu' },
          { text: '💎 ارتقای اشتراک', callback_data: 'user_upgrade' },
        ],
        [
          { text: '🤝 اهدای نود / کانفیگ', callback_data: 'user_donate_outbound' },
          { text: '📖 راهنمای اتصال', callback_data: 'user_guide' },
        ],
        [
          { text: '📥 دانلود اپلیکیشن', callback_data: 'user_download_app' },
          { text: '🎫 پشتیبانی و تیکت', callback_data: 'user_support' },
        ],
      ]
    : [
        [{ text: '✨ ثبت‌نام جدید (فوری)', callback_data: 'auth_register_new' }],
        [{ text: '🔑 ورود با حساب برنامه', callback_data: 'auth_login_app' }],
        [{ text: '📖 راهنمای اتصال', callback_data: 'user_guide' }],
      ];

  if (isAdmin) {
    inlineRows.push([{ text: '🛠 ورود به پنل مدیریت', callback_data: 'adm_panel_home' }]);
  }

  return {
    text: greeting,
    replyMarkup: { inline_keyboard: inlineRows },
  };
}

function buildUserAccountView(
  user: UserRow,
  sub: SubscriptionRow
): { text: string; replyMarkup: Record<string, unknown> } {
  const usedBytes = sub.upload_bytes + sub.download_bytes;
  const remainingBytes = Math.max(0, sub.traffic_limit_bytes - usedBytes);
  const statusLabel =
    sub.status === 'active'
      ? '🟢 فعال'
      : sub.status === 'expired'
      ? '🟡 منقضی‌شده'
      : sub.status === 'depleted'
      ? '🟠 اتمام حجم'
      : '🔴 غیرفعال';

  return {
    text:
      `👤 <b>وضعیت حساب کاربری شما</b>\n\n` +
      `🆔 شناسه یکتا: <code>${escapeHtml(user.user_uuid)}</code>\n` +
      `💎 نوع اشتراک: <b>${escapeHtml(sub.tier)}</b>\n` +
      `📌 وضعیت: ${statusLabel}\n` +
      `📊 حجم مصرفی: <b>${formatGb(usedBytes)} GB</b> از <b>${formatGb(sub.traffic_limit_bytes)} GB</b>\n` +
      `🔋 حجم باقیمانده: <b>${formatGb(remainingBytes)} GB</b>\n` +
      `📱 حداکثر دستگاه هم‌زمان: <b>${sub.max_concurrent_devices}</b>\n` +
      `📅 تاریخ انقضا: <code>${escapeHtml(sub.expires_at.slice(0, 10))}</code>`,
    replyMarkup: {
      inline_keyboard: [
        [
          { text: '🔑 دریافت لینک اشتراک و کد', callback_data: 'user_get_sub' },
          { text: '💎 ارتقای اشتراک', callback_data: 'user_upgrade' },
        ],
        [
          { text: '🎫 تیکت‌های من', callback_data: 'user_support' },
          { text: '🔄 بروزرسانی', callback_data: 'user_account' },
        ],
        [{ text: '🔙 منوی اصلی', callback_data: 'user_menu_home' }],
      ],
    },
  };
}

async function buildUserSubscriptionView(
  env: Env,
  user: UserRow,
  sub: SubscriptionRow
): Promise<{ text: string; replyMarkup: Record<string, unknown> }> {
  const otp = generateNumericCode(8);
  const expires = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  await env.DB.prepare(
    'UPDATE users SET auth_code = ?, auth_code_expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  )
    .bind(otp, expires, user.id)
    .run();

  const baseUrl = (env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const singboxUrl = baseUrl
    ? `${baseUrl}/sub/${sub.token}?format=singbox`
    : `/sub/${sub.token}?format=singbox`;
  const v2rayUrl = baseUrl ? `${baseUrl}/sub/${sub.token}` : `/sub/${sub.token}`;

  return {
    text:
      `🔑 <b>اطلاعات اتصال و لینک اشتراک شما</b>\n\n` +
      `🔢 <b>کد ورود ۸ رقمی اپلیکیشن Sentra Connect (اعتبار ۵ دقیقه):</b>\n<code>${otp}</code>\n\n` +
      `🔗 <b>لینک سابسکریپشن Sing-box 1.14+ (پیشنهادی):</b>\n<code>${escapeHtml(singboxUrl)}</code>\n\n` +
      `🌐 <b>لینک سابسکریپشن عمومی (V2Ray / Base64):</b>\n<code>${escapeHtml(v2rayUrl)}</code>\n\n` +
      `💡 برای کپی، روی کد یا لینک بالا ضربه بزنید.`,
    replyMarkup: {
      inline_keyboard: [
        [
          { text: '🍏 کانفیگ اختصاصی iOS', callback_data: 'user_ios_menu' },
          { text: '📖 راهنمای اتصال', callback_data: 'user_guide' },
        ],
        [
          { text: '🔄 تولید کد جدید', callback_data: 'user_get_sub' },
          { text: '👤 وضعیت حساب', callback_data: 'user_account' },
        ],
        [{ text: '🔙 منوی اصلی', callback_data: 'user_menu_home' }],
      ],
    },
  };
}

async function buildUserIosMenuView(
  env: Env,
  sub: SubscriptionRow
): Promise<{ text: string; replyMarkup: Record<string, unknown> }> {
  const gamingLive = await hasActiveGamingOutbounds(env.DB, env.SENTRA_KV);
  const canStatic = tierHasStaticIp(sub.tier);
  const canGaming = tierHasGaming(sub.tier);

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
  } else {
    buttons.push([{ text: '🔒 آی‌پی ثابت (نیازمند ارتقا)', callback_data: 'ios_mode_static_ip' }]);
  }
  buttons.push([{ text: '🔙 منوی اصلی', callback_data: 'user_menu_home' }]);

  return {
    text:
      '🍏 <b>دریافت کانفیگ اختصاصی iOS</b>\n\n' +
      'حالت اتصال مورد نظر خود را انتخاب کنید تا لینک سابسکریپشن SFI / Streisand یا پروفایل WireGuard برای شما ساخته شود:',
    replyMarkup: { inline_keyboard: buttons },
  };
}

function buildUserUpgradeView(
  env: Env,
  sub: SubscriptionRow | null
): { text: string; replyMarkup: Record<string, unknown> } {
  const proPrice = Number(env.PRO_SUBSCRIPTION_PRICE || '150000') || 150000;
  const flowPrice = Math.round(proPrice * 2);

  return {
    text:
      `💎 <b>ارتقای اشتراک و حمایت از Sentra</b>\n\n` +
      `پلن فعلی شما: <b>${escapeHtml(sub?.tier || 'Sentra Lite')}</b>\n\n` +
      `🚀 <b>Sentra Pro (۲۰۰ گیگابایت / ماهانه)</b>\n` +
      `• دسترسی به نودهای پرسرعت + آی‌پی ثابت (ترید و جمنای)\n` +
      `• مبلغ حمایت: <b>${proPrice.toLocaleString('en-US')} تومان</b>\n\n` +
      `🔥 <b>Sentra Flow+ (۵۰۰ گیگابایت / ماهانه)</b>\n` +
      `• تمام امکانات Pro + اولویت ترافیک و دسترسی کامل به گیمینگ پس از فعال‌سازی\n` +
      `• مبلغ حمایت: <b>${flowPrice.toLocaleString('en-US')} تومان</b>\n\n` +
      `💡 همچنین می‌توانید با <b>اهدای اوتباند فعال</b> به اکوسیستم کمک کنید.`,
    replyMarkup: {
      inline_keyboard: [
        [{ text: '💳 ارسال فیش واریزی پلن Pro', callback_data: 'user_submit_receipt_pro' }],
        [{ text: '💳 ارسال فیش واریزی پلن Flow+', callback_data: 'user_submit_receipt_flow' }],
        [{ text: '🤝 اهدای نود / اوتباند', callback_data: 'user_donate_outbound' }],
        [{ text: '🔙 منوی اصلی', callback_data: 'user_menu_home' }],
      ],
    },
  };
}

function buildUserGuideView(
  platform: 'overview' | 'android' | 'ios' | 'windows' = 'overview'
): { text: string; replyMarkup: Record<string, unknown> } {
  let text =
    '📖 <b>راهنمای اتصال به Sentra Platform</b>\n\n' +
    'سیستم‌عامل خود را از دکمه‌های زیر انتخاب کنید تا مراحل اتصال نمایش داده شود:';

  if (platform === 'android') {
    text =
      '🤖 <b>راهنمای اتصال در اندروید</b>\n\n' +
      '۱. اپلیکیشن <b>Sentra Connect</b> (یا Hiddify / sing-box SFA) را نصب کنید.\n' +
      '۲. از بخش «🔑 دریافت کانفیگ و کد اتصال»، کد ۸ رقمی یا لینک Sing-box 1.14+ را کپی کنید.\n' +
      '۳. در Sentra Connect کد ۸ رقمی را وارد کنید یا در sing-box لینک سابسکریپشن را Import نمایید.\n' +
      '۴. روی دکمه اتصال بزنید و مجوز VPN را تأیید کنید.';
  } else if (platform === 'ios') {
    text =
      '🍏 <b>راهنمای اتصال در iOS (آیفون و آیپد)</b>\n\n' +
      '۱. یکی از اپلیکیشن‌های <b>sing-box (SFI)</b>، <b>Streisand</b> یا <b>Hiddify</b> را از App Store نصب کنید.\n' +
      '۲. از بخش «🍏 دریافت کانفیگ iOS» حالت مورد نظر را انتخاب کرده و لینک اشتراک را کپی کنید.\n' +
      '۳. در برنامه گزینه <b>Add Profile / Subscription</b> را بزنید و لینک را وارد کنید.\n' +
      '۴. پروفایل را انتخاب کرده و اتصال را فعال کنید.';
  } else if (platform === 'windows') {
    text =
      '💻 <b>راهنمای اتصال در ویندوز / مک</b>\n\n' +
      '۱. اپلیکیشن <b>Sentra Connect</b> یا <b>Hiddify / sing-box</b> نسخه دسکتاپ را دانلود و اجرا کنید.\n' +
      '۲. از منوی ربات روی «🔑 دریافت کانفیگ و کد اتصال» بزنید.\n' +
      '۳. کد ورود ۸ رقمی را در Sentra Connect وارد کنید (یا لینک Sing-box 1.14+ را در کلاینت اضافه نمایید).\n' +
      '۴. حالت اتصال (وب‌گردی، دانلود یا آی‌پی ثابت) را انتخاب و متصل شوید.';
  }

  return {
    text,
    replyMarkup: {
      inline_keyboard: [
        [
          { text: '🤖 اندروید', callback_data: 'user_guide_android' },
          { text: '🍏 iOS', callback_data: 'user_guide_ios' },
          { text: '💻 ویندوز', callback_data: 'user_guide_windows' },
        ],
        [
          { text: '📥 دانلود اپلیکیشن', callback_data: 'user_download_app' },
          { text: '🔑 دریافت لینک اشتراک', callback_data: 'user_get_sub' },
        ],
        [{ text: '🔙 منوی اصلی', callback_data: 'user_menu_home' }],
      ],
    },
  };
}

async function buildUserDownloadAppView(
  env: Env
): Promise<{ text: string; replyMarkup: Record<string, unknown> }> {
  const releases = await env.DB.prepare(
    'SELECT platform, version, file_name, file_size_mb, changelog, updated_at FROM app_releases ORDER BY platform ASC'
  ).all<{
    platform: string;
    version: string;
    file_name: string;
    file_size_mb: number;
    changelog: string;
    updated_at: string;
  }>();

  const rows = releases.results || [];
  const win = rows.find((r) => r.platform === 'windows');
  const andr = rows.find((r) => r.platform === 'android');

  const lines: string[] = [];
  if (andr) {
    lines.push(
      `🤖 <b>اندروید:</b> نسخه <code>${escapeHtml(andr.version)}</code> (${andr.file_size_mb.toFixed(1)} MB)` +
        (andr.changelog ? `\n   📝 ${escapeHtml(andr.changelog.slice(0, 120))}` : '')
    );
  } else {
    lines.push('🤖 <b>اندروید:</b> فایل نصبی به‌زودی بارگذاری می‌شود (فعلاً از sing-box SFA یا Hiddify استفاده کنید).');
  }
  if (win) {
    lines.push(
      `💻 <b>ویندوز:</b> نسخه <code>${escapeHtml(win.version)}</code> (${win.file_size_mb.toFixed(1)} MB)` +
        (win.changelog ? `\n   📝 ${escapeHtml(win.changelog.slice(0, 120))}` : '')
    );
  } else {
    lines.push('💻 <b>ویندوز:</b> فایل نصبی به‌زودی بارگذاری می‌شود (فعلاً از Hiddify یا sing-box 1.14+ استفاده کنید).');
  }

  return {
    text:
      `📥 <b>دانلود اپلیکیشن رسمی Sentra Connect</b>\n\n` +
      `${lines.join('\n\n')}\n\n` +
      `پلتفرم مورد نظر خود را برای دریافت فایل انتخاب کنید:`,
    replyMarkup: {
      inline_keyboard: [
        [
          { text: '🤖 دانلود نسخه اندروید', callback_data: 'user_dl_android' },
          { text: '💻 دانلود نسخه ویندوز', callback_data: 'user_dl_windows' },
        ],
        [
          { text: '📖 راهنمای اتصال', callback_data: 'user_guide' },
          { text: '🔙 منوی اصلی', callback_data: 'user_menu_home' },
        ],
      ],
    },
  };
}

async function buildUserSupportView(
  env: Env,
  user: UserRow
): Promise<{ text: string; replyMarkup: Record<string, unknown> }> {
  const tickets = await env.DB.prepare(
    `SELECT ticket_number, category, subject, status, created_at
     FROM support_tickets
     WHERE user_id = ?
     ORDER BY id DESC
     LIMIT 5`
  )
    .bind(user.id)
    .all<{
      ticket_number: string;
      category: string;
      subject: string;
      status: string;
      created_at: string;
    }>();

  const list = tickets.results || [];
  const statusMap: Record<string, string> = {
    open: '🟢 باز',
    awaiting_user: '🟡 در انتظار پاسخ شما',
    investigating: '🔵 در حال بررسی',
    resolved: '✅ حل‌شده',
    closed: '⚪️ بسته‌شده',
  };

  const ticketLines = list.map(
    (t) =>
      `• <code>${escapeHtml(t.ticket_number)}</code> — ${statusMap[t.status] || escapeHtml(t.status)}\n` +
      `  ${escapeHtml(t.subject.slice(0, 60))}`
  );

  return {
    text:
      `🎫 <b>پشتیبانی Sentra Platform</b>\n\n` +
      (ticketLines.length > 0
        ? `<b>آخرین تیکت‌های شما:</b>\n${ticketLines.join('\n')}\n\n`
        : '<i>شما هنوز تیکت پشتیبانی ثبت نکرده‌اید.</i>\n\n') +
      `برای ثبت تیکت جدید، موضوع مشکل خود را انتخاب کنید:`,
    replyMarkup: {
      inline_keyboard: [
        [
          { text: '🌐 مشکل اتصال', callback_data: 'user_ticket_new_connection' },
          { text: '💳 پرداخت و اشتراک', callback_data: 'user_ticket_new_billing' },
        ],
        [
          { text: '📱 راه‌اندازی دستگاه', callback_data: 'user_ticket_new_device_setup' },
          { text: '💬 سایر موارد', callback_data: 'user_ticket_new_other' },
        ],
        [{ text: '🔙 منوی اصلی', callback_data: 'user_menu_home' }],
      ],
    },
  };
}

// ==============================================================================
// Callback Query Handler (Inline Keyboards)
// ==============================================================================

async function handleCallbackQuery(
  env: Env,
  q: TelegramCallbackQuery,
  ctx?: ExecutionContext
): Promise<void> {
  const chatId = q.message?.chat.id || q.from.id;
  const messageId = q.message?.message_id;
  const telegramId = q.from.id;
  const data = (q.data || '').trim();

  // 1. ALWAYS acknowledge the callback query first with await to clear Telegram's loading spinner
  await tgAnswerCallbackQuery(env, q.id);

  try {
    const isAdmin = await resolveIsAdmin(env, telegramId);

    // --- Auth Callbacks ---
    if (data === 'auth_register_new') {
      const { user, sub, isNewUser } = await ensureTelegramUserAndSubscription(
        env.DB,
        q.from,
        isEnvAdmin(env, telegramId)
      );
      const effectiveIsAdmin = isEnvAdmin(env, telegramId) || user.role === 'admin';
      if (messageId) {
        await tgEditMessageText(
          env,
          chatId,
          messageId,
          isNewUser
            ? `🎉 <b>ثبت‌نام شما با موفقیت انجام شد!</b>\n\n🆔 <b>کد شناسایی یکتا:</b> <code>${escapeHtml(user.user_uuid)}</code>\n💎 <b>پلن فعال:</b> ${escapeHtml(sub.tier)} (۱۰ گیگابایت)`
            : `✅ حساب شما از قبل فعال است.\n🆔 شناسه یکتا: <code>${escapeHtml(user.user_uuid)}</code>`
        );
      }
      await tgSendMessage(
        env,
        chatId,
        `از این پس می‌توانید وضعیت اشتراک، لینک اتصال و پشتیبانی را از منوی زیر مدیریت کنید.`,
        buildMainKeyboard(true, effectiveIsAdmin)
      );
      return;
    }

    if (data === 'auth_login_app') {
      await setBotState(env.DB, telegramId, 'awaiting_login_username');
      await tgSendMessage(
        env,
        chatId,
        '🔐 <b>ورود با حساب اپلیکیشن Sentra</b>\n\nلطفاً <b>نام کاربری (Username)</b> حساب خود در اپلیکیشن را ارسال کنید:',
        buildCancelStateInlineMarkup()
      );
      return;
    }

    // --- Cancel FSM State ---
    if (data === 'user_cancel_state') {
      await clearBotState(env.DB, telegramId);
      const record = await getUserAndSubByTelegramId(env.DB, telegramId);
      const effectiveIsAdmin = isAdmin || record?.user.role === 'admin';
      await sendOrEditView(
        env,
        chatId,
        messageId,
        buildUserMenuHomeView(record?.user || null, record?.sub || null, effectiveIsAdmin)
      );
      return;
    }

    // --- User Home Menu ---
    if (data === 'user_menu_home' || data === 'back_to_main') {
      await clearBotState(env.DB, telegramId);
      const record = await getUserAndSubByTelegramId(env.DB, telegramId);
      const effectiveIsAdmin = isAdmin || record?.user.role === 'admin';
      await sendOrEditView(
        env,
        chatId,
        messageId,
        buildUserMenuHomeView(record?.user || null, record?.sub || null, effectiveIsAdmin)
      );
      return;
    }

    // --- User Account Status ---
    if (data === 'user_account') {
      const { user, sub } = await ensureTelegramUserAndSubscription(
        env.DB,
        q.from,
        isEnvAdmin(env, telegramId)
      );
      await sendOrEditView(env, chatId, messageId, buildUserAccountView(user, sub));
      return;
    }

    // --- User Subscription Link & OTP Code ---
    if (data === 'user_get_sub') {
      const { user, sub } = await ensureTelegramUserAndSubscription(
        env.DB,
        q.from,
        isEnvAdmin(env, telegramId)
      );
      const view = await buildUserSubscriptionView(env, user, sub);
      await sendOrEditView(env, chatId, messageId, view);
      return;
    }

    // --- User iOS Menu & Mode Selection ---
    if (data === 'user_ios_menu') {
      const { sub } = await ensureTelegramUserAndSubscription(
        env.DB,
        q.from,
        isEnvAdmin(env, telegramId)
      );
      const view = await buildUserIosMenuView(env, sub);
      await sendOrEditView(env, chatId, messageId, view);
      return;
    }

    if (data.startsWith('ios_mode_')) {
      const mode = data.slice('ios_mode_'.length);
      const { sub } = await ensureTelegramUserAndSubscription(
        env.DB,
        q.from,
        isEnvAdmin(env, telegramId)
      );

      if (mode === 'gaming') {
        const gamingLive = await hasActiveGamingOutbounds(env.DB, env.SENTRA_KV);
        if (!gamingLive) {
          await tgSendMessage(
            env,
            chatId,
            '🎮 <b>بخش گیمینگ به‌زودی راه‌اندازی می‌شود!</b>\n\nبه‌محض افزودن سرور اختصاصی گیمینگ، کانفیگ WireGuard کم‌تاخیر iOS به صورت خودکار فعال خواهد شد.',
            { inline_keyboard: [[{ text: '🔙 بازگشت به منوی iOS', callback_data: 'user_ios_menu' }]] }
          );
          return;
        }
        if (!tierHasGaming(sub.tier)) {
          await tgSendMessage(
            env,
            chatId,
            '🔒 دسترسی به کانفیگ گیمینگ WireGuard نیازمند اشتراک گیمینگ یا ویژه است.',
            {
              inline_keyboard: [
                [{ text: '💎 ارتقای اشتراک', callback_data: 'user_upgrade' }],
                [{ text: '🔙 بازگشت', callback_data: 'user_ios_menu' }],
              ],
            }
          );
          return;
        }
        const serverHost = env.PUBLIC_BASE_URL
          ? new URL(env.PUBLIC_BASE_URL).hostname
          : 'vpn.sentra.local';
        const wg = await generateWireguardGamingProfile({
          subscription: sub,
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
            `🔹 پلن: <b>${escapeHtml(sub.tier)}</b>\n\n` +
            `فایل بالا را با اپلیکیشن رسمی WireGuard در iOS باز و فعال کنید.`
        );
        return;
      }

      if (mode === 'static_ip' && !tierHasStaticIp(sub.tier)) {
        await tgSendMessage(
          env,
          chatId,
          '🔒 حالت آی‌پی ثابت مخصوص پلن‌های ویژه (Pro / Flow+ / Static IP) است.',
          {
            inline_keyboard: [
              [{ text: '💎 ارتقای اشتراک', callback_data: 'user_upgrade' }],
              [{ text: '🔙 بازگشت به منوی iOS', callback_data: 'user_ios_menu' }],
            ],
          }
        );
        return;
      }

      const baseUrl = (env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
      const subUrl = baseUrl
        ? `${baseUrl}/sub/${sub.token}?format=singbox&mode=${encodeURIComponent(mode)}`
        : `/sub/${sub.token}?format=singbox&mode=${encodeURIComponent(mode)}`;
      await sendOrEditView(env, chatId, messageId, {
        text:
          `🍏 <b>پروفایل iOS (${escapeHtml(mode)}) آماده است</b>\n\n` +
          `لینک زیر را در اپلیکیشن‌های سازگار با Sing-box 1.14+ (مانند SFI / Streisand / Hiddify) ایمپورت کنید:\n` +
          `<code>${escapeHtml(subUrl)}</code>`,
        replyMarkup: {
          inline_keyboard: [
            [{ text: '📖 راهنمای اتصال iOS', callback_data: 'user_guide_ios' }],
            [
              { text: '🔙 انتخاب حالت دیگر', callback_data: 'user_ios_menu' },
              { text: '🏠 منوی اصلی', callback_data: 'user_menu_home' },
            ],
          ],
        },
      });
      return;
    }

    // --- User Upgrade & Payment Receipt ---
    if (data === 'user_upgrade') {
      const record = await getUserAndSubByTelegramId(env.DB, telegramId);
      await sendOrEditView(env, chatId, messageId, buildUserUpgradeView(env, record?.sub || null));
      return;
    }

    if (data === 'user_submit_receipt_pro' || data === 'user_submit_receipt_flow') {
      await ensureTelegramUserAndSubscription(env.DB, q.from, isEnvAdmin(env, telegramId));
      const basePrice = Number(env.PRO_SUBSCRIPTION_PRICE || '150000') || 150000;
      const isFlow = data === 'user_submit_receipt_flow';
      const plan = isFlow ? 'Sentra Flow+' : 'Sentra Pro';
      const amount = isFlow ? Math.round(basePrice * 2) : basePrice;

      await setBotState(env.DB, telegramId, 'awaiting_donation_receipt', { plan, amount });
      await tgSendMessage(
        env,
        chatId,
        `💳 <b>ارسال فیش واریزی برای پلن ${escapeHtml(plan)}</b>\n\n` +
          `💰 مبلغ: <b>${amount.toLocaleString('en-US')} تومان</b>\n\n` +
          `لطفاً <b>تصویر فیش واریزی</b> یا <b>شماره پیگیری تراکنش</b> خود را همینجا ارسال کنید تا پس از تأیید مدیریت، اشتراک شما ارتقا یابد:`,
        buildCancelStateInlineMarkup()
      );
      return;
    }

    // --- User Donate Outbound ---
    if (data === 'user_donate_outbound') {
      await ensureTelegramUserAndSubscription(env.DB, q.from, isEnvAdmin(env, telegramId));
      await setBotState(env.DB, telegramId, 'awaiting_donate_outbound');
      await tgSendMessage(
        env,
        chatId,
        '🤝 <b>اهدای اوتباند (حمایت از Sentra)</b>\n\n' +
          'لینک پروکسی خود (<code>vless://</code>, <code>vmess://</code>, <code>trojan://</code>, <code>hy2://</code>, <code>ss://</code>, <code>wg://</code>) یا کانفیگ JSON سینگ‌باکس را ارسال کنید تا پس از بررسی امنیتی در اکوسیستم ثبت شود:',
        buildCancelStateInlineMarkup()
      );
      return;
    }

    // --- User Connection Guide ---
    if (data === 'user_guide') {
      await sendOrEditView(env, chatId, messageId, buildUserGuideView('overview'));
      return;
    }
    if (data === 'user_guide_android') {
      await sendOrEditView(env, chatId, messageId, buildUserGuideView('android'));
      return;
    }
    if (data === 'user_guide_ios') {
      await sendOrEditView(env, chatId, messageId, buildUserGuideView('ios'));
      return;
    }
    if (data === 'user_guide_windows') {
      await sendOrEditView(env, chatId, messageId, buildUserGuideView('windows'));
      return;
    }

    // --- User Download App ---
    if (data === 'user_download_app') {
      const view = await buildUserDownloadAppView(env);
      await sendOrEditView(env, chatId, messageId, view);
      return;
    }

    if (data === 'user_dl_android' || data === 'user_dl_windows') {
      const platform = data === 'user_dl_android' ? 'android' : 'windows';
      const rel = await env.DB.prepare(
        'SELECT platform, version, telegram_file_id, file_name, file_size_mb, changelog FROM app_releases WHERE platform = ? LIMIT 1'
      )
        .bind(platform)
        .first<{
          platform: string;
          version: string;
          telegram_file_id: string;
          file_name: string;
          file_size_mb: number;
          changelog: string;
        }>();

      if (rel && rel.telegram_file_id) {
        await tgSendDocumentByFileId(
          env,
          chatId,
          rel.telegram_file_id,
          `📥 <b>Sentra Connect (${escapeHtml(platform === 'android' ? 'Android' : 'Windows')})</b>\n` +
            `🔹 نسخه: <code>${escapeHtml(rel.version)}</code> (${rel.file_size_mb.toFixed(1)} MB)\n` +
            (rel.changelog ? `📝 ${escapeHtml(rel.changelog)}` : '')
        );
      } else {
        await tgSendMessage(
          env,
          chatId,
          `📥 نسخه رسمی <b>${platform === 'android' ? 'اندروید' : 'ویندوز'} Sentra Connect</b> هنوز روی ربات بارگذاری نشده است.\n\n` +
            `در حال حاضر می‌توانید لینک اشتراک Sing-box 1.14+ خود را از بخش «🔑 دریافت کانفیگ و کد اتصال» دریافت کرده و در اپلیکیشن‌های <b>Hiddify</b> یا <b>sing-box</b> استفاده کنید.`,
          {
            inline_keyboard: [
              [{ text: '🔑 دریافت لینک اشتراک', callback_data: 'user_get_sub' }],
              [{ text: '📖 راهنمای اتصال', callback_data: platform === 'android' ? 'user_guide_android' : 'user_guide_windows' }],
            ],
          }
        );
      }
      return;
    }

    // --- User Support & Tickets ---
    if (data === 'user_support' || data === 'user_tickets') {
      const { user } = await ensureTelegramUserAndSubscription(
        env.DB,
        q.from,
        isEnvAdmin(env, telegramId)
      );
      const view = await buildUserSupportView(env, user);
      await sendOrEditView(env, chatId, messageId, view);
      return;
    }

    if (data.startsWith('user_ticket_new_')) {
      const rawCat = data.slice('user_ticket_new_'.length);
      const allowedCategories = ['connection', 'billing', 'device_setup', 'performance', 'other'];
      const category = allowedCategories.includes(rawCat) ? rawCat : 'other';
      const catNames: Record<string, string> = {
        connection: 'مشکل اتصال',
        billing: 'پرداخت و اشتراک',
        device_setup: 'راه‌اندازی دستگاه',
        performance: 'سرعت و کیفیت',
        other: 'سایر موارد',
      };

      await ensureTelegramUserAndSubscription(env.DB, q.from, isEnvAdmin(env, telegramId));
      await setBotState(env.DB, telegramId, 'awaiting_support_ticket', { category });
      await tgSendMessage(
        env,
        chatId,
        `🎫 <b>ثبت تیکت پشتیبانی (${escapeHtml(catNames[category])})</b>\n\n` +
          `لطفاً توضیحات مشکل یا درخواست خود را در یک پیام متنی ارسال کنید تا تیکت شما ثبت و پیگیری شود:`,
        buildCancelStateInlineMarkup()
      );
      return;
    }

    // --- Admin Panel Callbacks (Strict Admin Guard for adm_* / admin_*) ---
    if (data.startsWith('adm_') || data.startsWith('admin_')) {
      if (!isAdmin) {
        await tgSendMessage(env, chatId, '⛔ دسترسی غیرمجاز');
        return;
      }

      if (data === 'adm_panel_home' || data === 'admin_panel_home') {
        await clearBotState(env.DB, telegramId);
        await sendOrEditView(env, chatId, messageId, buildAdminPanelHomeView());
        return;
      }

      if (data === 'adm_add_node') {
        await sendOrEditView(env, chatId, messageId, buildAdminAddNodeView());
        return;
      }

      if (data === 'adm_list_nodes') {
        const view = await buildAdminNodesView(env);
        await sendOrEditView(env, chatId, messageId, view);
        return;
      }

      // --- Subscription Sources Management (subscription_sources) ---
      if (data === 'adm_sub_sources') {
        await clearBotState(env.DB, telegramId);
        const view = await buildAdminSubSourcesView(env);
        await sendOrEditView(env, chatId, messageId, view);
        return;
      }

      if (data === 'adm_subsrc_add') {
        await sendOrEditView(env, chatId, messageId, buildAdminAddSubSourceCategoryView());
        return;
      }

      if (data.startsWith('adm_subsrc_cat_')) {
        const rawCat = data.slice('adm_subsrc_cat_'.length);
        if (!VALID_SUB_SOURCE_CATEGORIES.includes(rawCat as SubSourceCategory)) {
          await tgSendMessage(env, chatId, '❌ دسته‌بندی انتخابی نامعتبر است.');
          return;
        }
        await setBotState(env.DB, telegramId, 'admin_awaiting_sub_source', { category: rawCat });
        await tgSendMessage(
          env,
          chatId,
          `🔗 <b>ارسال لینک سابسکریپشن برای دسته <code>${escapeHtml(rawCat)}</code></b>\n\n` +
            `لطفاً آدرس کامل سابسکریپشن (<code>https://...</code>) را ارسال کنید:`,
          buildCancelStateInlineMarkup()
        );
        return;
      }

      if (data.startsWith('adm_subsrc_del_')) {
        const srcId = Number(data.slice('adm_subsrc_del_'.length));
        if (!Number.isInteger(srcId) || srcId <= 0) return;
        await env.DB.prepare('DELETE FROM subscription_sources WHERE id = ?').bind(srcId).run();
        await invalidateNodesCache(env.DB, env.SENTRA_KV);
        const view = await buildAdminSubSourcesView(env);
        await sendOrEditView(env, chatId, messageId, view);
        return;
      }

      // --- Pending Donated Outbounds Review (donated_outbounds status='pending') ---
      if (data === 'adm_pending_nodes') {
        const view = await buildAdminPendingNodesView(env);
        await sendOrEditView(env, chatId, messageId, view);
        return;
      }

      if (data.startsWith('adm_node_approve_') || data.startsWith('adm_node_reject_')) {
        const isApprove = data.startsWith('adm_node_approve_');
        const nodeId = Number(
          data.slice(isApprove ? 'adm_node_approve_'.length : 'adm_node_reject_'.length)
        );
        if (!Number.isInteger(nodeId) || nodeId <= 0) return;

        const nodeRow = await env.DB.prepare(
          `SELECT d.id, d.tag, d.status, u.telegram_id AS donor_telegram_id
           FROM donated_outbounds d
           LEFT JOIN users u ON u.id = d.donor_user_id
           WHERE d.id = ?
           LIMIT 1`
        )
          .bind(nodeId)
          .first<{ id: number; tag: string; status: string; donor_telegram_id: number | null }>();

        if (!nodeRow) {
          await tgSendMessage(env, chatId, '❌ نود مورد نظر یافت نشد.');
          return;
        }

        if (isApprove) {
          await env.DB.prepare(
            `UPDATE donated_outbounds
             SET status = 'active', rejection_reason = NULL,
                 last_online_at = CURRENT_TIMESTAMP, last_checked_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`
          )
            .bind(nodeId)
            .run();
          await invalidateNodesCache(env.DB, env.SENTRA_KV);

          if (nodeRow.donor_telegram_id) {
            await tgSendMessage(
              env,
              nodeRow.donor_telegram_id,
              `✅ <b>نود اهدایی شما تأیید و فعال شد!</b>\n\n` +
                `🏷 نام نود: <b>${escapeHtml(nodeRow.tag)}</b> (#${nodeRow.id})\n` +
                `🤝 از حمایت ارزشمند شما از اکوسیستم Sentra سپاسگزاریم.`
            );
          }
        } else {
          await env.DB.prepare(
            `UPDATE donated_outbounds
             SET status = 'rejected', rejection_reason = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`
          )
            .bind('رد شده توسط مدیریت', nodeId)
            .run();
          await invalidateNodesCache(env.DB, env.SENTRA_KV);

          if (nodeRow.donor_telegram_id) {
            await tgSendMessage(
              env,
              nodeRow.donor_telegram_id,
              `❌ <b>نود اهدایی شما (#${nodeRow.id}) توسط مدیریت رد شد.</b>\n\n` +
                `🏷 نام نود: <b>${escapeHtml(nodeRow.tag)}</b>\n` +
                `در صورت تمایل می‌توانید نود سالم دیگری ارسال کنید.`
            );
          }
        }

        const view = await buildAdminPendingNodesView(env);
        await sendOrEditView(env, chatId, messageId, view);
        return;
      }

      // --- Pending Financial Receipts Review (donations status='pending') ---
      if (data === 'adm_pending_donations') {
        const view = await buildAdminPendingDonationsView(env);
        await sendOrEditView(env, chatId, messageId, view);
        return;
      }

      if (data.startsWith('adm_don_approve_') || data.startsWith('adm_don_reject_')) {
        const isApprove = data.startsWith('adm_don_approve_');
        const donId = Number(
          data.slice(isApprove ? 'adm_don_approve_'.length : 'adm_don_reject_'.length)
        );
        if (!Number.isInteger(donId) || donId <= 0) return;

        const donRow = await env.DB.prepare(
          `SELECT d.id, d.user_id, d.amount, d.status, u.telegram_id, u.first_name
           FROM donations d
           JOIN users u ON u.id = d.user_id
           WHERE d.id = ?
           LIMIT 1`
        )
          .bind(donId)
          .first<{
            id: number;
            user_id: number;
            amount: number;
            status: string;
            telegram_id: number | null;
            first_name: string;
          }>();

        if (!donRow) {
          await tgSendMessage(env, chatId, '❌ فیش مالی مورد نظر یافت نشد.');
          return;
        }

        if (isApprove) {
          const basePrice = Number(env.PRO_SUBSCRIPTION_PRICE || '150000') || 150000;
          const isFlow = donRow.amount >= Math.round(basePrice * 1.8);
          const targetTier = isFlow ? 'Sentra Flow+' : 'Sentra Pro';
          const targetLimit = isFlow
            ? 500 * 1024 * 1024 * 1024
            : 200 * 1024 * 1024 * 1024;

          const userSub = await env.DB.prepare(
            'SELECT id, expires_at FROM subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 1'
          )
            .bind(donRow.user_id)
            .first<{ id: number; expires_at: string }>();

          const approveBatch: D1PreparedStatement[] = [
            env.DB.prepare(
              `UPDATE donations SET status = 'approved', subscription_granted = 1 WHERE id = ?`
            ).bind(donId),
          ];

          if (userSub) {
            const baseMs = Math.max(Date.now(), Date.parse(userSub.expires_at) || Date.now());
            const nextExpires = new Date(baseMs + 30 * 24 * 60 * 60 * 1000).toISOString();
            approveBatch.push(
              env.DB.prepare(
                `UPDATE subscriptions
                 SET tier = ?, traffic_limit_bytes = ?, status = 'active',
                     expires_at = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`
              ).bind(targetTier, targetLimit, nextExpires, userSub.id)
            );
          }
          await executeD1Batch(env.DB, approveBatch);

          if (donRow.telegram_id) {
            await tgSendMessage(
              env,
              donRow.telegram_id,
              `✅ <b>فیش واریزی شما (#DON-${donRow.id}) تأیید شد!</b>\n\n` +
                `💎 اشتراک شما به پلن <b>${escapeHtml(targetTier)}</b> ارتقا یافت و به‌مدت ۳۰ روز فعال شد.\n` +
                `از بخش «👤 حساب کاربری» می‌توانید وضعیت جدید خود را مشاهده کنید.`
            );
          }
        } else {
          await env.DB.prepare(`UPDATE donations SET status = 'rejected' WHERE id = ?`)
            .bind(donId)
            .run();

          if (donRow.telegram_id) {
            await tgSendMessage(
              env,
              donRow.telegram_id,
              `❌ <b>فیش واریزی شما (#DON-${donRow.id}) توسط مدیریت رد شد.</b>\n\n` +
                `در صورت نیاز به پیگیری، از بخش «🎫 پشتیبانی» تیکت ثبت کنید.`
            );
          }
        }

        const view = await buildAdminPendingDonationsView(env);
        await sendOrEditView(env, chatId, messageId, view);
        return;
      }

      if (data === 'adm_manage_subs') {
        await clearBotState(env.DB, telegramId);
        const view = await buildAdminSubscriptionsView(env);
        await sendOrEditView(env, chatId, messageId, view);
        return;
      }

      if (data === 'adm_sub_search') {
        await setBotState(env.DB, telegramId, 'admin_awaiting_sub_lookup');
        await tgSendMessage(
          env,
          chatId,
          '🔎 <b>جستجوی سابسکریپشن</b>\n\nلطفاً یکی از موارد زیر را ارسال کنید:\n• شناسه عددی تلگرام کاربر (Telegram ID)\n• نام کاربری تلگرام (مثلاً <code>@username</code>)\n• شماره اشتراک یا توکن اشتراک',
          buildCancelStateInlineMarkup()
        );
        return;
      }

      if (data.startsWith('adm_sub_view_')) {
        const subId = Number(data.slice('adm_sub_view_'.length));
        if (!Number.isInteger(subId) || subId <= 0) return;
        const view = await buildAdminSubscriptionDetailView(env, subId);
        if (!view) {
          await tgSendMessage(env, chatId, '❌ اشتراک مورد نظر یافت نشد.');
          return;
        }
        await sendOrEditView(env, chatId, messageId, view);
        return;
      }

      if (data.startsWith('adm_sub_tier_')) {
        const match = /^adm_sub_tier_(\d+)_(lite|gaming|static|pro|flow)$/.exec(data);
        if (!match) return;
        const subId = Number(match[1]);
        const cfg = ADMIN_TIER_CONFIG[match[2]];
        await env.DB.prepare(
          `UPDATE subscriptions
           SET tier = ?, traffic_limit_bytes = ?, status = 'active', updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        )
          .bind(cfg.tier, cfg.limitBytes, subId)
          .run();
        const view = await buildAdminSubscriptionDetailView(env, subId);
        if (view) {
          await sendOrEditView(env, chatId, messageId, view);
        }
        return;
      }

      if (data.startsWith('adm_sub_ext_')) {
        const subId = Number(data.slice('adm_sub_ext_'.length));
        if (!Number.isInteger(subId) || subId <= 0) return;
        const current = await env.DB.prepare('SELECT expires_at FROM subscriptions WHERE id = ? LIMIT 1')
          .bind(subId)
          .first<{ expires_at: string }>();
        if (current) {
          const baseMs = Math.max(Date.now(), Date.parse(current.expires_at) || Date.now());
          const nextExpires = new Date(baseMs + 30 * 24 * 60 * 60 * 1000).toISOString();
          await env.DB.prepare(
            `UPDATE subscriptions
             SET expires_at = ?, status = 'active', updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`
          )
            .bind(nextExpires, subId)
            .run();
        }
        const view = await buildAdminSubscriptionDetailView(env, subId);
        if (view) {
          await sendOrEditView(env, chatId, messageId, view);
        }
        return;
      }

      if (data.startsWith('adm_sub_rst_')) {
        const subId = Number(data.slice('adm_sub_rst_'.length));
        if (!Number.isInteger(subId) || subId <= 0) return;
        await env.DB.prepare(
          `UPDATE subscriptions
           SET upload_bytes = 0, download_bytes = 0, web_browsing_used_mb = 0,
               download_used_mb = 0, static_ip_used_mb = 0, status = 'active',
               last_quota_reset = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        )
          .bind(subId)
          .run();
        const view = await buildAdminSubscriptionDetailView(env, subId);
        if (view) {
          await sendOrEditView(env, chatId, messageId, view);
        }
        return;
      }

      if (data.startsWith('adm_sub_tgl_')) {
        const subId = Number(data.slice('adm_sub_tgl_'.length));
        if (!Number.isInteger(subId) || subId <= 0) return;
        const current = await env.DB.prepare('SELECT status FROM subscriptions WHERE id = ? LIMIT 1')
          .bind(subId)
          .first<{ status: string }>();
        if (current) {
          const nextStatus = current.status === 'active' ? 'disabled' : 'active';
          await env.DB.prepare(
            'UPDATE subscriptions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
          )
            .bind(nextStatus, subId)
            .run();
        }
        const view = await buildAdminSubscriptionDetailView(env, subId);
        if (view) {
          await sendOrEditView(env, chatId, messageId, view);
        }
        return;
      }

      if (data === 'adm_stats') {
        const view = await buildAdminStatsView(env);
        await sendOrEditView(env, chatId, messageId, view);
        return;
      }

      if (data === 'adm_backup_now') {
        const backupRes = await sendDatabaseBackup(env);
        if (backupRes.ok) {
          await tgSendMessage(
            env,
            chatId,
            `✅ <b>بکاپ فوری دیتابیس D1 با موفقیت در تاپیک بکاپ منتشر شد!</b>\n\n` +
              `📄 فایل: <code>${escapeHtml(backupRes.filename || '')}</code>\n` +
              `🗂 تعداد جداول: <b>${backupRes.tablesCount ?? 0}</b>\n` +
              `📊 مجموع رکوردها: <b>${backupRes.totalRows ?? 0}</b>`,
            { inline_keyboard: [[{ text: '🔙 بازگشت به پنل مدیریت', callback_data: 'adm_panel_home' }]] }
          );
        } else {
          await tgSendMessage(
            env,
            chatId,
            `⚠️ <b>ارسال بکاپ انجام نشد:</b>\n${escapeHtml(backupRes.error || 'خطای نامشخص')}`,
            { inline_keyboard: [[{ text: '🔙 بازگشت به پنل مدیریت', callback_data: 'adm_panel_home' }]] }
          );
        }
        return;
      }

      if (data.startsWith('adm_ob_alloc_')) {
        const alloc = data.slice('adm_ob_alloc_'.length);
        if (!['free_only', 'gaming_only', 'static_only', 'all', 'auto', 'both'].includes(alloc)) {
          return;
        }
        await setBotState(env.DB, telegramId, 'admin_awaiting_outbound', { allocation: alloc });
        await tgSendMessage(
          env,
          chatId,
          `📥 <b>ارسال اوتباند رسمی یا ساب‌لینک (${escapeHtml(alloc)})</b>\n\n` +
            `لینک پروکسی (<code>vless://</code>, <code>vmess://</code>, <code>trojan://</code>, <code>hysteria2://</code>, <code>ss://</code>, <code>wg://</code>)، کانفیگ JSON سینگ‌باکس یا لینک سابسکریپشن (<code>https://...</code>) را ارسال کنید:`,
          buildCancelStateInlineMarkup()
        );
        return;
      }
    }

    // Fallback for any unrecognized or outdated callback_data so no click goes unanswered
    console.warn('[Sentra Unhandled Callback Data]', { data, telegramId });
    const record = await getUserAndSubByTelegramId(env.DB, telegramId);
    await tgSendMessage(
      env,
      chatId,
      'ℹ️ این دکمه منقضی شده است. لطفاً از منوی زیر گزینه مورد نظر را انتخاب کنید:',
      buildUserMenuHomeView(record?.user || null, record?.sub || null, isAdmin).replyMarkup
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('[Sentra Callback Query Error]', {
      callback_data: data,
      telegram_id: telegramId,
      error: errMsg,
      err,
    });
    await dispatchErrorAlert(
      env,
      ctx,
      `telegramWebhook.ts (callback_query: ${data}, uid=${telegramId})`,
      err
    );
    const showDetail = isEnvAdmin(env, telegramId) || (await resolveIsAdmin(env, telegramId));
    await tgSendMessage(
      env,
      chatId,
      showDetail
        ? `⚠️ <b>خطای پنل مدیریت:</b>\n<code>${escapeHtml(errMsg.slice(0, 350))}</code>`
        : '⚠️ خطایی در پردازش درخواست شما رخ داد. لطفاً لحظاتی دیگر دوباره تلاش کنید یا /start را ارسال نمایید.'
    );
  }
}

// ==============================================================================
// Incoming Message Handler (Commands, Reply Keyboard Buttons & FSM States)
// ==============================================================================

async function handleGroupMessage(env: Env, msg: TelegramMessage): Promise<void> {
  const from = msg.from;
  if (!from || from.is_bot) return;

  const chatId = msg.chat.id;
  const telegramId = from.id;
  const threadId =
    typeof msg.message_thread_id === 'number'
      ? msg.message_thread_id
      : typeof msg.reply_to_message?.message_thread_id === 'number'
      ? msg.reply_to_message.message_thread_id
      : undefined;
  const text = (msg.text || msg.caption || '').trim();
  const largestPhoto =
    Array.isArray(msg.photo) && msg.photo.length > 0
      ? msg.photo[msg.photo.length - 1]
      : null;
  const attachedDoc = msg.document || null;
  const threadExtra: Record<string, unknown> = {
    ...(threadId ? { message_thread_id: threadId } : {}),
    reply_to_message_id: msg.message_id,
  };

  // 1. Admin topic-binding commands: /set_logs, /set_backups, /set_support (with or without @BotUsername)
  const cmdMatch = /^\/(set_logs|set_backups|set_support)(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.exec(text);
  if (cmdMatch) {
    const isAdmin = await resolveIsAdmin(env, telegramId);
    if (!isAdmin) {
      await tgSendMessage(env, chatId, '⛔ دسترسی غیرمجاز', undefined, threadExtra);
      return;
    }

    const cmd = cmdMatch[1].toLowerCase();
    const mapping: Record<string, { type: TopicType; label: string }> = {
      set_logs: { type: 'logs', label: 'لاگ خطاهای سیستم' },
      set_backups: { type: 'backups', label: 'بکاپ‌های دیتابیس D1' },
      set_support: { type: 'support', label: 'پشتیبانی کاربران' },
    };
    const target = mapping[cmd];
    await saveTopicRoute(env.DB, target.type, chatId, threadId, env.SENTRA_KV);

    const threadLabel = threadId ? String(threadId) : 'عمومی (General / 0)';
    await tgSendMessage(
      env,
      chatId,
      `✅ <b>این تاپیک با موفقیت به عنوان تاپیک ${target.label} ثبت شد.</b>\n\n` +
        `👥 آیدی گروه: <code>${chatId}</code>\n` +
        `🧵 آیدی تاپیک: <code>${escapeHtml(threadLabel)}</code>`,
      undefined,
      threadExtra
    );
    return;
  }

  // 2. Admin Reply inside configured Support Topic -> forward directly to user's private chat
  if (msg.reply_to_message && (text || largestPhoto || attachedDoc)) {
    const topicConfig = await getTopicRoutingConfig(env.DB, env.SENTRA_KV);
    const currentThreadKey = String(threadId ?? 0);
    if (
      topicConfig.logGroupId === String(chatId) &&
      topicConfig.topicSupportId !== null &&
      String(topicConfig.topicSupportId) === currentThreadKey
    ) {
      const isAdmin = await resolveIsAdmin(env, telegramId);
      if (!isAdmin) return;

      const repliedText = msg.reply_to_message.text || msg.reply_to_message.caption || '';
      const targetUserId = extractSupportUid(repliedText);
      if (!targetUserId) return;

      let delivered = false;
      const replyCaption = text
        ? `💬 <b>پاسخ تیم پشتیبانی SentraVPN:</b>\n\n${escapeHtml(text)}`
        : '💬 <b>پاسخ تیم پشتیبانی SentraVPN:</b>';

      if (largestPhoto) {
        delivered = await tgApi(env, 'sendPhoto', {
          chat_id: targetUserId,
          photo: largestPhoto.file_id,
          caption: replyCaption.slice(0, 1020),
          parse_mode: 'HTML',
        });
      } else if (attachedDoc) {
        delivered = await tgApi(env, 'sendDocument', {
          chat_id: targetUserId,
          document: attachedDoc.file_id,
          caption: replyCaption.slice(0, 1020),
          parse_mode: 'HTML',
        });
      } else {
        delivered = await tgSendMessage(env, targetUserId, replyCaption);
      }

      if (delivered) {
        try {
          await env.DB.prepare(
            `UPDATE support_tickets
             SET status = 'awaiting_user', updated_at = CURRENT_TIMESTAMP
             WHERE id = (
               SELECT st.id FROM support_tickets st
               JOIN users u ON u.id = st.user_id
               WHERE u.telegram_id = ? AND st.status IN ('open', 'investigating')
               ORDER BY st.id DESC LIMIT 1
             )`
          )
            .bind(targetUserId)
            .run();
        } catch {
          // Non-critical status sync failure should never block support reply confirmation
        }

        await tgSendMessage(
          env,
          chatId,
          '✅ پاسخ به کاربر ارسال شد',
          undefined,
          threadExtra
        );
      } else {
        await tgSendMessage(
          env,
          chatId,
          '⚠️ ارسال پاسخ به کاربر ناموفق بود (ممکن است کاربر ربات را مسدود کرده باشد).',
          undefined,
          threadExtra
        );
      }
    }
  }

  // Ignore all other normal group messages so private /start menus are never triggered in groups
}

async function handleTextMessage(
  env: Env,
  msg: TelegramMessage,
  ctx?: ExecutionContext
): Promise<void> {
  const from = msg.from;
  if (!from) return;

  if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
    try {
      await handleGroupMessage(env, msg);
    } catch (err) {
      console.error('[Sentra Group Message Error]', err);
      await dispatchErrorAlert(
        env,
        ctx,
        `telegramWebhook.ts (group chat=${msg.chat.id})`,
        err
      );
    }
    return;
  }

  const chatId = msg.chat.id;
  const telegramId = from.id;
  const text = (msg.text || msg.caption || '').trim();
  const envAdmin = isEnvAdmin(env, telegramId);

  try {
    if (text === '/start' || text.startsWith('/start ') || /^\/start@[A-Za-z0-9_]+(\s|$)/.test(text)) {
      try {
        await clearBotState(env.DB, telegramId);
        const { user, sub, isNewUser } = await ensureTelegramUserAndSubscription(
          env.DB,
          from,
          envAdmin
        );
        const isAdmin = envAdmin || user.role === 'admin';
        const welcome = isNewUser
          ? `👋 به <b>Sentra Platform</b> خوش آمدید <b>${escapeHtml(user.first_name)}</b>!\n\n` +
            `✅ حساب شما به‌صورت خودکار ایجاد و فعال شد:\n` +
            `🆔 <b>کد شناسایی یکتا:</b> <code>${escapeHtml(user.user_uuid)}</code>\n` +
            `💎 <b>پلن اولیه:</b> ${escapeHtml(sub.tier)} (۱۰ گیگابایت)\n\n` +
            `از دکمه‌های منوی پایین برای دریافت لینک اشتراک، وضعیت حساب یا پشتیبانی استفاده کنید.`
          : `👋 خوش آمدید <b>${escapeHtml(user.first_name)}</b>!\n\n` +
            `حساب شما متصل و آماده استفاده است.\n` +
            `💎 <b>پلن فعال:</b> ${escapeHtml(sub.tier)}`;
        await tgSendMessage(env, chatId, welcome, buildMainKeyboard(true, isAdmin));
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error('[Sentra D1 Error] /start failed:', errMsg, err);
        await dispatchErrorAlert(
          env,
          ctx,
          `telegramWebhook.ts (/start D1, uid=${telegramId})`,
          err
        );
        await tgSendMessage(
          env,
          chatId,
          '⚠️ خطایی در اتصال به دیتابیس و ثبت اطلاعات شما رخ داد. لطفاً لحظاتی دیگر دوباره /start را ارسال کنید.'
        );
      }
      return;
    }

    let existing: { user: UserRow; sub: SubscriptionRow | null } | null = null;
    try {
      existing = await getUserAndSubByTelegramId(env.DB, telegramId);
    } catch (err) {
      console.error(
        '[Sentra D1 Error] Failed to query user:',
        err instanceof Error ? err.message : String(err),
        err
      );
      await dispatchErrorAlert(
        env,
        ctx,
        `telegramWebhook.ts (D1 user lookup, uid=${telegramId})`,
        err
      );
      await tgSendMessage(
        env,
        chatId,
        '⚠️ در حال حاضر ارتباط با دیتابیس با خطا مواجه شد. لطفاً لحظاتی دیگر دوباره تلاش کنید.'
      );
      return;
    }

    const isRegistered = Boolean(existing);
    const isAdmin = envAdmin || existing?.user.role === 'admin';
    const menuAction = text ? matchMenuAction(text) : null;

    // If user clicked a menu button or typed a /command while in an active FSM state,
    // cancel the FSM state first so menu buttons always stay responsive.
    const state = await getBotState(env.DB, telegramId);
    if (state && !text.startsWith('/') && !menuAction) {
      if (state.state_type === 'awaiting_login_username') {
        if (!text) {
          await tgSendMessage(env, chatId, '❌ لطفاً نام کاربری خود را به‌صورت متن ارسال کنید:');
          return;
        }
        await setBotState(env.DB, telegramId, 'awaiting_login_password', { username: text });
        await tgSendMessage(
          env,
          chatId,
          '🔑 اکنون <b>رمز عبور (Password)</b> حساب خود را وارد کنید:',
          buildCancelStateInlineMarkup()
        );
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

        const loggedInIsAdmin = envAdmin || user.role === 'admin';
        await tgSendMessage(
          env,
          chatId,
          `✅ <b>ورود موفق!</b>\nحساب <b>${escapeHtml(user.username || user.first_name)}</b> به تلگرام شما متصل شد.`,
          buildMainKeyboard(true, loggedInIsAdmin)
        );
        return;
      }

      if (state.state_type === 'awaiting_donate_outbound') {
        await clearBotState(env.DB, telegramId);
        try {
          if (!text) {
            await tgSendMessage(env, chatId, '❌ لطفاً لینک پروکسی یا کانفیگ JSON را به‌صورت متن ارسال کنید.');
            return;
          }
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
             ) VALUES (?, ?, ?, ?, ?, ?, 90, 12.0, 'web_browsing', 100, 'pending', 0, ?, ?, 0, ?, ?, ?, 1, 1, 0, 0, 'free_only', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
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
            `🤝 <b>سپاس از حمایت شما!</b>\nنود <b>${escapeHtml(parsed.tag)}</b> ثبت شد و در صف بررسی مدیریت قرار گرفت. پس از تأیید، به شما اطلاع داده خواهد شد.`,
            buildMainKeyboard(true, isAdmin)
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

      if (state.state_type === 'awaiting_donation_receipt') {
        const payload = JSON.parse(state.payload_json || '{}') as { plan?: string; amount?: number };
        const ensured = existing?.user
          ? existing
          : await ensureTelegramUserAndSubscription(env.DB, from, envAdmin);

        const largestPhoto =
          Array.isArray(msg.photo) && msg.photo.length > 0
            ? msg.photo[msg.photo.length - 1]
            : null;
        const receiptFileId =
          largestPhoto?.file_id || msg.document?.file_id || (text ? `text_ref:${text.slice(0, 180)}` : '');
        const fileUniqueId =
          largestPhoto?.file_unique_id ||
          msg.document?.file_unique_id ||
          (text ? `txt_${(await sha256Hex(`${ensured.user.id}:${text}`)).slice(0, 24)}` : null);

        if (!receiptFileId) {
          await tgSendMessage(
            env,
            chatId,
            '❌ لطفاً تصویر فیش واریزی یا کد پیگیری متنی را ارسال کنید.',
            buildCancelStateInlineMarkup()
          );
          return;
        }

        const receiptHash = await sha256Hex(fileUniqueId || receiptFileId);
        const dup = await env.DB.prepare(
          'SELECT id FROM donations WHERE file_unique_id = ? OR image_sha256 = ? LIMIT 1'
        )
          .bind(fileUniqueId, receiptHash)
          .first<{ id: number }>();

        await clearBotState(env.DB, telegramId);

        if (dup) {
          await tgSendMessage(
            env,
            chatId,
            '⚠️ این فیش یا کد پیگیری قبلاً در سیستم ثبت شده است.',
            buildMainKeyboard(true, isAdmin)
          );
          return;
        }

        const amount = Math.max(0, Math.round(Number(payload.amount) || 150000));
        const insertRes = await env.DB.prepare(
          `INSERT INTO donations (user_id, amount, receipt_file_id, file_unique_id, image_sha256, status, subscription_granted)
           VALUES (?, ?, ?, ?, ?, 'pending', 0)`
        )
          .bind(ensured.user.id, amount, receiptFileId, fileUniqueId, receiptHash)
          .run();

        await tgSendMessage(
          env,
          chatId,
          `✅ <b>فیش واریزی شما با موفقیت ثبت شد!</b>\n\n` +
            `🆔 کد پیگیری داخلی: <code>#DON-${insertRes.meta.last_row_id}</code>\n` +
            `💎 پلن درخواستی: <b>${escapeHtml(payload.plan || 'Sentra Pro')}</b>\n` +
            `💰 مبلغ: <b>${amount.toLocaleString('en-US')} تومان</b>\n\n` +
            `پس از بررسی توسط مدیریت، اشتراک شما به صورت خودکار ارتقا خواهد یافت.`,
          buildMainKeyboard(true, isAdmin)
        );
        return;
      }

      if (state.state_type === 'awaiting_support_ticket') {
        const payload = JSON.parse(state.payload_json || '{}') as { category?: string };
        const largestPhoto =
          Array.isArray(msg.photo) && msg.photo.length > 0
            ? msg.photo[msg.photo.length - 1]
            : null;
        const attachedDoc = msg.document || null;
        const hasMedia = Boolean(largestPhoto || attachedDoc);

        if (!hasMedia && text.length < 5) {
          await tgSendMessage(
            env,
            chatId,
            '❌ لطفاً توضیح مشکل خود را حداقل در ۵ کاراکتر (یا همراه با تصویر/فایل) ارسال کنید تا قابل پیگیری باشد:',
            buildCancelStateInlineMarkup()
          );
          return;
        }

        const ensured = existing?.user
          ? existing
          : await ensureTelegramUserAndSubscription(env.DB, from, envAdmin);

        const allowedCategories = ['connection', 'billing', 'device_setup', 'performance', 'other'];
        const category =
          payload.category && allowedCategories.includes(payload.category)
            ? payload.category
            : 'other';
        const ticketNumber = `TKT-${generateNumericCode(6)}`;
        const effectiveBody =
          text ||
          (largestPhoto
            ? '[تصویر پیوست‌شده توسط کاربر]'
            : `[فایل پیوست‌شده: ${attachedDoc?.file_name || 'document'}]`);
        const subject = effectiveBody.split('\n')[0].slice(0, 80);

        await env.DB.prepare(
          `INSERT INTO support_tickets (ticket_number, user_id, subscription_id, category, subject, description, priority, status)
           VALUES (?, ?, ?, ?, ?, ?, 'medium', 'open')`
        )
          .bind(
            ticketNumber,
            ensured.user.id,
            ensured.sub?.id ?? null,
            category,
            subject,
            effectiveBody.slice(0, 2000)
          )
          .run();

        await clearBotState(env.DB, telegramId);
        await tgSendMessage(
          env,
          chatId,
          `✅ <b>تیکت پشتیبانی شما با موفقیت ثبت شد!</b>\n\n` +
            `🎫 شماره تیکت: <code>${escapeHtml(ticketNumber)}</code>\n` +
            `📌 موضوع: <b>${escapeHtml(subject)}</b>\n\n` +
            `تیم پشتیبانی در کوتاه‌ترین زمان درخواست شما را بررسی خواهد کرد.`,
          buildMainKeyboard(true, isAdmin)
        );

        const fullName =
          [from.first_name, from.last_name].filter(Boolean).join(' ').trim() ||
          ensured.user.first_name;
        const usernameLine = from.username
          ? `@${escapeHtml(from.username)}`
          : ensured.user.username
          ? `@${escapeHtml(ensured.user.username)}`
          : 'ندارد';
        const supportHeader =
          `🎫 <b>پیام پشتیبانی جدید (${escapeHtml(ticketNumber)})</b>\n\n` +
          `🕒 زمان: <code>${escapeHtml(formatLogTimestamp())}</code>\n` +
          `👤 نام: <b>${escapeHtml(fullName)}</b>\n` +
          `🔗 یوزرنیم: ${usernameLine}\n` +
          `🆔 شناسه کاربر: #UID_${telegramId}\n` +
          `📂 دسته‌بندی: <code>${escapeHtml(category)}</code>\n\n`;

        if (largestPhoto) {
          const mediaCaption =
            supportHeader +
            `📝 <b>توضیحات:</b> ${escapeHtml(effectiveBody.slice(0, 500))}\n\n` +
            `↩️ <i>برای پاسخ مستقیم به کاربر، روی همین پیام Reply کنید.</i>`;
          await sendMediaToTopic(env, 'support', {
            kind: 'photo',
            fileId: largestPhoto.file_id,
            caption: mediaCaption,
          });
        } else if (attachedDoc) {
          const mediaCaption =
            supportHeader +
            `📎 <b>فایل:</b> <code>${escapeHtml(attachedDoc.file_name || 'document')}</code>\n` +
            `📝 <b>توضیحات:</b> ${escapeHtml(effectiveBody.slice(0, 450))}\n\n` +
            `↩️ <i>برای پاسخ مستقیم به کاربر، روی همین پیام Reply کنید.</i>`;
          await sendMediaToTopic(env, 'support', {
            kind: 'document',
            fileId: attachedDoc.file_id,
            caption: mediaCaption,
          });
        } else {
          await sendToTopic(
            env,
            'support',
            supportHeader +
              `📝 <b>متن پیام:</b>\n${escapeHtml(effectiveBody.slice(0, 2000))}\n\n` +
              `↩️ <i>برای پاسخ مستقیم به کاربر، روی همین پیام Reply کنید.</i>`
          );
        }
        return;
      }

      if (state.state_type.startsWith('admin_')) {
        if (!isAdmin) {
          await clearBotState(env.DB, telegramId);
          await tgSendMessage(env, chatId, '⛔ دسترسی غیرمجاز');
          return;
        }

        if (state.state_type === 'admin_awaiting_outbound') {
          const payload = JSON.parse(state.payload_json || '{}') as { allocation?: string };
          await clearBotState(env.DB, telegramId);
          await handleAdminOutboundSubmission(env, chatId, text, payload.allocation || 'auto');
          return;
        }

        if (state.state_type === 'admin_awaiting_sub_source') {
          const payload = JSON.parse(state.payload_json || '{}') as { category?: string };
          await clearBotState(env.DB, telegramId);
          const category = VALID_SUB_SOURCE_CATEGORIES.includes(
            payload.category as SubSourceCategory
          )
            ? (payload.category as SubSourceCategory)
            : 'web_browsing';
          await handleAdminSubSourceSubmission(env, chatId, text, category);
          return;
        }

        if (state.state_type === 'admin_awaiting_sub_lookup') {
          await clearBotState(env.DB, telegramId);
          const foundSubId = await findSubscriptionForAdmin(env.DB, text);
          if (!foundSubId) {
            await tgSendMessage(
              env,
              chatId,
              '❌ هیچ سابسکریپشنی با این مشخصات یافت نشد.',
              buildAdminPanelHomeView().replyMarkup
            );
            return;
          }
          const view = await buildAdminSubscriptionDetailView(env, foundSubId);
          if (view) {
            await tgSendMessage(env, chatId, view.text, view.replyMarkup);
          }
          return;
        }
      }
    }

    // Clear stale state when navigating via a recognized menu button
    if (state && (menuAction || text.startsWith('/'))) {
      await clearBotState(env.DB, telegramId);
    }

    // --- Route Recognized Menu Actions ---
    switch (menuAction) {
      case 'back': {
        const welcome = isRegistered
          ? `👋 خوش آمدید <b>${escapeHtml(existing!.user.first_name)}</b>!\nحساب شما متصل و آماده استفاده است.`
          : `👋 به <b>Sentra Platform</b> خوش آمدید!\n\nبرای شروع، روی دکمه <b>📝 ثبت‌نام / ورود</b> کلیک کنید.`;
        await tgSendMessage(env, chatId, welcome, buildMainKeyboard(isRegistered, isAdmin));
        return;
      }

      case 'auth': {
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

      case 'account': {
        const { user, sub } = await ensureTelegramUserAndSubscription(env.DB, from, envAdmin);
        const view = buildUserAccountView(user, sub);
        await tgSendMessage(env, chatId, view.text, view.replyMarkup);
        return;
      }

      case 'get_sub': {
        const { user, sub } = await ensureTelegramUserAndSubscription(env.DB, from, envAdmin);
        const view = await buildUserSubscriptionView(env, user, sub);
        await tgSendMessage(env, chatId, view.text, view.replyMarkup);
        return;
      }

      case 'ios_menu': {
        const { sub } = await ensureTelegramUserAndSubscription(env.DB, from, envAdmin);
        const view = await buildUserIosMenuView(env, sub);
        await tgSendMessage(env, chatId, view.text, view.replyMarkup);
        return;
      }

      case 'upgrade': {
        const { sub } = await ensureTelegramUserAndSubscription(env.DB, from, envAdmin);
        const view = buildUserUpgradeView(env, sub);
        await tgSendMessage(env, chatId, view.text, view.replyMarkup);
        return;
      }

      case 'donate_outbound': {
        await ensureTelegramUserAndSubscription(env.DB, from, envAdmin);
        await setBotState(env.DB, telegramId, 'awaiting_donate_outbound');
        await tgSendMessage(
          env,
          chatId,
          '🤝 <b>اهدای اوتباند (حمایت از Sentra)</b>\n\n' +
            'لینک پروکسی خود (vless/vmess/trojan/hy2/ss/wg) یا JSON سینگ‌باکس را ارسال کنید تا پس از بررسی امنیتی و اثرانگشت در کل اکوسیستم فعال شود:',
          buildCancelStateInlineMarkup()
        );
        return;
      }

      case 'guide': {
        const view = buildUserGuideView('overview');
        await tgSendMessage(env, chatId, view.text, view.replyMarkup);
        return;
      }

      case 'download_app': {
        const view = await buildUserDownloadAppView(env);
        await tgSendMessage(env, chatId, view.text, view.replyMarkup);
        return;
      }

      case 'support': {
        const { user } = await ensureTelegramUserAndSubscription(env.DB, from, envAdmin);
        const view = await buildUserSupportView(env, user);
        await tgSendMessage(env, chatId, view.text, view.replyMarkup);
        return;
      }

      case 'admin': {
        if (!isAdmin) {
          await tgSendMessage(env, chatId, '⛔ دسترسی غیرمجاز');
          return;
        }
        const panel = buildAdminPanelHomeView();
        await tgSendMessage(env, chatId, panel.text, panel.replyMarkup);
        return;
      }

      default: {
        const quickMenu = buildUserMenuHomeView(
          existing?.user || null,
          existing?.sub || null,
          isAdmin
        );
        await tgSendMessage(
          env,
          chatId,
          'از دکمه‌های منوی پایین یا گزینه سریع زیر برای ادامه استفاده کنید:',
          quickMenu.replyMarkup
        );
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('[Sentra Message Handler Error]', {
      telegram_id: telegramId,
      text: text.slice(0, 120),
      error: errMsg,
      err,
    });
    await dispatchErrorAlert(
      env,
      ctx,
      `telegramWebhook.ts (message handler, uid=${telegramId})`,
      err
    );
    const showDetail = envAdmin || (await resolveIsAdmin(env, telegramId));
    await tgSendMessage(
      env,
      chatId,
      showDetail
        ? `⚠️ <b>خطای پنل مدیریت:</b>\n<code>${escapeHtml(errMsg.slice(0, 350))}</code>`
        : '⚠️ خطایی در پردازش پیام شما رخ داد. لطفاً لحظاتی دیگر دوباره تلاش کنید یا /start را ارسال نمایید.'
    );
  }
}

/**
 * Cloudflare Worker Webhook Handler for POST /api/v1/telegram/webhook.
 * Enforces X-Telegram-Bot-Api-Secret-Token verification when TELEGRAM_WEBHOOK_SECRET is configured.
 */
export async function handleTelegramWebhook(
  request: Request,
  env: Env,
  ctx?: ExecutionContext
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
      await handleCallbackQuery(env, update.callback_query, ctx);
    } else if (update.message) {
      await handleTextMessage(env, update.message, ctx);
    }
  } catch (err) {
    console.error('[Sentra Webhook Error]', err);
    await dispatchErrorAlert(env, ctx, 'telegramWebhook.ts (webhook root)', err);
    const fallbackChatId =
      update.message?.chat.id ||
      update.callback_query?.message?.chat.id ||
      update.callback_query?.from.id;
    const isGroup =
      update.message?.chat.type === 'group' || update.message?.chat.type === 'supergroup';
    if (fallbackChatId && !isGroup) {
      await tgSendMessage(
        env,
        fallbackChatId,
        '⚠️ خطایی در پردازش درخواست شما رخ داد. لطفاً لحظاتی دیگر دوباره تلاش کنید.'
      );
    }
  }

  // Always return 200 OK to Telegram only AFTER all awaited replies complete
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
