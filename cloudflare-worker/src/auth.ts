/**
 * Lightweight Unified Authentication & Rate-Limiting Module for SentraVPN.
 *
 * Designed specifically for Cloudflare Workers Free Tier (<10ms CPU budget, zero npm deps):
 * - Password hashing uses native Web Crypto API (`crypto.subtle`) with 16-byte random Salt
 *   and PBKDF2-SHA256 at 15,000 iterations (~2-4ms CPU on Workers).
 * - Verification supports stored hashes with 10,000..200,000 iterations for full backwards
 *   compatibility with previously created accounts.
 * - Per-IP sliding-window failure limiter blocks brute-force bursts (max 5 failed attempts/min/IP).
 */

export const AUTH_PBKDF2_ITERATIONS = 15_000;
const AUTH_MIN_ITERATIONS = 10_000;
const AUTH_MAX_ITERATIONS = 200_000;
const SALT_BYTES = 16;
const DERIVED_BITS = 256;

export const MAX_FAILED_AUTH_ATTEMPTS_PER_MIN = 5;
export const AUTH_RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_TRACKED_AUTH_IPS = 2_000;

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> | null {
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

/**
 * Hashes a password with a fresh 16-byte cryptographic salt and PBKDF2-SHA256 (15,000 iterations).
 */
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
      iterations: AUTH_PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    DERIVED_BITS
  );
  return `pbkdf2_sha256$${AUTH_PBKDF2_ITERATIONS}$${toHex(salt)}$${toHex(new Uint8Array(derived))}`;
}

/**
 * Constant-time password verification against a stored `pbkdf2_sha256$<iter>$<salt>$<hash>` string.
 */
export async function verifyPassword(
  password: string,
  storedHash: string | null | undefined
): Promise<boolean> {
  if (!storedHash || !password) return false;
  const parts = storedHash.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') {
    return false;
  }
  const iterations = Number(parts[1]);
  const salt = fromHex(parts[2]);
  const expected = fromHex(parts[3]);
  if (
    !Number.isFinite(iterations) ||
    iterations < AUTH_MIN_ITERATIONS ||
    iterations > AUTH_MAX_ITERATIONS ||
    !salt ||
    salt.length < 8 ||
    !expected ||
    expected.length < 16
  ) {
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

/**
 * Validates and normalizes a unified username:
 * 3–24 chars, lowercase English letters, digits, and underscore (`[a-z0-9_]`).
 */
export function validateUnifiedUsername(
  raw: unknown
): { ok: true; username: string } | { ok: false; error: string } {
  const normalized = String(raw ?? '')
    .trim()
    .replace(/^@/, '')
    .toLowerCase();

  if (normalized.length < 3 || normalized.length > 24) {
    return {
      ok: false,
      error: 'نام کاربری باید بین ۳ تا ۲۴ کاراکتر باشد.',
    };
  }
  if (!/^[a-z0-9_]+$/.test(normalized)) {
    return {
      ok: false,
      error: 'نام کاربری فقط می‌تواند شامل حروف کوچک انگلیسی، اعداد و زیرخط (_) باشد.',
    };
  }
  return { ok: true, username: normalized };
}

/**
 * Validates a unified password (min 6 chars, max 128 chars).
 */
export function validateUnifiedPassword(
  raw: unknown
): { ok: true; password: string } | { ok: false; error: string } {
  const password = typeof raw === 'string' ? raw : '';
  if (password.length < 6) {
    return {
      ok: false,
      error: 'رمز عبور باید حداقل ۶ کاراکتر باشد.',
    };
  }
  if (password.length > 128) {
    return {
      ok: false,
      error: 'طول رمز عبور نباید بیشتر از ۱۲۸ کاراکتر باشد.',
    };
  }
  return { ok: true, password };
}

/**
 * Validates an optional email field. Empty/blank values return `{ ok: true, email: null }`.
 */
export function validateOptionalEmail(
  raw: unknown
): { ok: true; email: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) {
    return { ok: true, email: null };
  }
  const trimmed = String(raw).trim().toLowerCase();
  if (!trimmed) {
    return { ok: true, email: null };
  }
  if (trimmed.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmed)) {
    return {
      ok: false,
      error: 'فرمت ایمیل واردشده معتبر نیست.',
    };
  }
  return { ok: true, email: trimmed };
}

/**
 * Normalizes a login identifier (username or email, stripping a leading `@` for usernames).
 */
export function normalizeLoginIdentifier(raw: unknown): string {
  const trimmed = String(raw ?? '').trim().toLowerCase();
  if (trimmed.startsWith('@') && !trimmed.slice(1).includes('@')) {
    return trimmed.slice(1);
  }
  return trimmed;
}

// ============================================================================
// Per-IP Sliding-Window Brute-Force Protection (Max 5 Failed Attempts / Min)
// ============================================================================

const failedAuthAttemptsByIp = new Map<string, number[]>();

function pruneWindow(timestamps: number[], now: number): number[] {
  const cutoff = now - AUTH_RATE_LIMIT_WINDOW_MS;
  return timestamps.filter((ts) => ts > cutoff);
}

export function checkAuthFailureRateLimit(
  ip: string,
  now = Date.now()
): { allowed: boolean; retryAfterSec: number; failedCount: number } {
  const key = (ip || 'unknown').trim() || 'unknown';
  const existing = failedAuthAttemptsByIp.get(key);
  if (!existing || existing.length === 0) {
    return { allowed: true, retryAfterSec: 0, failedCount: 0 };
  }

  const active = pruneWindow(existing, now);
  if (active.length === 0) {
    failedAuthAttemptsByIp.delete(key);
    return { allowed: true, retryAfterSec: 0, failedCount: 0 };
  }
  failedAuthAttemptsByIp.set(key, active);

  if (active.length >= MAX_FAILED_AUTH_ATTEMPTS_PER_MIN) {
    const oldest = active[0];
    const retryAfterSec = Math.max(1, Math.ceil((oldest + AUTH_RATE_LIMIT_WINDOW_MS - now) / 1000));
    return { allowed: false, retryAfterSec, failedCount: active.length };
  }

  return { allowed: true, retryAfterSec: 0, failedCount: active.length };
}

export function recordAuthFailure(ip: string, now = Date.now()): number {
  const key = (ip || 'unknown').trim() || 'unknown';
  if (failedAuthAttemptsByIp.size >= MAX_TRACKED_AUTH_IPS && !failedAuthAttemptsByIp.has(key)) {
    // Evict oldest entry to keep isolate memory bounded
    const firstKey = failedAuthAttemptsByIp.keys().next().value;
    if (firstKey !== undefined) {
      failedAuthAttemptsByIp.delete(firstKey);
    }
  }
  const active = pruneWindow(failedAuthAttemptsByIp.get(key) || [], now);
  active.push(now);
  failedAuthAttemptsByIp.set(key, active);
  return active.length;
}

export function clearAuthFailures(ip: string): void {
  const key = (ip || 'unknown').trim() || 'unknown';
  failedAuthAttemptsByIp.delete(key);
}

export function resetAuthRateLimitsForTests(): void {
  failedAuthAttemptsByIp.clear();
}
