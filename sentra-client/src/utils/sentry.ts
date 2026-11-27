import * as Sentry from '@sentry/react';
import { APP_VERSION } from './proxyParser';

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY_RE =
  /(token|secret|password|authorization|cookie|private_key|api_key|salt|subscription)/i;

let sentryInitialized = false;

function sanitizeSentryString(input: string): string {
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

function detectPlatformTag(): 'android' | 'windows' {
  const ua =
    typeof navigator !== 'undefined' && navigator.userAgent
      ? navigator.userAgent.toLowerCase()
      : '';
  return ua.includes('android') ? 'android' : 'windows';
}

export function resolveClientSentryDsn(): string {
  try {
    const env =
      typeof import.meta !== 'undefined' && import.meta.env
        ? (import.meta.env as Record<string, string | undefined>)
        : {};
    const dsn = (env.SENTRY_DSN_CLIENT || env.VITE_SENTRY_DSN_CLIENT || '').trim();
    return dsn;
  } catch {
    return '';
  }
}

export function sanitizeSentryRecord(
  input?: Record<string, unknown>
): Record<string, unknown> {
  if (!input || typeof input !== 'object') return {};
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (SENSITIVE_KEY_RE.test(k)) {
      clean[k] = REDACTED;
      continue;
    }
    if (typeof v === 'string') {
      clean[k] = sanitizeSentryString(v).slice(0, 500);
    } else if (typeof v === 'number' || typeof v === 'boolean' || v === null) {
      clean[k] = v;
    } else if (v !== undefined) {
      try {
        clean[k] = sanitizeSentryString(JSON.stringify(v)).slice(0, 500);
      } catch {
        clean[k] = '[Unserializable]';
      }
    }
  }
  return clean;
}

/**
 * Initializes the official `@sentry/react` SDK when `SENTRY_DSN_CLIENT` is
 * configured at build time. Silently stays disabled if empty or unavailable.
 */
export function initClientSentry(overrideDsn?: string): boolean {
  if (sentryInitialized) return true;
  try {
    const dsn = (overrideDsn ?? resolveClientSentryDsn()).trim();
    if (!dsn) return false;

    const platform = detectPlatformTag();
    const isProd =
      typeof import.meta !== 'undefined' &&
      Boolean((import.meta.env as Record<string, unknown> | undefined)?.PROD);

    Sentry.init({
      dsn,
      release: `sentra-client@${APP_VERSION}`,
      environment: isProd ? 'production' : 'development',
      tracesSampleRate: 0,
      beforeSend(event) {
        try {
          if (event.request) {
            if (event.request.headers) {
              const safeHeaders: Record<string, string> = {};
              for (const [hk, hv] of Object.entries(event.request.headers)) {
                safeHeaders[hk] = SENSITIVE_KEY_RE.test(hk)
                  ? REDACTED
                  : sanitizeSentryString(String(hv));
              }
              event.request.headers = safeHeaders;
            }
            if (typeof event.request.url === 'string') {
              event.request.url = sanitizeSentryString(event.request.url);
            }
            delete event.request.cookies;
          }

          if (event.message) {
            event.message = sanitizeSentryString(event.message);
          }

          if (event.exception?.values) {
            for (const ex of event.exception.values) {
              if (ex.value) {
                ex.value = sanitizeSentryString(ex.value);
              }
            }
          }

          if (event.extra) {
            event.extra = sanitizeSentryRecord(event.extra as Record<string, unknown>);
          }

          if (event.user) {
            delete event.user.email;
            delete event.user.ip_address;
          }
        } catch {
          // Never drop or crash during scrubbing
        }
        return event;
      },
    });

    Sentry.setTag('platform', platform);
    Sentry.setTag('appVersion', APP_VERSION);
    sentryInitialized = true;
    return true;
  } catch {
    return false;
  }
}

export function isClientSentryEnabled(): boolean {
  return sentryInitialized;
}

/**
 * Reports a sanitized client exception (UI crash, sing-box error, or network failure)
 * to Sentry with `platform` and `appVersion` tags and zero subscription tokens.
 */
export function captureClientSentryException(params: {
  platform: 'android' | 'windows';
  appVersion: string;
  moduleOrFile: string;
  actionOrRoute: string;
  errorName: string;
  errorMessage: string;
  stackTrace?: string;
  context?: Record<string, unknown>;
}): void {
  if (!sentryInitialized) return;
  try {
    const err = new Error(sanitizeSentryString(params.errorMessage));
    err.name = sanitizeSentryString(params.errorName || 'ClientError');
    if (params.stackTrace) {
      err.stack = sanitizeSentryString(params.stackTrace);
    }

    Sentry.withScope((scope) => {
      scope.setTag('platform', params.platform);
      scope.setTag('appVersion', params.appVersion);
      scope.setTag('moduleOrFile', params.moduleOrFile.slice(0, 120));
      scope.setTag('actionOrRoute', params.actionOrRoute.slice(0, 120));
      scope.setExtras(sanitizeSentryRecord(params.context));
      Sentry.captureException(err);
    });
  } catch {
    // Never disrupt client flow if Sentry fails
  }
}
