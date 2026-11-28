import { constantTimeEquals, generateSubscriptionToken, generateUniqueConnectCode } from './security.ts';
import { ensureSchemaColumns } from './supportSessions.ts';
import type { Env, SubscriptionRow, UserRow } from './types.ts';

export interface TelegramWebAppUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
}

export interface VerifiedTelegramInitData {
  user: TelegramWebAppUser;
  authDate: number;
  queryId?: string;
  startParam?: string;
}

const MAX_INIT_DATA_AGE_SECONDS = 86_400; // 24 hours
const MAX_CLOCK_SKEW_SECONDS = 300; // 5 minutes

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hmacSha256Raw(
  keyBytes: Uint8Array,
  data: string
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes.buffer.slice(keyBytes.byteOffset, keyBytes.byteOffset + keyBytes.byteLength) as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}

/**
 * Verifies Telegram Mini App `initData` per official Telegram WebApp documentation:
 *   secret_key = HMAC-SHA256("WebAppData", bot_token)
 *   expected_hash = hex(HMAC-SHA256(secret_key, sorted_data_check_string))
 * Also enforces auth_date freshness (<= 24h) and timing-safe hash comparison.
 */
export async function verifyTelegramInitData(
  rawInitData: string,
  botToken: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<{ ok: true; data: VerifiedTelegramInitData } | { ok: false; error: string; code: string }> {
  const trimmed = (rawInitData || '').trim();
  const cleanToken = (botToken || '').trim();
  if (!cleanToken) {
    return {
      ok: false,
      error: 'توکن ربات تلگرام روی سرور پیکربندی نشده است.',
      code: 'BOT_TOKEN_NOT_CONFIGURED',
    };
  }
  if (!trimmed || trimmed.length > 8192) {
    return {
      ok: false,
      error: 'اطلاعات احراز هویت تلگرام (initData) ارسال نشده یا نامعتبر است.',
      code: 'MISSING_INIT_DATA',
    };
  }

  const params = new URLSearchParams(trimmed);
  const providedHash = (params.get('hash') || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(providedHash)) {
    return {
      ok: false,
      error: 'امضای امنیتی تلگرام (hash) نامعتبر است.',
      code: 'INVALID_INIT_DATA_HASH',
    };
  }

  const pairs: Array<[string, string]> = [];
  params.forEach((value, key) => {
    if (key !== 'hash') {
      pairs.push([key, value]);
    }
  });
  pairs.sort((a, b) => a[0].localeCompare(b[0]));
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join('\n');

  const secretKeyBytes = await hmacSha256Raw(
    new TextEncoder().encode('WebAppData'),
    cleanToken
  );
  const computedHashBytes = await hmacSha256Raw(secretKeyBytes, dataCheckString);
  const computedHash = bytesToHex(computedHashBytes);

  const hashValid = await constantTimeEquals(computedHash, providedHash);
  if (!hashValid) {
    return {
      ok: false,
      error: 'امضای امنیتی تلگرام تأیید نشد. لطفاً مینی‌اپ را مجدداً از داخل ربات تلگرام باز کنید.',
      code: 'INVALID_INIT_DATA_SIGNATURE',
    };
  }

  const authDate = Number(params.get('auth_date') || '0');
  if (!Number.isFinite(authDate) || authDate <= 0) {
    return {
      ok: false,
      error: 'زمان احراز هویت تلگرام (auth_date) نامعتبر است.',
      code: 'INVALID_AUTH_DATE',
    };
  }
  if (nowSeconds - authDate > MAX_INIT_DATA_AGE_SECONDS || authDate - nowSeconds > MAX_CLOCK_SKEW_SECONDS) {
    return {
      ok: false,
      error: 'نشست مینی‌اپ منقضی شده است. لطفاً مینی‌اپ را ببندید و دوباره از داخل ربات باز کنید.',
      code: 'EXPIRED_INIT_DATA',
    };
  }

  const rawUser = params.get('user');
  if (!rawUser) {
    return {
      ok: false,
      error: 'اطلاعات کاربر تلگرام در initData یافت نشد.',
      code: 'MISSING_TELEGRAM_USER',
    };
  }

  let parsedUser: Record<string, unknown>;
  try {
    parsedUser = JSON.parse(rawUser) as Record<string, unknown>;
  } catch {
    return {
      ok: false,
      error: 'ساختار اطلاعات کاربر تلگرام نامعتبر است.',
      code: 'INVALID_TELEGRAM_USER',
    };
  }

  const tgId = Number(parsedUser.id);
  if (!Number.isSafeInteger(tgId) || tgId <= 0) {
    return {
      ok: false,
      error: 'شناسه عددی کاربر تلگرام نامعتبر است.',
      code: 'INVALID_TELEGRAM_USER_ID',
    };
  }

  return {
    ok: true,
    data: {
      user: {
        id: tgId,
        first_name: String(parsedUser.first_name || 'کاربر').slice(0, 128),
        last_name: parsedUser.last_name ? String(parsedUser.last_name).slice(0, 128) : undefined,
        username: parsedUser.username ? String(parsedUser.username).slice(0, 64) : undefined,
        language_code: parsedUser.language_code ? String(parsedUser.language_code).slice(0, 16) : undefined,
        is_premium: Boolean(parsedUser.is_premium),
      },
      authDate,
      queryId: params.get('query_id') || undefined,
      startParam: params.get('start_param') || undefined,
    },
  };
}

/**
 * Ensures a verified Telegram Mini App user has both a `users` row and an active
 * `subscriptions` row with an 8-digit `connect_code` in D1.
 */
export async function ensureMiniAppUserAndSubscription(
  db: D1Database,
  tgUser: TelegramWebAppUser,
  env: Env
): Promise<{ user: UserRow; sub: SubscriptionRow; isNewUser: boolean }> {
  await ensureSchemaColumns(db);

  const adminIds = [
    ...(env.ADMIN_TELEGRAM_ID ? env.ADMIN_TELEGRAM_ID.split(',') : []),
    ...(env.ADMIN_CHAT_ID ? env.ADMIN_CHAT_ID.split(',') : []),
    ...(env.ADMIN_TELEGRAM_IDS ? env.ADMIN_TELEGRAM_IDS.split(',') : []),
  ]
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isSafeInteger(n) && n > 0);
  const isEnvAdmin = adminIds.includes(tgUser.id);

  let user = await db
    .prepare('SELECT * FROM users WHERE telegram_id = ? LIMIT 1')
    .bind(tgUser.id)
    .first<UserRow>();
  let isNewUser = false;

  if (!user) {
    isNewUser = true;
    const userUuid = crypto.randomUUID();
    const role = isEnvAdmin ? 'admin' : 'user';
    await db
      .prepare(
        `INSERT INTO users (user_uuid, telegram_id, first_name, last_name, role, status)
         VALUES (?, ?, ?, ?, ?, 'active')`
      )
      .bind(
        userUuid,
        tgUser.id,
        tgUser.first_name || 'کاربر',
        tgUser.last_name || null,
        role
      )
      .run();

    user = await db
      .prepare('SELECT * FROM users WHERE telegram_id = ? LIMIT 1')
      .bind(tgUser.id)
      .first<UserRow>();
  } else if (isEnvAdmin && user.role !== 'admin') {
    await db
      .prepare("UPDATE users SET role = 'admin', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(user.id)
      .run();
    user.role = 'admin';
  }

  if (!user) {
    throw new Error('Failed to create or load Mini App user record');
  }

  let sub = await db
    .prepare('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 1')
    .bind(user.id)
    .first<SubscriptionRow>();

  if (!sub) {
    const token = generateSubscriptionToken();
    const connectCode = await generateUniqueConnectCode(db);
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);

    await db
      .prepare(
        `INSERT INTO subscriptions
           (user_id, tier, plan_tier, connect_code, token, status, traffic_limit_bytes, speed_limit_bps, max_concurrent_devices, expires_at)
         VALUES
           (?, 'Sentra Lite', 'free', ?, ?, 'active', 0, 0, 2, ?)`
      )
      .bind(user.id, connectCode, token, expiresAt)
      .run();

    sub = await db
      .prepare('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 1')
      .bind(user.id)
      .first<SubscriptionRow>();
  }

  if (!sub) {
    throw new Error('Failed to create or load Mini App subscription record');
  }

  if (!sub.connect_code || !/^\d{8}$/.test(sub.connect_code)) {
    const connectCode = await generateUniqueConnectCode(db);
    await db
      .prepare('UPDATE subscriptions SET connect_code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(connectCode, sub.id)
      .run();
    sub.connect_code = connectCode;
  }

  return { user, sub, isNewUser };
}

/**
 * Helper used in tests and tooling to generate a valid Telegram WebApp `initData` string.
 */
export async function signTelegramInitDataForTests(
  fields: Record<string, string>,
  botToken: string
): Promise<string> {
  const entries = Object.entries(fields).filter(([k]) => k !== 'hash');
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');
  const secretKeyBytes = await hmacSha256Raw(
    new TextEncoder().encode('WebAppData'),
    botToken.trim()
  );
  const sigBytes = await hmacSha256Raw(secretKeyBytes, dataCheckString);
  const hash = bytesToHex(sigBytes);

  const params = new URLSearchParams();
  for (const [k, v] of entries) {
    params.set(k, v);
  }
  params.set('hash', hash);
  return params.toString();
}
