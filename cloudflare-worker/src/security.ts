const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const DERIVED_BITS = 256;

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

export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(new ArrayBuffer(SALT_BYTES));
  crypto.getRandomValues(salt);
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    DERIVED_BITS
  );
  return `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${toHex(salt)}$${toHex(new Uint8Array(derived))}`;
}

export async function verifyPassword(password: string, storedHash: string | null): Promise<boolean> {
  if (!storedHash || !password) return false;
  const parts = storedHash.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') {
    return false;
  }
  const iterations = Number(parts[1]);
  const salt = fromHex(parts[2]);
  const expected = fromHex(parts[3]);
  if (!Number.isFinite(iterations) || iterations < 10_000 || !salt || !expected) {
    return false;
  }

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derived = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt,
        iterations,
        hash: 'SHA-256',
      },
      keyMaterial,
      expected.length * 8
    )
  );

  if (derived.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < derived.length; i += 1) {
    diff |= derived[i] ^ expected[i];
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

/**
 * Anti-SSRF validator: blocks loopback, private RFC1918, link-local / cloud metadata,
 * IPv6 local ranges, and internal DNS suffixes.
 */
export function isBlockedHost(rawHost: string): boolean {
  const host = rawHost.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;

  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.home.arpa') ||
    host === 'metadata.google.internal' ||
    host === 'metadata'
  ) {
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
    if (a >= 224) return true; // Multicast & reserved
    return false;
  }

  // IPv6 ULA (fc00::/7) and link-local (fe80::/10)
  if (host.includes(':')) {
    if (
      host.startsWith('fc') ||
      host.startsWith('fd') ||
      host.startsWith('fe8') ||
      host.startsWith('fe9') ||
      host.startsWith('fea') ||
      host.startsWith('feb') ||
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
