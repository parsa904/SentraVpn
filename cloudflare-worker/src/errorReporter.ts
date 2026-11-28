import {
  escapeTelegramHtml,
  sendToTopic,
} from './telegramTopics.ts';
import { logTelemetryToTurso } from './tursoClient.ts';
import type { Env } from './types.ts';

export type ErrorPlatform =
  | 'worker'
  | 'github-actions'
  | 'android-build'
  | 'windows-build'
  | 'android'
  | 'windows'
  | 'sentry';

export const ALLOWED_ERROR_PLATFORMS: readonly ErrorPlatform[] = [
  'worker',
  'github-actions',
  'android-build',
  'windows-build',
  'android',
  'windows',
  'sentry',
] as const;

export const ALLOWED_INGEST_PLATFORMS: readonly Exclude<ErrorPlatform, 'worker'>[] = [
  'github-actions',
  'android-build',
  'windows-build',
  'android',
  'windows',
  'sentry',
] as const;

export interface UnifiedErrorReport {
  platform: ErrorPlatform;
  appVersion?: string;
  moduleOrFile: string;
  actionOrRoute: string;
  errorName: string;
  errorMessage: string;
  stackTrace?: string;
  context?: Record<string, unknown>;
  timestamp?: string;
  source?: 'sentry' | 'internal' | string;
  sentryProject?: string;
  sentryLevel?: string;
  sentryIssueUrl?: string;
}

const REDACTED = '[REDACTED]';
const TELEGRAM_MAX_MESSAGE_LEN = 3950;
export const ERROR_DEDUP_WINDOW_MS = 5 * 60_000; // 5-minute RAM deduplication window
export const MAX_ERROR_DEDUP_KEYS = 100; // Strict FIFO cap in Worker isolate RAM
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_REPORTS_PER_CLIENT_PER_MIN = 10;
const MAX_CLIENT_RATE_KEYS = 200;

// In-memory sliding windows (per Worker isolate — zero D1 reads/writes)
const recentFingerprints = new Map<string, number>();
const clientHitTimestamps = new Map<string, number[]>();

const PLATFORM_META: Record<
  ErrorPlatform,
  { emoji: string; label: string }
> = {
  worker: { emoji: '☁️', label: 'Cloudflare Worker' },
  'github-actions': { emoji: '⚙️', label: 'GitHub Actions / QualityEngine' },
  'android-build': { emoji: '🤖', label: 'GitHub Actions (Android Build)' },
  'windows-build': { emoji: '🪟', label: 'GitHub Actions (Windows Build)' },
  android: { emoji: '🤖', label: 'Android Client' },
  windows: { emoji: '🪟', label: 'Windows Client' },
  sentry: { emoji: '🚨', label: '[SENTRY]' },
};

/**
 * Returns true when an error report originated from Sentry (Sentry Webhook or
 * Sentry SDK tracking in Worker / Client) so Telegram messages carry the
 * dedicated `#Sentry_Error | 🚨 [SENTRY]` tag and are never looped back to Sentry.
 */
export function isSentryErrorReport(report: UnifiedErrorReport): boolean {
  if (report.platform === 'sentry') return true;
  if (typeof report.source === 'string' && report.source.trim().toLowerCase() === 'sentry') {
    return true;
  }
  if (report.sentryProject || report.sentryIssueUrl) return true;
  const ctx = report.context;
  if (ctx && typeof ctx === 'object') {
    if (String(ctx.source || '').trim().toLowerCase() === 'sentry') return true;
    if (ctx.sentry_origin === true || ctx.via_sentry === true) return true;
  }
  return false;
}

function sanitizeSafeHttpsUrl(raw?: string): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    if (parsed.username || parsed.password) return null;
    return parsed.toString().slice(0, 400);
  } catch {
    return null;
  }
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Redacts all known secrets, tokens, auth headers, subscription paths, and
 * credentials from any string before it is formatted or sent to Telegram.
 */
export function sanitizeSecrets(
  input: string,
  extraSecrets?: Array<string | undefined | null>
): string {
  if (!input) return '';
  let out = input;

  // 1. Redact explicit runtime secrets first (longest first to avoid partial remnants)
  if (extraSecrets && extraSecrets.length > 0) {
    const cleaned = extraSecrets
      .map((s) => (typeof s === 'string' ? s.trim() : ''))
      .filter((s) => s.length >= 6)
      .sort((a, b) => b.length - a.length);

    for (const secret of cleaned) {
      out = out.replace(new RegExp(escapeRegExp(secret), 'g'), REDACTED);
    }
  }

  // 2. Telegram Bot API tokens (both URL `/bot123456:ABC...` and standalone `123456:ABC...`)
  out = out.replace(/\bbot\d{6,14}:[A-Za-z0-9_-]{20,}\b/g, `bot${REDACTED}`);
  out = out.replace(/\b\d{6,14}:[A-Za-z0-9_-]{20,}\b/g, REDACTED);

  // 3. Authorization Bearer headers and standalone Bearer tokens
  out = out.replace(
    /(Authorization\s*:\s*Bearer\s+)[^\s"',;\r\n]+/gi,
    `$1${REDACTED}`
  );
  out = out.replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED}`);

  // 4. Sensitive HTTP headers (X-Quality-Secret, X-Subscription-Token, Telegram secret header)
  out = out.replace(
    /((?:X-Quality-Secret|X-Subscription-Token|X-Telegram-Bot-Api-Secret-Token)\s*:\s*)[^\s"',;\r\n]+/gi,
    `$1${REDACTED}`
  );

  // 5. Subscription tokens in URL paths (/sub/<token> or /api/v1/sub/<token>)
  out = out.replace(
    /(\/(?:api\/v1\/)?sub\/)([^/?#\s"'<>]+)/gi,
    `$1${REDACTED}`
  );

  // 6. Sensitive query parameters (token, secret, api_key, password, auth, key)
  out = out.replace(
    /([?&](?:token|secret|api_key|apikey|password|passwd|auth|access_token|subscription_token|quality_secret)=)([^&\s"'<>]+)/gi,
    `$1${REDACTED}`
  );

  // 7. Sensitive JSON key/value fields
  out = out.replace(
    /("(?:password|password_hash|token|auth_token|access_token|subscription_token|secret|quality_engine_secret|telegram_bot_token|bot_token|api_key)"\s*:\s*")([^"]*)(")/gi,
    `$1${REDACTED}$3`
  );

  // 8. Proxy URI credentials (vless://uuid@host, trojan://pass@host, hysteria2://pass@host, ss://cred@host)
  out = out.replace(
    /(\b(?:vless|trojan|hysteria2|hy2|tuic|ss):\/\/)([^@\s/]+)(@)/gi,
    `$1${REDACTED}$3`
  );

  // 9. Named env assignments like TELEGRAM_BOT_TOKEN=..., TURSO_AUTH_TOKEN=..., SENTRY_DSN_WORKER=...
  out = out.replace(
    /(\b(?:TELEGRAM_BOT_TOKEN|QUALITY_ENGINE_SECRET|TELEGRAM_WEBHOOK_SECRET|WIREGUARD_KEY_SALT|TURSO_AUTH_TOKEN|SENTRY_DSN_WORKER|SENTRY_DSN_CLIENT)\s*=\s*)([^\s"',;\r\n]+)/gi,
    `$1${REDACTED}`
  );

  // 10. Sentry DSN credentials (`https://<public_key>@o123.ingest.sentry.io/456`)
  out = out.replace(
    /(https?:\/\/)([A-Za-z0-9]{16,64})(@[^\s"'<>]*sentry\.io)/gi,
    `$1${REDACTED}$3`
  );

  return out;
}

function collectEnvSecrets(env?: Env): string[] {
  if (!env) return [];
  return [
    env.TELEGRAM_BOT_TOKEN,
    env.QUALITY_ENGINE_SECRET,
    env.TELEGRAM_WEBHOOK_SECRET,
    env.WIREGUARD_KEY_SALT,
    env.SENTRY_DSN_WORKER,
    env.TURSO_AUTH_TOKEN,
  ].filter((v): v is string => typeof v === 'string' && v.trim().length >= 6);
}

function sanitizeContextValue(
  value: unknown,
  extraSecrets: string[],
  depth = 0
): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'string') {
    return sanitizeSecrets(value, extraSecrets).replace(/\r?\n/g, ' ').slice(0, 260);
  }
  if (depth >= 2) {
    return '[Object]';
  }
  try {
    return sanitizeSecrets(JSON.stringify(value), extraSecrets).slice(0, 260);
  } catch {
    return '[Unserializable]';
  }
}

function formatContextBlock(
  context: Record<string, unknown> | undefined,
  extraSecrets: string[]
): string {
  if (!context || typeof context !== 'object') return '  (none)';
  const entries = Object.entries(context).slice(0, 16);
  if (entries.length === 0) return '  (none)';

  const sensitiveKeyPattern =
    /(token|secret|password|authorization|cookie|private_key|api_key|salt)/i;

  return entries
    .map(([rawKey, rawVal]) => {
      const key = String(rawKey).replace(/[\r\n]/g, '').slice(0, 64);
      const val = sensitiveKeyPattern.test(key)
        ? REDACTED
        : sanitizeContextValue(rawVal, extraSecrets);
      return `  ${key}: ${val}`;
    })
    .join('\n');
}

/**
 * Formats a UnifiedErrorReport into a Telegram HTML message whose technical
 * block is wrapped inside `<pre><code>...</code></pre>` for one-tap copy & paste
 * directly into Gemini.
 */
export function formatAiReadyErrorMessage(
  report: UnifiedErrorReport,
  extraSecrets: Array<string | undefined | null> = []
): string {
  const secrets = extraSecrets.filter(
    (s): s is string => typeof s === 'string' && s.trim().length >= 6
  );
  const meta = PLATFORM_META[report.platform] ?? PLATFORM_META.worker;

  const timestamp = (report.timestamp || new Date().toISOString()).trim().slice(0, 64);
  const appVersion = sanitizeSecrets(
    (report.appVersion || 'unknown').trim().slice(0, 48),
    secrets
  );
  const moduleOrFile = sanitizeSecrets(
    (report.moduleOrFile || 'unknown').trim().slice(0, 180),
    secrets
  );
  const actionOrRoute = sanitizeSecrets(
    (report.actionOrRoute || 'unknown').trim().slice(0, 180),
    secrets
  );
  const errorName = sanitizeSecrets(
    (report.errorName || 'Error').trim().slice(0, 120),
    secrets
  );
  const errorMessage = sanitizeSecrets(
    (report.errorMessage || 'Unknown error').trim().slice(0, 800),
    secrets
  );
  const sentryOrigin = isSentryErrorReport(report);
  const sentryProject = sanitizeSecrets(
    (
      report.sentryProject ||
      (typeof report.context?.sentry_project === 'string' ? report.context.sentry_project : '') ||
      (report.platform === 'android' || report.platform === 'windows'
        ? 'sentra-client'
        : 'sentra-worker')
    )
      .trim()
      .slice(0, 64),
    secrets
  );
  const sentryLevel = sanitizeSecrets(
    (
      report.sentryLevel ||
      (typeof report.context?.sentry_level === 'string' ? report.context.sentry_level : '') ||
      'error'
    )
      .trim()
      .toLowerCase()
      .slice(0, 24),
    secrets
  );
  const sentryIssueUrl = sanitizeSafeHttpsUrl(
    report.sentryIssueUrl ||
      (typeof report.context?.sentry_issue_url === 'string'
        ? report.context.sentry_issue_url
        : undefined)
  );

  const enrichedContext: Record<string, unknown> | undefined = sentryOrigin
    ? {
        ...(report.context || {}),
        source: 'sentry',
        sentry_project: sentryProject,
        sentry_level: sentryLevel,
        ...(sentryIssueUrl ? { sentry_issue_url: sentryIssueUrl } : {}),
      }
    : report.context;

  const contextText = formatContextBlock(enrichedContext, secrets);

  const rawStack = report.stackTrace
    ? sanitizeSecrets(report.stackTrace.trim(), secrets)
    : '';

  const headerHtml = sentryOrigin
    ? `🚨 <b>#Sentry_Error | [SENTRY] گزارش خطا از سنتری</b>\n` +
      `📦 <b>پروژه:</b> <code>${escapeTelegramHtml(sentryProject)}</code> | 🎚 <b>سطح:</b> <code>${escapeTelegramHtml(sentryLevel)}</code>\n` +
      (sentryIssueUrl
        ? `🔗 <a href="${escapeTelegramHtml(sentryIssueUrl)}">مشاهده مستقیم Issue در پنل Sentry</a>\n`
        : '') +
      `📌 <code>${escapeTelegramHtml(moduleOrFile)}</code>\n` +
      `📋 <i>برای ارسال به Gemini روی کادر زیر ضربه بزنید تا کامل کپی شود:</i>\n\n`
    : `🚨 <b>گزارش خطای SentraVPN</b> | ${meta.emoji} <code>${escapeTelegramHtml(report.platform)}</code>\n` +
      `📌 <b>${escapeTelegramHtml(meta.label)}</b> — <code>${escapeTelegramHtml(moduleOrFile)}</code>\n` +
      `📋 <i>برای ارسال به Gemini روی کادر زیر ضربه بزنید تا کامل کپی شود:</i>\n\n`;

  const buildCodeBody = (stackSlice: string): string => {
    const lines = [
      '=== SENTRAVPN ERROR REPORT (AI-READY) ===',
      `platform: ${report.platform}`,
      `appVersion: ${appVersion}`,
      `timestamp: ${timestamp}`,
      `moduleOrFile: ${moduleOrFile}`,
      `actionOrRoute: ${actionOrRoute}`,
      `errorName: ${errorName}`,
      `errorMessage: ${errorMessage}`,
      'context:',
      contextText,
    ];
    if (stackSlice) {
      lines.push('stackTrace:');
      lines.push(stackSlice);
    }
    return lines.join('\n');
  };

  // Guarantee final HTML message fits cleanly within Telegram's 4096-char limit
  // without ever cutting off the closing `</code></pre>` tag.
  const wrapperOverhead = headerHtml.length + '<pre><code></code></pre>'.length;
  const maxEscapedBodyLen = Math.max(400, TELEGRAM_MAX_MESSAGE_LEN - wrapperOverhead);

  let stackCandidate = rawStack.slice(0, 1800);
  let escapedBody = escapeTelegramHtml(buildCodeBody(stackCandidate));

  if (escapedBody.length > maxEscapedBodyLen && stackCandidate.length > 0) {
    const excess = escapedBody.length - maxEscapedBodyLen + 32;
    const nextLen = Math.max(0, stackCandidate.length - excess);
    stackCandidate =
      nextLen > 40 ? `${stackCandidate.slice(0, nextLen)}\n...[truncated]` : '';
    escapedBody = escapeTelegramHtml(buildCodeBody(stackCandidate));
  }

  if (escapedBody.length > maxEscapedBodyLen) {
    // Hard trim raw body safely before HTML-escaping so entities (&lt; etc.) are never split
    const rawTrimmed = buildCodeBody('').slice(0, Math.floor(maxEscapedBodyLen * 0.75));
    escapedBody = `${escapeTelegramHtml(rawTrimmed)}\n...[truncated]`;
  }

  return `${headerHtml}<pre><code>${escapedBody}</code></pre>`;
}

/**
 * Extracts normalized error fields from any thrown unknown value.
 */
export function normalizeUnknownError(errorDetails: unknown): {
  errorName: string;
  errorMessage: string;
  stackTrace?: string;
} {
  if (errorDetails instanceof Error) {
    return {
      errorName: errorDetails.name || 'Error',
      errorMessage: errorDetails.message || String(errorDetails),
      stackTrace: errorDetails.stack,
    };
  }
  if (typeof errorDetails === 'string') {
    return {
      errorName: 'RuntimeError',
      errorMessage: errorDetails,
    };
  }
  try {
    return {
      errorName: 'RuntimeError',
      errorMessage: JSON.stringify(errorDetails),
    };
  } catch {
    return {
      errorName: 'RuntimeError',
      errorMessage: String(errorDetails),
    };
  }
}

export function resetErrorReporterThrottleForTests(): void {
  recentFingerprints.clear();
  clientHitTimestamps.clear();
}

export function getDedupCacheSizeForTests(): number {
  return recentFingerprints.size;
}

/**
 * Prevents crash-loop flooding on client ingestion endpoints via per-client rate
 * limiting and identical-error deduplication completely inside Worker isolate RAM
 * (5-minute window, max 100 keys with FIFO eviction, zero D1 writes).
 */
export function checkIngestionRateAndDedup(
  report: Pick<UnifiedErrorReport, 'platform' | 'moduleOrFile' | 'errorName' | 'errorMessage'>,
  clientKey: string,
  nowMs: number = Date.now()
): { allowed: boolean; reason?: 'rate_limited' | 'deduplicated' } {
  // Prune expired client windows if map exceeds bound
  if (clientHitTimestamps.size >= MAX_CLIENT_RATE_KEYS) {
    for (const [k, list] of clientHitTimestamps.entries()) {
      const fresh = list.filter((ts) => nowMs - ts <= RATE_LIMIT_WINDOW_MS);
      if (fresh.length === 0) clientHitTimestamps.delete(k);
      else clientHitTimestamps.set(k, fresh);
    }
    while (clientHitTimestamps.size >= MAX_CLIENT_RATE_KEYS) {
      const oldestClient = clientHitTimestamps.keys().next().value;
      if (oldestClient === undefined) break;
      clientHitTimestamps.delete(oldestClient);
    }
  }

  // 1. Per-client burst rate limit
  const hits = (clientHitTimestamps.get(clientKey) || []).filter(
    (ts) => nowMs - ts <= RATE_LIMIT_WINDOW_MS
  );
  if (hits.length >= MAX_REPORTS_PER_CLIENT_PER_MIN) {
    clientHitTimestamps.set(clientKey, hits);
    return { allowed: false, reason: 'rate_limited' };
  }

  // 2. Deduplicate identical error signature within ERROR_DEDUP_WINDOW_MS (5 minutes)
  const fingerprint = [
    report.platform,
    report.moduleOrFile.slice(0, 80),
    report.errorName.slice(0, 60),
    report.errorMessage.slice(0, 140),
  ].join('|');

  const lastSeen = recentFingerprints.get(fingerprint);
  if (lastSeen !== undefined && nowMs - lastSeen < ERROR_DEDUP_WINDOW_MS) {
    return { allowed: false, reason: 'deduplicated' };
  }

  // Prune expired entries first, then evict oldest FIFO key to enforce 100-key cap
  if (recentFingerprints.size >= MAX_ERROR_DEDUP_KEYS && !recentFingerprints.has(fingerprint)) {
    for (const [k, ts] of recentFingerprints.entries()) {
      if (nowMs - ts >= ERROR_DEDUP_WINDOW_MS) {
        recentFingerprints.delete(k);
      }
    }
    while (recentFingerprints.size >= MAX_ERROR_DEDUP_KEYS) {
      const oldestKey = recentFingerprints.keys().next().value;
      if (oldestKey === undefined) break;
      recentFingerprints.delete(oldestKey);
    }
  }

  hits.push(nowMs);
  clientHitTimestamps.set(clientKey, hits);
  if (recentFingerprints.has(fingerprint)) {
    recentFingerprints.delete(fingerprint);
  }
  recentFingerprints.set(fingerprint, nowMs);
  return { allowed: true };
}

/**
 * Validates and normalizes an untrusted JSON payload received by the
 * `/api/v1/telemetry/error` ingestion endpoint.
 */
export function parseExternalErrorPayload(raw: unknown):
  | { ok: true; report: UnifiedErrorReport }
  | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'بدنه گزارش خطا باید یک آبجکت JSON معتبر باشد.' };
  }

  const body = raw as Record<string, unknown>;
  const platformRaw = String(body.platform || '').trim().toLowerCase();
  if (
    platformRaw !== 'github-actions' &&
    platformRaw !== 'android-build' &&
    platformRaw !== 'windows-build' &&
    platformRaw !== 'android' &&
    platformRaw !== 'windows' &&
    platformRaw !== 'sentry'
  ) {
    return {
      ok: false,
      error:
        'مقدار platform نامعتبر است. مقادیر مجاز: github-actions, android-build, windows-build, android, windows, sentry.',
    };
  }

  const moduleOrFile = String(body.moduleOrFile || body.module || body.file || '').trim();
  const actionOrRoute = String(body.actionOrRoute || body.action || body.route || '').trim();
  const errorName = String(body.errorName || body.name || 'Error').trim();
  const errorMessage = String(body.errorMessage || body.message || '').trim();

  if (!errorMessage) {
    return { ok: false, error: 'فیلد errorMessage الزامی است.' };
  }

  const appVersion =
    typeof body.appVersion === 'string' && body.appVersion.trim()
      ? body.appVersion.trim().slice(0, 48)
      : 'unknown';

  const stackTrace =
    typeof body.stackTrace === 'string' && body.stackTrace.trim()
      ? body.stackTrace.trim().slice(0, 4000)
      : undefined;

  const timestamp =
    typeof body.timestamp === 'string' && body.timestamp.trim()
      ? body.timestamp.trim().slice(0, 64)
      : new Date().toISOString();

  const context =
    body.context && typeof body.context === 'object' && !Array.isArray(body.context)
      ? (body.context as Record<string, unknown>)
      : undefined;

  const source =
    typeof body.source === 'string' && body.source.trim()
      ? body.source.trim().toLowerCase().slice(0, 32)
      : platformRaw === 'sentry'
      ? 'sentry'
      : undefined;
  const sentryProject =
    typeof body.sentryProject === 'string' && body.sentryProject.trim()
      ? body.sentryProject.trim().slice(0, 64)
      : typeof body.project === 'string' && body.project.trim()
      ? body.project.trim().slice(0, 64)
      : undefined;
  const sentryLevel =
    typeof body.sentryLevel === 'string' && body.sentryLevel.trim()
      ? body.sentryLevel.trim().toLowerCase().slice(0, 24)
      : typeof body.level === 'string' && body.level.trim()
      ? body.level.trim().toLowerCase().slice(0, 24)
      : undefined;
  const sentryIssueUrl = sanitizeSafeHttpsUrl(
    typeof body.sentryIssueUrl === 'string'
      ? body.sentryIssueUrl
      : typeof body.issueUrl === 'string'
      ? body.issueUrl
      : undefined
  ) ?? undefined;

  return {
    ok: true,
    report: {
      platform: platformRaw,
      appVersion,
      moduleOrFile: (moduleOrFile || 'unknown').slice(0, 180),
      actionOrRoute: (actionOrRoute || 'unknown').slice(0, 180),
      errorName: (errorName || 'Error').slice(0, 120),
      errorMessage: errorMessage.slice(0, 1200),
      stackTrace,
      context,
      timestamp,
      ...(source ? { source } : {}),
      ...(sentryProject ? { sentryProject } : {}),
      ...(sentryLevel ? { sentryLevel } : {}),
      ...(sentryIssueUrl ? { sentryIssueUrl } : {}),
    },
  };
}

/**
 * Verifies Sentry's official `Sentry-Hook-Signature` header (HMAC-SHA256 hex digest
 * of the raw JSON body signed with the integration client secret) using Web Crypto.
 */
export async function verifySentryWebhookSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string
): Promise<boolean> {
  const sig = signatureHeader.trim().toLowerCase();
  const keyStr = secret.trim();
  if (!sig || !keyStr || !/^[0-9a-f]{64}$/.test(sig)) return false;

  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(keyStr),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
    const computed = Array.from(new Uint8Array(mac))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    if (computed.length !== sig.length) return false;
    let diff = 0;
    for (let i = 0; i < computed.length; i += 1) {
      diff |= computed.charCodeAt(i) ^ sig.charCodeAt(i);
    }
    return diff === 0;
  } catch {
    return false;
  }
}

function normalizeSentryProjectName(raw: string): string {
  const clean = raw.trim();
  if (!clean) return 'sentra-worker';
  const lower = clean.toLowerCase();
  if (lower.includes('client') || lower.includes('android') || lower.includes('windows') || lower.includes('tauri')) {
    return lower === 'sentra-client' ? 'sentra-client' : clean.slice(0, 64);
  }
  if (lower.includes('worker') || lower.includes('core')) {
    return lower === 'sentra-worker' ? 'sentra-worker' : clean.slice(0, 64);
  }
  return clean.slice(0, 64);
}

/**
 * Parses Sentry Webhook payloads (Internal Integration `issue`/`error`/`event_alert`
 * webhooks as well as Legacy Project Alert Webhooks) into a `UnifiedErrorReport`
 * tagged with `platform: 'sentry'` and `source: 'sentry'`.
 */
export function parseSentryWebhookPayload(raw: unknown):
  | { ok: true; report: UnifiedErrorReport }
  | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'بدنه وب‌هوک Sentry باید یک آبجکت JSON معتبر باشد.' };
  }

  const root = raw as Record<string, unknown>;
  const data =
    root.data && typeof root.data === 'object' && !Array.isArray(root.data)
      ? (root.data as Record<string, unknown>)
      : {};
  const issue =
    data.issue && typeof data.issue === 'object' && !Array.isArray(data.issue)
      ? (data.issue as Record<string, unknown>)
      : {};
  const eventObj =
    (data.event && typeof data.event === 'object' && !Array.isArray(data.event)
      ? (data.event as Record<string, unknown>)
      : data.error && typeof data.error === 'object' && !Array.isArray(data.error)
      ? (data.error as Record<string, unknown>)
      : root.event && typeof root.event === 'object' && !Array.isArray(root.event)
      ? (root.event as Record<string, unknown>)
      : {}) as Record<string, unknown>;

  const issueProject =
    issue.project && typeof issue.project === 'object'
      ? String((issue.project as Record<string, unknown>).slug || (issue.project as Record<string, unknown>).name || '')
      : '';
  const rawProject =
    issueProject ||
    String(root.project_slug || root.project || root.project_name || eventObj.project || '');
  const sentryProject = normalizeSentryProjectName(rawProject);

  const sentryLevel = String(
    eventObj.level || issue.level || root.level || 'error'
  )
    .trim()
    .toLowerCase()
    .slice(0, 24) || 'error';

  const rawIssueUrl =
    (typeof issue.permalink === 'string' && issue.permalink) ||
    (typeof eventObj.web_url === 'string' && eventObj.web_url) ||
    (typeof root.url === 'string' && root.url) ||
    (typeof data.web_url === 'string' && data.web_url) ||
    '';
  const sentryIssueUrl = sanitizeSafeHttpsUrl(rawIssueUrl) ?? undefined;

  // Extract exception type/value & stack frames if available
  const excContainer = eventObj.exception as { values?: Array<Record<string, unknown>> } | undefined;
  const firstExc =
    Array.isArray(excContainer?.values) && excContainer.values.length > 0
      ? excContainer.values[excContainer.values.length - 1]
      : undefined;

  const issueMeta =
    issue.metadata && typeof issue.metadata === 'object'
      ? (issue.metadata as Record<string, unknown>)
      : {};

  const errorName = String(
    firstExc?.type ||
      issueMeta.type ||
      root.action ||
      'SentryError'
  )
    .trim()
    .slice(0, 120);

  const errorMessage = String(
    firstExc?.value ||
      issueMeta.value ||
      issue.title ||
      eventObj.title ||
      eventObj.message ||
      root.message ||
      ''
  )
    .trim()
    .slice(0, 1200);

  if (!errorMessage) {
    return { ok: false, error: 'پیلود وب‌هوک Sentry فاقد متن خطا یا عنوان Issue است.' };
  }

  let stackTrace: string | undefined;
  const stackObj = firstExc?.stacktrace as { frames?: Array<Record<string, unknown>> } | undefined;
  if (Array.isArray(stackObj?.frames) && stackObj.frames.length > 0) {
    const formattedFrames = stackObj.frames
      .slice(-12)
      .reverse()
      .map((frame) => {
        const fn = String(frame.function || '<anonymous>');
        const file = String(frame.filename || frame.abs_path || 'unknown');
        const line = frame.lineno ? `:${frame.lineno}` : '';
        const col = frame.colno ? `:${frame.colno}` : '';
        return `  at ${fn} (${file}${line}${col})`;
      });
    stackTrace = formattedFrames.join('\n').slice(0, 3500);
  }

  const culprit = String(
    eventObj.culprit ||
      issue.culprit ||
      (Array.isArray(stackObj?.frames) && stackObj.frames.length > 0
        ? stackObj.frames[stackObj.frames.length - 1]?.filename || ''
        : '') ||
      sentryProject
  )
    .trim()
    .slice(0, 180);

  const actionOrRoute = String(
    (eventObj.request && typeof eventObj.request === 'object'
      ? (eventObj.request as Record<string, unknown>).url
      : '') ||
      root.action ||
      issue.shortId ||
      'sentry_webhook'
  )
    .trim()
    .slice(0, 180);

  const appVersion = String(
    eventObj.release ||
      issue.firstRelease ||
      (eventObj.tags && Array.isArray(eventObj.tags)
        ? (eventObj.tags as Array<[string, string]>).find((t) => t[0] === 'appVersion')?.[1]
        : '') ||
      'unknown'
  )
    .trim()
    .slice(0, 48);

  const timestamp =
    typeof eventObj.datetime === 'string' && eventObj.datetime.trim()
      ? eventObj.datetime.trim().slice(0, 64)
      : typeof issue.lastSeen === 'string' && issue.lastSeen.trim()
      ? issue.lastSeen.trim().slice(0, 64)
      : new Date().toISOString();

  const context: Record<string, unknown> = {
    source: 'sentry',
    sentry_project: sentryProject,
    sentry_level: sentryLevel,
    ...(sentryIssueUrl ? { sentry_issue_url: sentryIssueUrl } : {}),
    ...(issue.shortId ? { issue_id: String(issue.shortId) } : {}),
    ...(root.action ? { webhook_action: String(root.action) } : {}),
    ...(eventObj.environment ? { environment: String(eventObj.environment) } : {}),
  };

  return {
    ok: true,
    report: {
      platform: 'sentry',
      source: 'sentry',
      sentryProject,
      sentryLevel,
      sentryIssueUrl,
      appVersion,
      moduleOrFile: culprit || sentryProject,
      actionOrRoute,
      errorName: errorName || 'SentryError',
      errorMessage,
      stackTrace,
      context,
      timestamp,
    },
  };
}

export interface ParsedSentryDsn {
  publicKey: string;
  host: string;
  projectId: string;
  envelopeUrl: string;
}

/**
 * Parses a standard Sentry DSN (`https://<public_key>@<host>/<project_id>`)
 * into the direct Sentry Envelope API URL (`https://<host>/api/<project_id>/envelope/`).
 */
export function parseSentryDsn(dsn?: string): ParsedSentryDsn | null {
  const trimmed = (dsn || '').trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || !parsed.username || !parsed.host) {
    return null;
  }

  const segments = parsed.pathname.split('/').filter(Boolean);
  const projectId = segments[segments.length - 1] || '';
  if (!projectId || !/^\d+$/.test(projectId)) {
    return null;
  }

  const prefixPath = segments.length > 1 ? `/${segments.slice(0, -1).join('/')}` : '';
  return {
    publicKey: parsed.username,
    host: parsed.host,
    projectId,
    envelopeUrl: `${parsed.protocol}//${parsed.host}${prefixPath}/api/${projectId}/envelope/`,
  };
}

function sanitizeContextObject(
  context: Record<string, unknown> | undefined,
  extraSecrets: string[]
): Record<string, string> {
  if (!context || typeof context !== 'object') return {};
  const sensitiveKeyPattern =
    /(token|secret|password|authorization|cookie|private_key|api_key|salt|dsn)/i;
  const out: Record<string, string> = {};
  for (const [rawKey, rawVal] of Object.entries(context).slice(0, 16)) {
    const key = String(rawKey).replace(/[\r\n]/g, '').slice(0, 64);
    out[key] = sensitiveKeyPattern.test(key)
      ? REDACTED
      : sanitizeContextValue(rawVal, extraSecrets);
  }
  return out;
}

/**
 * Builds a lightweight Sentry Envelope payload (newline-delimited JSON) with all
 * secrets redacted — zero Sentry SDK bundle overhead.
 */
export function buildSentryEnvelope(
  dsn: ParsedSentryDsn,
  report: UnifiedErrorReport,
  extraSecrets: string[] = []
): string {
  const eventId = crypto.randomUUID().replace(/-/g, '');
  const nowIso = new Date().toISOString();
  const parsedTs = report.timestamp ? Date.parse(report.timestamp) : NaN;
  const timestampSec = Number.isFinite(parsedTs) ? parsedTs / 1000 : Date.now() / 1000;

  const errorName = sanitizeSecrets((report.errorName || 'Error').trim().slice(0, 120), extraSecrets);
  const errorMessage = sanitizeSecrets(
    (report.errorMessage || 'Unknown error').trim().slice(0, 1000),
    extraSecrets
  );
  const moduleOrFile = sanitizeSecrets(
    (report.moduleOrFile || 'unknown').trim().slice(0, 180),
    extraSecrets
  );
  const actionOrRoute = sanitizeSecrets(
    (report.actionOrRoute || 'unknown').trim().slice(0, 180),
    extraSecrets
  );
  const appVersion = sanitizeSecrets(
    (report.appVersion || 'worker-v1').trim().slice(0, 48),
    extraSecrets
  );
  const sanitizedStack = report.stackTrace
    ? sanitizeSecrets(report.stackTrace.trim(), extraSecrets).slice(0, 3000)
    : undefined;

  const sanitizedExtra = sanitizeContextObject(report.context, extraSecrets);
  if (sanitizedStack) {
    sanitizedExtra.stackTrace = sanitizedStack;
  }

  const envelopeHeader = {
    event_id: eventId,
    sent_at: nowIso,
    dsn: `https://${dsn.publicKey}@${dsn.host}/${dsn.projectId}`,
  };
  const itemHeader = { type: 'event' };
  const eventPayload = {
    event_id: eventId,
    timestamp: timestampSec,
    level: 'error',
    platform: 'javascript',
    release: `sentra-${report.platform}@${appVersion}`,
    logger: moduleOrFile,
    tags: {
      sentra_platform: report.platform,
      appVersion,
      moduleOrFile,
      actionOrRoute,
    },
    exception: {
      values: [
        {
          type: errorName,
          value: errorMessage,
        },
      ],
    },
    extra: sanitizedExtra,
  };

  return `${JSON.stringify(envelopeHeader)}\n${JSON.stringify(itemHeader)}\n${JSON.stringify(eventPayload)}`;
}

/**
 * Lightweight zero-dependency Sentry Envelope sender for Cloudflare Workers.
 * Parses `env.SENTRY_DSN_WORKER` and posts directly to Sentry's Envelope API.
 * Strictly wrapped in `try/catch` and silently no-ops when DSN is not configured.
 */
export async function sendToSentry(
  env: Env,
  payload: UnifiedErrorReport
): Promise<boolean> {
  try {
    const parsedDsn = parseSentryDsn(env.SENTRY_DSN_WORKER);
    if (!parsedDsn) return false;

    const secrets = collectEnvSecrets(env);
    const envelopeBody = buildSentryEnvelope(parsedDsn, payload, secrets);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    let resp: Response;
    try {
      resp = await fetch(parsedDsn.envelopeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-sentry-envelope',
          'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${parsedDsn.publicKey}, sentry_client=sentra-worker/1.0`,
        },
        body: envelopeBody,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      console.warn('[Sentra Sentry Envelope HTTP Error]', resp.status);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(
      '[Sentra Sentry Fallback]',
      err instanceof Error ? err.message : String(err)
    );
    return false;
  }
}

/**
 * Central sender: dispatches any UnifiedErrorReport in parallel (`Promise.allSettled`)
 * to Telegram `topic_logs_id`, Sentry Envelope API, and Turso `telemetry_logs`.
 * Sanitizes all secrets before dispatch, never throws, and never recurses.
 */
export async function reportUnifiedError(
  env: Env,
  report: UnifiedErrorReport
): Promise<boolean> {
  try {
    const secrets = collectEnvSecrets(env);
    const htmlMessage = formatAiReadyErrorMessage(report, secrets);

    const sanitizedDetails = {
      appVersion: sanitizeSecrets((report.appVersion || 'unknown').slice(0, 48), secrets),
      moduleOrFile: sanitizeSecrets((report.moduleOrFile || 'unknown').slice(0, 180), secrets),
      actionOrRoute: sanitizeSecrets((report.actionOrRoute || 'unknown').slice(0, 180), secrets),
      errorName: sanitizeSecrets((report.errorName || 'Error').slice(0, 120), secrets),
      errorMessage: sanitizeSecrets((report.errorMessage || 'Unknown error').slice(0, 800), secrets),
      context: sanitizeContextObject(report.context, secrets),
      timestamp: report.timestamp || new Date().toISOString(),
    };

    const sentryOrigin = isSentryErrorReport(report);
    const [tgOutcome] = await Promise.allSettled([
      sendToTopic(env, 'logs', htmlMessage),
      // Prevent Sentry -> Worker -> Sentry feedback loop for events already coming from Sentry
      sentryOrigin ? Promise.resolve(false) : sendToSentry(env, report),
      logTelemetryToTurso(env, {
        platform: report.platform,
        eventType: sentryOrigin ? 'sentry_error_report' : 'error_report',
        details: sanitizedDetails,
      }),
    ]);

    return tgOutcome.status === 'fulfilled' ? tgOutcome.value : false;
  } catch (err) {
    console.error('[Sentra reportUnifiedError Fatal]', report.platform, report.moduleOrFile, err);
    return false;
  }
}

export const reportErrorToTelegram = reportUnifiedError;

/**
 * Dispatches a UnifiedErrorReport using `ctx.waitUntil` when available so user
 * responses are not blocked while still guaranteeing delivery.
 */
export async function dispatchUnifiedError(
  env: Env,
  ctx: ExecutionContext | undefined,
  report: UnifiedErrorReport
): Promise<void> {
  const promise = reportUnifiedError(env, report).then(() => undefined);
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(promise);
    return;
  }
  await promise;
}

/**
 * Convenience helper for Cloudflare Worker internal errors (`platform: 'worker'`).
 */
export async function reportWorkerError(
  env: Env,
  ctx: ExecutionContext | undefined,
  params: {
    moduleOrFile: string;
    actionOrRoute: string;
    error: unknown;
    context?: Record<string, unknown>;
  }
): Promise<void> {
  const normalized = normalizeUnknownError(params.error);
  await dispatchUnifiedError(env, ctx, {
    platform: 'worker',
    appVersion: 'worker-v1',
    moduleOrFile: params.moduleOrFile,
    actionOrRoute: params.actionOrRoute,
    errorName: normalized.errorName,
    errorMessage: normalized.errorMessage,
    stackTrace: normalized.stackTrace,
    context: params.context,
    timestamp: new Date().toISOString(),
  });
}
