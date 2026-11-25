import type { PersonalConfigItem } from '../types/sentra';

export interface ParsedProxyInput {
  protocol: string;
  name: string;
  server_address: string;
  server_port: number;
  country_code: string;
  flag: string;
  is_subscription: boolean;
  uri: string;
}

const SUPPORTED_PROXY_SCHEMES = [
  'vless://',
  'vmess://',
  'trojan://',
  'ss://',
  'hy2://',
  'hysteria2://',
  'tuic://',
  'wireguard://',
  'wg://',
] as const;

const COUNTRY_HINTS: Array<{ regex: RegExp; code: string; flag: string }> = [
  { regex: /\b(de|germany|frankfurt|falkenstein|nuremberg|berlin|hetzner)\b/i, code: 'DE', flag: '🇩🇪' },
  { regex: /\b(nl|netherlands|amsterdam|rotterdam)\b/i, code: 'NL', flag: '🇳🇱' },
  { regex: /\b(fi|finland|helsinki)\b/i, code: 'FI', flag: '🇫🇮' },
  { regex: /\b(us|usa|america|newyork|dallas|ashburn|miami|losangeles|silicon)\b/i, code: 'US', flag: '🇺🇸' },
  { regex: /\b(gb|uk|london|britain|manchester)\b/i, code: 'GB', flag: '🇬🇧' },
  { regex: /\b(fr|france|paris|gravelines|strasbourg)\b/i, code: 'FR', flag: '🇫🇷' },
  { regex: /\b(tr|turkey|istanbul|ankara)\b/i, code: 'TR', flag: '🇹🇷' },
  { regex: /\b(ae|uae|dubai|emirates)\b/i, code: 'AE', flag: '🇦🇪' },
  { regex: /\b(sg|singapore)\b/i, code: 'SG', flag: '🇸🇬' },
  { regex: /\b(jp|japan|tokyo|osaka)\b/i, code: 'JP', flag: '🇯🇵' },
  { regex: /\b(se|sweden|stockholm)\b/i, code: 'SE', flag: '🇸🇪' },
  { regex: /\b(ch|switzerland|zurich)\b/i, code: 'CH', flag: '🇨🇭' },
  { regex: /\b(ca|canada|toronto|montreal)\b/i, code: 'CA', flag: '🇨🇦' },
  { regex: /\b(at|austria|vienna)\b/i, code: 'AT', flag: '🇦🇹' },
  { regex: /\b(pl|poland|warsaw)\b/i, code: 'PL', flag: '🇵🇱' },
  { regex: /\b(it|italy|milan|rome)\b/i, code: 'IT', flag: '🇮🇹' },
];

export function countryCodeToFlag(code: string | null | undefined): string {
  if (!code || code.length !== 2) return '🌐';
  const upper = code.toUpperCase();
  if (upper === 'XX' || !/^[A-Z]{2}$/.test(upper)) return '🌐';
  const chars = [...upper].map((c) => 0x1f1e6 + (c.charCodeAt(0) - 65));
  return String.fromCodePoint(...chars);
}

export function detectCountryFromText(text: string): { code: string; flag: string } {
  for (const hint of COUNTRY_HINTS) {
    if (hint.regex.test(text)) {
      return { code: hint.code, flag: hint.flag };
    }
  }
  return { code: 'XX', flag: '🌐' };
}

function decodeBase64Safe(raw: string): string | null {
  try {
    const normalized = raw.trim().replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const binary = globalThis.atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return null;
  }
}

function safeDecodeFragment(raw: string): string {
  const cleaned = raw.replace(/^#/, '').trim();
  if (!cleaned) return '';
  try {
    return decodeURIComponent(cleaned).trim();
  } catch {
    return cleaned;
  }
}

function parseHostPort(authority: string, defaultPort: number): { host: string; port: number } {
  const clean = authority.trim();
  if (!clean) return { host: '', port: defaultPort };

  if (clean.startsWith('[')) {
    const endBracket = clean.indexOf(']');
    if (endBracket > 0) {
      const host = clean.slice(1, endBracket);
      const rest = clean.slice(endBracket + 1);
      const port = rest.startsWith(':') ? Number.parseInt(rest.slice(1), 10) : defaultPort;
      return { host, port: Number.isFinite(port) && port > 0 && port <= 65535 ? port : defaultPort };
    }
  }

  const lastColon = clean.lastIndexOf(':');
  if (lastColon > 0) {
    const host = clean.slice(0, lastColon);
    const parsedPort = Number.parseInt(clean.slice(lastColon + 1), 10);
    if (Number.isFinite(parsedPort) && parsedPort > 0 && parsedPort <= 65535) {
      return { host, port: parsedPort };
    }
  }
  return { host: clean, port: defaultPort };
}

export function isSupportedProxyUri(raw: string): boolean {
  const lower = raw.trim().toLowerCase();
  return SUPPORTED_PROXY_SCHEMES.some((s) => lower.startsWith(s));
}

export function isSubscriptionUrl(raw: string): boolean {
  const lower = raw.trim().toLowerCase();
  return lower.startsWith('https://') || lower.startsWith('http://');
}

export function parseProxyInput(rawInput: string, customName?: string): ParsedProxyInput {
  const uri = rawInput.trim();
  if (!uri) {
    throw new Error('لطفاً لینک کانفیگ یا لینک اشتراک را وارد کنید.');
  }

  const lower = uri.toLowerCase();

  // Subscription URL
  if (isSubscriptionUrl(uri)) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(uri);
    } catch {
      throw new Error('آدرس لینک اشتراک (Subscription URL) معتبر نیست.');
    }
    const host = parsedUrl.hostname;
    if (!host) {
      throw new Error('دامنه یا آدرس سرور در لینک اشتراک یافت نشد.');
    }
    const port = parsedUrl.port ? Number.parseInt(parsedUrl.port, 10) : parsedUrl.protocol === 'https:' ? 443 : 80;
    const fragmentName = safeDecodeFragment(parsedUrl.hash);
    const name = (customName?.trim() || fragmentName || `Subscription (${host})`).slice(0, 64);
    const country = detectCountryFromText(`${name} ${host}`);
    return {
      protocol: 'SUBSCRIPTION',
      name,
      server_address: host,
      server_port: port,
      country_code: country.code,
      flag: country.flag,
      is_subscription: true,
      uri,
    };
  }

  if (!isSupportedProxyUri(uri)) {
    throw new Error(
      'پروتکل پشتیبانی نمی‌شود. پروتکل‌های مجاز: vless, vmess, trojan, ss, hy2, hysteria2, tuic, wireguard یا لینک اشتراک.'
    );
  }

  // VMess (base64 JSON)
  if (lower.startsWith('vmess://')) {
    const payload = uri.slice('vmess://'.length).trim();
    const decoded = decodeBase64Safe(payload);
    if (!decoded) {
      throw new Error('ساختار Base64 در لینک VMess نامعتبر است.');
    }
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(decoded) as Record<string, unknown>;
    } catch {
      throw new Error('داده JSON داخل لینک VMess قابل خواندن نیست.');
    }
    const host = String(json.add || '').trim();
    const port = Number.parseInt(String(json.port || '443'), 10);
    if (!host || !Number.isFinite(port) || port <= 0 || port > 65535) {
      throw new Error('آدرس سرور یا پورت در کانفیگ VMess معتبر نیست.');
    }
    const ps = String(json.ps || '').trim();
    const name = (customName?.trim() || ps || `VMess · ${host}`).slice(0, 64);
    const country = detectCountryFromText(`${name} ${host}`);
    return {
      protocol: 'VMESS',
      name,
      server_address: host,
      server_port: port,
      country_code: country.code,
      flag: country.flag,
      is_subscription: false,
      uri,
    };
  }

  // Shadowsocks (SIP002 or legacy base64)
  if (lower.startsWith('ss://')) {
    const withoutScheme = uri.slice('ss://'.length);
    const hashIdx = withoutScheme.indexOf('#');
    const mainPart = hashIdx >= 0 ? withoutScheme.slice(0, hashIdx) : withoutScheme;
    const fragment = hashIdx >= 0 ? safeDecodeFragment(withoutScheme.slice(hashIdx + 1)) : '';
    const beforeQuery = mainPart.split('?')[0];

    let host = '';
    let port = 443;
    if (beforeQuery.includes('@')) {
      const hostPort = beforeQuery.split('@').pop() || '';
      const parsed = parseHostPort(hostPort, 443);
      host = parsed.host;
      port = parsed.port;
    } else {
      const decoded = decodeBase64Safe(beforeQuery);
      if (decoded && decoded.includes('@')) {
        const hostPort = decoded.split('@').pop() || '';
        const parsed = parseHostPort(hostPort, 443);
        host = parsed.host;
        port = parsed.port;
      }
    }

    if (!host) {
      throw new Error('آدرس سرور در لینک Shadowsocks یافت نشد.');
    }
    const name = (customName?.trim() || fragment || `Shadowsocks · ${host}`).slice(0, 64);
    const country = detectCountryFromText(`${name} ${host}`);
    return {
      protocol: 'SHADOWSOCKS',
      name,
      server_address: host,
      server_port: port,
      country_code: country.code,
      flag: country.flag,
      is_subscription: false,
      uri,
    };
  }

  // Standard authority-based URIs: vless, trojan, hy2, hysteria2, tuic, wireguard, wg
  const schemeEnd = uri.indexOf('://');
  const rawScheme = uri.slice(0, schemeEnd).toLowerCase();
  const rest = uri.slice(schemeEnd + 3);
  const hashIdx = rest.indexOf('#');
  const body = hashIdx >= 0 ? rest.slice(0, hashIdx) : rest;
  const fragment = hashIdx >= 0 ? safeDecodeFragment(rest.slice(hashIdx + 1)) : '';
  const beforeQuery = body.split('?')[0].split('/')[0];
  const hostPortRaw = beforeQuery.includes('@') ? beforeQuery.split('@').pop() || '' : beforeQuery;
  const defaultPort = rawScheme === 'wireguard' || rawScheme === 'wg' ? 51820 : 443;
  const { host, port } = parseHostPort(hostPortRaw, defaultPort);

  if (!host) {
    throw new Error('آدرس سرور در لینک کانفیگ یافت نشد.');
  }

  const protocolLabelMap: Record<string, string> = {
    vless: 'VLESS',
    trojan: 'TROJAN',
    hy2: 'HYSTERIA2',
    hysteria2: 'HYSTERIA2',
    tuic: 'TUIC',
    wireguard: 'WIREGUARD',
    wg: 'WIREGUARD',
  };
  const protocol = protocolLabelMap[rawScheme] || rawScheme.toUpperCase();
  const name = (customName?.trim() || fragment || `${protocol} · ${host}`).slice(0, 64);
  const country = detectCountryFromText(`${name} ${host}`);

  return {
    protocol,
    name,
    server_address: host,
    server_port: port,
    country_code: country.code,
    flag: country.flag,
    is_subscription: false,
    uri,
  };
}

export function buildPersonalConfigItem(rawInput: string, customName?: string): PersonalConfigItem {
  const parsed = parseProxyInput(rawInput, customName);
  return {
    id: `pc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: parsed.name,
    uri: parsed.uri,
    protocol: parsed.protocol,
    server_address: parsed.server_address,
    server_port: parsed.server_port,
    country_code: parsed.country_code,
    flag: parsed.flag,
    is_subscription: parsed.is_subscription,
    latency_ms: null,
    added_at: new Date().toISOString(),
  };
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return '—';
  }
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exp;
  return `${value >= 100 || exp === 0 ? value.toFixed(0) : value.toFixed(exp >= 3 ? 2 : 1)} ${units[exp]}`;
}

export function formatSpeed(bytesPerSec: number | null | undefined): string {
  if (!bytesPerSec || !Number.isFinite(bytesPerSec) || bytesPerSec <= 0) {
    return '0 KB/s';
  }
  if (bytesPerSec < 1024 * 1024) {
    return `${(bytesPerSec / 1024).toFixed(bytesPerSec < 10240 ? 1 : 0)} KB/s`;
  }
  return `${(bytesPerSec / (1024 * 1024)).toFixed(2)} MB/s`;
}

export function formatDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  return [hrs, mins, secs].map((v) => String(v).padStart(2, '0')).join(':');
}

export const APP_VERSION = '1.0.0';

export type LatencyTier = 'good' | 'fair' | 'poor' | 'timeout' | 'idle';

/**
 * Classifies server latency into standard color tiers:
 * - good (<200ms): green
 * - fair (200..=500ms): yellow/amber
 * - poor (>500ms): red
 * - timeout (tested & unreachable/null/<=0): red
 * - idle (not yet tested & no baseline ping): neutral
 */
export function getLatencyTier(
  ms: number | null | undefined,
  tested = false
): LatencyTier {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) {
    return tested ? 'timeout' : 'idle';
  }
  if (ms < 200) return 'good';
  if (ms <= 500) return 'fair';
  return 'poor';
}

export function formatPing(
  ms: number | null | undefined,
  lang: 'en' | 'fa' = 'en',
  tested = false
): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) {
    return tested ? (lang === 'fa' ? 'تایم‌اوت' : 'Timeout') : '—';
  }
  return `${Math.round(ms)} ms`;
}

export function formatRemainingDays(
  days: number | null | undefined,
  lang: 'en' | 'fa' = 'en'
): string {
  if (days === null || days === undefined || !Number.isFinite(days)) return '—';
  if (days <= 0) return lang === 'fa' ? 'منقضی شده' : 'Expired';
  return lang === 'fa' ? `${days} روز باقی‌مانده` : `${days}d left`;
}

export function validateCredentialsForm(
  username: string,
  password: string,
  isRegister: boolean,
  lang: 'en' | 'fa' = 'en'
): string | null {
  const u = username.trim();
  if (!u) {
    return lang === 'fa' ? 'نام کاربری نمی‌تواند خالی باشد.' : 'Username is required.';
  }
  if (isRegister) {
    if (u.length < 3 || u.length > 32) {
      return lang === 'fa'
        ? 'نام کاربری باید بین ۳ تا ۳۲ کاراکتر باشد.'
        : 'Username must be between 3 and 32 characters.';
    }
    if (!/^[a-zA-Z0-9_]+$/.test(u)) {
      return lang === 'fa'
        ? 'نام کاربری فقط می‌تواند شامل حروف انگلیسی، اعداد و زیرخط (_) باشد.'
        : 'Username can only contain letters, numbers, and underscores (_).';
    }
  } else {
    const cleanSignIn = u.startsWith('@') && !u.slice(1).includes('@') ? u.slice(1) : u;
    if (cleanSignIn.length < 2 || cleanSignIn.length > 254) {
      return lang === 'fa'
        ? 'نام کاربری یا ایمیل واردشده معتبر نیست.'
        : 'Enter a valid username or email address.';
    }
    if (!/^[a-zA-Z0-9_.@+-]+$/.test(cleanSignIn)) {
      return lang === 'fa'
        ? 'نام کاربری یا ایمیل فقط می‌تواند شامل حروف انگلیسی، اعداد و کاراکترهای مجاز باشد.'
        : 'Username or email contains unsupported characters.';
    }
  }
  if (!password) {
    return lang === 'fa' ? 'رمز عبور را وارد کنید.' : 'Password is required.';
  }
  if (isRegister && password.length < 8) {
    return lang === 'fa'
      ? 'رمز عبور برای ثبت‌نام باید حداقل ۸ کاراکتر باشد.'
      : 'Password must be at least 8 characters.';
  }
  return null;
}

export function validateOtpCode(
  code: string,
  lang: 'en' | 'fa' = 'en'
): string | null {
  const cleaned = code.trim();
  if (!cleaned) {
    return lang === 'fa'
      ? 'لطفاً کد ورود ۸ رقمی را وارد کنید.'
      : 'Enter the 8-digit Telegram code.';
  }
  if (!/^\d{8}$/.test(cleaned)) {
    return lang === 'fa'
      ? 'کد ورود تلگرام باید دقیقاً ۸ رقم عددی باشد.'
      : 'Telegram code must be exactly 8 digits.';
  }
  return null;
}

export function computeUsagePercent(usedBytes: number, limitBytes: number): number {
  if (!Number.isFinite(limitBytes) || limitBytes <= 0) return 0;
  if (!Number.isFinite(usedBytes) || usedBytes <= 0) return 0;
  return Math.min(100, Math.round((usedBytes / limitBytes) * 100));
}

/**
 * Deterministically picks the healthy server with the lowest positive latency.
 */
export function selectFastestHealthyServer<
  T extends { id: string; is_online?: boolean; latency_ms?: number | null }
>(
  nodes: T[],
  livePings: Record<string, number | null>
): { node: T; latencyMs: number } | null {
  let best: { node: T; latencyMs: number } | null = null;
  for (const node of nodes) {
    if (node.is_online === false) continue;
    const measured =
      node.id in livePings
        ? livePings[node.id]
        : typeof node.latency_ms === 'number' && node.latency_ms > 0
        ? node.latency_ms
        : null;
    if (measured === null || !Number.isFinite(measured) || measured <= 0) {
      continue;
    }
    if (!best || measured < best.latencyMs) {
      best = { node, latencyMs: Math.round(measured) };
    }
  }
  return best;
}

function parseSemverParts(tag: string): [number, number, number] | null {
  const cleaned = tag.trim().replace(/^v/i, '').split('-')[0];
  const parts = cleaned.split('.');
  if (parts.length === 0 || parts.length > 3) return null;
  const nums = [0, 0, 0];
  for (let i = 0; i < parts.length; i += 1) {
    if (!/^\d+$/.test(parts[i])) return null;
    nums[i] = Number.parseInt(parts[i], 10);
  }
  return [nums[0], nums[1], nums[2]];
}

export function compareSemver(a: string, b: string): number {
  const pa = parseSemverParts(a);
  const pb = parseSemverParts(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

export function isNewerVersion(currentVersion: string, latestTag: string): boolean {
  return compareSemver(latestTag, currentVersion) > 0;
}

export function isSafeReleaseUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.hostname !== 'github.com') return false;
    return parsed.pathname.toLowerCase().startsWith('/parsa904/sentravpn/');
  } catch {
    return false;
  }
}

export interface RawAuthApiResponse {
  access_token?: string;
  auth_token?: string;
  subscription_token?: string;
  token?: string;
  username?: string;
  tier?: string;
  expires_at?: string | null;
  user?: {
    username?: string | null;
    first_name?: string | null;
  };
  subscription?: {
    token?: string;
    tier?: string;
    expires_at?: string | null;
  };
}

/**
 * Pure parser normalizing both nested Sentra Core auth responses
 * ({ access_token, user, subscription }) and flat session payloads.
 */
export function parseAuthSessionResponse(
  data: RawAuthApiResponse,
  fallbackUsername = ''
): {
  auth_token: string;
  subscription_token: string;
  username: string;
  tier: string;
  expires_at: string | null;
} | null {
  const subToken =
    data.subscription?.token ||
    data.subscription_token ||
    data.token ||
    data.access_token ||
    data.auth_token;

  if (!subToken || typeof subToken !== 'string' || !subToken.trim()) {
    return null;
  }

  const authToken = data.access_token || data.auth_token || subToken;
  const username =
    data.user?.username ||
    data.user?.first_name ||
    data.username ||
    fallbackUsername;
  const tier = data.subscription?.tier || data.tier || '';
  const expiresAt = data.subscription?.expires_at ?? data.expires_at ?? null;

  return {
    auth_token: authToken,
    subscription_token: subToken,
    username,
    tier,
    expires_at: expiresAt,
  };
}
