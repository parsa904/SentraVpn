import {
  auditOutboundSecurity,
  parseOutboundInput,
  parseSubscriptionPayload,
} from './outboundAnalyzer.ts';
import {
  hashPassword,
  normalizeLoginIdentifier,
  validateUnifiedPassword,
  validateUnifiedUsername,
  verifyPassword,
} from './auth.ts';
import {
  constantTimeEquals,
  generateNumericCode,
  generateSubscriptionToken,
  generateUniqueConnectCode,
  sha256Hex,
  validateExternalHttpsUrl,
  validateUserSubmittedSublink,
} from './security.ts';
import { resolvePlanTier } from './singboxCompiler.ts';
import {
  attachTopicToSupportSession,
  buildSupportTopicTitle,
  closeSupportSession,
  ensureSchemaColumns,
  getOpenSupportSessionByTopic,
  getOpenSupportSessionByUser,
  recordSupportSessionActivity,
  SUPPORT_TOPIC_ESCALATION_THRESHOLD,
  type SupportSessionRow,
} from './supportSessions.ts';
import { invalidateEdgeVersionCache } from './edgeCache.ts';
import {
  createSupportForumTopic,
  deleteSupportForumTopic,
  dispatchErrorAlert,
  extractSupportUid,
  formatLogTimestamp,
  getFreeQuotaSettings,
  getTopicRoutingConfig,
  pinGroupMessage,
  saveTopicRoute,
  sendDatabaseBackup,
  sendErrorAlert,
  sendMediaToTopic,
  sendToTopic,
  sendToTopicWithResult,
  type TopicType,
} from './telegramTopics.ts';
import {
  executeD1Batch,
  getCachedActiveNodesPool,
  getCachedHasActiveGaming,
  invalidateNodesCache,
} from './workerCache.ts';
import type { AppReleaseFileRow, Env, SubscriptionRow, UserRow } from './types.ts';

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
  mime_type?: string;
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
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
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

const GIB_BYTES = 1024 * 1024 * 1024;
const MIB_BYTES = 1024 * 1024;
const SPECIAL_TRIAL_BYTES = 1 * GIB_BYTES; // 1 GB one-time trial for Free users
const PRO_PLAN_PRICE_TOMAN = 120000;
const FLOW_PLUS_PLAN_PRICE_TOMAN = 180000;
const PRO_SPECIAL_QUOTA_BYTES = 30 * GIB_BYTES;
const FLOW_PLUS_SPECIAL_QUOTA_BYTES = 50 * GIB_BYTES;
const GITHUB_RELEASES_BASE_URL = 'https://github.com/parsa904/SentraVpn/releases/latest/download';
const DEFAULT_MINIAPP_URL = 'https://sentravpn.pages.dev';
const MINIAPP_BUTTON_LABEL = '📱 ورود به پنل گرافیکی (Mini App)';

function resolveMiniAppUrl(env?: Env): string {
  const raw = (env?.MINIAPP_URL || '').trim();
  if (raw) {
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === 'https:') {
        return parsed.toString().replace(/\/$/, '');
      }
    } catch {
      // Fallback to default Cloudflare Pages URL
    }
  }
  return DEFAULT_MINIAPP_URL;
}

function buildProgressBar(used: number, total: number, length = 10): string {
  const safeTotal = Math.max(1, total);
  const ratio = Math.max(0, Math.min(1, used / safeTotal));
  const filled = Math.round(ratio * length);
  const empty = Math.max(0, length - filled);
  const pct = Math.round(ratio * 100);
  return `${'▓'.repeat(filled)}${'░'.repeat(empty)} ${pct}%`;
}

function getAdminTelegramIds(env: Env): number[] {
  const raw = [
    ...(env.ADMIN_TELEGRAM_ID ? env.ADMIN_TELEGRAM_ID.split(',') : []),
    ...(env.ADMIN_CHAT_ID ? env.ADMIN_CHAT_ID.split(',') : []),
    ...(env.ADMIN_TELEGRAM_IDS ? env.ADMIN_TELEGRAM_IDS.split(',') : []),
  ]
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isSafeInteger(n) && n > 0);
  return Array.from(new Set(raw));
}

const USER_BTN = {
  ACCOUNT: '👤 حساب کاربری',
  AUTH: '📝 ثبت‌نام / ورود',
  UPGRADE: '💎 ارتقای اشتراک',
  DONATE_OUTBOUND: '🤝 اهدای نود / سابلینک',
  GUIDE: '📖 راهنمای اتصال',
  DOWNLOAD_APP: '📥 دانلود اپلیکیشن',
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
    norm === '🔑 دریافت کانفیگ و کد اتصال' ||
    norm === 'دریافت لینک اشتراک' ||
    norm === '🔗 دریافت لینک اشتراک' ||
    norm === 'دریافت کانفیگ' ||
    norm === 'کد اتصال'
  ) {
    return 'get_sub';
  }
  if (norm === '🍏 دریافت کانفیگ iOS' || norm === 'دریافت کانفیگ iOS') {
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
    norm === '🤝 اهدای نود / سابلینک' ||
    norm === 'اهدای نود / سابلینک' ||
    norm === '🤝 اهدای اوتباند (حمایت از Sentra)' ||
    norm === 'اهدای اوتباند' ||
    norm === 'اهدای نود' ||
    norm === '🤝 اهدای نود' ||
    norm === 'اهدای سابلینک' ||
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

/**
 * Quiet best-effort deleteMessage helper used to immediately erase user password
 * messages from Telegram chat history without spamming admin logs if already removed.
 */
async function tgDeleteMessage(
  env: Env,
  chatId: number,
  messageId: number
): Promise<boolean> {
  const botToken = resolveBotToken(env);
  if (!botToken || !messageId) return false;
  try {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
      }),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

function isUnifiedRegisteredAccount(user: UserRow | null | undefined): boolean {
  return Boolean(user && user.username && user.password_hash);
}

async function tgSendDocumentByFileId(
  env: Env,
  chatId: number,
  fileId: string,
  caption: string,
  replyMarkup?: Record<string, unknown>
): Promise<boolean> {
  return await tgApi(env, 'sendDocument', {
    chat_id: chatId,
    document: fileId,
    caption,
    parse_mode: 'HTML',
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

function detectReleaseBinary(
  doc: TelegramDocument | null | undefined,
  captionOrText = ''
): { platform: 'android' | 'windows'; fileName: string; version: string | null } | null {
  if (!doc?.file_id) return null;
  const fileName = (doc.file_name || '').trim();
  const lowerName = fileName.toLowerCase();
  const lowerMime = (doc.mime_type || '').toLowerCase();
  const combinedText = `${captionOrText} ${fileName}`;

  let platform: 'android' | 'windows' | null = null;
  if (lowerName.endsWith('.apk') || lowerMime === 'application/vnd.android.package-archive') {
    platform = 'android';
  } else if (
    lowerName.endsWith('.exe') ||
    lowerName.endsWith('.msi') ||
    lowerMime === 'application/x-msdownload' ||
    lowerMime === 'application/x-msdos-program'
  ) {
    platform = 'windows';
  } else if (
    lowerName.endsWith('.zip') &&
    /(windows|win64|win32|portable|sentra.*x64)/i.test(combinedText)
  ) {
    platform = 'windows';
  }

  if (!platform) return null;
  const versionMatch = /v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.]+)?/.exec(combinedText);
  return {
    platform,
    fileName: fileName || (platform === 'android' ? 'SentraVPN-Android-Universal.apk' : 'SentraVPN-Windows-Setup-x64.exe'),
    version: versionMatch ? versionMatch[0] : null,
  };
}

async function saveTelegramReleaseFile(
  env: Env,
  params: {
    platform: 'android' | 'windows';
    fileId: string;
    fileName?: string;
    captionOrText?: string;
    versionHint?: string | null;
  }
): Promise<{ platform: 'android' | 'windows'; version: string; githubUrl: string; fileName: string }> {
  await ensureSchemaColumns(env.DB);
  const existingRel = await env.DB.prepare(
    'SELECT version, github_url FROM app_release_files WHERE platform = ? LIMIT 1'
  )
    .bind(params.platform)
    .first<{ version: string; github_url: string }>();

  const versionMatch = /v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.]+)?/.exec(
    `${params.captionOrText || ''} ${params.fileName || ''}`
  );
  const version =
    params.versionHint ||
    (versionMatch ? versionMatch[0] : null) ||
    existingRel?.version ||
    'latest';

  const defaultGithubUrl =
    params.platform === 'android'
      ? `${GITHUB_RELEASES_BASE_URL}/SentraVPN-Android-Universal.apk`
      : `${GITHUB_RELEASES_BASE_URL}/SentraVPN-Windows-Setup-x64.exe`;
  const githubUrl = existingRel?.github_url || defaultGithubUrl;

  await env.DB.prepare(
    `INSERT INTO app_release_files (platform, version, github_url, telegram_file_id, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(platform) DO UPDATE SET
       version = excluded.version,
       github_url = excluded.github_url,
       telegram_file_id = excluded.telegram_file_id,
       updated_at = CURRENT_TIMESTAMP`
  )
    .bind(params.platform, version, githubUrl, params.fileId)
    .run();

  await invalidateEdgeVersionCache();

  return {
    platform: params.platform,
    version,
    githubUrl,
    fileName:
      params.fileName ||
      (params.platform === 'android'
        ? 'SentraVPN-Android-Universal.apk'
        : 'SentraVPN-Windows-Setup-x64.exe'),
  };
}

function buildMainKeyboard(
  isRegistered: boolean,
  isAdmin: boolean,
  env?: Env
): Record<string, unknown> {
  const accountOrAuthBtn = isRegistered
    ? { text: USER_BTN.ACCOUNT }
    : { text: USER_BTN.AUTH };

  const rows: Array<Array<{ text: string; web_app?: { url: string } }>> = [
    [{ text: MINIAPP_BUTTON_LABEL, web_app: { url: resolveMiniAppUrl(env) } }],
    [accountOrAuthBtn, { text: USER_BTN.UPGRADE }],
    [{ text: USER_BTN.DONATE_OUTBOUND }, { text: USER_BTN.DOWNLOAD_APP }],
    [{ text: USER_BTN.GUIDE }, { text: USER_BTN.SUPPORT }],
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
    const connectCode = await generateUniqueConnectCode(db);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    await db
      .prepare(
        `INSERT INTO subscriptions (
           user_id, tier, plan_tier, connect_code, token, status,
           upload_bytes, download_bytes, traffic_limit_bytes, speed_limit_bps,
           max_concurrent_devices, web_browsing_used_mb, download_used_mb,
           static_ip_used_mb, web_used_bytes, download_used_bytes,
           special_quota_bytes, special_used_bytes, has_used_special_trial, expires_at
         ) VALUES (?, 'Sentra Lite', 'free', ?, ?, 'active', 0, 0, ?, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, ?)`
      )
      .bind(user.id, connectCode, token, 10 * GIB_BYTES, expiresAt)
      .run();

    sub = await db
      .prepare('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 1')
      .bind(user.id)
      .first<SubscriptionRow>();

    if (!sub) {
      throw new Error('Failed to load newly inserted subscription from D1');
    }
  } else if (!sub.connect_code) {
    const connectCode = await generateUniqueConnectCode(db);
    await db
      .prepare('UPDATE subscriptions SET connect_code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(connectCode, sub.id)
      .run();
    sub = { ...sub, connect_code: connectCode };
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
         compiled_outbound_json, validation_error,
         latency_ms, speed_mbps, assigned_tier, health_score, status, fail_count,
         raw_link, fingerprint_sha256, is_official, label, country_code, country_name,
         allow_web, allow_download, allow_gaming, allow_static_ip, allocation_mode,
         last_online_at, last_checked_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 'active', 0, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    )
    .bind(
      null,
      parsed.tag,
      parsed.protocol,
      parsed.server_address,
      parsed.server_port,
      parsed.compiled_outbound_json,
      parsed.compiled_outbound_json,
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
       compiled_outbound_json, validation_error,
       latency_ms, speed_mbps, assigned_tier, health_score, status, fail_count,
       raw_link, fingerprint_sha256, is_official, label, country_code, country_name,
       allow_web, allow_download, allow_gaming, allow_static_ip, allocation_mode,
       last_online_at, last_checked_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 'active', 0, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;

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
          parsed.compiled_outbound_json,
          parsed.compiled_outbound_json,
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
    const { nodes, skipped, rejectionReasons } = await parseSubscriptionPayload(body);
    if (nodes.length === 0) {
      const sampleReason = rejectionReasons[0]
        ? `\n\n📌 دلیل نمونه رد شدن:\n<i>${escapeHtml(rejectionReasons[0])}</i>`
        : '';
      await tgSendMessage(
        env,
        chatId,
        `❌ هیچ نود سازگار با sing-box 1.14+ در این لینک سابسکریپشن یافت نشد.${sampleReason}`
      );
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
      `INSERT INTO subscription_sources (category, sub_url, tag, submitted_by_user_id, status, total_nodes, healthy_nodes, last_sync_at)
       VALUES (?, ?, ?, NULL, 'active', ?, ?, CURRENT_TIMESTAMP)`
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

const ADMIN_TIER_CONFIG: Record<
  string,
  { tier: string; planTier: 'free' | 'pro' | 'flow_plus'; limitBytes: number; specialQuotaBytes: number; label: string }
> = {
  lite: {
    tier: 'Sentra Lite',
    planTier: 'free',
    limitBytes: 10 * GIB_BYTES,
    specialQuotaBytes: 0,
    label: 'Free (رایگان)',
  },
  gaming: {
    tier: 'Sentra Flow+',
    planTier: 'flow_plus',
    limitBytes: 500 * GIB_BYTES,
    specialQuotaBytes: FLOW_PLUS_SPECIAL_QUOTA_BYTES,
    label: 'Flow+ (50GB Special)',
  },
  static: {
    tier: 'Sentra Pro',
    planTier: 'pro',
    limitBytes: 200 * GIB_BYTES,
    specialQuotaBytes: PRO_SPECIAL_QUOTA_BYTES,
    label: 'Pro (30GB Static IP)',
  },
  pro: {
    tier: 'Sentra Pro',
    planTier: 'pro',
    limitBytes: 200 * GIB_BYTES,
    specialQuotaBytes: PRO_SPECIAL_QUOTA_BYTES,
    label: 'Pro (30GB Static IP)',
  },
  flow: {
    tier: 'Sentra Flow+',
    planTier: 'flow_plus',
    limitBytes: 500 * GIB_BYTES,
    specialQuotaBytes: FLOW_PLUS_SPECIAL_QUOTA_BYTES,
    label: 'Flow+ (50GB Special)',
  },
};

function buildAdminPanelHomeView(): { text: string; replyMarkup: Record<string, unknown> } {
  return {
    text:
      '🛠 <b>پنل مدیریت Sentra Platform (Cloudflare D1)</b>\n\n' +
      'از منوی زیر بخش مورد نظر را برای مدیریت نودهای رسمی، منابع سابسکریپشن، بررسی نودهای اهدایی و فیش‌های مالی، بروزرسانی فایل نصبی، مدیریت کاربران یا آمار سیستم انتخاب کنید:',
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
          { text: '📦 بروزرسانی فایل نصبی ربات', callback_data: 'adm_update_release_file' },
          { text: '💾 دریافت بکاپ فوری', callback_data: 'adm_backup_now' },
        ],
        [{ text: '📊 آمار سیستم', callback_data: 'adm_stats' }],
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
    `SELECT id, category, sub_url, tag, status, submitted_by_user_id, total_nodes, healthy_nodes, last_sync_at
     FROM subscription_sources
     ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, id DESC
     LIMIT 10`
  ).all<{
    id: number;
    category: string;
    sub_url: string;
    tag: string | null;
    status: string | null;
    submitted_by_user_id: number | null;
    total_nodes: number;
    healthy_nodes: number;
    last_sync_at: string;
  }>();

  const list = rows.results || [];
  const lines = list.map((s) => {
    const shortUrl = s.sub_url.length > 48 ? `${s.sub_url.slice(0, 48)}...` : s.sub_url;
    const statusIcon =
      s.status === 'pending' ? '⏳' : s.status === 'rejected' ? '❌' : '🟢';
    const submitterTag = s.submitted_by_user_id ? ` | اهدایی کاربر #${s.submitted_by_user_id}` : '';
    return (
      `${statusIcon} <b>#${s.id}</b> [<code>${escapeHtml(s.category)}</code>] — نودها: <b>${s.healthy_nodes}/${s.total_nodes}</b>${submitterTag}\n` +
      `   🔗 <code>${escapeHtml(shortUrl)}</code>`
    );
  });

  const actionButtons: Array<Array<{ text: string; callback_data: string }>> = [];
  for (const src of list) {
    if (src.status === 'pending') {
      actionButtons.push([
        { text: `✅ تأیید سابلینک #${src.id}`, callback_data: `adm_subsrc_approve_${src.id}` },
        { text: `❌ رد سابلینک #${src.id}`, callback_data: `adm_subsrc_reject_${src.id}` },
      ]);
    }
  }
  const activeOrRejected = list.filter((s) => s.status !== 'pending');
  for (let i = 0; i < activeOrRejected.length; i += 2) {
    const rowBtns: Array<{ text: string; callback_data: string }> = [];
    for (const src of activeOrRejected.slice(i, i + 2)) {
      rowBtns.push({
        text: `🗑 حذف #${src.id} (${src.category})`,
        callback_data: `adm_subsrc_del_${src.id}`,
      });
    }
    actionButtons.push(rowBtns);
  }

  return {
    text:
      `🔗 <b>مدیریت منابع سابسکریپشن (subscription_sources)</b>\n\n` +
      (lines.length > 0 ? lines.join('\n') : '<i>هیچ منبع سابسکریپشنی هنوز ثبت نشده است.</i>'),
    replyMarkup: {
      inline_keyboard: [
        [{ text: '➕ افزودن لینک سابسکریپشن جدید', callback_data: 'adm_subsrc_add' }],
        ...actionButtons,
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
    `INSERT INTO subscription_sources (category, sub_url, tag, submitted_by_user_id, status, total_nodes, healthy_nodes, last_sync_at)
     VALUES (?, ?, ?, NULL, 'active', ?, ?, CURRENT_TIMESTAMP)`
  )
    .bind(category, validUrl.toString(), `Source (${category})`, totalNodes, addedNodes)
    .run();

  await invalidateNodesCache(env.DB, env.SENTRA_KV);

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
  isAdmin: boolean,
  env?: Env
): { text: string; replyMarkup: Record<string, unknown> } {
  const planTier = sub ? resolvePlanTier(sub) : 'free';
  const planLabel =
    planTier === 'flow_plus'
      ? 'Sentra Flow+'
      : planTier === 'pro'
      ? 'Sentra Pro'
      : 'رایگان (Free)';

  const greeting = user
    ? `👋 <b>منوی اصلی SentraVPN</b>\n\n` +
      `👤 کاربر: <b>${escapeHtml(user.first_name)}</b>\n` +
      `💎 پلن فعال: <b>${escapeHtml(planLabel)}</b>\n\n` +
      `بخش مورد نظر خود را انتخاب کنید:`
    : `👋 <b>به SentraVPN خوش آمدید!</b>\n\nبرای دریافت کد اتصال ۸ رقمی اختصاصی و استفاده از اپلیکیشن رسمی SentraVPN، ابتدا ثبت‌نام یا ورود انجام دهید:`;

  const inlineRows: Array<Array<{ text: string; callback_data?: string; web_app?: { url: string } }>> = user
    ? [
        [{ text: MINIAPP_BUTTON_LABEL, web_app: { url: resolveMiniAppUrl(env) } }],
        [
          { text: '👤 حساب کاربری', callback_data: 'user_account' },
          { text: '💎 ارتقای اشتراک', callback_data: 'user_upgrade' },
        ],
        [
          { text: '🤝 اهدای نود / سابلینک', callback_data: 'user_donate_outbound' },
          { text: '📥 دانلود اپلیکیشن', callback_data: 'user_download_app' },
        ],
        [
          { text: '📖 راهنمای اتصال', callback_data: 'user_guide' },
          { text: '🎫 پشتیبانی و تیکت', callback_data: 'user_support' },
        ],
      ]
    : [
        [{ text: MINIAPP_BUTTON_LABEL, web_app: { url: resolveMiniAppUrl(env) } }],
        [{ text: '📝 ثبت‌نام جدید', callback_data: 'auth_register_new' }],
        [{ text: '🔑 ورود به حساب موجود (اتصال به اپلیکیشن)', callback_data: 'auth_login_app' }],
      ];

  if (isAdmin) {
    inlineRows.push([{ text: '🛠 ورود به پنل مدیریت', callback_data: 'adm_panel_home' }]);
  }

  return {
    text: greeting,
    replyMarkup: { inline_keyboard: inlineRows },
  };
}

function buildUnlinkedAccountAuthView(): { text: string; replyMarkup: Record<string, unknown> } {
  return {
    text:
      `👋 <b>به بخش حساب کاربری SentraVPN خوش آمدید!</b>\n\n` +
      `برای دریافت <b>کد اتصال ۸ رقمی اختصاصی</b>، مشاهده وضعیت مصرف و همگام‌سازی یکپارچه حساب خود بین ربات تلگرام و اپلیکیشن SentraVPN، لطفاً یکی از گزینه‌های زیر را انتخاب کنید:`,
    replyMarkup: {
      inline_keyboard: [
        [{ text: '📝 ثبت‌نام جدید', callback_data: 'auth_register_new' }],
        [{ text: '🔑 ورود به حساب موجود (اتصال به اپلیکیشن)', callback_data: 'auth_login_app' }],
      ],
    },
  };
}

async function ensureSubscriptionConnectCode(
  db: D1Database,
  sub: SubscriptionRow
): Promise<string> {
  if (sub.connect_code && /^\d{8}$/.test(sub.connect_code)) {
    return sub.connect_code;
  }
  const code = await generateUniqueConnectCode(db);
  await db
    .prepare('UPDATE subscriptions SET connect_code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .bind(code, sub.id)
    .run();
  sub.connect_code = code;
  return code;
}

async function buildUserAccountView(
  env: Env,
  user: UserRow,
  sub: SubscriptionRow
): Promise<{ text: string; replyMarkup: Record<string, unknown> }> {
  const connectCode = await ensureSubscriptionConnectCode(env.DB, sub);
  const planTier = resolvePlanTier(sub);
  const statusLabel =
    sub.status === 'active'
      ? '🟢 فعال'
      : sub.status === 'expired'
      ? '🟡 منقضی‌شده'
      : sub.status === 'depleted'
      ? '🟠 اتمام حجم'
      : '🔴 غیرفعال';

  let planHeader = '🆓 <b>پلن فعلی:</b> رایگان (Free)';
  let quotaSection = '';
  const hasUsedTrial = Number(sub.has_used_special_trial || 0) === 1;
  const specialQuotaBytes = Math.max(0, Number(sub.special_quota_bytes || 0));
  const specialUsedBytes = Math.max(
    Number(sub.special_used_bytes || 0),
    Math.round(Number(sub.static_ip_used_mb || 0) * MIB_BYTES)
  );

  if (planTier === 'free') {
    const { webQuotaGb, downloadQuotaGb, webQuotaBytes, downloadQuotaBytes } =
      await getFreeQuotaSettings(env.DB, env.SENTRA_KV);
    const webUsedBytes = Math.max(
      Number(sub.web_used_bytes || 0),
      Math.round(Number(sub.web_browsing_used_mb || 0) * MIB_BYTES)
    );
    const dlUsedBytes = Math.max(
      Number(sub.download_used_bytes || 0),
      Math.round(Number(sub.download_used_mb || 0) * MIB_BYTES)
    );
    const webRemBytes = Math.max(0, webQuotaBytes - webUsedBytes);
    const dlRemBytes = Math.max(0, downloadQuotaBytes - dlUsedBytes);

    quotaSection =
      `🌐 <b>وبگردی (سقف ${webQuotaGb} GB):</b>\n` +
      `   • مصرف‌شده: <b>${formatGb(webUsedBytes)} GB</b> | باقیمانده: <b>${formatGb(webRemBytes)} GB</b>\n` +
      `📥 <b>دانلود (سقف ${downloadQuotaGb} GB):</b>\n` +
      `   • مصرف‌شده: <b>${formatGb(dlUsedBytes)} GB</b> | باقیمانده: <b>${formatGb(dlRemBytes)} GB</b>`;

    if (specialQuotaBytes > 0) {
      const trialRem = Math.max(0, specialQuotaBytes - specialUsedBytes);
      quotaSection +=
        `\n\n🎁 <b>تست ۱ گیگابایتی بخش ویژه (آیپی ثابت + گیمینگ):</b>\n` +
        `   • مصرف: <b>${formatGb(specialUsedBytes)} GB</b> از <b>${formatGb(specialQuotaBytes)} GB</b> (باقیمانده: <b>${formatGb(trialRem)} GB</b>)\n` +
        `   • <code>${buildProgressBar(specialUsedBytes, specialQuotaBytes)}</code>`;
    }
  } else if (planTier === 'pro') {
    planHeader = '🚀 <b>پلن فعلی:</b> Sentra Pro';
    const totalSpecial = specialQuotaBytes > 0 ? specialQuotaBytes : PRO_SPECIAL_QUOTA_BYTES;
    const remSpecial = Math.max(0, totalSpecial - specialUsedBytes);
    quotaSection =
      `🌐 <b>وبگردی:</b> ♾️ نامحدود\n` +
      `📥 <b>دانلود:</b> ♾️ نامحدود\n\n` +
      `🛡 <b>بخش ویژه (آیپی ثابت):</b>\n` +
      `   • کل حجم: <b>${formatGb(totalSpecial)} GB</b>\n` +
      `   • مصرف‌شده: <b>${formatGb(specialUsedBytes)} GB</b> | باقیمانده: <b>${formatGb(remSpecial)} GB</b>\n` +
      `   • <code>${buildProgressBar(specialUsedBytes, totalSpecial)}</code>`;
  } else {
    planHeader = '🔥 <b>پلن فعلی:</b> Sentra Flow+';
    const totalSpecial = specialQuotaBytes > 0 ? specialQuotaBytes : FLOW_PLUS_SPECIAL_QUOTA_BYTES;
    const remSpecial = Math.max(0, totalSpecial - specialUsedBytes);
    quotaSection =
      `🌐 <b>وبگردی:</b> ♾️ نامحدود\n` +
      `📥 <b>دانلود:</b> ♾️ نامحدود\n\n` +
      `🛡 <b>بخش ویژه (آیپی ثابت + 🎮 گیمینگ):</b>\n` +
      `   • کل حجم: <b>${formatGb(totalSpecial)} GB</b>\n` +
      `   • مصرف‌شده: <b>${formatGb(specialUsedBytes)} GB</b> | باقیمانده: <b>${formatGb(remSpecial)} GB</b>\n` +
      `   • <code>${buildProgressBar(specialUsedBytes, totalSpecial)}</code>`;
  }

  const inlineRows: Array<Array<{ text: string; callback_data?: string; web_app?: { url: string } }>> = [
    [{ text: MINIAPP_BUTTON_LABEL, web_app: { url: resolveMiniAppUrl(env) } }],
  ];
  if (planTier === 'free' && !hasUsedTrial) {
    inlineRows.push([
      {
        text: '🎁 فعال‌سازی تست رایگان ۱ گیگابایتی (آیپی ثابت + گیمینگ)',
        callback_data: 'user_activate_special_trial',
      },
    ]);
  }
  inlineRows.push([
    { text: '💎 ارتقای اشتراک', callback_data: 'user_upgrade' },
    { text: '📥 دانلود اپلیکیشن', callback_data: 'user_download_app' },
  ]);
  inlineRows.push([
    { text: '🎫 تیکت‌های من', callback_data: 'user_support' },
    { text: '🔄 بروزرسانی', callback_data: 'user_account' },
  ]);
  inlineRows.push([{ text: '🔙 منوی اصلی', callback_data: 'user_menu_home' }]);

  return {
    text:
      `👤 <b>حساب کاربری SentraVPN</b>\n\n` +
      `🔑 <b>کد اتصال ۸ رقمی اختصاصی شما (برای کپی ضربه بزنید):</b>\n` +
      `<code>${escapeHtml(connectCode)}</code>\n\n` +
      `${planHeader}\n` +
      `📌 <b>وضعیت:</b> ${statusLabel}\n` +
      `📅 <b>تاریخ انقضا:</b> <code>${escapeHtml(sub.expires_at.slice(0, 10))}</code>\n` +
      `📱 <b>حداکثر دستگاه هم‌زمان:</b> <b>${sub.max_concurrent_devices}</b>\n\n` +
      `${quotaSection}\n\n` +
      `💡 <i>این کد ۸ رقمی را مستقیماً داخل اپلیکیشن رسمی SentraVPN وارد کنید.</i>`,
    replyMarkup: { inline_keyboard: inlineRows },
  };
}

function buildUserUpgradeView(
  sub: SubscriptionRow | null
): { text: string; replyMarkup: Record<string, unknown> } {
  const planTier = sub ? resolvePlanTier(sub) : 'free';
  const currentLabel =
    planTier === 'flow_plus'
      ? 'Sentra Flow+'
      : planTier === 'pro'
      ? 'Sentra Pro'
      : 'رایگان (Free)';

  return {
    text:
      `💎 <b>ارتقای اشتراک SentraVPN</b>\n\n` +
      `پلن فعلی شما: <b>${escapeHtml(currentLabel)}</b>\n\n` +
      `🚀 <b>پلن Sentra Pro — ۱۲۰,۰۰۰ تومان (ماهانه)</b>\n` +
      `• 🌐 وبگردی و 📥 دانلود: <b>♾️ نامحدود</b>\n` +
      `• 🛡 بخش ویژه: <b>۳۰ گیگابایت آیپی ثابت اختصاصی</b> (مناسب ترید، هوش مصنوعی و حساب‌های حساس)\n\n` +
      `🔥 <b>پلن Sentra Flow+ — ۱۸۰,۰۰۰ تومان (ماهانه)</b>\n` +
      `• 🌐 وبگردی و 📥 دانلود: <b>♾️ نامحدود</b>\n` +
      `• 🛡 بخش ویژه: <b>۵۰ گیگابایت آیپی ثابت + 🎮 گیمینگ کم‌تاخیر</b>\n\n` +
      `💡 پلن مورد نظر را انتخاب کنید تا فیش واریزی خود را ارسال نمایید:`,
    replyMarkup: {
      inline_keyboard: [
        [
          {
            text: `🚀 ارتقا به Sentra Pro (${PRO_PLAN_PRICE_TOMAN.toLocaleString('en-US')} تومان)`,
            callback_data: 'user_submit_receipt_pro',
          },
        ],
        [
          {
            text: `🔥 ارتقا به Sentra Flow+ (${FLOW_PLUS_PLAN_PRICE_TOMAN.toLocaleString('en-US')} تومان)`,
            callback_data: 'user_submit_receipt_flow',
          },
        ],
        [{ text: '🤝 اهدای نود / سابلینک (دریافت پلن هدیه)', callback_data: 'user_donate_outbound' }],
        [{ text: '🔙 منوی اصلی', callback_data: 'user_menu_home' }],
      ],
    },
  };
}

function buildUserDonateMenuView(): { text: string; replyMarkup: Record<string, unknown> } {
  return {
    text:
      `🤝 <b>اهدای نود یا سابلینک به اکوسیستم SentraVPN</b>\n\n` +
      `با اشتراک‌گذاری سرور یا سابلینک سالم خود، به پایداری شبکه آزاد کمک کنید و اشتراک ویژه هدیه بگیرید:\n\n` +
      `🎁 <b>توجه:</b> اگر کاربری سرور یا سابلینکی با حجم <b>۲۰۰ گیگابایت یا بیشتر</b> اهدا کند اشتراک <b>Sentra Pro</b>، و در صورت اهدای سرور با حجم <b>۳۰۰ گیگابایت یا بیشتر</b>، اشتراک <b>Sentra Flow+</b> به‌عنوان هدیه دریافت خواهد کرد.\n\n` +
      `روش اهدا را انتخاب کنید:`,
    replyMarkup: {
      inline_keyboard: [
        [{ text: '➕ اهدای نود (کانفیگ تکی)', callback_data: 'user_donate_single_node' }],
        [{ text: '🔗 اهدای سابلینک (Subscription)', callback_data: 'user_donate_sublink' }],
        [{ text: '🔙 منوی اصلی', callback_data: 'user_menu_home' }],
      ],
    },
  };
}

function buildUserGuideView(
  platform: 'overview' | 'android' | 'windows' = 'overview'
): { text: string; replyMarkup: Record<string, unknown> } {
  let text =
    '📖 <b>راهنمای اتصال به SentraVPN</b>\n\n' +
    'اتصال به سرویس SentraVPN به‌صورت اختصاصی از طریق <b>اپلیکیشن رسمی SentraVPN</b> و <b>کد اتصال ۸ رقمی</b> انجام می‌شود.\n\n' +
    'سیستم‌عامل خود را انتخاب کنید:';

  if (platform === 'android') {
    text =
      '🤖 <b>راهنمای اتصال در اندروید</b>\n\n' +
      '۱. از بخش «📥 دانلود اپلیکیشن»، نسخه رسمی اندروید <b>SentraVPN</b> را دانلود و نصب کنید.\n' +
      '۲. وارد بخش «👤 حساب کاربری» در همین ربات شوید و روی <b>کد اتصال ۸ رقمی</b> خود ضربه بزنید تا کپی شود.\n' +
      '۳. اپلیکیشن SentraVPN را باز کرده، کد ۸ رقمی را وارد کنید و روی دکمه ورود بزنید.\n' +
      '۴. حالت دلخواه (وبگردی، دانلود، آیپی ثابت یا گیمینگ) را انتخاب کرده و متصل شوید.';
  } else if (platform === 'windows') {
    text =
      '🪟 <b>راهنمای اتصال در ویندوز</b>\n\n' +
      '۱. از بخش «📥 دانلود اپلیکیشن»، نسخه <b>Setup x64</b> یا <b>Portable x64</b> ویندوز را دریافت کنید.\n' +
      '۲. از بخش «👤 حساب کاربری» در ربات، <b>کد اتصال ۸ رقمی</b> اختصاصی خود را کپی کنید.\n' +
      '۳. برنامه SentraVPN را اجرا کرده و با کد ۸ رقمی وارد حساب خود شوید.\n' +
      '۴. سرور و حالت اتصال را انتخاب کرده و دکمه اتصال را بزنید.';
  }

  return {
    text,
    replyMarkup: {
      inline_keyboard: [
        [
          { text: '🤖 راهنمای اندروید', callback_data: 'user_guide_android' },
          { text: '🪟 راهنمای ویندوز', callback_data: 'user_guide_windows' },
        ],
        [
          { text: '📥 دانلود اپلیکیشن', callback_data: 'user_download_app' },
          { text: '👤 مشاهده کد اتصال ۸ رقمی', callback_data: 'user_account' },
        ],
        [{ text: '🔙 منوی اصلی', callback_data: 'user_menu_home' }],
      ],
    },
  };
}

async function buildUserDownloadAppView(
  env: Env
): Promise<{ text: string; replyMarkup: Record<string, unknown> }> {
  let rows: AppReleaseFileRow[] = [];
  try {
    await ensureSchemaColumns(env.DB);
    const res = await env.DB.prepare(
      'SELECT platform, version, github_url, telegram_file_id, updated_at FROM app_release_files ORDER BY platform ASC'
    ).all<AppReleaseFileRow>();
    rows = res.results || [];
  } catch {
    rows = [];
  }

  const andr = rows.find((r) => r.platform === 'android');
  const win = rows.find((r) => r.platform === 'windows');

  const lines: string[] = [
    `🤖 <b>اندروید (Android):</b> ` +
      (andr
        ? `نسخه <code>${escapeHtml(andr.version)}</code>${andr.telegram_file_id ? ' — ارسال فوری از سرور تلگرام ⚡️' : ' — دانلود مستقیم از گیتهاب'}`
        : 'دانلود مستقیم آخرین نسخه از گیتهاب (Universal / ARMv8 / ARMv7 / x64)'),
    `🪟 <b>ویندوز (Windows):</b> ` +
      (win
        ? `نسخه <code>${escapeHtml(win.version)}</code>${win.telegram_file_id ? ' — ارسال فوری از سرور تلگرام ⚡️' : ' — دانلود مستقیم از گیتهاب'}`
        : 'دانلود مستقیم آخرین نسخه از گیتهاب (Setup x64 / Portable x64)'),
  ];

  return {
    text:
      `📥 <b>دانلود اپلیکیشن رسمی SentraVPN</b>\n\n` +
      `${lines.join('\n\n')}\n\n` +
      `سیستم‌عامل خود را انتخاب کنید تا فایل نصبی (با نهایت سرعت از سرور تلگرام یا لینک مستقیم گیتهاب) برای شما ارسال شود:`,
    replyMarkup: {
      inline_keyboard: [
        [
          { text: '🤖 اندروید (Android)', callback_data: 'user_dl_android' },
          { text: '🪟 ویندوز (Windows)', callback_data: 'user_dl_windows' },
        ],
        [
          { text: '👤 مشاهده کد اتصال ۸ رقمی', callback_data: 'user_account' },
          { text: '🔙 منوی اصلی', callback_data: 'user_menu_home' },
        ],
      ],
    },
  };
}

async function sendPlatformReleaseDownload(
  env: Env,
  chatId: number,
  platform: 'android' | 'windows'
): Promise<void> {
  let relFile: AppReleaseFileRow | null = null;
  try {
    await ensureSchemaColumns(env.DB);
    relFile = await env.DB.prepare(
      'SELECT platform, version, github_url, telegram_file_id, updated_at FROM app_release_files WHERE platform = ? LIMIT 1'
    )
      .bind(platform)
      .first<AppReleaseFileRow>();
  } catch {
    relFile = null;
  }

  let fileId = relFile?.telegram_file_id || null;
  let version = relFile?.version || 'latest';

  if (!fileId) {
    try {
      const legacy = await env.DB.prepare(
        'SELECT version, telegram_file_id FROM app_releases WHERE platform = ? LIMIT 1'
      )
        .bind(platform)
        .first<{ version: string; telegram_file_id: string }>();
      if (legacy?.telegram_file_id) {
        fileId = legacy.telegram_file_id;
        if (!relFile?.version && legacy.version) {
          version = legacy.version;
        }
      }
    } catch {
      // ignore if legacy table is empty
    }
  }

  const base = GITHUB_RELEASES_BASE_URL;
  const isAndroid = platform === 'android';
  const urlButtons: Array<Array<{ text: string; url?: string; callback_data?: string }>> = isAndroid
    ? [
        [{ text: '📱 دانلود Universal APK (پیشنهادی)', url: `${base}/SentraVPN-Android-Universal.apk` }],
        [
          { text: '📱 ARMv8 (۶۴ بیتی)', url: `${base}/SentraVPN-Android-ARMv8.apk` },
          { text: '📱 ARMv7 (۳۲ بیتی)', url: `${base}/SentraVPN-Android-ARMv7.apk` },
        ],
        [{ text: '📱 x64 (شبیه‌ساز / تبلت)', url: `${base}/SentraVPN-Android-x64.apk` }],
        [{ text: '👤 مشاهده کد اتصال ۸ رقمی', callback_data: 'user_account' }],
      ]
    : [
        [{ text: '💿 دانلود Windows Setup x64 (.exe)', url: `${base}/SentraVPN-Windows-Setup-x64.exe` }],
        [{ text: '📦 دانلود Windows Portable x64 (.zip)', url: `${base}/SentraVPN-Windows-Portable-x64.zip` }],
        [{ text: '👤 مشاهده کد اتصال ۸ رقمی', callback_data: 'user_account' }],
      ];

  const installGuide = isAndroid
    ? `📌 <b>راهنمای نصب:</b> فایل را نصب کرده، سپس کد اتصال ۸ رقمی یا نام کاربری خود را در برنامه وارد کنید.`
    : `📌 <b>راهنمای نصب:</b> فایل نصبی را اجرا کرده (Run as Administrator در صورت نیاز) و با کد اتصال ۸ رقمی یا نام کاربری وارد شوید.`;

  if (fileId) {
    // Instant CDN delivery straight from Telegram servers using cached telegram_file_id
    await tgSendDocumentByFileId(
      env,
      chatId,
      fileId,
      `⚡️ <b>SentraVPN (${isAndroid ? 'Android' : 'Windows'}) — نسخه <code>${escapeHtml(version)}</code></b>\n\n` +
        `${installGuide}`
    );

    await tgSendMessage(
      env,
      chatId,
      `🌐 <b>لینک‌های جایگزین (GitHub Releases) — ${isAndroid ? 'اندروید' : 'ویندوز'}</b>\n` +
        `در صورت نیاز به معماری خاص یا دانلود از خارج تلگرام، از دکمه‌های زیر استفاده کنید:`,
      { inline_keyboard: urlButtons }
    );
    return;
  }

  await tgSendMessage(
    env,
    chatId,
    `📥 <b>دانلود نسخه رسمی ${isAndroid ? 'اندروید (Android)' : 'ویندوز (Windows)'} SentraVPN</b>\n\n` +
      `🔹 نسخه: <code>${escapeHtml(version)}</code>\n` +
      `🌐 لینک‌های مستقیم آخرین نسخه از GitHub Releases (parsa904/SentraVpn):\n\n` +
      `${installGuide}`,
    { inline_keyboard: urlButtons }
  );
}

function buildAdminUpdateReleaseFileView(): {
  text: string;
  replyMarkup: Record<string, unknown>;
} {
  return {
    text:
      '📦 <b>بروزرسانی فایل نصبی ربات (Telegram file_id)</b>\n\n' +
      'پلتفرم مورد نظر را انتخاب کنید تا فایل نصبی (APK یا EXE/ZIP) را فوروارد یا ارسال کرده و در دیتابیس D1 ثبت نمایید:',
    replyMarkup: {
      inline_keyboard: [
        [
          { text: '🤖 فایل نصبی اندروید (APK)', callback_data: 'adm_rel_pick_android' },
          { text: '🪟 فایل نصبی ویندوز (EXE / ZIP)', callback_data: 'adm_rel_pick_windows' },
        ],
        [{ text: '🔙 بازگشت به پنل مدیریت', callback_data: 'adm_panel_home' }],
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
  const threadId =
    typeof q.message?.message_thread_id === 'number' ? q.message.message_thread_id : undefined;
  const telegramId = q.from.id;
  const data = (q.data || '').trim();

  // 1. ALWAYS acknowledge the callback query first with await to clear Telegram's loading spinner
  await tgAnswerCallbackQuery(env, q.id);

  try {
    const isAdmin = await resolveIsAdmin(env, telegramId);

    // --- Group Support Management Callbacks (Admin Only) ---
    if (data.startsWith('support_reply:')) {
      if (!isAdmin) {
        await tgSendMessage(env, chatId, '⛔ دسترسی غیرمجاز', undefined, {
          ...(threadId ? { message_thread_id: threadId } : {}),
          ...(messageId ? { reply_to_message_id: messageId } : {}),
        });
        return;
      }

      const parts = data.split(':');
      const targetUserId = Number(parts[1]);
      const userMessageId = Number(parts[2] || 0);
      if (!Number.isSafeInteger(targetUserId) || targetUserId <= 0) {
        return;
      }

      await setBotState(env.DB, telegramId, 'admin_awaiting_support_reply', {
        targetUserId,
        userMessageId: Number.isSafeInteger(userMessageId) && userMessageId > 0 ? userMessageId : null,
        groupChatId: chatId,
        groupThreadId: threadId ?? null,
      });

      await tgSendMessage(
        env,
        chatId,
        `💬 <b>حالت پاسخ به کاربر فعال شد</b>\n` +
          `🆔 شناسه کاربر: <code>${targetUserId}</code>\n\n` +
          `لطفاً پاسخ خود را (متن، عکس یا فایل) همینجا ارسال یا روی این پیام Reply کنید تا مستقیماً به پیام اصلی کاربر ارسال شود.`,
        {
          inline_keyboard: [
            [{ text: '❌ انصراف از پاسخ', callback_data: 'cancel_support_reply' }],
          ],
        },
        {
          ...(threadId ? { message_thread_id: threadId } : {}),
          ...(messageId ? { reply_to_message_id: messageId, allow_sending_without_reply: true } : {}),
        }
      );
      return;
    }

    if (data === 'cancel_support_reply') {
      if (!isAdmin) return;
      await clearBotState(env.DB, telegramId);
      const cancelMsg = '❌ حالت پاسخ به کاربر لغو شد.';
      if (messageId) {
        await tgEditMessageText(env, chatId, messageId, cancelMsg);
      } else {
        await tgSendMessage(env, chatId, cancelMsg, undefined, {
          ...(threadId ? { message_thread_id: threadId } : {}),
        });
      }
      return;
    }

    if (data.startsWith('close_support_topic:')) {
      if (!isAdmin) {
        await tgSendMessage(env, chatId, '⛔ دسترسی غیرمجاز', undefined, {
          ...(threadId ? { message_thread_id: threadId } : {}),
        });
        return;
      }

      const parts = data.split(':');
      const targetUserId = Number(parts[1]);
      const topicThreadId = Number(parts[2] || threadId || 0);
      if (!Number.isSafeInteger(targetUserId) || targetUserId <= 0) {
        return;
      }

      // 1. Mark session closed in D1 so future messages start a fresh cycle
      await closeSupportSession(env.DB, {
        userId: targetUserId,
        topicThreadId: Number.isSafeInteger(topicThreadId) && topicThreadId > 0 ? topicThreadId : null,
      });

      // 2. Best-effort close any open support_tickets for this user
      try {
        await env.DB.prepare(
          `UPDATE support_tickets
           SET status = 'closed', updated_at = CURRENT_TIMESTAMP
           WHERE user_id IN (SELECT id FROM users WHERE telegram_id = ?)
             AND status IN ('open', 'awaiting_user', 'investigating')`
        )
          .bind(targetUserId)
          .run();
      } catch {
        // Non-fatal ticket sync failure
      }

      // 3. Delete the dedicated Forum Topic via Telegram Bot API
      if (Number.isSafeInteger(topicThreadId) && topicThreadId > 0) {
        await deleteSupportForumTopic(env, topicThreadId);
      }

      // 4. Notify user in private chat that the support session was closed
      await tgSendMessage(env, targetUserId, '🔒 گفتگوی پشتیبانی توسط پشتیبانی بسته شد.');
      return;
    }

    // --- Auth Callbacks ---
    if (data === 'auth_register_new') {
      const existingRecord = await getUserAndSubByTelegramId(env.DB, telegramId);
      if (existingRecord?.sub && isUnifiedRegisteredAccount(existingRecord.user)) {
        const view = await buildUserAccountView(env, existingRecord.user, existingRecord.sub);
        await sendOrEditView(env, chatId, messageId, view);
        return;
      }

      await setBotState(env.DB, telegramId, 'awaiting_register_username');
      await sendOrEditView(env, chatId, messageId, {
        text:
          `📝 <b>ثبت‌نام حساب جدید SentraVPN (مرحله ۱ از ۳)</b>\n\n` +
          `لطفاً <b>نام کاربری (Username)</b> دلخواه خود را وارد کنید:\n` +
          `<i>• بین ۳ تا ۲۴ کاراکتر\n• فقط حروف انگلیسی، اعداد و زیرخط (_)</i>`,
        replyMarkup: buildCancelStateInlineMarkup(),
      });
      return;
    }

    if (data === 'auth_login_app') {
      await setBotState(env.DB, telegramId, 'awaiting_login_username');
      await sendOrEditView(env, chatId, messageId, {
        text:
          `🔑 <b>ورود به حساب موجود (اتصال به اپلیکیشن)</b>\n\n` +
          `لطفاً <b>نام کاربری (Username)</b> حساب خود در اپلیکیشن SentraVPN را ارسال کنید:`,
        replyMarkup: buildCancelStateInlineMarkup(),
      });
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
        buildUserMenuHomeView(record?.user || null, record?.sub || null, effectiveIsAdmin, env)
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
        buildUserMenuHomeView(record?.user || null, record?.sub || null, effectiveIsAdmin, env)
      );
      return;
    }

    // --- User Account Status (Unified Auth Gate) ---
    if (data === 'user_account') {
      const record = await getUserAndSubByTelegramId(env.DB, telegramId);
      if (!record || !record.sub || !isUnifiedRegisteredAccount(record.user)) {
        await sendOrEditView(env, chatId, messageId, buildUnlinkedAccountAuthView());
        return;
      }
      const view = await buildUserAccountView(env, record.user, record.sub);
      await sendOrEditView(env, chatId, messageId, view);
      return;
    }

    // --- One-time 1 GB Special Trial Activation (Atomic Double-Click Guard) ---
    if (data === 'user_activate_special_trial') {
      const { user, sub } = await ensureTelegramUserAndSubscription(
        env.DB,
        q.from,
        isEnvAdmin(env, telegramId)
      );
      const planTier = resolvePlanTier(sub);
      if (planTier !== 'free') {
        const view = await buildUserAccountView(env, user, sub);
        await sendOrEditView(env, chatId, messageId, view);
        return;
      }

      const updateRes = await env.DB.prepare(
        `UPDATE subscriptions
         SET has_used_special_trial = 1,
             special_quota_bytes = CASE
               WHEN COALESCE(special_quota_bytes, 0) < ? THEN ?
               ELSE special_quota_bytes
             END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND COALESCE(has_used_special_trial, 0) = 0`
      )
        .bind(SPECIAL_TRIAL_BYTES, SPECIAL_TRIAL_BYTES, sub.id)
        .run();

      const changes = updateRes.meta?.changes ?? 0;
      if (changes === 0) {
        const refreshed = await getUserAndSubByTelegramId(env.DB, telegramId);
        await tgSendMessage(
          env,
          chatId,
          'ℹ️ شما پیش‌تر از تست رایگان ۱ گیگابایتی بخش ویژه استفاده کرده‌اید.'
        );
        if (refreshed?.sub) {
          const view = await buildUserAccountView(env, refreshed.user, refreshed.sub);
          await sendOrEditView(env, chatId, messageId, view);
        }
        return;
      }

      // Check cached active nodes pool (zero extra D1 cost on cache hit) for active special servers
      const activePool = await getCachedActiveNodesPool(env.DB, env.SENTRA_KV);
      const hasSpecialServers =
        activePool.hasActiveGaming ||
        activePool.donated.some(
          (n) =>
            n.allow_static_ip === 1 ||
            n.allow_gaming === 1 ||
            n.assigned_tier === 'static_ip' ||
            n.assigned_tier === 'gaming'
        ) ||
        activePool.core.some(
          (c) => c.mode_category === 'static_ip' || c.mode_category === 'gaming'
        );

      sub.has_used_special_trial = 1;
      sub.special_quota_bytes = Math.max(Number(sub.special_quota_bytes || 0), SPECIAL_TRIAL_BYTES);

      const notice = hasSpecialServers
        ? '🎁 <b>تست رایگان ۱ گیگابایتی بخش ویژه (آیپی ثابت + گیمینگ) با موفقیت برای حساب شما فعال شد!</b>\n\nهم‌اکنون می‌توانید با کد ۸ رقمی خود داخل اپلیکیشن SentraVPN از حالت‌های آیپی ثابت و گیمینگ استفاده کنید.'
        : '🎁 <b>تست رایگان ۱ گیگابایتی بخش ویژه برای حساب شما ثبت و ذخیره شد!</b>\n\nℹ️ سرورهای اختصاصی آیپی ثابت و گیمینگ هم‌اکنون در حال آماده‌سازی هستند؛ به محض فعال شدن سرورهای ویژه، ۱ گیگابایت هدیه شما به‌صورت خودکار در اپلیکیشن قابل استفاده خواهد بود.';

      await tgSendMessage(env, chatId, notice);
      const view = await buildUserAccountView(env, user, sub);
      await sendOrEditView(env, chatId, messageId, view);
      return;
    }

    // --- Deprecated V2Ray / iOS sublink callbacks -> gently redirect to 8-digit account view ---
    if (data === 'user_get_sub' || data === 'user_ios_menu' || data.startsWith('ios_mode_')) {
      const { user, sub } = await ensureTelegramUserAndSubscription(
        env.DB,
        q.from,
        isEnvAdmin(env, telegramId)
      );
      const view = await buildUserAccountView(env, user, sub);
      await sendOrEditView(env, chatId, messageId, view);
      return;
    }

    // --- User Upgrade & Payment Receipt ---
    if (data === 'user_upgrade') {
      const record = await getUserAndSubByTelegramId(env.DB, telegramId);
      await sendOrEditView(env, chatId, messageId, buildUserUpgradeView(record?.sub || null));
      return;
    }

    if (data === 'user_submit_receipt_pro' || data === 'user_submit_receipt_flow') {
      await ensureTelegramUserAndSubscription(env.DB, q.from, isEnvAdmin(env, telegramId));
      const isFlow = data === 'user_submit_receipt_flow';
      const plan = isFlow ? 'Sentra Flow+' : 'Sentra Pro';
      const amount = isFlow ? FLOW_PLUS_PLAN_PRICE_TOMAN : PRO_PLAN_PRICE_TOMAN;

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

    // --- User Donate Outbound / Sublink ---
    if (data === 'user_donate_outbound') {
      await ensureTelegramUserAndSubscription(env.DB, q.from, isEnvAdmin(env, telegramId));
      await sendOrEditView(env, chatId, messageId, buildUserDonateMenuView());
      return;
    }

    if (data === 'user_donate_single_node') {
      await ensureTelegramUserAndSubscription(env.DB, q.from, isEnvAdmin(env, telegramId));
      await setBotState(env.DB, telegramId, 'awaiting_donate_outbound');
      await tgSendMessage(
        env,
        chatId,
        '➕ <b>اهدای نود (کانفیگ تکی)</b>\n\n' +
          'لینک پروکسی خود (<code>vless://</code>, <code>vmess://</code>, <code>trojan://</code>, <code>hy2://</code>, <code>ss://</code>, <code>tuic://</code>) یا کانفیگ JSON سینگ‌باکس را ارسال کنید تا پس از بررسی امنیتی و تأیید مدیریت در اکوسیستم ثبت شود:',
        buildCancelStateInlineMarkup()
      );
      return;
    }

    if (data === 'user_donate_sublink') {
      await ensureTelegramUserAndSubscription(env.DB, q.from, isEnvAdmin(env, telegramId));
      await setBotState(env.DB, telegramId, 'awaiting_donate_sublink');
      await tgSendMessage(
        env,
        chatId,
        '🔗 <b>اهدای سابلینک (Subscription)</b>\n\n' +
          'لطفاً لینک اشتراک معتبر با پروتکل <code>https://</code> (حداکثر ۵۱۲ کاراکتر و بدون نام کاربری/رمز در آدرس) را ارسال کنید.\n' +
          'سابلینک شما پس از بررسی امنیتی و تأیید ادمین، به‌صورت خودکار توسط QualityEngine پایش و به شبکه اضافه خواهد شد:',
        buildCancelStateInlineMarkup()
      );
      return;
    }

    // --- User Connection Guide ---
    if (data === 'user_guide' || data === 'user_guide_ios') {
      await sendOrEditView(env, chatId, messageId, buildUserGuideView('overview'));
      return;
    }
    if (data === 'user_guide_android') {
      await sendOrEditView(env, chatId, messageId, buildUserGuideView('android'));
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
      await sendPlatformReleaseDownload(env, chatId, platform);
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

      if (data.startsWith('adm_subsrc_approve_') || data.startsWith('adm_subsrc_reject_')) {
        const isApprove = data.startsWith('adm_subsrc_approve_');
        const srcId = Number(
          data.slice(isApprove ? 'adm_subsrc_approve_'.length : 'adm_subsrc_reject_'.length)
        );
        if (!Number.isInteger(srcId) || srcId <= 0) return;

        const srcRow = await env.DB.prepare(
          `SELECT s.id, s.sub_url, s.status, u.telegram_id AS submitter_telegram_id
           FROM subscription_sources s
           LEFT JOIN users u ON u.id = s.submitted_by_user_id
           WHERE s.id = ?
           LIMIT 1`
        )
          .bind(srcId)
          .first<{
            id: number;
            sub_url: string;
            status: string | null;
            submitter_telegram_id: number | null;
          }>();

        if (!srcRow) {
          await tgSendMessage(env, chatId, '❌ منبع سابسکریپشن مورد نظر یافت نشد.');
          return;
        }

        const nextStatus = isApprove ? 'active' : 'rejected';
        await env.DB.prepare(
          'UPDATE subscription_sources SET status = ?, last_sync_at = CURRENT_TIMESTAMP WHERE id = ?'
        )
          .bind(nextStatus, srcId)
          .run();
        await invalidateNodesCache(env.DB, env.SENTRA_KV);

        if (srcRow.submitter_telegram_id) {
          await tgSendMessage(
            env,
            srcRow.submitter_telegram_id,
            isApprove
              ? `✅ <b>سابلینک اهدایی شما (#${srcRow.id}) توسط مدیریت تأیید و فعال شد!</b>\n\n🤝 از حمایت ارزشمند شما از شبکه SentraVPN سپاسگزاریم.`
              : `❌ <b>سابلینک اهدایی شما (#${srcRow.id}) توسط مدیریت رد شد.</b>\n\nدر صورت تمایل می‌توانید سابلینک معتبر دیگری ارسال کنید.`
          );
        }

        const view = await buildAdminSubSourcesView(env);
        await sendOrEditView(env, chatId, messageId, view);
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
          const isFlow = donRow.amount >= 170000;
          const targetTier = isFlow ? 'Sentra Flow+' : 'Sentra Pro';
          const targetPlanTier = isFlow ? 'flow_plus' : 'pro';
          const targetSpecialQuota = isFlow
            ? FLOW_PLUS_SPECIAL_QUOTA_BYTES
            : PRO_SPECIAL_QUOTA_BYTES;
          const targetLimit = isFlow ? 500 * GIB_BYTES : 200 * GIB_BYTES;

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
                 SET tier = ?, plan_tier = ?, traffic_limit_bytes = ?,
                     special_quota_bytes = ?, special_used_bytes = 0,
                     status = 'active', expires_at = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`
              ).bind(
                targetTier,
                targetPlanTier,
                targetLimit,
                targetSpecialQuota,
                nextExpires,
                userSub.id
              )
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
           SET tier = ?, plan_tier = ?, traffic_limit_bytes = ?,
               special_quota_bytes = ?, special_used_bytes = 0,
               status = 'active', updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        )
          .bind(cfg.tier, cfg.planTier, cfg.limitBytes, cfg.specialQuotaBytes, subId)
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
           SET upload_bytes = 0, download_bytes = 0,
               web_used_bytes = 0, download_used_bytes = 0, special_used_bytes = 0,
               web_browsing_used_mb = 0, download_used_mb = 0, static_ip_used_mb = 0,
               status = 'active', last_quota_reset = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP
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

      if (data === 'adm_update_release_file') {
        await clearBotState(env.DB, telegramId);
        await sendOrEditView(env, chatId, messageId, buildAdminUpdateReleaseFileView());
        return;
      }

      if (data === 'adm_rel_pick_android' || data === 'adm_rel_pick_windows') {
        const platform = data === 'adm_rel_pick_android' ? 'android' : 'windows';
        await setBotState(env.DB, telegramId, 'admin_awaiting_release_file', { platform });
        await tgSendMessage(
          env,
          chatId,
          `📦 <b>بروزرسانی فایل نصبی ${platform === 'android' ? 'اندروید (APK)' : 'ویندوز (EXE / ZIP)'}</b>\n\n` +
            `فایل نصبی جدید را همینجا ارسال یا فوروارد کنید (می‌توانید شماره نسخه مثل <code>v1.0.5</code> را در کپشن فایل بنویسید):`,
          buildCancelStateInlineMarkup()
        );
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
      buildUserMenuHomeView(record?.user || null, record?.sub || null, isAdmin, env).replyMarkup
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
// Support Reply & Dedicated Forum Topic Helpers
// ==============================================================================

function buildSupportReplyInlineMarkup(
  userTelegramId: number,
  userMessageId: number
): Record<string, unknown> {
  return {
    inline_keyboard: [
      [
        {
          text: '💬 پاسخ به کاربر',
          callback_data: `support_reply:${userTelegramId}:${userMessageId}`,
        },
      ],
    ],
  };
}

function buildCloseSupportTopicInlineMarkup(
  userTelegramId: number,
  topicThreadId: number
): Record<string, unknown> {
  return {
    inline_keyboard: [
      [
        {
          text: '🗑 پایان گفتگو و حذف تاپیک',
          callback_data: `close_support_topic:${userTelegramId}:${topicThreadId}`,
        },
      ],
    ],
  };
}

/**
 * Escalates an ongoing support conversation (`message_count >= 3`) to a dedicated
 * Telegram Forum Topic (`🎫 پشتیبانی: <name> (<uid>)`), saves `topic_thread_id`
 * in D1 `support_sessions`, pins the control panel with the close/delete button,
 * and returns the dedicated `topic_thread_id` (or `null` on graceful fallback).
 */
async function ensureEscalatedSupportTopicIfNeeded(
  env: Env,
  session: SupportSessionRow,
  userMeta: {
    userId: number;
    fullName?: string | null;
    username?: string | null;
  }
): Promise<number | null> {
  if (session.topic_thread_id && session.topic_thread_id > 0) {
    return session.topic_thread_id;
  }
  if (session.message_count < SUPPORT_TOPIC_ESCALATION_THRESHOLD) {
    return null;
  }

  let fullName = (userMeta.fullName || '').trim();
  let username = (userMeta.username || '').trim();
  if (!fullName && !username) {
    try {
      const userRow = await env.DB.prepare(
        `SELECT first_name, last_name, username FROM users WHERE telegram_id = ? LIMIT 1`
      )
        .bind(userMeta.userId)
        .first<{ first_name?: string | null; last_name?: string | null; username?: string | null }>();
      if (userRow) {
        fullName = [userRow.first_name, userRow.last_name].filter(Boolean).join(' ').trim();
        username = (userRow.username || '').trim();
      }
    } catch {
      // Fallback to numeric ID in title
    }
  }

  const topicTitle = buildSupportTopicTitle({
    fullName,
    username,
    userId: userMeta.userId,
  });

  const created = await createSupportForumTopic(env, topicTitle);
  if (!created.ok) {
    return null;
  }

  await attachTopicToSupportSession(env.DB, session.id, created.threadId);

  const usernameDisplay = username
    ? `@${escapeHtml(username.replace(/^@+/, ''))}`
    : 'ندارد';
  const controlText =
    `🎫 <b>تاپیک اختصاصی پشتیبانی فعال شد</b>\n\n` +
    `👤 نام: <b>${escapeHtml(fullName || 'کاربر')}</b>\n` +
    `🔗 یوزرنیم: ${usernameDisplay}\n` +
    `🆔 شناسه کاربر: #UID_${userMeta.userId}\n\n` +
    `💬 <i>هر پیامی (متن، عکس یا فایل) که ادمین در این تاپیک ارسال کند، بدون نیاز به دکمه یا Reply به‌صورت خودکار برای کاربر ارسال می‌شود.</i>`;

  const ctrlRes = await sendToTopicWithResult(env, 'support', controlText, {
    threadIdOverride: created.threadId,
    replyMarkup: buildCloseSupportTopicInlineMarkup(userMeta.userId, created.threadId),
  });
  if (ctrlRes.ok && ctrlRes.messageId) {
    await pinGroupMessage(env, ctrlRes.messageId);
  }

  await sendToTopic(
    env,
    'support',
    `📌 گفتگوی ادامه‌دار با <b>${escapeHtml(fullName || 'کاربر')}</b> (#UID_${userMeta.userId}) به تاپیک اختصاصی <b>${escapeHtml(topicTitle)}</b> منتقل شد.`
  );

  return created.threadId;
}

/**
 * Forwards an incoming user support message (ticket or follow-up) to either the
 * user's dedicated Forum Topic (auto-created once `message_count >= 3`) or the
 * general Support Topic with a one-click `💬 پاسخ به کاربر` inline button.
 */
async function forwardUserSupportMessageToGroup(
  env: Env,
  params: {
    telegramId: number;
    userMessageId: number;
    fullName: string;
    username?: string | null;
    ticketNumber?: string | null;
    category?: string | null;
    effectiveBody: string;
    largestPhoto: TelegramPhotoSize | null;
    attachedDoc: TelegramDocument | null;
  }
): Promise<SupportSessionRow> {
  const session = await recordSupportSessionActivity(env.DB, {
    userId: params.telegramId,
    lastUserMessageId: params.userMessageId,
  });

  const dedicatedThreadId = await ensureEscalatedSupportTopicIfNeeded(env, session, {
    userId: params.telegramId,
    fullName: params.fullName,
    username: params.username,
  });
  const effectiveSession: SupportSessionRow = dedicatedThreadId
    ? { ...session, topic_thread_id: dedicatedThreadId }
    : session;

  const usernameLine = params.username
    ? `@${escapeHtml(params.username.replace(/^@+/, ''))}`
    : 'ندارد';
  const titleLine = params.ticketNumber
    ? `🎫 <b>پیام پشتیبانی جدید (${escapeHtml(params.ticketNumber)})</b>\n\n`
    : `🎫 <b>پیام جدید کاربر در پشتیبانی</b>\n\n`;
  const categoryLine = params.category
    ? `📂 دسته‌بندی: <code>${escapeHtml(params.category)}</code>\n`
    : '';
  const supportHeader =
    titleLine +
    `🕒 زمان: <code>${escapeHtml(formatLogTimestamp())}</code>\n` +
    `👤 نام: <b>${escapeHtml(params.fullName)}</b>\n` +
    `🔗 یوزرنیم: ${usernameLine}\n` +
    `🆔 شناسه کاربر: #UID_${params.telegramId}\n` +
    categoryLine +
    `\n`;

  const footerHint = dedicatedThreadId
    ? `💬 <i>برای پاسخ به کاربر، پیام خود را مستقیماً در همین تاپیک ارسال کنید.</i>`
    : `↩️ <i>برای پاسخ مستقیم روی دکمه «💬 پاسخ به کاربر» بزنید یا روی همین پیام Reply کنید.</i>`;

  const sendOptions = dedicatedThreadId
    ? { threadIdOverride: dedicatedThreadId }
    : { replyMarkup: buildSupportReplyInlineMarkup(params.telegramId, params.userMessageId) };

  if (params.largestPhoto) {
    const mediaCaption =
      supportHeader +
      `📝 <b>توضیحات:</b> ${escapeHtml(params.effectiveBody.slice(0, 500))}\n\n` +
      footerHint;
    await sendMediaToTopic(
      env,
      'support',
      {
        kind: 'photo',
        fileId: params.largestPhoto.file_id,
        caption: mediaCaption,
      },
      sendOptions
    );
  } else if (params.attachedDoc) {
    const mediaCaption =
      supportHeader +
      `📎 <b>فایل:</b> <code>${escapeHtml(params.attachedDoc.file_name || 'document')}</code>\n` +
      `📝 <b>توضیحات:</b> ${escapeHtml(params.effectiveBody.slice(0, 450))}\n\n` +
      footerHint;
    await sendMediaToTopic(
      env,
      'support',
      {
        kind: 'document',
        fileId: params.attachedDoc.file_id,
        caption: mediaCaption,
      },
      sendOptions
    );
  } else {
    await sendToTopic(
      env,
      'support',
      supportHeader +
        `📝 <b>متن پیام:</b>\n${escapeHtml(params.effectiveBody.slice(0, 2000))}\n\n` +
        footerHint,
      sendOptions
    );
  }

  return effectiveSession;
}

/**
 * Delivers an admin's support reply (text, photo, or document) directly to the
 * target user's private chat (optionally replying to `replyToUserMessageId`),
 * syncs ticket & session counters, and auto-escalates to a dedicated topic when
 * the conversation becomes ongoing (`message_count >= 3`).
 */
async function deliverAdminSupportReply(
  env: Env,
  params: {
    targetUserId: number;
    replyToUserMessageId?: number | null;
    text: string;
    largestPhoto: TelegramPhotoSize | null;
    attachedDoc: TelegramDocument | null;
    skipAutoEscalate?: boolean;
  }
): Promise<boolean> {
  const replyCaption = params.text
    ? `💬 <b>پاسخ تیم پشتیبانی SentraVPN:</b>\n\n${escapeHtml(params.text)}`
    : '💬 <b>پاسخ تیم پشتیبانی SentraVPN:</b>';

  const replyExtra: Record<string, unknown> =
    params.replyToUserMessageId && params.replyToUserMessageId > 0
      ? {
          reply_to_message_id: params.replyToUserMessageId,
          allow_sending_without_reply: true,
        }
      : {};

  let delivered = false;
  if (params.largestPhoto) {
    delivered = await tgApi(env, 'sendPhoto', {
      chat_id: params.targetUserId,
      photo: params.largestPhoto.file_id,
      caption: replyCaption.slice(0, 1020),
      parse_mode: 'HTML',
      ...replyExtra,
    });
  } else if (params.attachedDoc) {
    delivered = await tgApi(env, 'sendDocument', {
      chat_id: params.targetUserId,
      document: params.attachedDoc.file_id,
      caption: replyCaption.slice(0, 1020),
      parse_mode: 'HTML',
      ...replyExtra,
    });
  } else {
    delivered = await tgSendMessage(env, params.targetUserId, replyCaption, undefined, replyExtra);
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
        .bind(params.targetUserId)
        .run();
    } catch {
      // Non-critical status sync failure should never block support reply confirmation
    }

    try {
      const updatedSession = await recordSupportSessionActivity(env.DB, {
        userId: params.targetUserId,
      });
      if (!params.skipAutoEscalate) {
        await ensureEscalatedSupportTopicIfNeeded(env, updatedSession, {
          userId: params.targetUserId,
        });
      }
    } catch {
      // Non-critical session tracking error should never block reply confirmation
    }
  }

  return delivered;
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
  const hasPayload = Boolean(text || largestPhoto || attachedDoc);
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

  if (!hasPayload) return;

  // Only inspect support routing inside the configured management group (RAM/KV cached)
  const topicConfig = await getTopicRoutingConfig(env.DB, env.SENTRA_KV);
  if (topicConfig.logGroupId !== String(chatId)) {
    return;
  }

  const isAdmin = await resolveIsAdmin(env, telegramId);
  if (!isAdmin) return;

  const currentThreadKey = String(threadId ?? 0);

  // 2A. Admin message inside a Dedicated User Support Topic -> auto-forward directly to user
  if (
    threadId &&
    threadId > 0 &&
    String(topicConfig.topicSupportId ?? '') !== currentThreadKey &&
    String(topicConfig.topicLogsId ?? '') !== currentThreadKey &&
    String(topicConfig.topicBackupsId ?? '') !== currentThreadKey
  ) {
    const dedicatedSession = await getOpenSupportSessionByTopic(env.DB, threadId);
    if (dedicatedSession) {
      const delivered = await deliverAdminSupportReply(env, {
        targetUserId: dedicatedSession.user_id,
        replyToUserMessageId: dedicatedSession.last_user_message_id,
        text,
        largestPhoto,
        attachedDoc,
        skipAutoEscalate: true,
      });
      await tgSendMessage(
        env,
        chatId,
        delivered
          ? '✅ پاسخ برای کاربر ارسال شد'
          : '⚠️ ارسال پاسخ به کاربر ناموفق بود (ممکن است کاربر ربات را مسدود کرده باشد).',
        undefined,
        threadExtra
      );
      return;
    }
  }

  // 2B. Admin in one-click `admin_awaiting_support_reply` state (clicked `💬 پاسخ به کاربر`)
  const adminState = await getBotState(env.DB, telegramId);
  if (adminState?.state_type === 'admin_awaiting_support_reply') {
    const statePayload = JSON.parse(adminState.payload_json || '{}') as {
      targetUserId?: number;
      userMessageId?: number | null;
      groupChatId?: number;
      groupThreadId?: number | null;
    };
    const matchesGroup =
      !statePayload.groupChatId || Number(statePayload.groupChatId) === chatId;
    const matchesThread =
      statePayload.groupThreadId === undefined ||
      statePayload.groupThreadId === null ||
      Number(statePayload.groupThreadId) === Number(threadId ?? 0);

    if (matchesGroup && matchesThread && statePayload.targetUserId) {
      await clearBotState(env.DB, telegramId);
      const delivered = await deliverAdminSupportReply(env, {
        targetUserId: Number(statePayload.targetUserId),
        replyToUserMessageId: statePayload.userMessageId ?? null,
        text,
        largestPhoto,
        attachedDoc,
      });
      await tgSendMessage(
        env,
        chatId,
        delivered
          ? '✅ پاسخ برای کاربر ارسال شد'
          : '⚠️ ارسال پاسخ به کاربر ناموفق بود (ممکن است کاربر ربات را مسدود کرده باشد).',
        undefined,
        threadExtra
      );
      return;
    }
  }

  // 2C. Classic Admin Reply to `#UID_<id>` inside configured Support Topic
  if (
    msg.reply_to_message &&
    topicConfig.topicSupportId !== null &&
    String(topicConfig.topicSupportId) === currentThreadKey
  ) {
    const repliedText = msg.reply_to_message.text || msg.reply_to_message.caption || '';
    const targetUserId = extractSupportUid(repliedText);
    if (!targetUserId) return;

    const existingSession = await getOpenSupportSessionByUser(env.DB, targetUserId);
    const delivered = await deliverAdminSupportReply(env, {
      targetUserId,
      replyToUserMessageId: existingSession?.last_user_message_id ?? null,
      text,
      largestPhoto,
      attachedDoc,
    });

    await tgSendMessage(
      env,
      chatId,
      delivered
        ? '✅ پاسخ به کاربر ارسال شد'
        : '⚠️ ارسال پاسخ به کاربر ناموفق بود (ممکن است کاربر ربات را مسدود کرده باشد).',
      undefined,
      threadExtra
    );
    return;
  }

  // 2D. Auto-capture APK / EXE / Windows ZIP files uploaded or forwarded by Admin in the management group
  if (attachedDoc) {
    const detected = detectReleaseBinary(attachedDoc, text);
    if (detected) {
      const saved = await saveTelegramReleaseFile(env, {
        platform: detected.platform,
        fileId: attachedDoc.file_id,
        fileName: detected.fileName,
        versionHint: detected.version,
        captionOrText: text,
      });
      await tgSendMessage(
        env,
        chatId,
        `✅ <b>فایل نسخه جدید در سرور تلگرام کش شد</b>\n\n` +
          `🖥 پلتفرم: <b>${saved.platform === 'android' ? 'اندروید (Android)' : 'ویندوز (Windows)'}</b>\n` +
          `🔹 نسخه: <code>${escapeHtml(saved.version)}</code>\n` +
          `📄 فایل: <code>${escapeHtml(saved.fileName)}</code>\n` +
          `🆔 Telegram file_id: <code>${escapeHtml(attachedDoc.file_id.slice(0, 32))}...</code>`,
        undefined,
        threadExtra
      );
      return;
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
        const connectCode = await ensureSubscriptionConnectCode(env.DB, sub);
        const welcome = isNewUser
          ? `👋 به <b>SentraVPN</b> خوش آمدید <b>${escapeHtml(user.first_name)}</b>!\n\n` +
            `✅ حساب شما به‌صورت خودکار ایجاد و فعال شد:\n` +
            `🔑 <b>کد اتصال ۸ رقمی شما:</b> <code>${escapeHtml(connectCode)}</code>\n` +
            `💎 <b>پلن اولیه:</b> رایگان (Free)\n\n` +
            `از دکمه «👤 حساب کاربری» کد اتصال و وضعیت حجم خود را ببینید و اپلیکیشن رسمی SentraVPN را از «📥 دانلود اپلیکیشن» دریافت کنید.`
          : `👋 خوش آمدید <b>${escapeHtml(user.first_name)}</b>!\n\n` +
            `حساب شما متصل و آماده استفاده است.\n` +
            `🔑 <b>کد اتصال ۸ رقمی:</b> <code>${escapeHtml(connectCode)}</code>`;
        await tgSendMessage(env, chatId, welcome, buildMainKeyboard(true, isAdmin, env));
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
      if (state.state_type === 'awaiting_register_username') {
        const usernameCheck = validateUnifiedUsername(text);
        if (!usernameCheck.ok) {
          await tgSendMessage(
            env,
            chatId,
            `❌ ${escapeHtml(usernameCheck.error)}\n\nلطفاً نام کاربری معتبر دیگری وارد کنید:`,
            buildCancelStateInlineMarkup()
          );
          return;
        }

        const candidate = usernameCheck.username;
        const taken = await env.DB.prepare(
          'SELECT id, telegram_id, password_hash FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1'
        )
          .bind(candidate)
          .first<{ id: number; telegram_id: number | null; password_hash: string | null }>();

        if (taken && (taken.telegram_id !== telegramId || Boolean(taken.password_hash))) {
          await tgSendMessage(
            env,
            chatId,
            '❌ این نام کاربری قبلاً ثبت شده است. لطفاً نام کاربری دیگری ارسال کنید:',
            buildCancelStateInlineMarkup()
          );
          return;
        }

        await setBotState(env.DB, telegramId, 'awaiting_register_password', {
          username: candidate,
        });
        await tgSendMessage(
          env,
          chatId,
          `🔐 <b>ثبت‌نام حساب جدید (مرحله ۲ از ۳ — تعیین رمز عبور)</b>\n\n` +
            `نام کاربری: <code>${escapeHtml(candidate)}</code>\n` +
            `لطفاً <b>رمز عبور</b> دلخواه خود را وارد کنید (حداقل ۶ کاراکتر):\n\n` +
            `<i>🛡 برای حفظ امنیت، پیام رمز عبور شما بلافاصله از چت حذف می‌شود.</i>`,
          buildCancelStateInlineMarkup()
        );
        return;
      }

      if (state.state_type === 'awaiting_register_password') {
        await tgDeleteMessage(env, chatId, msg.message_id);
        const payload = JSON.parse(state.payload_json || '{}') as { username?: string };
        const username = (payload.username || '').trim().toLowerCase();
        if (!username) {
          await clearBotState(env.DB, telegramId);
          await tgSendMessage(env, chatId, '⚠️ جلسه ثبت‌نام منقضی شد. لطفاً از بخش «👤 حساب کاربری» دوباره تلاش کنید.');
          return;
        }

        const passwordCheck = validateUnifiedPassword(text);
        if (!passwordCheck.ok) {
          await tgSendMessage(
            env,
            chatId,
            `❌ ${escapeHtml(passwordCheck.error)}\n\nلطفاً رمز عبور معتبر وارد کنید:`,
            buildCancelStateInlineMarkup()
          );
          return;
        }

        // Hash immediately — plaintext password is NEVER persisted in telegram_states
        const pendingHash = await hashPassword(passwordCheck.password);
        await setBotState(env.DB, telegramId, 'awaiting_register_confirm_password', {
          username,
          password_hash: pendingHash,
        });
        await tgSendMessage(
          env,
          chatId,
          `🔁 <b>ثبت‌نام حساب جدید (مرحله ۳ از ۳ — تکرار رمز عبور)</b>\n\n` +
            `لطفاً رمز عبور خود را <b>مجدداً وارد کنید</b> تا مطابقت آن تأیید شود:\n\n` +
            `<i>🛡 پیام شما پس از بررسی فوراً از چت حذف می‌شود.</i>`,
          buildCancelStateInlineMarkup()
        );
        return;
      }

      if (state.state_type === 'awaiting_register_confirm_password') {
        await tgDeleteMessage(env, chatId, msg.message_id);
        const payload = JSON.parse(state.payload_json || '{}') as {
          username?: string;
          password_hash?: string;
        };
        const username = (payload.username || '').trim().toLowerCase();
        const pendingHash = payload.password_hash || '';

        if (!username || !pendingHash) {
          await clearBotState(env.DB, telegramId);
          await tgSendMessage(env, chatId, '⚠️ جلسه ثبت‌نام منقضی شد. لطفاً از بخش «👤 حساب کاربری» دوباره تلاش کنید.');
          return;
        }

        const matches = await verifyPassword(text, pendingHash);
        if (!matches) {
          await setBotState(env.DB, telegramId, 'awaiting_register_password', { username });
          await tgSendMessage(
            env,
            chatId,
            `❌ <b>تکرار رمز عبور مطابقت نداشت.</b>\n\nلطفاً رمز عبور خود را مجدداً وارد کنید (حداقل ۶ کاراکتر):`,
            buildCancelStateInlineMarkup()
          );
          return;
        }

        await clearBotState(env.DB, telegramId);

        const taken = await env.DB.prepare(
          'SELECT id, telegram_id, password_hash FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1'
        )
          .bind(username)
          .first<{ id: number; telegram_id: number | null; password_hash: string | null }>();

        if (taken && (taken.telegram_id !== telegramId || Boolean(taken.password_hash))) {
          await tgSendMessage(
            env,
            chatId,
            '❌ این نام کاربری هم‌اکنون توسط کاربر دیگری ثبت شده است. لطفاً از بخش «👤 حساب کاربری» دوباره ثبت‌نام کنید.',
            buildMainKeyboard(isRegistered, isAdmin, env)
          );
          return;
        }

        let targetUser: UserRow | null = null;
        let targetSub: SubscriptionRow | null = null;

        if (existing?.user && !existing.user.password_hash) {
          await env.DB.prepare(
            `UPDATE users
             SET username = ?, password_hash = ?, role = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`
          )
            .bind(
              username,
              pendingHash,
              envAdmin || existing.user.role === 'admin' ? 'admin' : 'user',
              existing.user.id
            )
            .run();
          const refreshed = await getUserAndSubByTelegramId(env.DB, telegramId);
          targetUser = refreshed?.user ?? null;
          targetSub = refreshed?.sub ?? null;
        } else {
          const userUuid = crypto.randomUUID();
          await env.DB.prepare(
            `INSERT INTO users (
               user_uuid, telegram_id, username, email, password_hash,
               first_name, last_name, role, status, outbound_reward_banned
             ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'active', 0)`
          )
            .bind(
              userUuid,
              telegramId,
              username,
              pendingHash,
              (from.first_name || username).trim() || username,
              from.last_name || null,
              envAdmin ? 'admin' : 'user'
            )
            .run();
          const created = await getUserAndSubByTelegramId(env.DB, telegramId);
          targetUser = created?.user ?? null;
          targetSub = created?.sub ?? null;
        }

        if (!targetUser) {
          await tgSendMessage(env, chatId, '⚠️ خطایی در ذخیره حساب کاربری رخ داد. لطفاً دوباره تلاش کنید.');
          return;
        }

        if (!targetSub) {
          const token = generateSubscriptionToken();
          const connectCode = await generateUniqueConnectCode(env.DB);
          const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
          const freeQuotas = await getFreeQuotaSettings(env.DB);
          const initialLimit = freeQuotas.webQuotaBytes + freeQuotas.downloadQuotaBytes;
          await env.DB.prepare(
            `INSERT INTO subscriptions (
               user_id, tier, plan_tier, connect_code, token, status,
               upload_bytes, download_bytes, traffic_limit_bytes, speed_limit_bps,
               max_concurrent_devices, web_browsing_used_mb, download_used_mb,
               static_ip_used_mb, web_used_bytes, download_used_bytes,
               special_quota_bytes, special_used_bytes, has_used_special_trial, expires_at
             ) VALUES (?, 'Sentra Lite', 'free', ?, ?, 'active', 0, 0, ?, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, ?)`
          )
            .bind(targetUser.id, connectCode, token, initialLimit, expiresAt)
            .run();
          targetSub = await env.DB.prepare(
            'SELECT * FROM subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 1'
          )
            .bind(targetUser.id)
            .first<SubscriptionRow>();
        }

        if (!targetSub) {
          await tgSendMessage(env, chatId, '⚠️ خطایی در ایجاد اشتراک رخ داد. لطفاً دوباره تلاش کنید.');
          return;
        }

        const connectCode = await ensureSubscriptionConnectCode(env.DB, targetSub);
        targetSub = { ...targetSub, connect_code: connectCode };
        const effectiveIsAdmin = envAdmin || targetUser.role === 'admin';

        await tgSendMessage(
          env,
          chatId,
          `🎉 <b>ثبت‌نام یکپارچه با موفقیت انجام شد!</b>\n\n` +
            `👤 <b>نام کاربری:</b> <code>${escapeHtml(targetUser.username || username)}</code>\n` +
            `🔑 <b>کد اتصال ۸ رقمی:</b> <code>${escapeHtml(connectCode)}</code>\n\n` +
            `از این پس می‌توانید با همین نام کاربری و رمز عبور یا کد اتصال ۸ رقمی در اپلیکیشن SentraVPN وارد شوید.`,
          buildMainKeyboard(true, effectiveIsAdmin, env)
        );
        const accountView = await buildUserAccountView(env, targetUser, targetSub);
        await tgSendMessage(env, chatId, accountView.text, accountView.replyMarkup);
        return;
      }

      if (state.state_type === 'awaiting_login_username') {
        const cleanIdentifier = normalizeLoginIdentifier(text);
        if (!cleanIdentifier) {
          await tgSendMessage(
            env,
            chatId,
            '❌ لطفاً نام کاربری خود را به‌صورت متن ارسال کنید:',
            buildCancelStateInlineMarkup()
          );
          return;
        }
        await setBotState(env.DB, telegramId, 'awaiting_login_password', {
          username: cleanIdentifier,
        });
        await tgSendMessage(
          env,
          chatId,
          `🔑 اکنون <b>رمز عبور (Password)</b> حساب خود را وارد کنید:\n\n<i>🛡 برای حفظ امنیت، پیام رمز عبور شما بلافاصله از چت حذف می‌شود.</i>`,
          buildCancelStateInlineMarkup()
        );
        return;
      }

      if (state.state_type === 'awaiting_login_password') {
        await tgDeleteMessage(env, chatId, msg.message_id);
        const payload = JSON.parse(state.payload_json || '{}') as { username?: string };
        await clearBotState(env.DB, telegramId);
        const username = normalizeLoginIdentifier(payload.username);
        const user = await env.DB.prepare(
          'SELECT * FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?) LIMIT 1'
        )
          .bind(username, username)
          .first<UserRow>();

        if (!user || !(await verifyPassword(text, user.password_hash))) {
          await tgSendMessage(
            env,
            chatId,
            '❌ نام کاربری یا رمز عبور اشتباه است. لطفاً از بخش «👤 حساب کاربری» دوباره تلاش کنید.',
            buildMainKeyboard(isRegistered, isAdmin, env)
          );
          return;
        }

        if (user.status !== 'active') {
          await tgSendMessage(
            env,
            chatId,
            '⛔ حساب کاربری شما تعلیق شده است.',
            buildMainKeyboard(isRegistered, isAdmin, env)
          );
          return;
        }

        if (user.telegram_id && user.telegram_id !== telegramId) {
          await tgSendMessage(
            env,
            chatId,
            '⛔ این حساب کاربری قبلاً به یک حساب تلگرام دیگر متصل شده است. در صورت نیاز با پشتیبانی تماس بگیرید.',
            buildMainKeyboard(isRegistered, isAdmin, env)
          );
          return;
        }

        // If current Telegram user had an unlinked passwordless shell record, detach its telegram_id first
        if (existing?.user && existing.user.id !== user.id) {
          if (existing.user.password_hash) {
            await tgSendMessage(
              env,
              chatId,
              '⚠️ تلگرام شما هم‌اکنون به یک حساب ثبت‌نام‌شده دیگر متصل است.',
              buildMainKeyboard(true, isAdmin, env)
            );
            return;
          }
          await env.DB.prepare(
            'UPDATE users SET telegram_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
          )
            .bind(existing.user.id)
            .run();
        }

        await env.DB.prepare(
          'UPDATE users SET telegram_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        )
          .bind(telegramId, user.id)
          .run();

        let linkedSub = await env.DB.prepare(
          'SELECT * FROM subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 1'
        )
          .bind(user.id)
          .first<SubscriptionRow>();

        if (!linkedSub) {
          const token = generateSubscriptionToken();
          const connectCode = await generateUniqueConnectCode(env.DB);
          const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
          const freeQuotas = await getFreeQuotaSettings(env.DB);
          const initialLimit = freeQuotas.webQuotaBytes + freeQuotas.downloadQuotaBytes;
          await env.DB.prepare(
            `INSERT INTO subscriptions (
               user_id, tier, plan_tier, connect_code, token, status,
               upload_bytes, download_bytes, traffic_limit_bytes, speed_limit_bps,
               max_concurrent_devices, web_browsing_used_mb, download_used_mb,
               static_ip_used_mb, web_used_bytes, download_used_bytes,
               special_quota_bytes, special_used_bytes, has_used_special_trial, expires_at
             ) VALUES (?, 'Sentra Lite', 'free', ?, ?, 'active', 0, 0, ?, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, ?)`
          )
            .bind(user.id, connectCode, token, initialLimit, expiresAt)
            .run();
          linkedSub = await env.DB.prepare(
            'SELECT * FROM subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 1'
          )
            .bind(user.id)
            .first<SubscriptionRow>();
        }

        const linkedUser: UserRow = { ...user, telegram_id: telegramId };
        const loggedInIsAdmin = envAdmin || linkedUser.role === 'admin';
        const connectCode = linkedSub
          ? await ensureSubscriptionConnectCode(env.DB, linkedSub)
          : '';
        if (linkedSub) {
          linkedSub = { ...linkedSub, connect_code: connectCode };
        }

        await tgSendMessage(
          env,
          chatId,
          `✅ <b>ورود موفق و همگام‌سازی کامل!</b>\n\n` +
            `👤 <b>حساب:</b> <code>${escapeHtml(linkedUser.username || linkedUser.first_name)}</code>\n` +
            (connectCode ? `🔑 <b>کد اتصال ۸ رقمی:</b> <code>${escapeHtml(connectCode)}</code>\n` : '') +
            `حساب اپلیکیشن شما با موفقیت به تلگرام متصل شد.`,
          buildMainKeyboard(true, loggedInIsAdmin, env)
        );
        if (linkedSub) {
          const accountView = await buildUserAccountView(env, linkedUser, linkedSub);
          await tgSendMessage(env, chatId, accountView.text, accountView.replyMarkup);
        }
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
               compiled_outbound_json, validation_error,
               latency_ms, speed_mbps, assigned_tier, health_score, status, fail_count,
               raw_link, fingerprint_sha256, is_official, label, country_code, country_name,
               allow_web, allow_download, allow_gaming, allow_static_ip, allocation_mode,
               last_online_at, last_checked_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 90, 12.0, 'web_browsing', 100, 'pending', 0, ?, ?, 0, ?, ?, ?, 1, 1, 0, 0, 'free_only', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
          )
            .bind(
              existing?.user.id ?? null,
              parsed.tag,
              parsed.protocol,
              parsed.server_address,
              parsed.server_port,
              parsed.compiled_outbound_json,
              parsed.compiled_outbound_json,
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
            `🤝 <b>سپاس از حمایت شما!</b>\nنود <b>${escapeHtml(parsed.tag)}</b> بررسی و با استاندارد <code>sing-box 1.14+</code> کامپایل شد و در صف تأیید مدیریت قرار گرفت.`,
            buildMainKeyboard(true, isAdmin, env)
          );
        } catch (err) {
          await tgSendMessage(
            env,
            chatId,
            `❌ <b>کانفیگ رد شد:</b>\n${escapeHtml(err instanceof Error ? err.message : 'خطا در ثبت اوتباند.')}`,
            buildMainKeyboard(true, isAdmin, env)
          );
        }
        return;
      }

      if (state.state_type === 'awaiting_donate_sublink') {
        await clearBotState(env.DB, telegramId);
        try {
          if (!text) {
            await tgSendMessage(
              env,
              chatId,
              '❌ لطفاً آدرس سابلینک را به‌صورت متن ارسال کنید.',
              buildMainKeyboard(true, isAdmin, env)
            );
            return;
          }

          // Strict security validation: HTTPS only, max 512 chars, no credentials, anti-SSRF & internal host block.
          // Worker NEVER performs fetch() on user-submitted sublinks.
          const validUrl = validateUserSubmittedSublink(text);
          const normalizedUrl = validUrl.toString();

          const ensured = existing?.user
            ? existing
            : await ensureTelegramUserAndSubscription(env.DB, from, envAdmin);

          // Rate limit: max 3 sublink submissions per user per 24 hours
          const rateRow = await env.DB.prepare(
            `SELECT COUNT(*) AS cnt
             FROM subscription_sources
             WHERE submitted_by_user_id = ?
               AND created_at >= datetime('now', '-24 hours')`
          )
            .bind(ensured.user.id)
            .first<{ cnt: number }>();

          if (Number(rateRow?.cnt || 0) >= 3) {
            await tgSendMessage(
              env,
              chatId,
              '⏳ شما در ۲۴ ساعت گذشته حداکثر تعداد مجاز (۳ سابلینک) را ارسال کرده‌اید. لطفاً فردا مجدداً تلاش کنید.',
              buildMainKeyboard(true, isAdmin, env)
            );
            return;
          }

          // Deduplication check
          const dup = await env.DB.prepare(
            'SELECT id FROM subscription_sources WHERE sub_url = ? LIMIT 1'
          )
            .bind(normalizedUrl)
            .first<{ id: number }>();

          if (dup) {
            await tgSendMessage(
              env,
              chatId,
              '⚠️ این سابلینک قبلاً در سیستم ثبت شده است.',
              buildMainKeyboard(true, isAdmin, env)
            );
            return;
          }

          const insertRes = await env.DB.prepare(
            `INSERT INTO subscription_sources (
               category, sub_url, tag, submitted_by_user_id, status,
               total_nodes, healthy_nodes, last_sync_at
             ) VALUES ('web_browsing', ?, ?, ?, 'pending', 0, 0, CURRENT_TIMESTAMP)`
          )
            .bind(normalizedUrl, `user:${ensured.user.id}`, ensured.user.id)
            .run();

          const newSourceId = Number(insertRes.meta.last_row_id || 0);

          await tgSendMessage(
            env,
            chatId,
            `🤝 <b>سپاس از حمایت شما!</b>\n\n` +
              `سابلینک اهدایی شما (#${newSourceId}) با موفقیت ثبت شد و در صف بررسی امنیتی مدیریت قرار گرفت.\n` +
              `پس از تأیید ادمین، نتیجه به شما اطلاع داده خواهد شد.`,
            buildMainKeyboard(true, isAdmin, env)
          );

          // Notify admins with approve/reject inline buttons
          const adminIds = getAdminTelegramIds(env);
          const submitterName = escapeHtml(
            [from.first_name, from.last_name].filter(Boolean).join(' ') || ensured.user.first_name
          );
          const submitterUser = from.username ? `@${escapeHtml(from.username)}` : `ID:${telegramId}`;
          for (const adminId of adminIds) {
            await tgSendMessage(
              env,
              adminId,
              `🔗 <b>سابلینک اهدایی جدید در انتظار تأیید (#${newSourceId})</b>\n\n` +
                `👤 ارسال‌کننده: <b>${submitterName}</b> (${submitterUser})\n` +
                `🌐 آدرس:\n<code>${escapeHtml(normalizedUrl)}</code>`,
              {
                inline_keyboard: [
                  [
                    {
                      text: `✅ تأیید سابلینک #${newSourceId}`,
                      callback_data: `adm_subsrc_approve_${newSourceId}`,
                    },
                    {
                      text: `❌ رد سابلینک #${newSourceId}`,
                      callback_data: `adm_subsrc_reject_${newSourceId}`,
                    },
                  ],
                ],
              }
            );
          }
        } catch (err) {
          await tgSendMessage(
            env,
            chatId,
            `🚫 ${escapeHtml(err instanceof Error ? err.message : 'سابلینک ارسال‌شده نامعتبر است.')}`,
            buildMainKeyboard(true, isAdmin, env)
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
            buildMainKeyboard(true, isAdmin, env)
          );
          return;
        }

        const amount = Math.max(0, Math.round(Number(payload.amount) || PRO_PLAN_PRICE_TOMAN));
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
          buildMainKeyboard(true, isAdmin, env)
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
          buildMainKeyboard(true, isAdmin, env)
        );

        const fullName =
          [from.first_name, from.last_name].filter(Boolean).join(' ').trim() ||
          ensured.user.first_name;
        const username = from.username || ensured.user.username || null;

        await forwardUserSupportMessageToGroup(env, {
          telegramId,
          userMessageId: msg.message_id,
          fullName,
          username,
          ticketNumber,
          category,
          effectiveBody,
          largestPhoto,
          attachedDoc,
        });
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

        if (state.state_type === 'admin_awaiting_support_reply') {
          const payload = JSON.parse(state.payload_json || '{}') as {
            targetUserId?: number;
            userMessageId?: number | null;
          };
          const largestPhoto =
            Array.isArray(msg.photo) && msg.photo.length > 0
              ? msg.photo[msg.photo.length - 1]
              : null;
          const attachedDoc = msg.document || null;
          if (!text && !largestPhoto && !attachedDoc) {
            await tgSendMessage(
              env,
              chatId,
              '❌ لطفاً متن، تصویر یا فایل پاسخ خود را ارسال کنید:',
              buildCancelStateInlineMarkup()
            );
            return;
          }
          await clearBotState(env.DB, telegramId);
          if (payload.targetUserId) {
            const delivered = await deliverAdminSupportReply(env, {
              targetUserId: Number(payload.targetUserId),
              replyToUserMessageId: payload.userMessageId ?? null,
              text,
              largestPhoto,
              attachedDoc,
            });
            await tgSendMessage(
              env,
              chatId,
              delivered
                ? '✅ پاسخ برای کاربر ارسال شد'
                : '⚠️ ارسال پاسخ به کاربر ناموفق بود (ممکن است کاربر ربات را مسدود کرده باشد).'
            );
          }
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

        if (state.state_type === 'admin_awaiting_release_file') {
          const payload = JSON.parse(state.payload_json || '{}') as { platform?: string };
          const platform: 'android' | 'windows' =
            payload.platform === 'windows' ? 'windows' : 'android';
          const doc = msg.document;
          if (!doc?.file_id) {
            await tgSendMessage(
              env,
              chatId,
              '❌ لطفاً فایل نصبی (به‌صورت Document مثل APK، EXE یا ZIP) را ارسال یا فوروارد کنید:',
              buildCancelStateInlineMarkup()
            );
            return;
          }
          await clearBotState(env.DB, telegramId);

          const saved = await saveTelegramReleaseFile(env, {
            platform,
            fileId: doc.file_id,
            fileName: doc.file_name,
            captionOrText: text,
          });

          await tgSendMessage(
            env,
            chatId,
            `✅ <b>فایل نسخه جدید در سرور تلگرام کش شد</b>\n\n` +
              `🖥 پلتفرم: <b>${saved.platform === 'android' ? 'اندروید (Android)' : 'ویندوز (Windows)'}</b>\n` +
              `🔹 نسخه: <code>${escapeHtml(saved.version)}</code>\n` +
              `📄 فایل: <code>${escapeHtml(saved.fileName)}</code>\n` +
              `🆔 Telegram file_id: <code>${escapeHtml(doc.file_id.slice(0, 32))}...</code>`,
            buildAdminPanelHomeView().replyMarkup
          );
          return;
        }
      }
    }

    // Auto-capture APK / EXE / Windows ZIP files forwarded or uploaded directly by Admin in private chat
    if (isAdmin && msg.document && !menuAction && !text.startsWith('/')) {
      const detected = detectReleaseBinary(msg.document, text);
      if (detected) {
        if (state) {
          await clearBotState(env.DB, telegramId);
        }
        const saved = await saveTelegramReleaseFile(env, {
          platform: detected.platform,
          fileId: msg.document.file_id,
          fileName: detected.fileName,
          versionHint: detected.version,
          captionOrText: text,
        });
        await tgSendMessage(
          env,
          chatId,
          `✅ <b>فایل نسخه جدید در سرور تلگرام کش شد</b>\n\n` +
            `🖥 پلتفرم: <b>${saved.platform === 'android' ? 'اندروید (Android)' : 'ویندوز (Windows)'}</b>\n` +
            `🔹 نسخه: <code>${escapeHtml(saved.version)}</code>\n` +
            `📄 فایل: <code>${escapeHtml(saved.fileName)}</code>\n` +
            `🆔 Telegram file_id: <code>${escapeHtml(msg.document.file_id.slice(0, 32))}...</code>\n\n` +
            `⚡️ از این لحظه کاربران در بخش «📥 دانلود اپلیکیشن» این نسخه را مستقیماً از سرور تلگرام دریافت می‌کنند.`,
          buildAdminPanelHomeView().replyMarkup
        );
        return;
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
        await tgSendMessage(env, chatId, welcome, buildMainKeyboard(isRegistered, isAdmin, env));
        return;
      }

      case 'auth': {
        const authView = buildUnlinkedAccountAuthView();
        await tgSendMessage(env, chatId, authView.text, authView.replyMarkup);
        return;
      }

      case 'account':
      case 'get_sub':
      case 'ios_menu': {
        if (!existing || !existing.sub || !isUnifiedRegisteredAccount(existing.user)) {
          const authView = buildUnlinkedAccountAuthView();
          await tgSendMessage(env, chatId, authView.text, authView.replyMarkup);
          return;
        }
        const view = await buildUserAccountView(env, existing.user, existing.sub);
        await tgSendMessage(env, chatId, view.text, view.replyMarkup);
        return;
      }

      case 'upgrade': {
        const { sub } = await ensureTelegramUserAndSubscription(env.DB, from, envAdmin);
        const view = buildUserUpgradeView(sub);
        await tgSendMessage(env, chatId, view.text, view.replyMarkup);
        return;
      }

      case 'donate_outbound': {
        await ensureTelegramUserAndSubscription(env.DB, from, envAdmin);
        const view = buildUserDonateMenuView();
        await tgSendMessage(env, chatId, view.text, view.replyMarkup);
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
        const largestPhoto =
          Array.isArray(msg.photo) && msg.photo.length > 0
            ? msg.photo[msg.photo.length - 1]
            : null;
        const attachedDoc = msg.document || null;
        const hasPayload = Boolean(text || largestPhoto || attachedDoc);

        // Route follow-up private messages into an active dedicated support topic
        // (or when the user directly replies to a support reply in private chat)
        if (hasPayload && !text.startsWith('/')) {
          const repliedToSupport = Boolean(
            msg.reply_to_message &&
              ((msg.reply_to_message.text || msg.reply_to_message.caption || '').includes(
                'پاسخ تیم پشتیبانی SentraVPN'
              ))
          );
          const openSession = await getOpenSupportSessionByUser(env.DB, telegramId);
          if (openSession && (openSession.topic_thread_id || repliedToSupport)) {
            const fullName =
              [from.first_name, from.last_name].filter(Boolean).join(' ').trim() ||
              existing?.user.first_name ||
              'کاربر';
            const username = from.username || existing?.user.username || null;
            const effectiveBody =
              text ||
              (largestPhoto
                ? '[تصویر پیوست‌شده توسط کاربر]'
                : `[فایل پیوست‌شده: ${attachedDoc?.file_name || 'document'}]`);

            await forwardUserSupportMessageToGroup(env, {
              telegramId,
              userMessageId: msg.message_id,
              fullName,
              username,
              effectiveBody,
              largestPhoto,
              attachedDoc,
            });
            await tgSendMessage(
              env,
              chatId,
              '✅ پیام شما به تیم پشتیبانی ارسال شد. پاسخ به محض بررسی همینجا ارسال می‌شود.'
            );
            return;
          }
        }

        const quickMenu = buildUserMenuHomeView(
          existing?.user || null,
          existing?.sub || null,
          isAdmin,
          env
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
      text_length: text.length,
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

async function handleChannelReleasePost(env: Env, post: TelegramMessage): Promise<void> {
  const configuredChannelId = (env.RELEASES_CHANNEL_ID || '').trim();
  if (!configuredChannelId) return;
  if (String(post.chat.id) !== configuredChannelId) return;
  if (!post.document?.file_id) return;

  const caption = (post.caption || post.text || '').trim();
  const detected = detectReleaseBinary(post.document, caption);
  if (!detected) return;

  await saveTelegramReleaseFile(env, {
    platform: detected.platform,
    fileId: post.document.file_id,
    fileName: detected.fileName,
    versionHint: detected.version,
    captionOrText: caption,
  });
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
    } else if (update.channel_post) {
      await handleChannelReleasePost(env, update.channel_post);
    } else if (update.edited_channel_post) {
      await handleChannelReleasePost(env, update.edited_channel_post);
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
