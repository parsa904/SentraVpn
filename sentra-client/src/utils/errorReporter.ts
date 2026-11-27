import { API_BASE_URL, SESSION_STORAGE_KEY } from '../constants';
import { APP_VERSION } from './proxyParser';
import { captureClientSentryException } from './sentry';

export type ClientErrorPlatform = 'android' | 'windows';

export interface ClientErrorReportPayload {
  platform: ClientErrorPlatform;
  appVersion: string;
  moduleOrFile: string;
  actionOrRoute: string;
  errorName: string;
  errorMessage: string;
  stackTrace?: string;
  context?: Record<string, unknown>;
  timestamp: string;
}

export interface ReportClientErrorInput {
  moduleOrFile: string;
  actionOrRoute: string;
  error: unknown;
  context?: Record<string, unknown>;
  subscriptionToken?: string | null;
}

const REDACTED = '[REDACTED]';
const DEDUP_WINDOW_MS = 60_000;
const MAX_REPORTS_PER_MIN = 5;

const sentFingerprints = new Map<string, number>();
let recentReportTimestamps: number[] = [];
let globalHandlersInstalled = false;

/**
 * Classifies the client runtime into the unified error platform enum
 * (`android` vs `windows`) for Telegram error triage.
 */
export function detectClientPlatform(userAgent?: string): ClientErrorPlatform {
  const ua =
    (userAgent ?? (typeof navigator !== 'undefined' ? navigator.userAgent : ''))
      .toLowerCase();
  if (ua.includes('android')) {
    return 'android';
  }
  return 'windows';
}

/**
 * Defense-in-depth client-side secret sanitizer so tokens and credentials are
 * stripped before leaving the user's device.
 */
export function sanitizeClientSecrets(input: string): string {
  if (!input) return '';
  return input
    .replace(/\bbot\d{6,14}:[A-Za-z0-9_-]{20,}\b/g, `bot${REDACTED}`)
    .replace(/\b\d{6,14}:[A-Za-z0-9_-]{20,}\b/g, REDACTED)
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s"',;\r\n]+/gi, `$1${REDACTED}`)
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED}`)
    .replace(/(\/(?:api\/v1\/)?sub\/)([^/?#\s"'<>]+)/gi, `$1${REDACTED}`)
    .replace(
      /([?&](?:token|secret|api_key|password|auth|subscription_token)=)([^&\s"'<>]+)/gi,
      `$1${REDACTED}`
    )
    .replace(
      /(\b(?:vless|trojan|hysteria2|hy2|tuic|ss):\/\/)([^@\s/]+)(@)/gi,
      `$1${REDACTED}$3`
    );
}

function readStoredSubscriptionToken(): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { subscription_token?: string };
    return typeof parsed.subscription_token === 'string' && parsed.subscription_token.trim()
      ? parsed.subscription_token.trim()
      : null;
  } catch {
    return null;
  }
}

function normalizeClientError(error: unknown): {
  errorName: string;
  errorMessage: string;
  stackTrace?: string;
} {
  if (error instanceof Error) {
    return {
      errorName: error.name || 'Error',
      errorMessage: error.message || String(error),
      stackTrace: error.stack,
    };
  }
  if (typeof error === 'string') {
    return {
      errorName: 'ClientError',
      errorMessage: error,
    };
  }
  try {
    return {
      errorName: 'ClientError',
      errorMessage: JSON.stringify(error),
    };
  } catch {
    return {
      errorName: 'ClientError',
      errorMessage: String(error),
    };
  }
}

export function resetClientErrorReporterForTests(): void {
  sentFingerprints.clear();
  recentReportTimestamps = [];
  globalHandlersInstalled = false;
}

/**
 * Builds a sanitized UnifiedErrorReport payload for Android/Windows clients.
 */
export function buildClientErrorPayload(
  input: ReportClientErrorInput
): ClientErrorReportPayload {
  const normalized = normalizeClientError(input.error);
  const platform = detectClientPlatform();
  const isTauri =
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);

  const sanitizedContext: Record<string, unknown> = {
    is_tauri: isTauri,
    online: typeof navigator !== 'undefined' ? navigator.onLine : true,
    os_ua:
      typeof navigator !== 'undefined'
        ? sanitizeClientSecrets(navigator.userAgent).slice(0, 140)
        : 'unknown',
    ...(input.context || {}),
  };

  return {
    platform,
    appVersion: APP_VERSION,
    moduleOrFile: sanitizeClientSecrets(input.moduleOrFile || 'sentra-client').slice(0, 180),
    actionOrRoute: sanitizeClientSecrets(input.actionOrRoute || 'unknown').slice(0, 180),
    errorName: sanitizeClientSecrets(normalized.errorName).slice(0, 120),
    errorMessage: sanitizeClientSecrets(normalized.errorMessage).slice(0, 1000),
    stackTrace: normalized.stackTrace
      ? sanitizeClientSecrets(normalized.stackTrace).slice(0, 3000)
      : undefined,
    context: sanitizedContext,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Sends a sanitized client error report to `POST /api/v1/telemetry/error`
 * without blocking the UI. Deduplicates repeated errors and never throws.
 */
export async function reportClientError(
  input: ReportClientErrorInput
): Promise<boolean> {
  try {
    const payload = buildClientErrorPayload(input);

    // Prevent feedback loops if the telemetry endpoint itself fails
    if (
      payload.actionOrRoute.includes('/api/v1/telemetry/error') ||
      payload.actionOrRoute.includes('/api/v1/errors/report') ||
      payload.errorMessage.includes('/api/v1/telemetry/error')
    ) {
      return false;
    }

    const now = Date.now();
    recentReportTimestamps = recentReportTimestamps.filter(
      (ts) => now - ts <= DEDUP_WINDOW_MS
    );
    if (recentReportTimestamps.length >= MAX_REPORTS_PER_MIN) {
      return false;
    }

    const fingerprint = `${payload.platform}|${payload.moduleOrFile}|${payload.errorName}|${payload.errorMessage.slice(0, 120)}`;
    const prev = sentFingerprints.get(fingerprint);
    if (prev !== undefined && now - prev < DEDUP_WINDOW_MS) {
      return false;
    }
    sentFingerprints.set(fingerprint, now);
    recentReportTimestamps.push(now);

    // Report sanitized exception to Sentry in parallel (no subscription token included)
    captureClientSentryException({
      platform: payload.platform,
      appVersion: payload.appVersion,
      moduleOrFile: payload.moduleOrFile,
      actionOrRoute: payload.actionOrRoute,
      errorName: payload.errorName,
      errorMessage: payload.errorMessage,
      stackTrace: payload.stackTrace,
      context: payload.context,
    });

    const endpoint = `${API_BASE_URL.replace(/\/+$/, '')}/api/v1/telemetry/error`;
    const subToken = input.subscriptionToken ?? readStoredSubscriptionToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-App-Version': APP_VERSION,
    };
    if (subToken) {
      headers['X-Subscription-Token'] = subToken;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
        keepalive: true,
      });
      return resp.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/**
 * Installs global `window.error` and `unhandledrejection` listeners once per session.
 */
export function installGlobalErrorHandlers(): void {
  if (globalHandlersInstalled || typeof window === 'undefined') return;
  globalHandlersInstalled = true;

  window.addEventListener('error', (event: ErrorEvent) => {
    const err = event.error || new Error(event.message || 'Uncaught window error');
    void reportClientError({
      moduleOrFile: event.filename || 'window.onerror',
      actionOrRoute: 'global_uncaught_error',
      error: err,
      context: {
        lineno: event.lineno,
        colno: event.colno,
      },
    });
  });

  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    void reportClientError({
      moduleOrFile: 'window.unhandledrejection',
      actionOrRoute: 'unhandled_promise_rejection',
      error: event.reason ?? 'Unhandled promise rejection',
    });
  });
}
