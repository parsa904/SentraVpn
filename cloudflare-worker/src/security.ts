import { hashPassword, verifyPassword } from './auth.ts';

export { hashPassword, verifyPassword };

const encoder = new TextEncoder();

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex: string): Uint8Array<ArrayBuffer> | null {
  const clean = hex.trim();
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) {
    return null;
  }
  const out = new Uint8Array(new ArrayBuffer(clean.length / 2));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return toHex(new Uint8Array(digest));
}

/**
 * Constant-time string equality check using SHA-256 normalization to prevent
 * length and byte-index timing side channels on shared secrets.
 */
export async function constantTimeEquals(a: string, b: string): Promise<boolean> {
  if (!a || !b) return false;
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  const ba = new Uint8Array(da);
  const bb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < ba.length; i += 1) {
    diff |= ba[i] ^ bb[i];
  }
  return diff === 0;
}

export function generateSubscriptionToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `sentra_${toHex(bytes)}`;
}

export function generateNumericCode(digits: number): string {
  const bytes = new Uint8Array(digits);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < digits; i += 1) {
    out += String(bytes[i] % 10);
  }
  return out;
}

export function extractAuthToken(request: Request, bodyToken?: unknown): string | null {
  const subHeader = request.headers.get('X-Subscription-Token')?.trim();
  if (subHeader) return subHeader.replace(/^jwt_sentra_/, '');

  const authHeader = request.headers.get('Authorization')?.trim();
  if (authHeader) {
    const bearer = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (bearer) return bearer.replace(/^jwt_sentra_/, '');
  }

  if (typeof bodyToken === 'string' && bodyToken.trim()) {
    return bodyToken.trim().replace(/^jwt_sentra_/, '');
  }

  return null;
}

export function extractBearerOrHeaderSecret(request: Request, customHeader: string): string | null {
  const custom = request.headers.get(customHeader)?.trim();
  if (custom) return custom;

  const authHeader = request.headers.get('Authorization')?.trim();
  if (authHeader && /^Bearer\s+/i.test(authHeader)) {
    return authHeader.replace(/^Bearer\s+/i, '').trim();
  }
  return null;
}

export const MAX_USER_SUBLINK_LENGTH = 512;

/**
 * Anti-SSRF validator: blocks loopback, private RFC1918, link-local / cloud metadata,
 * IPv6 local ranges, obfuscated numeric IPs, Cloudflare internal domains, and internal DNS suffixes.
 */
export function isBlockedHost(rawHost: string): boolean {
  const host = rawHost.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return true;

  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::' ||
    host === '::1' ||
    host === '1.1.1.1' ||
    host === '1.0.0.1' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.arpa') ||
    host.endsWith('.lan') ||
    host.endsWith('.localdomain') ||
    host === 'metadata.google.internal' ||
    host === 'metadata' ||
    host === 'cloudflare.com' ||
    host.endsWith('.cloudflare.com') ||
    host.endsWith('.workers.dev') ||
    host.endsWith('.pages.dev') ||
    host.endsWith('.cfargotunnel.com') ||
    host.endsWith('.cloudflareclient.com')
  ) {
    return true;
  }

  // Reject purely numeric (decimal/hex/octal) obfuscated IP hosts e.g. 2130706433 or 0x7f000001
  if (/^(0x[0-9a-f]+|0[0-7]+|\d+)$/i.test(host)) {
    return true;
  }

  // IPv4-mapped IPv6 e.g. ::ffff:127.0.0.1
  const mappedMatch = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
  const candidateIpv4 = mappedMatch ? mappedMatch[1] : host;

  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(candidateIpv4);
  if (ipv4Match) {
    const [a, b, c, d] = ipv4Match.slice(1).map((n) => Number(n));
    if ([a, b, c, d].some((octet) => octet < 0 || octet > 255)) return true;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // Link-local / AWS/GCP/Azure metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a === 198 && (b === 18 || b === 19)) return true; // Benchmarking RFC 2544
    if (a >= 224) return true; // Multicast & reserved
    return false;
  }

  // IPv6 ULA (fc00::/7), link-local (fe80::/10), unspecified/loopback, and mapped addresses
  if (host.includes(':')) {
    if (
      host === '::' ||
      host === '::1' ||
      /^0*:0*:0*:0*:0*:0*:0*:[01]$/.test(host) ||
      host.startsWith('fc') ||
      host.startsWith('fd') ||
      host.startsWith('fe8') ||
      host.startsWith('fe9') ||
      host.startsWith('fea') ||
      host.startsWith('feb') ||
      host.startsWith('ff') ||
      host.startsWith('::ffff:')
    ) {
      return true;
    }
  }

  return false;
}

export function validateExternalHttpsUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error('آدرس URL نامعتبر است.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('فقط پروتکل‌های http و https مجاز هستند.');
  }
  if (isBlockedHost(parsed.hostname)) {
    throw new Error('دسترسی به آدرس‌های محلی یا شبکه داخلی مجاز نیست.');
  }
  return parsed;
}

/**
 * Strict validation for community-submitted subscription URLs:
 * - Max 512 characters
 * - Strictly `https://` only (blocks http, file, ftp, javascript, data, etc.)
 * - No embedded credentials (user:pass@host)
 * - Full private/loopback/metadata/Cloudflare internal host blocklist
 */
export function validateUserSubmittedSublink(rawUrl: string): URL {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error('لینک سابلینک نمی‌تواند خالی باشد.');
  }
  if (trimmed.length > MAX_USER_SUBLINK_LENGTH) {
    throw new Error(`طول لینک سابلینک نباید بیشتر از ${MAX_USER_SUBLINK_LENGTH} کاراکتر باشد.`);
  }
  if (/\s/.test(trimmed)) {
    throw new Error('لینک سابلینک نباید شامل فاصله یا چند خط باشد.');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('فرمت لینک سابلینک نامعتبر است.');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('فقط لینک‌های امن با پروتکل https:// مجاز هستند.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('استفاده از نام کاربری یا رمز عبور داخل لینک مجاز نیست.');
  }
  if (!parsed.hostname || !parsed.hostname.includes('.')) {
    throw new Error('دامنه لینک سابلینک معتبر نیست.');
  }
  if (isBlockedHost(parsed.hostname)) {
    throw new Error('ارسال آدرس‌های محلی، داخلی یا دامنه‌های کلودفلر مجاز نیست.');
  }

  return parsed;
}

const BLOCKED_THIRD_PARTY_UA_PATTERN =
  /(v2rayn|v2rayng|nekobox|nekoray|clash|shadowrocket|streisand|hiddify|sing-box|karing|v2box|foxray|loon|surge|quantumult|stash|curl\/|wget\/|python-requests|go-http-client)/i;

const GENERIC_BROWSER_UA_PATTERN = /(mozilla\/|chrome\/|safari\/|firefox\/|edg\/|opera\/)/i;

/**
 * Validates that a client config/connect request originates from the official SentraVPN client.
 * Requires a non-empty `X-Sentra-Client` header and rejects third-party V2Ray/Clash clients
 * and raw browser requests lacking the Sentra client header.
 */
export function validateSentraClientRequest(request: Request): {
  ok: boolean;
  reason?: string;
  clientHeader?: string;
} {
  const clientHeader = (request.headers.get('X-Sentra-Client') || '').trim();
  const userAgent = (request.headers.get('User-Agent') || '').trim();

  if (BLOCKED_THIRD_PARTY_UA_PATTERN.test(userAgent)) {
    return {
      ok: false,
      reason: 'دسترسی از طریق کلاینت‌های شخص ثالث (V2Ray/Clash) مسدود است. لطفاً از اپلیکیشن رسمی SentraVPN استفاده کنید.',
    };
  }

  if (!clientHeader || !/^sentra(?:vpn|-client)?\/[0-9a-zA-Z._-]+$/i.test(clientHeader)) {
    if (GENERIC_BROWSER_UA_PATTERN.test(userAgent)) {
      return {
        ok: false,
        reason: 'دسترسی مستقیم از مرورگر مجاز نیست. لطفاً کد اتصال ۸ رقمی خود را در اپلیکیشن رسمی SentraVPN وارد کنید.',
      };
    }
    return {
      ok: false,
      reason: 'هدر احراز هویت کلاینت رسمی SentraVPN (X-Sentra-Client) ارسال نشده یا نامعتبر است.',
    };
  }

  return { ok: true, clientHeader };
}

export function isValidEightDigitConnectCode(raw: string | null | undefined): boolean {
  if (!raw) return false;
  return /^\d{8}$/.test(raw.trim());
}

/**
 * Generates an 8-digit permanent connect code (10000000–99999999) and verifies
 * uniqueness against `subscriptions.connect_code` using the unique index.
 */
export async function generateUniqueConnectCode(db: D1Database): Promise<string> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    const firstDigit = String(1 + (bytes[0] % 9));
    let rest = '';
    for (let i = 1; i < 8; i += 1) {
      rest += String(bytes[i] % 10);
    }
    const candidate = `${firstDigit}${rest}`;
    const existing = await db
      .prepare('SELECT id FROM subscriptions WHERE connect_code = ? LIMIT 1')
      .bind(candidate)
      .first<{ id: number }>();
    if (!existing) {
      return candidate;
    }
  }
  throw new Error('تولید کد اتصال ۸ رقمی یکتا ناموفق بود.');
}
