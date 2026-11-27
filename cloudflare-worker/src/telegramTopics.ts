import {
  normalizeUnknownError,
  reportUnifiedError,
} from './errorReporter.ts';
import {
  DEFAULT_FREE_DOWNLOAD_QUOTA_GB,
  DEFAULT_FREE_WEB_QUOTA_GB,
  getOrLoadSystemSettingsCache,
  updateSystemSettingsKvCache,
} from './kvCache.ts';
import { saveD1BackupMirrorToTurso } from './tursoClient.ts';
import {
  executeD1Batch,
  invalidateNodesCache,
} from './workerCache.ts';
import type { Env } from './types.ts';

export type TopicType = 'logs' | 'backups' | 'support';

export const SYSTEM_SETTING_KEYS = {
  LOG_GROUP_ID: 'log_group_id',
  TOPIC_LOGS_ID: 'topic_logs_id',
  TOPIC_BACKUPS_ID: 'topic_backups_id',
  TOPIC_SUPPORT_ID: 'topic_support_id',
  FREE_WEB_QUOTA_GB: 'free_web_quota_gb',
  FREE_DOWNLOAD_QUOTA_GB: 'free_download_quota_gb',
} as const;

export type SystemSettingKey =
  (typeof SYSTEM_SETTING_KEYS)[keyof typeof SYSTEM_SETTING_KEYS];

export interface TopicRoutingConfig {
  logGroupId: string | null;
  topicLogsId: string | null;
  topicBackupsId: string | null;
  topicSupportId: string | null;
  freeWebQuotaGb?: number;
  freeDownloadQuotaGb?: number;
}

export interface FreeQuotaSettings {
  webQuotaGb: number;
  downloadQuotaGb: number;
  webQuotaBytes: number;
  downloadQuotaBytes: number;
}

export interface DatabaseBackupResult {
  ok: boolean;
  filename?: string;
  tablesCount?: number;
  totalRows?: number;
  tursoMirrored?: boolean;
  error?: string;
}

interface TelegramApiResponse {
  ok?: boolean;
  error_code?: number;
  description?: string;
}

/**
 * Core persistent tables included in automated 12-hour D1 backups.
 * High-churn temporary tables (`telegram_states`, `traffic_logs`,
 * `ip_registrations`, `device_sessions`) are intentionally excluded to stay
 * well within Cloudflare Workers 10ms CPU and D1 free-tier read budgets.
 */
export const CORE_BACKUP_TABLES = [
  'users',
  'subscriptions',
  'donated_outbounds',
  'subscription_sources',
  'donations',
  'system_settings',
] as const;

export interface StalePruneResult {
  deletedStates: number;
  deletedOutbounds: number;
  deletedIpRegistrations: number;
}

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

function parsePositiveQuotaGb(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 10000) {
    return fallback;
  }
  return parsed;
}

async function fetchTopicRoutingFromD1(db: D1Database): Promise<TopicRoutingConfig> {
  const rows = await db
    .prepare(
      `SELECT key, value FROM system_settings
       WHERE key IN (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      SYSTEM_SETTING_KEYS.LOG_GROUP_ID,
      SYSTEM_SETTING_KEYS.TOPIC_LOGS_ID,
      SYSTEM_SETTING_KEYS.TOPIC_BACKUPS_ID,
      SYSTEM_SETTING_KEYS.TOPIC_SUPPORT_ID,
      SYSTEM_SETTING_KEYS.FREE_WEB_QUOTA_GB,
      SYSTEM_SETTING_KEYS.FREE_DOWNLOAD_QUOTA_GB
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
    freeWebQuotaGb: parsePositiveQuotaGb(
      map.get(SYSTEM_SETTING_KEYS.FREE_WEB_QUOTA_GB),
      DEFAULT_FREE_WEB_QUOTA_GB
    ),
    freeDownloadQuotaGb: parsePositiveQuotaGb(
      map.get(SYSTEM_SETTING_KEYS.FREE_DOWNLOAD_QUOTA_GB),
      DEFAULT_FREE_DOWNLOAD_QUOTA_GB
    ),
  };
}

export async function getFreeQuotaSettings(
  db: D1Database,
  kv?: KVNamespace
): Promise<FreeQuotaSettings> {
  const cached = await getTopicRoutingConfig(db, kv);
  const webQuotaGb =
    typeof cached.freeWebQuotaGb === 'number' && cached.freeWebQuotaGb > 0
      ? cached.freeWebQuotaGb
      : DEFAULT_FREE_WEB_QUOTA_GB;
  const downloadQuotaGb =
    typeof cached.freeDownloadQuotaGb === 'number' && cached.freeDownloadQuotaGb > 0
      ? cached.freeDownloadQuotaGb
      : DEFAULT_FREE_DOWNLOAD_QUOTA_GB;
  const GIB = 1024 * 1024 * 1024;
  return {
    webQuotaGb,
    downloadQuotaGb,
    webQuotaBytes: Math.round(webQuotaGb * GIB),
    downloadQuotaBytes: Math.round(downloadQuotaGb * GIB),
  };
}

export async function getSystemSetting(
  db: D1Database,
  key: SystemSettingKey,
  kv?: KVNamespace
): Promise<string | null> {
  const cached = await getTopicRoutingConfig(db, kv);
  if (key === SYSTEM_SETTING_KEYS.LOG_GROUP_ID) return cached.logGroupId;
  if (key === SYSTEM_SETTING_KEYS.TOPIC_LOGS_ID) return cached.topicLogsId;
  if (key === SYSTEM_SETTING_KEYS.TOPIC_BACKUPS_ID) return cached.topicBackupsId;
  if (key === SYSTEM_SETTING_KEYS.TOPIC_SUPPORT_ID) return cached.topicSupportId;
  if (key === SYSTEM_SETTING_KEYS.FREE_WEB_QUOTA_GB) {
    return String(cached.freeWebQuotaGb ?? DEFAULT_FREE_WEB_QUOTA_GB);
  }
  if (key === SYSTEM_SETTING_KEYS.FREE_DOWNLOAD_QUOTA_GB) {
    return String(cached.freeDownloadQuotaGb ?? DEFAULT_FREE_DOWNLOAD_QUOTA_GB);
  }
  const row = await db
    .prepare('SELECT value FROM system_settings WHERE key = ? LIMIT 1')
    .bind(key)
    .first<{ value: string }>();
  return row ? String(row.value) : null;
}

export async function setSystemSetting(
  db: D1Database,
  key: SystemSettingKey,
  value: string,
  kv?: KVNamespace
): Promise<void> {
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

  const freshConfig = await fetchTopicRoutingFromD1(db);
  await updateSystemSettingsKvCache(db, kv, freshConfig);
}

export async function saveTopicRoute(
  db: D1Database,
  topicType: TopicType,
  groupId: number,
  threadId?: number,
  kv?: KVNamespace
): Promise<void> {
  const topicKey =
    topicType === 'logs'
      ? SYSTEM_SETTING_KEYS.TOPIC_LOGS_ID
      : topicType === 'backups'
      ? SYSTEM_SETTING_KEYS.TOPIC_BACKUPS_ID
      : SYSTEM_SETTING_KEYS.TOPIC_SUPPORT_ID;

  const upsertSql = `INSERT INTO system_settings (key, value, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = CURRENT_TIMESTAMP`;

  await executeD1Batch(db, [
    db.prepare(upsertSql).bind(SYSTEM_SETTING_KEYS.LOG_GROUP_ID, String(groupId)),
    db.prepare(upsertSql).bind(topicKey, String(threadId ?? 0)),
  ]);

  // Write-through to L1 RAM + L2 KV (`cache:system_settings_v1`, 1 single KV write)
  const freshConfig = await fetchTopicRoutingFromD1(db);
  await updateSystemSettingsKvCache(db, kv, freshConfig);
}

export async function getTopicRoutingConfig(
  db: D1Database,
  kv?: KVNamespace
): Promise<TopicRoutingConfig> {
  const { config } = await getOrLoadSystemSettingsCache(db, kv, () =>
    fetchTopicRoutingFromD1(db)
  );
  return config;
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

    const config = await getTopicRoutingConfig(env.DB, env.SENTRA_KV);
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

    const config = await getTopicRoutingConfig(env.DB, env.SENTRA_KV);
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

    return await reportUnifiedError(env, {
      platform: 'worker',
      appVersion: 'worker-v1',
      moduleOrFile,
      actionOrRoute,
      errorName: normalized.errorName,
      errorMessage: normalized.errorMessage,
      stackTrace: normalized.stackTrace,
      context,
      timestamp: new Date().toISOString(),
    });
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

export async function exportCoreD1BackupSnapshot(
  db: D1Database,
  now: Date = new Date()
): Promise<{
  filename: string;
  tablesCount: number;
  totalRows: number;
  jsonString: string;
}> {
  const batchStatements = CORE_BACKUP_TABLES.map((tableName) =>
    db.prepare(`SELECT * FROM "${tableName}"`)
  );
  const batchResults = await executeD1Batch<Record<string, unknown>>(
    db,
    batchStatements
  );

  const tablesData: Record<string, unknown[]> = {};
  let totalRows = 0;

  CORE_BACKUP_TABLES.forEach((tableName, idx) => {
    const rows = batchResults[idx]?.results || [];
    tablesData[tableName] = rows;
    totalRows += rows.length;
  });

  const filename = buildBackupFilename(now);
  const backupPayload = {
    project: 'SentraVPN',
    exported_at: now.toISOString(),
    tables_count: CORE_BACKUP_TABLES.length,
    total_rows: totalRows,
    tables: tablesData,
  };

  return {
    filename,
    tablesCount: CORE_BACKUP_TABLES.length,
    totalRows,
    jsonString: JSON.stringify(backupPayload),
  };
}

/**
 * Exports critical tables from Cloudflare D1 into a compact JSON snapshot, sends it
 * via Telegram `sendDocument` to `topic_backups_id`, and mirrors the snapshot into
 * Turso `d1_backups` (retaining only the latest 14 backups) when Turso is configured.
 * Turso failures never break the primary Telegram backup and vice versa.
 */
export async function sendDatabaseBackup(
  env: Env,
  now: Date = new Date()
): Promise<DatabaseBackupResult> {
  try {
    if (!env.DB) {
      const error = 'اتصال دیتابیس D1 در دسترس نیست.';
      await sendErrorAlert(env, 'Database Backup (D1)', error);
      return { ok: false, error };
    }

    const botToken = (env.TELEGRAM_BOT_TOKEN || '').trim();
    const hasTurso = Boolean(
      (env.TURSO_DATABASE_URL || '').trim() && (env.TURSO_AUTH_TOKEN || '').trim()
    );

    const config = botToken ? await getTopicRoutingConfig(env.DB, env.SENTRA_KV) : null;
    const groupId = config?.logGroupId ? Number(config.logGroupId) : 0;
    const topicTarget = config
      ? resolveTopicThreadId(config, 'backups')
      : { configured: false, threadId: null };
    const canSendTelegram =
      Boolean(botToken) &&
      Boolean(config?.logGroupId) &&
      Number.isFinite(groupId) &&
      groupId !== 0 &&
      topicTarget.configured;

    // If Telegram cannot run, still attempt Turso Cloud Mirror if configured
    if (!canSendTelegram) {
      let tursoMirrored = false;
      if (hasTurso) {
        const snapshot = await exportCoreD1BackupSnapshot(env.DB, now);
        tursoMirrored = await saveD1BackupMirrorToTurso(env, snapshot.jsonString);
      }

      if (!botToken) {
        const error = 'توکن ربات تلگرام (TELEGRAM_BOT_TOKEN) تنظیم نشده است.';
        console.error('[Sentra Database Backup Error]', error);
        return { ok: false, tursoMirrored, error };
      }
      if (!config?.logGroupId) {
        return {
          ok: false,
          tursoMirrored,
          error: 'گروه لاگ/بکاپ هنوز متصل نشده است. ابتدا در تاپیک بکاپ دستور /set_backups را ارسال کنید.',
        };
      }
      const error =
        'تاپیک بکاپ هنوز تنظیم نشده است. در گروه تلگرام داخل تاپیک بکاپ دستور /set_backups را بزنید.';
      await sendErrorAlert(env, 'Database Backup (D1)', error);
      return { ok: false, tursoMirrored, error };
    }

    // Single batched D1 export shared between Telegram document upload & Turso Cloud Mirror
    const snapshot = await exportCoreD1BackupSnapshot(env.DB, now);
    const { filename, tablesCount, totalRows, jsonString } = snapshot;

    const caption =
      `💾 <b>بکاپ کامل دیتابیس D1 (SentraVPN)</b>\n\n` +
      `🕒 زمان بکاپ: <code>${escapeTelegramHtml(formatLogTimestamp(now))}</code>\n` +
      `🗂 تعداد جداول حیاتی: <b>${tablesCount}</b>\n` +
      `📊 مجموع ردیف‌ها: <b>${totalRows}</b>\n` +
      `📄 فایل: <code>${escapeTelegramHtml(filename)}</code>`;

    const form = new FormData();
    form.append('chat_id', String(groupId));
    if (topicTarget.threadId !== null) {
      form.append('message_thread_id', String(topicTarget.threadId));
    }
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
    form.append(
      'document',
      new Blob([jsonString], { type: 'application/json; charset=utf-8' }),
      filename
    );

    const [tgOutcome, tursoOutcome] = await Promise.allSettled([
      fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
        method: 'POST',
        body: form,
      }),
      hasTurso ? saveD1BackupMirrorToTurso(env, jsonString) : Promise.resolve(false),
    ]);

    const tursoMirrored =
      tursoOutcome.status === 'fulfilled' ? tursoOutcome.value : false;

    if (tgOutcome.status === 'rejected') {
      throw tgOutcome.reason;
    }

    const resp = tgOutcome.value;
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
      return { ok: false, tursoMirrored, error };
    }

    return {
      ok: true,
      filename,
      tablesCount,
      totalRows,
      tursoMirrored,
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

/**
 * Automated 12-hour D1 storage protection: prunes expired temporary rows so the
 * database stays comfortably within Cloudflare D1's 500MB free-tier storage cap.
 * - `telegram_states` older than 24 hours
 * - `donated_outbounds` in `rejected` / `inactive` status older than 14 days
 * - `ip_registrations` older than 7 days
 */
export async function pruneStaleRecords(db: D1Database): Promise<StalePruneResult> {
  const statements = [
    db.prepare(
      `DELETE FROM telegram_states
       WHERE updated_at < datetime('now', '-24 hours')`
    ),
    db.prepare(
      `DELETE FROM donated_outbounds
       WHERE status IN ('rejected', 'inactive')
         AND updated_at < datetime('now', '-14 days')`
    ),
    db.prepare(
      `DELETE FROM ip_registrations
       WHERE created_at < datetime('now', '-7 days')`
    ),
  ];

  const [statesRes, outboundsRes, ipRes] = await executeD1Batch(db, statements);
  const deletedStates = Number(statesRes?.meta?.changes ?? 0);
  const deletedOutbounds = Number(outboundsRes?.meta?.changes ?? 0);
  const deletedIpRegistrations = Number(ipRes?.meta?.changes ?? 0);

  if (deletedOutbounds > 0) {
    // Only inactive/rejected outbounds are pruned; clear local L1 RAM without consuming a KV write
    await invalidateNodesCache(db);
  }

  return {
    deletedStates,
    deletedOutbounds,
    deletedIpRegistrations,
  };
}
