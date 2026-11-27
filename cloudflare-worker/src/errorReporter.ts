import {
  escapeTelegramHtml,
  sendToTopic,
} from './telegramTopics.ts';
import { logTelemetryToTurso } from './tursoClient.ts';
import type { Env } from './types.ts';

export type ErrorPlatform = 'worker' | 'github-actions' | 'android' | 'windows';

export const ALLOWED_ERROR_PLATFORMS: readonly ErrorPlatform[] = [
  'worker',
  'github-actions',
  'android',
  'windows',
] as const;

export const ALLOWED_INGEST_PLATFORMS: readonly Exclude<ErrorPlatform, 'worker'>[] = [
  'github-actions',
  'android',
  'windows',
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
  android: { emoji: '🤖', label: 'Android Client' },
  windows: { emoji: '🪟', label: 'Windows Client' },
};

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
  const contextText = formatContextBlock(report.context, secrets);

  const rawStack = report.stackTrace
    ? sanitizeSecrets(report.stackTrace.trim(), secrets)
    : '';

  const headerHtml =
    `🚨 <b>گزارش خطای SentraVPN</b> | ${meta.emoji} <code>${escapeTelegramHtml(report.platform)}</code>\n` +
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
    platformRaw !== 'android' &&
    platformRaw !== 'windows'
  ) {
    return {
      ok: false,
      error: 'مقدار platform نامعتبر است. مقادیر مجاز: github-actions, android, windows.',
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

    const [tgOutcome] = await Promise.allSettled([
      sendToTopic(env, 'logs', htmlMessage),
      sendToSentry(env, report),
      logTelemetryToTurso(env, {
        platform: report.platform,
        eventType: 'error_report',
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
