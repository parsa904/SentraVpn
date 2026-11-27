import {
  formatAiReadyErrorMessage,
  normalizeUnknownError,
} from './errorReporter.ts';
import type { Env } from './types.ts';

export type TopicType = 'logs' | 'backups' | 'support';

export const SYSTEM_SETTING_KEYS = {
  LOG_GROUP_ID: 'log_group_id',
  TOPIC_LOGS_ID: 'topic_logs_id',
  TOPIC_BACKUPS_ID: 'topic_backups_id',
  TOPIC_SUPPORT_ID: 'topic_support_id',
} as const;

export type SystemSettingKey =
  (typeof SYSTEM_SETTING_KEYS)[keyof typeof SYSTEM_SETTING_KEYS];

export interface TopicRoutingConfig {
  logGroupId: string | null;
  topicLogsId: string | null;
  topicBackupsId: string | null;
  topicSupportId: string | null;
}

export interface DatabaseBackupResult {
  ok: boolean;
  filename?: string;
  tablesCount?: number;
  totalRows?: number;
  error?: string;
}

interface TelegramApiResponse {
  ok?: boolean;
  error_code?: number;
  description?: string;
}

const VALID_SQLITE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function escapeTelegramHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function formatLogTimestamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(
    date.getUTCDate()
  )} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(
    date.getUTCSeconds()
  )} UTC`;
}

export function buildBackupFilename(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `sentra-backup-${date.getUTCFullYear()}-${pad(
    date.getUTCMonth() + 1
  )}-${pad(date.getUTCDate())}-${pad(date.getUTCHours())}-${pad(
    date.getUTCMinutes()
  )}.json`;
}

/**
 * Extracts a numeric Telegram user ID from a support message containing `#UID_<telegram_id>`.
 */
export function extractSupportUid(text?: string | null): number | null {
  if (!text) return null;
  const match = /#UID_(\d{4,20})\b/.exec(text);
  if (!match) return null;
  const parsed = Number(match[1]);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

/**
 * Ensures the `system_settings` table exists in Cloudflare D1 without requiring manual migrations.
 */
export async function ensureSystemSettingsTable(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS system_settings (
         key TEXT PRIMARY KEY,
         value TEXT NOT NULL,
         updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
       )`
    )
    .run();
}

export async function getSystemSetting(
  db: D1Database,
  key: SystemSettingKey
): Promise<string | null> {
  await ensureSystemSettingsTable(db);
  const row = await db
    .prepare('SELECT value FROM system_settings WHERE key = ? LIMIT 1')
    .bind(key)
    .first<{ value: string }>();
  return row ? String(row.value) : null;
}

export async function setSystemSetting(
  db: D1Database,
  key: SystemSettingKey,
  value: string
): Promise<void> {
  await ensureSystemSettingsTable(db);
  await db
    .prepare(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = CURRENT_TIMESTAMP`
    )
    .bind(key, value)
    .run();
}

export async function saveTopicRoute(
  db: D1Database,
  topicType: TopicType,
  groupId: number,
  threadId?: number
): Promise<void> {
  const topicKey =
    topicType === 'logs'
      ? SYSTEM_SETTING_KEYS.TOPIC_LOGS_ID
      : topicType === 'backups'
      ? SYSTEM_SETTING_KEYS.TOPIC_BACKUPS_ID
      : SYSTEM_SETTING_KEYS.TOPIC_SUPPORT_ID;

  await setSystemSetting(db, SYSTEM_SETTING_KEYS.LOG_GROUP_ID, String(groupId));
  await setSystemSetting(db, topicKey, String(threadId ?? 0));
}

export async function getTopicRoutingConfig(
  db: D1Database
): Promise<TopicRoutingConfig> {
  await ensureSystemSettingsTable(db);
  const rows = await db
    .prepare(
      `SELECT key, value FROM system_settings
       WHERE key IN (?, ?, ?, ?)`
    )
    .bind(
      SYSTEM_SETTING_KEYS.LOG_GROUP_ID,
      SYSTEM_SETTING_KEYS.TOPIC_LOGS_ID,
      SYSTEM_SETTING_KEYS.TOPIC_BACKUPS_ID,
      SYSTEM_SETTING_KEYS.TOPIC_SUPPORT_ID
    )
    .all<{ key: string; value: string }>();

  const map = new Map<string, string>();
  for (const row of rows.results || []) {
    map.set(row.key, String(row.value));
  }

  return {
    logGroupId: map.get(SYSTEM_SETTING_KEYS.LOG_GROUP_ID) ?? null,
    topicLogsId: map.get(SYSTEM_SETTING_KEYS.TOPIC_LOGS_ID) ?? null,
    topicBackupsId: map.get(SYSTEM_SETTING_KEYS.TOPIC_BACKUPS_ID) ?? null,
    topicSupportId: map.get(SYSTEM_SETTING_KEYS.TOPIC_SUPPORT_ID) ?? null,
  };
}

function resolveTopicThreadId(
  config: TopicRoutingConfig,
  topicType: TopicType
): { configured: boolean; threadId: number | null } {
  const raw =
    topicType === 'logs'
      ? config.topicLogsId
      : topicType === 'backups'
      ? config.topicBackupsId
      : config.topicSupportId;

  if (raw === null || raw === '') {
    return { configured: false, threadId: null };
  }
  const numeric = Number(raw);
  if (!Number.isInteger(numeric) || numeric < 0) {
    return { configured: false, threadId: null };
  }
  return { configured: true, threadId: numeric > 0 ? numeric : null };
}

/**
 * Sends a formatted HTML message to the configured Telegram Forum Topic
 * (`logs`, `backups`, or `support`). Always wrapped in try/catch so logging
 * failures can never crash the worker or trigger recursive error loops.
 */
export async function sendToTopic(
  env: Env,
  topicType: TopicType,
  text: string
): Promise<boolean> {
  try {
    const botToken = (env.TELEGRAM_BOT_TOKEN || '').trim();
    if (!botToken || !env.DB) return false;

    const config = await getTopicRoutingConfig(env.DB);
    if (!config.logGroupId) return false;

    const groupId = Number(config.logGroupId);
    if (!Number.isFinite(groupId) || groupId === 0) return false;

    const { configured, threadId } = resolveTopicThreadId(config, topicType);
    if (!configured) return false;

    const payload: Record<string, unknown> = {
      chat_id: groupId,
      text: text.slice(0, 4000),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };
    if (threadId !== null) {
      payload.message_thread_id = threadId;
    }

    const resp = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );

    const rawText = await resp.text();
    let parsed: TelegramApiResponse | null = null;
    try {
      parsed = JSON.parse(rawText) as TelegramApiResponse;
    } catch {
      parsed = null;
    }

    if (!resp.ok || !parsed || parsed.ok !== true) {
      console.error('[Sentra Topic Send Failed]', {
        topicType,
        http_status: resp.status,
        error_code: parsed?.error_code ?? null,
        description: parsed?.description ?? rawText.slice(0, 300),
      });
      return false;
    }

    return true;
  } catch (err) {
    console.error('[Sentra Topic Send Error]', topicType, err);
    return false;
  }
}

/**
 * Sends a photo or document by Telegram `file_id` to a configured Forum Topic.
 * Falls back gracefully and never throws.
 */
export async function sendMediaToTopic(
  env: Env,
  topicType: TopicType,
  media: { kind: 'photo' | 'document'; fileId: string; caption: string }
): Promise<boolean> {
  try {
    const botToken = (env.TELEGRAM_BOT_TOKEN || '').trim();
    if (!botToken || !env.DB) return false;

    const config = await getTopicRoutingConfig(env.DB);
    if (!config.logGroupId) return false;

    const groupId = Number(config.logGroupId);
    if (!Number.isFinite(groupId) || groupId === 0) return false;

    const { configured, threadId } = resolveTopicThreadId(config, topicType);
    if (!configured) return false;

    const method = media.kind === 'photo' ? 'sendPhoto' : 'sendDocument';
    const fieldName = media.kind === 'photo' ? 'photo' : 'document';
    const payload: Record<string, unknown> = {
      chat_id: groupId,
      [fieldName]: media.fileId,
      caption: media.caption.slice(0, 1020),
      parse_mode: 'HTML',
    };
    if (threadId !== null) {
      payload.message_thread_id = threadId;
    }

    const resp = await fetch(
      `https://api.telegram.org/bot${botToken}/${method}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );

    const rawText = await resp.text();
    let parsed: TelegramApiResponse | null = null;
    try {
      parsed = JSON.parse(rawText) as TelegramApiResponse;
    } catch {
      parsed = null;
    }

    if (!resp.ok || !parsed || parsed.ok !== true) {
      console.error('[Sentra Topic Media Send Failed]', {
        topicType,
        method,
        http_status: resp.status,
        error_code: parsed?.error_code ?? null,
        description: parsed?.description ?? rawText.slice(0, 300),
      });
      return false;
    }

    return true;
  } catch (err) {
    console.error('[Sentra Topic Media Send Error]', topicType, err);
    return false;
  }
}

/**
 * Error-Only Alert helper: immediately dispatches unexpected errors, D1/Telegram failures,
 * and critical QualityEngine outages to `topic_logs_id` using the Unified AI-Ready format
 * with automatic secret sanitization.
 * Fully wrapped in try/catch and logs only to console.error on failure to prevent infinite loops.
 */
export async function sendErrorAlert(
  env: Env,
  source: string,
  errorDetails: unknown,
  context?: Record<string, unknown>
): Promise<boolean> {
  try {
    const normalized = normalizeUnknownError(errorDetails);
    const parsedSource = /^([^()]+?)\s*\((.+)\)\s*$/.exec(source.trim());
    const moduleOrFile = parsedSource ? parsedSource[1].trim() : source.trim();
    const actionOrRoute = parsedSource ? parsedSource[2].trim() : source.trim();

    const extraSecrets = [
      env.TELEGRAM_BOT_TOKEN,
      env.QUALITY_ENGINE_SECRET,
      env.TELEGRAM_WEBHOOK_SECRET,
      env.WIREGUARD_KEY_SALT,
    ];

    const alertText = formatAiReadyErrorMessage(
      {
        platform: 'worker',
        appVersion: 'worker-v1',
        moduleOrFile,
        actionOrRoute,
        errorName: normalized.errorName,
        errorMessage: normalized.errorMessage,
        stackTrace: normalized.stackTrace,
        context,
        timestamp: new Date().toISOString(),
      },
      extraSecrets
    );

    return await sendToTopic(env, 'logs', alertText);
  } catch (err) {
    console.error('[Sentra sendErrorAlert Fatal]', source, err);
    return false;
  }
}

/**
 * Dispatches an error alert without blocking user responses when `ExecutionContext.waitUntil`
 * is available, or awaits delivery directly when `ctx` is not provided.
 */
export async function dispatchErrorAlert(
  env: Env,
  ctx: ExecutionContext | undefined,
  source: string,
  errorDetails: unknown
): Promise<void> {
  const promise = sendErrorAlert(env, source, errorDetails).then(() => undefined);
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(promise);
    return;
  }
  await promise;
}

/**
 * Exports all real tables from Cloudflare D1 into a JSON file and sends it
 * via Telegram `sendDocument` to the configured Backup Forum Topic (`topic_backups_id`).
 * Automatically reports any backup error to `sendErrorAlert`.
 */
export async function sendDatabaseBackup(
  env: Env,
  now: Date = new Date()
): Promise<DatabaseBackupResult> {
  try {
    const botToken = (env.TELEGRAM_BOT_TOKEN || '').trim();
    if (!botToken) {
      const error = 'توکن ربات تلگرام (TELEGRAM_BOT_TOKEN) تنظیم نشده است.';
      console.error('[Sentra Database Backup Error]', error);
      return { ok: false, error };
    }
    if (!env.DB) {
      const error = 'اتصال دیتابیس D1 در دسترس نیست.';
      await sendErrorAlert(env, 'Database Backup (D1)', error);
      return { ok: false, error };
    }

    const config = await getTopicRoutingConfig(env.DB);
    if (!config.logGroupId) {
      return {
        ok: false,
        error: 'گروه لاگ/بکاپ هنوز متصل نشده است. ابتدا در تاپیک بکاپ دستور /set_backups را ارسال کنید.',
      };
    }

    const groupId = Number(config.logGroupId);
    const { configured, threadId } = resolveTopicThreadId(config, 'backups');
    if (!Number.isFinite(groupId) || groupId === 0 || !configured) {
      const error =
        'تاپیک بکاپ هنوز تنظیم نشده است. در گروه تلگرام داخل تاپیک بکاپ دستور /set_backups را بزنید.';
      await sendErrorAlert(env, 'Database Backup (D1)', error);
      return { ok: false, error };
    }

    const tablesRes = await env.DB.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
         AND name NOT LIKE '_cf_%'
       ORDER BY name ASC`
    ).all<{ name: string }>();

    const tableNames = (tablesRes.results || [])
      .map((r) => String(r.name || ''))
      .filter((name) => VALID_SQLITE_IDENTIFIER.test(name));

    const tablesData: Record<string, unknown[]> = {};
    let totalRows = 0;

    for (const tableName of tableNames) {
      const rowsRes = await env.DB.prepare(`SELECT * FROM "${tableName}"`).all<
        Record<string, unknown>
      >();
      const rows = rowsRes.results || [];
      tablesData[tableName] = rows;
      totalRows += rows.length;
    }

    const filename = buildBackupFilename(now);
    const backupPayload = {
      project: 'SentraVPN',
      exported_at: now.toISOString(),
      tables_count: tableNames.length,
      total_rows: totalRows,
      tables: tablesData,
    };

    const jsonString = JSON.stringify(backupPayload, null, 2);
    const caption =
      `💾 <b>بکاپ کامل دیتابیس D1 (SentraVPN)</b>\n\n` +
      `🕒 زمان بکاپ: <code>${escapeTelegramHtml(formatLogTimestamp(now))}</code>\n` +
      `🗂 تعداد جداول: <b>${tableNames.length}</b>\n` +
      `📊 مجموع ردیف‌ها: <b>${totalRows}</b>\n` +
      `📄 فایل: <code>${escapeTelegramHtml(filename)}</code>`;

    const form = new FormData();
    form.append('chat_id', String(groupId));
    if (threadId !== null) {
      form.append('message_thread_id', String(threadId));
    }
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
    form.append(
      'document',
      new Blob([jsonString], { type: 'application/json; charset=utf-8' }),
      filename
    );

    const resp = await fetch(
      `https://api.telegram.org/bot${botToken}/sendDocument`,
      {
        method: 'POST',
        body: form,
      }
    );

    const rawText = await resp.text();
    let parsed: TelegramApiResponse | null = null;
    try {
      parsed = JSON.parse(rawText) as TelegramApiResponse;
    } catch {
      parsed = null;
    }

    if (!resp.ok || !parsed || parsed.ok !== true) {
      const desc = parsed?.description ?? rawText.slice(0, 300);
      const error = `ارسال فایل بکاپ به تلگرام ناموفق بود (HTTP ${resp.status}): ${desc}`;
      console.error('[Sentra Backup Upload Failed]', {
        http_status: resp.status,
        error_code: parsed?.error_code ?? null,
        description: desc,
      });
      await sendErrorAlert(env, 'Database Backup (sendDocument)', error);
      return { ok: false, error };
    }

    return {
      ok: true,
      filename,
      tablesCount: tableNames.length,
      totalRows,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('[Sentra Database Backup Error]', err);
    await sendErrorAlert(env, 'Database Backup (D1)', err);
    return {
      ok: false,
      error: `خطا در تهیه یا ارسال بکاپ: ${errMsg}`,
    };
  }
}
