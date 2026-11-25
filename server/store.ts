import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class StoreError extends Error {
  status: number;
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'StoreError';
    this.status = status;
    this.code = code;
  }
}

export interface AuthCredentialsInput {
  username: string;
  password: string;
  device_identifier?: string;
  device_name?: string;
  os?: string;
}

export interface AuthResponsePayload {
  success: true;
  access_token: string;
  token_type: 'Bearer';
  user: {
    id: number;
    user_uuid: string;
    telegram_id: number | null;
    username: string | null;
    first_name: string;
    role: string;
  };
  subscription: {
    tier: string;
    token: string;
    status: string;
    remaining_bytes: number;
    max_concurrent_devices: number;
    expires_at: string;
  };
}

export interface SyncedClientStatePayload {
  personal_configs: unknown[];
  preferences: Record<string, unknown>;
  updated_at: string;
}

export interface HeartbeatInput {
  device_id: string;
  mode?: string;
  delta_upload_bytes?: number;
  delta_download_bytes?: number;
}

export type HeartbeatVerdict =
  | {
      action: 'continue';
      remaining_bytes: number;
      upload_bytes: number;
      download_bytes: number;
      used_bytes: number;
      web_browsing_used_mb: number;
      download_used_mb: number;
      static_ip_used_mb: number;
      static_ip_remaining_mb: number;
    }
  | {
      action: 'disconnect';
      code: string;
      message: string;
    };

interface UserRow {
  id: number;
  user_uuid: string;
  telegram_id: number | null;
  username: string | null;
  email: string | null;
  password_hash: string | null;
  first_name: string;
  role: string;
  status: string;
  auth_code: string | null;
  auth_code_expires_at: string | null;
  link_code: string | null;
  link_code_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SubscriptionRow {
  id: number;
  user_id: number;
  tier: string;
  token: string;
  status: string;
  upload_bytes: number;
  download_bytes: number;
  traffic_limit_bytes: number;
  max_concurrent_devices: number;
  web_browsing_used_mb: number;
  download_used_mb: number;
  static_ip_used_mb: number;
  last_quota_reset: string | null;
  starts_at: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

interface DeviceRow {
  id: number;
  device_id: string;
  device_name: string;
  platform: string;
  last_active_at: string;
  created_at: string;
}

interface DonatedRow {
  id: number;
  name: string;
  protocol: string;
  server_address: string;
  server_port: number;
  country_code: string;
  flag: string;
  latency_ms: number;
  status: string;
  reward_days: number;
  user_note: string | null;
  rejection_reason: string | null;
  created_at: string;
  approved_at: string | null;
}

interface ClientStateRow {
  user_id: number;
  personal_configs_json: string;
  preferences_json: string;
  updated_at: string;
}

const RESERVED_USERNAMES = new Set([
  'admin',
  'root',
  'sentra',
  'support',
  'system',
  'administrator',
  'sentravpn',
  'superuser',
]);

const DEFAULT_LITE_TRAFFIC_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB
const DEFAULT_MAX_DEVICES = 3;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const MAX_PERSONAL_CONFIGS = 100;

export function resolveUnifiedSqlitePath(explicitPath?: string): string {
  if (explicitPath && explicitPath.trim()) {
    return explicitPath.trim();
  }
  const envSqlitePath = (process.env.SENTRA_SQLITE_PATH || '').trim();
  if (envSqlitePath) {
    return envSqlitePath;
  }
  const databaseUrl = (process.env.DATABASE_URL || '').trim();
  if (databaseUrl.startsWith('sqlite://')) {
    const withoutScheme = databaseUrl.slice('sqlite://'.length).split('?')[0].trim();
    if (withoutScheme) {
      return path.isAbsolute(withoutScheme)
        ? withoutScheme
        : path.resolve(process.cwd(), withoutScheme);
    }
  }
  const coreDefaultDb = path.resolve(process.cwd(), 'sentra_local.db');
  if (fs.existsSync(coreDefaultDb)) {
    return coreDefaultDb;
  }
  return path.resolve(process.cwd(), 'data', 'sentra.sqlite');
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${derived.toString('hex')}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return false;
  }
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = parts[4];
  const expectedHex = parts[5];
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p) || !salt || !expectedHex) {
    return false;
  }

  try {
    const expectedBuf = Buffer.from(expectedHex, 'hex');
    const actualBuf = crypto.scryptSync(password, salt, expectedBuf.length, { N: n, r, p });
    if (actualBuf.length !== expectedBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(actualBuf, expectedBuf);
  } catch {
    return false;
  }
}

export function normalizeLoginIdentifier(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.startsWith('@') && !trimmed.slice(1).includes('@')) {
    return trimmed.slice(1);
  }
  return trimmed;
}

export function normalizeSubscriptionToken(raw: string | undefined | null): string | null {
  if (!raw || typeof raw !== 'string') return null;
  let cleaned = raw.trim();
  if (cleaned.toLowerCase().startsWith('bearer ')) {
    cleaned = cleaned.slice(7).trim();
  }
  if (cleaned.startsWith('jwt_sentra_')) {
    cleaned = cleaned.slice('jwt_sentra_'.length).trim();
  }
  return cleaned.length > 0 ? cleaned : null;
}

function defaultDeviceName(platform: string): string {
  switch (platform.toLowerCase()) {
    case 'android':
      return 'Android Mobile';
    case 'ios':
      return 'iPhone / iPad';
    case 'darwin':
    case 'macos':
      return 'Apple Mac';
    case 'linux':
      return 'Linux PC';
    case 'web':
      return 'Sentra Web Client';
    default:
      return 'Windows PC';
  }
}

function getTehranDateKey(date: Date): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tehran',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function isBlockedHost(rawHost: string): boolean {
  const host = rawHost.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === '0.0.0.0' ||
    host === '::' ||
    host === '::1'
  ) {
    return true;
  }

  // IPv4-mapped IPv6 e.g. ::ffff:127.0.0.1
  const ipv4Candidate = host.startsWith('::ffff:') ? host.slice(7) : host;
  const ipv4Match = ipv4Candidate.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const a = Number(ipv4Match[1]);
    const b = Number(ipv4Match[2]);
    const c = Number(ipv4Match[3]);
    const d = Number(ipv4Match[4]);
    if (a > 255 || b > 255 || c > 255 || d > 255) return true;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved
  }

  // IPv6 ULA / link-local
  if (host.includes(':')) {
    if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) {
      return true;
    }
  }

  return false;
}

function buildSingboxOutboundFromUri(
  rawUri: string,
  protocol: string,
  serverAddress: string,
  serverPort: number,
  tag: string
): Record<string, unknown> {
  const protoLower = protocol.toLowerCase();
  if (protoLower === 'vmess') {
    const body = rawUri.replace(/^vmess:\/\//i, '').split('#')[0].trim();
    const parsed = JSON.parse(Buffer.from(body, 'base64').toString('utf8')) as Record<string, unknown>;
    const obj: Record<string, unknown> = {
      type: 'vmess',
      tag,
      server: serverAddress,
      server_port: serverPort,
      uuid: String(parsed.id || ''),
      security: String(parsed.scy || 'auto'),
      alter_id: Number(parsed.aid || 0),
    };
    if (String(parsed.tls || '').toLowerCase() === 'tls') {
      obj.tls = {
        enabled: true,
        server_name: String(parsed.sni || parsed.host || serverAddress),
      };
    }
    return obj;
  }

  const normalizedUrl = new URL(rawUri.replace(/^[a-zA-Z0-9+.-]+:\/\//, 'https://'));
  const params = normalizedUrl.searchParams;
  const userInfo = decodeURIComponent(normalizedUrl.username || '');
  const sni = params.get('sni') || params.get('host') || serverAddress;

  if (protoLower === 'vless') {
    const obj: Record<string, unknown> = {
      type: 'vless',
      tag,
      server: serverAddress,
      server_port: serverPort,
      uuid: userInfo,
      flow: params.get('flow') || '',
      packet_encoding: 'xudp',
    };
    const security = (params.get('security') || '').toLowerCase();
    if (security === 'tls' || security === 'reality') {
      const tls: Record<string, unknown> = {
        enabled: true,
        server_name: sni,
      };
      if (security === 'reality' && params.get('pbk')) {
        tls.reality = {
          enabled: true,
          public_key: params.get('pbk'),
          short_id: params.get('sid') || '',
        };
      }
      obj.tls = tls;
    }
    return obj;
  }

  if (protoLower === 'trojan') {
    return {
      type: 'trojan',
      tag,
      server: serverAddress,
      server_port: serverPort,
      password: userInfo,
      tls: {
        enabled: true,
        server_name: sni,
      },
    };
  }

  if (protoLower === 'hysteria2') {
    return {
      type: 'hysteria2',
      tag,
      server: serverAddress,
      server_port: serverPort,
      password: userInfo,
      tls: {
        enabled: true,
        server_name: sni,
      },
    };
  }

  if (protoLower === 'tuic') {
    return {
      type: 'tuic',
      tag,
      server: serverAddress,
      server_port: serverPort,
      uuid: userInfo,
      password: decodeURIComponent(normalizedUrl.password || ''),
      congestion_control: params.get('congestion_control') || 'bbr',
      tls: {
        enabled: true,
        server_name: sni,
      },
    };
  }

  if (protoLower === 'shadowsocks') {
    let method = 'aes-256-gcm';
    let password = decodeURIComponent(normalizedUrl.password || '');
    if (!password && userInfo) {
      try {
        const decoded = Buffer.from(userInfo, 'base64').toString('utf8');
        const colonIdx = decoded.indexOf(':');
        if (colonIdx > 0) {
          method = decoded.slice(0, colonIdx);
          password = decoded.slice(colonIdx + 1);
        }
      } catch {
        password = userInfo;
      }
    } else if (userInfo) {
      method = userInfo;
    }
    return {
      type: 'shadowsocks',
      tag,
      server: serverAddress,
      server_port: serverPort,
      method,
      password,
    };
  }

  if (protoLower === 'socks' || protoLower === 'socks5') {
    return {
      type: 'socks',
      tag,
      server: serverAddress,
      server_port: serverPort,
      version: '5',
    };
  }

  if (protoLower === 'http') {
    return {
      type: 'http',
      tag,
      server: serverAddress,
      server_port: serverPort,
    };
  }

  return {
    type: protoLower,
    tag,
    server: serverAddress,
    server_port: serverPort,
  };
}

function parseDonatedUri(uri: string): {
  protocol: string;
  server_address: string;
  server_port: number;
  name: string;
  fingerprint_sha256: string;
  config_json: string;
} {
  const cleaned = uri.trim();
  if (!cleaned || cleaned.length > 8192) {
    throw new StoreError(400, 'فرمت لینک کانفیگ معتبر نیست.');
  }
  const match = cleaned.match(/^([a-zA-Z0-9+.-]+):\/\/(.+)$/);
  if (!match) {
    throw new StoreError(400, 'فرمت لینک کانفیگ معتبر نیست.');
  }

  const rawScheme = match[1].toLowerCase();
  const schemeMap: Record<string, string> = {
    vless: 'VLESS',
    vmess: 'VMESS',
    trojan: 'TROJAN',
    ss: 'SHADOWSOCKS',
    hy2: 'HYSTERIA2',
    hysteria2: 'HYSTERIA2',
    tuic: 'TUIC',
    wireguard: 'WIREGUARD',
    wg: 'WIREGUARD',
    socks: 'SOCKS',
    socks5: 'SOCKS',
    http: 'HTTP',
  };

  const protocol = schemeMap[rawScheme];
  if (!protocol) {
    throw new StoreError(400, 'پروتکل انتخاب‌شده پشتیبانی نمی‌شود.');
  }

  let serverAddress = '';
  let serverPort = 443;
  let name = '';

  if (rawScheme === 'vmess') {
    try {
      const jsonStr = Buffer.from(match[2].split('#')[0].trim(), 'base64').toString('utf8');
      const parsed = JSON.parse(jsonStr) as { add?: string; port?: string | number; ps?: string };
      if (!parsed.add) {
        throw new Error('missing host');
      }
      const port = Number(parsed.port || 443);
      serverAddress = parsed.add.trim();
      serverPort = Number.isFinite(port) && port > 0 && port <= 65535 ? port : 443;
      name = (parsed.ps || `${protocol}-${serverAddress}`).slice(0, 80);
    } catch {
      throw new StoreError(400, 'ساختار لینک VMess معتبر نیست.');
    }
  } else {
    try {
      const normalizedUrl = new URL(cleaned.replace(/^[a-zA-Z0-9+.-]+:\/\//, 'https://'));
      const host = normalizedUrl.hostname;
      const port = normalizedUrl.port ? Number(normalizedUrl.port) : 443;
      const fragment = normalizedUrl.hash ? decodeURIComponent(normalizedUrl.hash.slice(1)) : '';
      if (!host) {
        throw new Error('missing host');
      }
      serverAddress = host.trim();
      serverPort = Number.isFinite(port) && port > 0 && port <= 65535 ? port : 443;
      name = (fragment || `${protocol}-${serverAddress}`).slice(0, 80);
    } catch {
      throw new StoreError(400, 'ساختار لینک کانفیگ معتبر نیست.');
    }
  }

  if (isBlockedHost(serverAddress)) {
    throw new StoreError(
      400,
      'آدرس سرور واردشده متعلق به شبکه داخلی یا غیرمجاز است و امکان ثبت آن وجود ندارد.'
    );
  }

  const fingerprint_sha256 = crypto
    .createHash('sha256')
    .update(`${protocol.toLowerCase()}:${serverAddress.toLowerCase()}:${serverPort}`)
    .digest('hex');

  const singboxObj = buildSingboxOutboundFromUri(
    cleaned,
    protocol,
    serverAddress,
    serverPort,
    name
  );

  return {
    protocol,
    server_address: serverAddress,
    server_port: serverPort,
    name,
    fingerprint_sha256,
    config_json: JSON.stringify(singboxObj),
  };
}

export function tierHasStaticIp(tier: string): boolean {
  const lower = (tier || '').trim().toLowerCase();
  if (!lower || lower === 'sentra lite' || lower === 'lite' || lower === 'free') {
    return false;
  }
  return (
    lower.includes('static') ||
    lower.includes('pro') ||
    lower.includes('flow') ||
    lower.includes('ultra') ||
    lower.includes('vip') ||
    lower.includes('all')
  );
}

export function tierHasGaming(tier: string): boolean {
  const lower = (tier || '').trim().toLowerCase();
  if (!lower || lower === 'sentra lite' || lower === 'lite' || lower === 'free') {
    return false;
  }
  return (
    lower.includes('gaming') ||
    lower.includes('game') ||
    lower.includes('pro') ||
    lower.includes('flow') ||
    lower.includes('ultra') ||
    lower.includes('vip') ||
    lower.includes('all')
  );
}

function deriveX25519KeypairFromSeed(seed: Buffer): { privateKeyB64: string; publicKeyB64: string } {
  // PKCS#8 DER prefix for X25519 private key (RFC 8410) + 32-byte raw seed
  const pkcs8Prefix = Buffer.from('302e020100300506032b656e04220420', 'hex');
  const rawSeed = Buffer.from(seed.subarray(0, 32));
  const privKeyObj = crypto.createPrivateKey({
    key: Buffer.concat([pkcs8Prefix, rawSeed]),
    format: 'der',
    type: 'pkcs8',
  });
  const pubKeyObj = crypto.createPublicKey(privKeyObj);
  const spkiDer = pubKeyObj.export({ format: 'der', type: 'spki' }) as Buffer;
  const rawPub = spkiDer.subarray(spkiDer.length - 32);
  return {
    privateKeyB64: rawSeed.toString('base64'),
    publicKeyB64: rawPub.toString('base64'),
  };
}

function sanitizeSyncPreferences(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const input = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  if (
    input.selected_mode === 'web_browsing' ||
    input.selected_mode === 'download' ||
    input.selected_mode === 'gaming' ||
    input.selected_mode === 'static_ip'
  ) {
    out.selected_mode = input.selected_mode;
  }
  if (
    input.routing_mode === 'tunnel' ||
    input.routing_mode === 'system_proxy' ||
    input.routing_mode === 'proxy'
  ) {
    out.routing_mode = input.routing_mode;
  }
  if (typeof input.split_tunneling === 'boolean') out.split_tunneling = input.split_tunneling;
  if (typeof input.kill_switch === 'boolean') out.kill_switch = input.kill_switch;
  if (typeof input.auto_reconnect === 'boolean') out.auto_reconnect = input.auto_reconnect;
  if (typeof input.ping_optimization_enabled === 'boolean') {
    out.ping_optimization_enabled = input.ping_optimization_enabled;
  }
  if (typeof input.use_warp === 'boolean') out.use_warp = input.use_warp;
  if (typeof input.custom_dns === 'string' && input.custom_dns.trim().length <= 64) {
    out.custom_dns = input.custom_dns.trim();
  }
  if (
    input.selected_outbound_id === null ||
    (typeof input.selected_outbound_id === 'string' && input.selected_outbound_id.length <= 128)
  ) {
    out.selected_outbound_id = input.selected_outbound_id;
  }
  if (typeof input.auto_mode === 'boolean') out.auto_mode = input.auto_mode;
  if (input.lang === 'en' || input.lang === 'fa') out.lang = input.lang;
  if (input.theme === 'dark' || input.theme === 'light') out.theme = input.theme;

  return out;
}

function sanitizePersonalConfigs(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  const cleaned: unknown[] = [];
  for (const item of raw.slice(0, MAX_PERSONAL_CONFIGS)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const uri = typeof rec.uri === 'string' ? rec.uri.trim() : '';
    const id = typeof rec.id === 'string' ? rec.id.trim() : '';
    if (!uri || !id || uri.length > 4096 || id.length > 128) continue;
    cleaned.push({
      id,
      name: typeof rec.name === 'string' ? rec.name.slice(0, 120) : 'Config',
      uri,
      protocol: typeof rec.protocol === 'string' ? rec.protocol.slice(0, 32) : 'UNKNOWN',
      server_address:
        typeof rec.server_address === 'string' ? rec.server_address.slice(0, 255) : '',
      server_port:
        typeof rec.server_port === 'number' &&
        Number.isFinite(rec.server_port) &&
        rec.server_port >= 0 &&
        rec.server_port <= 65535
          ? Math.trunc(rec.server_port)
          : 443,
      country_code:
        typeof rec.country_code === 'string' ? rec.country_code.slice(0, 8) : 'XX',
      flag: typeof rec.flag === 'string' ? rec.flag.slice(0, 8) : '🌐',
      is_subscription: Boolean(rec.is_subscription),
      latency_ms:
        typeof rec.latency_ms === 'number' && Number.isFinite(rec.latency_ms) && rec.latency_ms > 0
          ? Math.round(rec.latency_ms)
          : null,
      added_at:
        typeof rec.added_at === 'string' && rec.added_at.trim()
          ? rec.added_at.slice(0, 64)
          : new Date().toISOString(),
    });
  }
  return cleaned;
}

export class SentraStore {
  private db: DatabaseSync;
  readonly dbPath: string;

  constructor(dbPath?: string) {
    const resolvedPath = resolveUnifiedSqlitePath(dbPath);
    this.dbPath = resolvedPath;

    if (resolvedPath !== ':memory:') {
      fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    }

    this.db = new DatabaseSync(resolvedPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.initSchema();
  }

  close(): void {
    this.db.close();
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    const exists = rows.some((r) => r.name.toLowerCase() === column.toLowerCase());
    if (!exists) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_uuid TEXT NOT NULL UNIQUE,
        telegram_id INTEGER UNIQUE,
        username TEXT UNIQUE,
        email TEXT UNIQUE,
        password_hash TEXT,
        first_name TEXT NOT NULL DEFAULT '',
        last_name TEXT,
        photo_url TEXT,
        role TEXT NOT NULL DEFAULT 'user',
        status TEXT NOT NULL DEFAULT 'active',
        auth_code TEXT,
        auth_code_expires_at TEXT,
        link_code TEXT,
        link_code_expires_at TEXT,
        outbound_reward_banned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE TABLE IF NOT EXISTS subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        tier TEXT NOT NULL DEFAULT 'Sentra Lite',
        token TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'active',
        upload_bytes INTEGER NOT NULL DEFAULT 0,
        download_bytes INTEGER NOT NULL DEFAULT 0,
        traffic_limit_bytes INTEGER NOT NULL DEFAULT ${DEFAULT_LITE_TRAFFIC_BYTES},
        speed_limit_bps INTEGER NOT NULL DEFAULT 0,
        max_concurrent_devices INTEGER NOT NULL DEFAULT ${DEFAULT_MAX_DEVICES},
        web_browsing_used_mb INTEGER NOT NULL DEFAULT 0,
        download_used_mb INTEGER NOT NULL DEFAULT 0,
        static_ip_used_mb INTEGER NOT NULL DEFAULT 0,
        last_quota_reset TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        starts_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS user_devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        subscription_id INTEGER NOT NULL,
        device_id TEXT NOT NULL,
        device_name TEXT NOT NULL,
        platform TEXT NOT NULL,
        last_active_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        UNIQUE(user_id, device_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS traffic_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subscription_id INTEGER NOT NULL,
        bytes_sent INTEGER NOT NULL DEFAULT 0,
        bytes_received INTEGER NOT NULL DEFAULT 0,
        recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS donated_outbounds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        donor_user_id INTEGER NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        tag TEXT NOT NULL DEFAULT '',
        protocol TEXT NOT NULL,
        server_address TEXT NOT NULL,
        server_port INTEGER NOT NULL,
        country_code TEXT NOT NULL DEFAULT 'XX',
        country_name TEXT NOT NULL DEFAULT 'Unknown',
        flag TEXT NOT NULL DEFAULT '🌐',
        raw_link TEXT NOT NULL DEFAULT '',
        latency_ms INTEGER NOT NULL DEFAULT 0,
        health_score INTEGER NOT NULL DEFAULT 100,
        is_official INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        reward_days INTEGER NOT NULL DEFAULT 0,
        user_note TEXT,
        rejection_reason TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        approved_at TEXT,
        FOREIGN KEY (donor_user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS user_client_state (
        user_id INTEGER PRIMARY KEY,
        personal_configs_json TEXT NOT NULL DEFAULT '[]',
        preferences_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS outbounds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tag TEXT NOT NULL UNIQUE,
        protocol TEXT NOT NULL,
        server_address TEXT NOT NULL,
        server_port INTEGER NOT NULL,
        uuid TEXT,
        tier_access TEXT NOT NULL DEFAULT 'Sentra Lite',
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE INDEX IF NOT EXISTS idx_users_username_lower ON users (LOWER(username));
      CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users (LOWER(email));
      CREATE INDEX IF NOT EXISTS idx_subscriptions_token ON subscriptions (token);
      CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions (user_id);
      CREATE INDEX IF NOT EXISTS idx_user_devices_user_id ON user_devices (user_id);
      CREATE INDEX IF NOT EXISTS idx_traffic_logs_sub_id ON traffic_logs (subscription_id);
    `);

    // Safe additive migrations for pre-existing databases (never destructive)
    this.ensureColumn('users', 'email', 'TEXT');
    this.ensureColumn('users', 'outbound_reward_banned', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn(
      'subscriptions',
      'last_quota_reset',
      "TEXT NOT NULL DEFAULT '2026-01-01T00:00:00Z'"
    );
    this.ensureColumn('subscriptions', 'speed_limit_bps', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('donated_outbounds', 'label', 'TEXT');
    this.ensureColumn('donated_outbounds', 'config_json', "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn('donated_outbounds', 'assigned_tier', "TEXT NOT NULL DEFAULT 'web_browsing'");
    this.ensureColumn('donated_outbounds', 'allow_web', 'INTEGER NOT NULL DEFAULT 1');
    this.ensureColumn('donated_outbounds', 'allow_download', 'INTEGER NOT NULL DEFAULT 1');
    this.ensureColumn('donated_outbounds', 'allow_static_ip', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('donated_outbounds', 'allow_gaming', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('donated_outbounds', 'speed_score', 'INTEGER NOT NULL DEFAULT 80');
    this.ensureColumn('donated_outbounds', 'last_online_at', 'TEXT');
    this.ensureColumn('donated_outbounds', 'allocation_mode', "TEXT NOT NULL DEFAULT 'auto'");
    this.ensureColumn('donated_outbounds', 'fingerprint_sha256', 'TEXT');
    this.ensureColumn('donated_outbounds', 'fail_count', 'INTEGER NOT NULL DEFAULT 0');

    // Normalize existing active/approved outbounds so they are active across the entire ecosystem
    this.db.exec(`
      UPDATE donated_outbounds
      SET allow_gaming = 1
      WHERE assigned_tier = 'gaming'
         OR COALESCE(allocation_mode, 'auto') IN ('gaming_only', 'gaming', 'all');

      UPDATE donated_outbounds
      SET allow_web = 1,
          allow_download = 1
      WHERE status IN ('active', 'approved')
        AND COALESCE(allocation_mode, 'auto') NOT IN ('static_only', 'gaming_only')
        AND (allow_web = 0 OR allow_download = 0);
    `);
  }

  private checkAndResetDailyQuota(sub: SubscriptionRow): SubscriptionRow {
    const now = new Date();
    const todayTehran = getTehranDateKey(now);
    const lastResetDate = sub.last_quota_reset ? new Date(sub.last_quota_reset) : new Date(0);
    const lastTehran = Number.isNaN(lastResetDate.getTime())
      ? ''
      : getTehranDateKey(lastResetDate);

    if (lastTehran !== todayTehran) {
      const nowIso = now.toISOString();
      this.db
        .prepare(
          `UPDATE subscriptions
           SET web_browsing_used_mb = 0,
               download_used_mb = 0,
               last_quota_reset = ?,
               updated_at = ?
           WHERE id = ?`
        )
        .run(nowIso, nowIso, sub.id);
      return {
        ...sub,
        web_browsing_used_mb: 0,
        download_used_mb: 0,
        last_quota_reset: nowIso,
        updated_at: nowIso,
      };
    }
    return sub;
  }

  private ensureSubscriptionForUser(userId: number): SubscriptionRow {
    const existing = this.db
      .prepare('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 1')
      .get(userId) as SubscriptionRow | undefined;
    if (existing) {
      return this.checkAndResetDailyQuota(existing);
    }

    const token = `sentra_${crypto.randomBytes(16).toString('hex')}`;
    const nowIso = new Date().toISOString();
    const expiresIso = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    this.db
      .prepare(
        `INSERT INTO subscriptions (
          user_id, tier, token, status, upload_bytes, download_bytes,
          traffic_limit_bytes, speed_limit_bps, max_concurrent_devices,
          web_browsing_used_mb, download_used_mb, static_ip_used_mb,
          last_quota_reset, starts_at, expires_at, created_at, updated_at
        ) VALUES (?, 'Sentra Lite', ?, 'active', 0, 0, ?, 0, ?, 0, 0, 0, ?, ?, ?, ?, ?)`
      )
      .run(
        userId,
        token,
        DEFAULT_LITE_TRAFFIC_BYTES,
        DEFAULT_MAX_DEVICES,
        nowIso,
        nowIso,
        expiresIso,
        nowIso,
        nowIso
      );

    return this.db
      .prepare('SELECT * FROM subscriptions WHERE token = ? LIMIT 1')
      .get(token) as SubscriptionRow;
  }

  private registerOrUpdateDevice(
    userId: number,
    sub: SubscriptionRow,
    deviceIdentifier?: string,
    deviceName?: string,
    os?: string
  ): void {
    const cleanDeviceId = (deviceIdentifier || 'web-default-device').trim().slice(0, 128);
    const cleanPlatform = (os || 'web').trim().slice(0, 32) || 'web';
    const cleanName = (deviceName || defaultDeviceName(cleanPlatform)).trim().slice(0, 80);
    const nowIso = new Date().toISOString();

    const existing = this.db
      .prepare('SELECT id FROM user_devices WHERE user_id = ? AND device_id = ? LIMIT 1')
      .get(userId, cleanDeviceId) as { id: number } | undefined;

    if (existing) {
      this.db
        .prepare(
          'UPDATE user_devices SET device_name = ?, platform = ?, last_active_at = ? WHERE id = ?'
        )
        .run(cleanName, cleanPlatform, nowIso, existing.id);
      return;
    }

    const countRow = this.db
      .prepare('SELECT COUNT(*) as cnt FROM user_devices WHERE user_id = ?')
      .get(userId) as { cnt: number };

    const maxDevices = Math.max(1, sub.max_concurrent_devices || DEFAULT_MAX_DEVICES);
    if (countRow.cnt >= maxDevices) {
      throw new StoreError(
        403,
        `سقف اتصال هم‌زمان ${maxDevices} دستگاه برای این اشتراک تکمیل شده است. لطفاً یکی از دستگاه‌های قبلی را حذف کنید.`,
        'MAX_DEVICES_REACHED'
      );
    }

    this.db
      .prepare(
        `INSERT INTO user_devices (user_id, subscription_id, device_id, device_name, platform, last_active_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(userId, sub.id, cleanDeviceId, cleanName, cleanPlatform, nowIso, nowIso);
  }

  private formatAuthResponse(user: UserRow, sub: SubscriptionRow): AuthResponsePayload {
    const remainingBytes = Math.max(
      0,
      sub.traffic_limit_bytes - (sub.upload_bytes + sub.download_bytes)
    );
    return {
      success: true,
      access_token: `jwt_sentra_${sub.token}`,
      token_type: 'Bearer',
      user: {
        id: user.id,
        user_uuid: user.user_uuid,
        telegram_id: user.telegram_id,
        username: user.username,
        first_name: user.first_name,
        role: user.role,
      },
      subscription: {
        tier: sub.tier,
        token: sub.token,
        status: sub.status,
        remaining_bytes: remainingBytes,
        max_concurrent_devices: sub.max_concurrent_devices,
        expires_at: sub.expires_at,
      },
    };
  }

  /**
   * Returns true once at least one active outbound has been allocated to Gaming.
   * Until then, Gaming remains visible as "coming_soon" across the entire ecosystem.
   */
  hasActiveGamingOutbounds(): boolean {
    const donatedRow = this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM donated_outbounds
         WHERE status IN ('active', 'approved')
           AND (allow_gaming = 1 OR assigned_tier = 'gaming' OR allocation_mode IN ('gaming_only', 'gaming', 'all'))`
      )
      .get() as { cnt: number };
    if ((donatedRow?.cnt || 0) > 0) {
      return true;
    }

    const outboundsCols = this.db
      .prepare('PRAGMA table_info(outbounds)')
      .all() as Array<{ name: string }>;
    if (outboundsCols.some((c) => c.name === 'mode_category')) {
      const coreRow = this.db
        .prepare(
          `SELECT COUNT(*) as cnt FROM outbounds
           WHERE is_active = 1 AND server_address != '127.0.0.1' AND mode_category = 'gaming'`
        )
        .get() as { cnt: number };
      if ((coreRow?.cnt || 0) > 0) {
        return true;
      }
    }

    return false;
  }

  private buildModes(sub: SubscriptionRow) {
    const isLite = sub.tier === 'Sentra Lite';
    const gamingEnabled = this.hasActiveGamingOutbounds();
    const hasGaming = tierHasGaming(sub.tier);
    const hasStatic = tierHasStaticIp(sub.tier);
    return [
      {
        id: 'web_browsing',
        name: 'Web Browsing',
        status: isLite && sub.web_browsing_used_mb >= 2048 ? 'depleted' : 'active',
        badge: null,
        daily_limit_mb: isLite ? 2048 : 102400,
        used_today_mb: sub.web_browsing_used_mb,
        remaining_today_mb: Math.max(0, (isLite ? 2048 : 102400) - sub.web_browsing_used_mb),
        speed_desc: 'Balanced',
        security_desc: 'Reality TLS',
        description: 'Optimized for web browsing, messengers, and AI tools.',
      },
      {
        id: 'download',
        name: 'Download',
        status: isLite && sub.download_used_mb >= 3072 ? 'depleted' : 'active',
        badge: null,
        daily_limit_mb: isLite ? 3072 : 204800,
        used_today_mb: sub.download_used_mb,
        remaining_today_mb: Math.max(0, (isLite ? 3072 : 204800) - sub.download_used_mb),
        speed_desc: 'High Throughput',
        security_desc: 'Hysteria2 / QUIC',
        description: 'High-bandwidth routing for large downloads and streaming.',
      },
      {
        id: 'gaming',
        name: 'Gaming',
        status: !gamingEnabled ? 'coming_soon' : hasGaming ? 'active' : 'locked',
        badge: !gamingEnabled
          ? 'Coming Soon'
          : hasGaming
          ? 'Low Ping · MTU 1280'
          : 'Gaming / Pro',
        daily_limit_mb: gamingEnabled && hasGaming ? 204800 : 0,
        used_today_mb: 0,
        remaining_today_mb: gamingEnabled && hasGaming ? 204800 : 0,
        speed_desc: 'Ultra-Low Ping',
        security_desc: 'Full-Cone NAT · WireGuard iOS',
        description: gamingEnabled
          ? 'Zero-jitter routing for Windows/Android gaming and WireGuard protocol for iOS.'
          : 'Gaming mode is coming soon and activates automatically once gaming servers are added.',
      },
      {
        id: 'static_ip',
        name: 'Static IP',
        status: !hasStatic ? 'locked' : sub.static_ip_used_mb >= 30720 ? 'depleted' : 'active',
        badge: !hasStatic ? 'Static / Pro' : null,
        daily_limit_mb: !hasStatic ? 0 : 30720,
        used_today_mb: sub.static_ip_used_mb,
        remaining_today_mb: Math.max(0, (!hasStatic ? 0 : 30720) - sub.static_ip_used_mb),
        speed_desc: 'Dedicated Route',
        security_desc: 'Clean Residential / Trading Safe',
        description: 'Consistent exit IP for banking, exchanges, and sensitive accounts.',
      },
    ];
  }

  registerUser(input: AuthCredentialsInput): AuthResponsePayload {
    const cleanUsername = normalizeLoginIdentifier(input.username || '');
    const rawPassword = typeof input.password === 'string' ? input.password : '';

    if (cleanUsername.length < 3 || cleanUsername.length > 32) {
      throw new StoreError(400, 'نام کاربری باید بین ۳ تا ۳۲ کاراکتر باشد.');
    }
    if (!/^[a-z0-9_]+$/.test(cleanUsername)) {
      throw new StoreError(
        400,
        'نام کاربری فقط می‌تواند شامل حروف انگلیسی، اعداد و زیرخط (_) باشد.'
      );
    }
    if (RESERVED_USERNAMES.has(cleanUsername)) {
      throw new StoreError(400, 'این نام کاربری رزرو شده و قابل انتخاب نیست.');
    }
    if (rawPassword.length < 8) {
      throw new StoreError(400, 'رمز عبور باید حداقل ۸ کاراکتر باشد.');
    }
    if (rawPassword.length > 128) {
      throw new StoreError(400, 'رمز عبور نمی‌تواند بیشتر از ۱۲۸ کاراکتر باشد.');
    }

    const existing = this.db
      .prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1')
      .get(cleanUsername) as { id: number } | undefined;

    if (existing) {
      throw new StoreError(
        409,
        'این نام کاربری قبلاً ثبت شده است. لطفاً نام دیگری انتخاب کنید یا وارد حساب خود شوید.'
      );
    }

    const passwordHash = hashPassword(rawPassword);
    const userUuid = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    const insertResult = this.db
      .prepare(
        `INSERT INTO users (user_uuid, username, password_hash, first_name, role, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'user', 'active', ?, ?)`
      )
      .run(userUuid, cleanUsername, passwordHash, cleanUsername, nowIso, nowIso);

    const userId = Number(insertResult.lastInsertRowid);
    const user = this.db
      .prepare('SELECT * FROM users WHERE id = ? LIMIT 1')
      .get(userId) as UserRow;

    const sub = this.ensureSubscriptionForUser(user.id);
    this.registerOrUpdateDevice(
      user.id,
      sub,
      input.device_identifier,
      input.device_name,
      input.os
    );

    return this.formatAuthResponse(user, sub);
  }

  loginUser(input: AuthCredentialsInput): AuthResponsePayload {
    const identifier = normalizeLoginIdentifier(input.username || '');
    const rawPassword = typeof input.password === 'string' ? input.password : '';

    if (!identifier || !rawPassword) {
      throw new StoreError(400, 'لطفاً نام کاربری و رمز عبور خود را وارد نمایید.');
    }

    const user = this.db
      .prepare(
        'SELECT * FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?) LIMIT 1'
      )
      .get(identifier, identifier) as UserRow | undefined;

    if (!user) {
      throw new StoreError(401, 'نام کاربری یا رمز عبور اشتباه است.');
    }

    if (!user.password_hash) {
      throw new StoreError(
        401,
        'برای این حساب کاربری رمز عبور ثبت نشده است. لطفاً از طریق کد یک‌بار مصرف وارد شوید.'
      );
    }

    const trimmedPassword = rawPassword.trim();
    const valid =
      verifyPassword(rawPassword, user.password_hash) ||
      (trimmedPassword !== rawPassword && verifyPassword(trimmedPassword, user.password_hash));

    if (!valid) {
      throw new StoreError(401, 'نام کاربری یا رمز عبور اشتباه است.');
    }

    if (user.status === 'suspended') {
      throw new StoreError(
        403,
        'حساب کاربری شما موقتاً مسدود شده است. لطفاً با پشتیبانی در ارتباط باشید.',
        'ACCOUNT_SUSPENDED'
      );
    }
    if (user.status === 'banned') {
      throw new StoreError(403, 'حساب کاربری شما مسدود شده است.');
    }

    const sub = this.ensureSubscriptionForUser(user.id);
    this.registerOrUpdateDevice(
      user.id,
      sub,
      input.device_identifier,
      input.device_name,
      input.os
    );

    return this.formatAuthResponse(user, sub);
  }

  loginWithCode(input: {
    code: string;
    device_identifier?: string;
    device_name?: string;
    os?: string;
  }): AuthResponsePayload {
    const cleanCode = (input.code || '').trim();
    if (!/^\d{8}$/.test(cleanCode)) {
      throw new StoreError(400, 'کد ورود باید دقیقاً ۸ رقم عددی باشد.');
    }

    const nowIso = new Date().toISOString();
    const user = this.db
      .prepare(
        'SELECT * FROM users WHERE auth_code = ? AND auth_code_expires_at > ? LIMIT 1'
      )
      .get(cleanCode, nowIso) as UserRow | undefined;

    if (!user) {
      throw new StoreError(401, 'کد ورود نامعتبر است یا منقضی شده است.');
    }

    if (user.status === 'suspended' || user.status === 'banned') {
      throw new StoreError(403, 'حساب کاربری شما مسدود یا تعلیق شده است.', 'ACCOUNT_SUSPENDED');
    }

    this.db
      .prepare('UPDATE users SET auth_code = NULL, auth_code_expires_at = NULL WHERE id = ?')
      .run(user.id);

    const sub = this.ensureSubscriptionForUser(user.id);
    this.registerOrUpdateDevice(
      user.id,
      sub,
      input.device_identifier,
      input.device_name,
      input.os
    );

    return this.formatAuthResponse(user, sub);
  }

  issueAuthCodeForUser(userId: number): string {
    const code = String(crypto.randomInt(10_000_000, 100_000_000));
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    this.db
      .prepare('UPDATE users SET auth_code = ?, auth_code_expires_at = ? WHERE id = ?')
      .run(code, expiresAt, userId);
    return code;
  }

  createEmailUserForTest(email: string, password: string, firstName = 'Email User'): number {
    const cleanEmail = email.trim().toLowerCase();
    const hash = hashPassword(password);
    const uuid = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    const res = this.db
      .prepare(
        `INSERT INTO users (user_uuid, username, email, password_hash, first_name, role, status, created_at, updated_at)
         VALUES (?, NULL, ?, ?, ?, 'user', 'active', ?, ?)`
      )
      .run(uuid, cleanEmail, hash, firstName, nowIso, nowIso);
    const userId = Number(res.lastInsertRowid);
    this.ensureSubscriptionForUser(userId);
    return userId;
  }

  private resolveAuthenticatedUser(rawToken: string | undefined | null): {
    user: UserRow;
    sub: SubscriptionRow;
  } {
    const token = normalizeSubscriptionToken(rawToken);
    if (!token) {
      throw new StoreError(401, 'توکن احراز هویت نامعتبر است. لطفاً دوباره وارد شوید.');
    }

    const rawSub = this.db
      .prepare('SELECT * FROM subscriptions WHERE token = ? LIMIT 1')
      .get(token) as SubscriptionRow | undefined;

    if (!rawSub) {
      throw new StoreError(401, 'نشست کاربری معتبر نیست یا منقضی شده است.');
    }

    const user = this.db
      .prepare('SELECT * FROM users WHERE id = ? LIMIT 1')
      .get(rawSub.user_id) as UserRow | undefined;

    if (!user) {
      throw new StoreError(401, 'حساب کاربری مرتبط با این نشست یافت نشد.');
    }

    if (user.status === 'suspended' || user.status === 'banned') {
      throw new StoreError(403, 'حساب کاربری شما مسدود یا تعلیق شده است.', 'ACCOUNT_SUSPENDED');
    }

    const sub = this.checkAndResetDailyQuota(rawSub);
    return { user, sub };
  }

  private readClientStateRow(userId: number): SyncedClientStatePayload {
    const row = this.db
      .prepare(
        'SELECT user_id, personal_configs_json, preferences_json, updated_at FROM user_client_state WHERE user_id = ? LIMIT 1'
      )
      .get(userId) as ClientStateRow | undefined;

    if (!row) {
      return {
        personal_configs: [],
        preferences: {},
        updated_at: '',
      };
    }

    let personalConfigs: unknown[] = [];
    let preferences: Record<string, unknown> = {};
    try {
      personalConfigs = sanitizePersonalConfigs(JSON.parse(row.personal_configs_json));
    } catch {
      personalConfigs = [];
    }
    try {
      preferences = sanitizeSyncPreferences(JSON.parse(row.preferences_json));
    } catch {
      preferences = {};
    }

    return {
      personal_configs: personalConfigs,
      preferences,
      updated_at: row.updated_at,
    };
  }

  getClientSyncState(rawToken: string | undefined | null): {
    success: true;
    client_state: SyncedClientStatePayload;
  } {
    const { user } = this.resolveAuthenticatedUser(rawToken);
    return {
      success: true,
      client_state: this.readClientStateRow(user.id),
    };
  }

  updateClientSyncState(
    rawToken: string | undefined | null,
    payload: { personal_configs?: unknown; preferences?: unknown }
  ): {
    success: true;
    client_state: SyncedClientStatePayload;
  } {
    const { user } = this.resolveAuthenticatedUser(rawToken);
    const current = this.readClientStateRow(user.id);

    const nextConfigs =
      payload.personal_configs !== undefined
        ? sanitizePersonalConfigs(payload.personal_configs)
        : current.personal_configs;
    const nextPrefs =
      payload.preferences !== undefined
        ? { ...current.preferences, ...sanitizeSyncPreferences(payload.preferences) }
        : current.preferences;

    const nowIso = new Date().toISOString();
    const configsJson = JSON.stringify(nextConfigs);
    const prefsJson = JSON.stringify(nextPrefs);

    this.db
      .prepare(
        `INSERT INTO user_client_state (user_id, personal_configs_json, preferences_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           personal_configs_json = excluded.personal_configs_json,
           preferences_json = excluded.preferences_json,
           updated_at = excluded.updated_at`
      )
      .run(user.id, configsJson, prefsJson, nowIso);

    return {
      success: true,
      client_state: {
        personal_configs: nextConfigs,
        preferences: nextPrefs,
        updated_at: nowIso,
      },
    };
  }

  processHeartbeat(
    rawToken: string | undefined | null,
    input: HeartbeatInput
  ): HeartbeatVerdict {
    const { user, sub } = this.resolveAuthenticatedUser(rawToken);
    const cleanDeviceId = (input.device_id || '').trim();
    if (!cleanDeviceId) {
      throw new StoreError(400, 'شناسه دستگاه ارسال نشده است.');
    }

    const devRow = this.db
      .prepare('SELECT id FROM user_devices WHERE user_id = ? AND device_id = ? LIMIT 1')
      .get(user.id, cleanDeviceId) as { id: number } | undefined;

    if (!devRow) {
      return {
        action: 'disconnect',
        code: 'DEVICE_REVOKED',
        message: 'این دستگاه از فهرست دستگاه‌های مجاز حساب شما حذف شده است.',
      };
    }

    const mode =
      input.mode === 'download' || input.mode === 'static_ip' ? input.mode : 'web_browsing';
    const deltaUp = Math.max(0, Math.trunc(Number(input.delta_upload_bytes || 0)));
    const deltaDown = Math.max(0, Math.trunc(Number(input.delta_download_bytes || 0)));
    const deltaTotal = deltaUp + deltaDown;
    const deltaMb = deltaTotal > 0 ? Math.ceil(deltaTotal / 1_048_576) : 0;

    const deltaWb = mode === 'web_browsing' ? deltaMb : 0;
    const deltaDl = mode === 'download' ? deltaMb : 0;
    const deltaStatic = mode === 'static_ip' ? deltaMb : 0;
    const nowIso = new Date().toISOString();

    let updatedUp = sub.upload_bytes;
    let updatedDown = sub.download_bytes;
    let updatedWb = sub.web_browsing_used_mb;
    let updatedDl = sub.download_used_mb;
    let updatedStatic = sub.static_ip_used_mb;

    if (deltaTotal > 0) {
      this.db
        .prepare(
          `UPDATE subscriptions
           SET upload_bytes = upload_bytes + ?,
               download_bytes = download_bytes + ?,
               web_browsing_used_mb = web_browsing_used_mb + ?,
               download_used_mb = download_used_mb + ?,
               static_ip_used_mb = static_ip_used_mb + ?,
               updated_at = ?
           WHERE id = ?`
        )
        .run(deltaUp, deltaDown, deltaWb, deltaDl, deltaStatic, nowIso, sub.id);

      this.db
        .prepare(
          'INSERT INTO traffic_logs (subscription_id, bytes_sent, bytes_received, recorded_at) VALUES (?, ?, ?, ?)'
        )
        .run(sub.id, deltaUp, deltaDown, nowIso);

      updatedUp += deltaUp;
      updatedDown += deltaDown;
      updatedWb += deltaWb;
      updatedDl += deltaDl;
      updatedStatic += deltaStatic;
    }

    this.db
      .prepare('UPDATE user_devices SET last_active_at = ? WHERE id = ?')
      .run(nowIso, devRow.id);

    if (mode === 'static_ip') {
      if (sub.tier === 'Sentra Lite') {
        return {
          action: 'disconnect',
          code: 'MODE_LOCKED',
          message: 'حالت آی‌پی ثابت اختصاصی نیاز به ارتقا به اشتراک Pro دارد.',
        };
      }
      if (updatedStatic >= 30_720) {
        return {
          action: 'disconnect',
          code: 'STATIC_IP_QUOTA_EXCEEDED',
          message: 'سقف حجم ۳۰ گیگابایت آی‌پی ثابت اختصاصی شما به پایان رسید.',
        };
      }
    } else if (sub.tier === 'Sentra Lite') {
      if (mode === 'web_browsing' && updatedWb >= 2048) {
        return {
          action: 'disconnect',
          code: 'QUOTA_EXCEEDED',
          message: 'سقف حجم روزانه ۲ گیگابایت وب‌گردی به پایان رسید.',
        };
      }
      if (mode === 'download' && updatedDl >= 3072) {
        return {
          action: 'disconnect',
          code: 'QUOTA_EXCEEDED',
          message: 'سقف حجم روزانه ۳ گیگابایت دانلود به پایان رسید.',
        };
      }
    }

    const totalUsed = updatedUp + updatedDown;
    if (sub.tier === 'Sentra Lite' && sub.traffic_limit_bytes > 0 && totalUsed >= sub.traffic_limit_bytes) {
      return {
        action: 'disconnect',
        code: 'PACKAGE_DEPLETED',
        message: 'حجم کلی بسته اشتراک شما به پایان رسیده است.',
      };
    }

    const remainingBytes =
      sub.tier === 'Sentra Lite'
        ? Math.max(0, sub.traffic_limit_bytes - totalUsed)
        : 999_999_999_999;

    return {
      action: 'continue',
      remaining_bytes: remainingBytes,
      upload_bytes: updatedUp,
      download_bytes: updatedDown,
      used_bytes: totalUsed,
      web_browsing_used_mb: updatedWb,
      download_used_mb: updatedDl,
      static_ip_used_mb: updatedStatic,
      static_ip_remaining_mb: sub.tier === 'Sentra Lite' ? 0 : Math.max(0, 30_720 - updatedStatic),
    };
  }

  recordTelemetry(
    rawToken: string | undefined | null,
    payload: { bytes_delta?: number; device_id?: string }
  ): { success: true; status: 'normal' } {
    const { user, sub } = this.resolveAuthenticatedUser(rawToken);
    const bytesDelta = Math.max(0, Math.trunc(Number(payload.bytes_delta || 0)));
    const nowIso = new Date().toISOString();

    if (bytesDelta > 0) {
      this.db
        .prepare(
          'UPDATE subscriptions SET download_bytes = download_bytes + ?, updated_at = ? WHERE id = ?'
        )
        .run(bytesDelta, nowIso, sub.id);
      this.db
        .prepare(
          'INSERT INTO traffic_logs (subscription_id, bytes_sent, bytes_received, recorded_at) VALUES (?, 0, ?, ?)'
        )
        .run(sub.id, bytesDelta, nowIso);
    }

    if (payload.device_id && payload.device_id.trim()) {
      this.db
        .prepare('UPDATE user_devices SET last_active_at = ? WHERE user_id = ? AND device_id = ?')
        .run(nowIso, user.id, payload.device_id.trim());
    }

    return { success: true, status: 'normal' };
  }

  generateLinkCode(rawToken: string | undefined | null): {
    success: true;
    link_code: string;
    expires_in_seconds: number;
    instructions: string;
  } {
    const { user } = this.resolveAuthenticatedUser(rawToken);
    const linkCode = String(crypto.randomInt(100_000, 1_000_000));
    const expiresAt = new Date(Date.now() + 300 * 1000).toISOString();

    this.db
      .prepare('UPDATE users SET link_code = ?, link_code_expires_at = ? WHERE id = ?')
      .run(linkCode, expiresAt, user.id);

    return {
      success: true,
      link_code: linkCode,
      expires_in_seconds: 300,
      instructions:
        'این کد ۶ رقمی را ظرف ۵ دقیقه در ربات تلگرام با دستور /link وارد فرمایید.',
    };
  }

  getClientModes(rawToken: string | undefined | null) {
    const { sub } = this.resolveAuthenticatedUser(rawToken);
    return {
      success: true,
      modes: this.buildModes(sub),
    };
  }

  getClientDevices(rawToken: string | undefined | null) {
    const { user, sub } = this.resolveAuthenticatedUser(rawToken);
    const devices = this.db
      .prepare(
        `SELECT id, device_id, device_name, platform, last_active_at, created_at
         FROM user_devices WHERE user_id = ? ORDER BY last_active_at DESC`
      )
      .all(user.id) as unknown as DeviceRow[];

    return {
      success: true,
      devices,
      count: devices.length,
      max_allowed: Math.max(3, sub.max_concurrent_devices || DEFAULT_MAX_DEVICES),
    };
  }

  getBootstrap(rawToken: string | undefined | null, deviceId?: string) {
    const { user, sub } = this.resolveAuthenticatedUser(rawToken);

    if (deviceId && deviceId.trim()) {
      this.db
        .prepare('UPDATE user_devices SET last_active_at = ? WHERE user_id = ? AND device_id = ?')
        .run(new Date().toISOString(), user.id, deviceId.trim());
    }

    const devices = this.db
      .prepare(
        `SELECT id, device_id, device_name, platform, last_active_at, created_at
         FROM user_devices WHERE user_id = ? ORDER BY last_active_at DESC`
      )
      .all(user.id) as unknown as DeviceRow[];

    const activeOutbounds = this.getActiveEcosystemOutboundsList();

    const usedBytes = sub.upload_bytes + sub.download_bytes;
    const remainingBytes = Math.max(0, sub.traffic_limit_bytes - usedBytes);
    const remainingDays = Math.max(
      0,
      Math.ceil((Date.parse(sub.expires_at) - Date.now()) / (24 * 60 * 60 * 1000))
    );

    return {
      success: true,
      server_time: new Date().toISOString(),
      bot_username: process.env.TELEGRAM_BOT_USERNAME || process.env.BOT_USERNAME || 'SentraVpnBot',
      user: {
        id: user.id,
        user_uuid: user.user_uuid,
        username: user.username,
        first_name: user.first_name,
        telegram_id: user.telegram_id,
        role: user.role,
        status: user.status,
      },
      subscription: {
        tier: sub.tier,
        token: sub.token,
        status: sub.status,
        upload_bytes: sub.upload_bytes,
        download_bytes: sub.download_bytes,
        used_bytes: usedBytes,
        traffic_limit_bytes: sub.traffic_limit_bytes,
        remaining_bytes: remainingBytes,
        web_browsing_used_mb: sub.web_browsing_used_mb,
        download_used_mb: sub.download_used_mb,
        static_ip_used_mb: sub.static_ip_used_mb,
        active_devices_count: devices.length,
        max_concurrent_devices: Math.max(3, sub.max_concurrent_devices || DEFAULT_MAX_DEVICES),
        remaining_days: remainingDays,
        expires_at: sub.expires_at,
      },
      devices,
      modes: this.buildModes(sub),
      outbounds: activeOutbounds,
      client_state: this.readClientStateRow(user.id),
    };
  }

  private getActiveEcosystemOutboundsList() {
    const donatedRows = this.db
      .prepare(
        `SELECT id,
                COALESCE(NULLIF(label, ''), NULLIF(name, ''), NULLIF(tag, ''), protocol) as name,
                COALESCE(NULLIF(tag, ''), NULLIF(label, ''), NULLIF(name, ''), protocol) as tag,
                protocol, assigned_tier, country_code, country_name, flag, latency_ms, health_score,
                is_official, server_address, server_port, raw_link, config_json,
                allow_web, allow_download, allow_static_ip
         FROM donated_outbounds
         WHERE status IN ('active', 'approved')
         ORDER BY is_official DESC, speed_score DESC, latency_ms ASC, id DESC`
      )
      .all() as Array<{
      id: number;
      name: string;
      tag: string;
      protocol: string;
      assigned_tier: string | null;
      country_code: string | null;
      country_name: string | null;
      flag: string | null;
      latency_ms: number;
      health_score: number;
      is_official: number;
      server_address: string;
      server_port: number;
      raw_link: string | null;
      config_json: string | null;
      allow_web: number;
      allow_download: number;
      allow_static_ip: number;
    }>;

    const coreRows = this.db
      .prepare(
        `SELECT id, tag, protocol, server_address, server_port, uuid, tier_access
         FROM outbounds
         WHERE is_active = 1 AND server_address != '127.0.0.1'
         ORDER BY id ASC`
      )
      .all() as Array<{
      id: number;
      tag: string;
      protocol: string;
      server_address: string;
      server_port: number;
      uuid: string | null;
      tier_access: string;
    }>;

    const result = donatedRows.map((o) => ({
      id: `node-${o.id}`,
      db_id: o.id,
      name: o.name,
      tag: o.tag,
      protocol: o.protocol,
      category: o.assigned_tier || 'web_browsing',
      country_code: o.country_code || 'XX',
      country_name: o.country_name || 'Global',
      flag: o.flag || '🌐',
      latency_ms: o.latency_ms || 0,
      health_score: o.health_score || 100,
      is_official: o.is_official === 1,
      is_online: true,
      server_address: o.server_address,
      server_port: o.server_port,
      uri: o.raw_link,
    }));

    for (const c of coreRows) {
      let uri = `${c.protocol.toLowerCase()}://${c.server_address}:${c.server_port}#${encodeURIComponent(c.tag)}`;
      if (c.protocol.toLowerCase() === 'vless') {
        uri = `vless://${c.uuid || '00000000-0000-0000-0000-000000000000'}@${c.server_address}:${c.server_port}?security=reality&type=tcp#${encodeURIComponent(c.tag)}`;
      }
      result.push({
        id: `core-${c.id}`,
        db_id: c.id,
        name: c.tag,
        tag: c.tag,
        protocol: c.protocol.toUpperCase(),
        category: 'web_browsing',
        country_code: 'XX',
        country_name: 'Sentra Core',
        flag: '🛡️',
        latency_ms: 0,
        health_score: 100,
        is_official: true,
        is_online: true,
        server_address: c.server_address,
        server_port: c.server_port,
        uri,
      });
    }

    return result;
  }

  getClientLocations() {
    const outbounds = this.getActiveEcosystemOutboundsList();
    const byCountry = new Map<
      string,
      {
        country_code: string;
        country_name: string;
        flag: string;
        node_count: number;
        best_latency_ms: number;
      }
    >();

    for (const o of outbounds) {
      const code = (o.country_code || 'XX').toUpperCase();
      const existing = byCountry.get(code);
      if (!existing) {
        byCountry.set(code, {
          country_code: code,
          country_name: o.country_name || 'Global',
          flag: o.flag || '🌐',
          node_count: 1,
          best_latency_ms: o.latency_ms || 0,
        });
      } else {
        existing.node_count += 1;
        if (o.latency_ms > 0 && (existing.best_latency_ms === 0 || o.latency_ms < existing.best_latency_ms)) {
          existing.best_latency_ms = o.latency_ms;
        }
      }
    }

    return {
      success: true,
      locations: Array.from(byCountry.values()),
    };
  }

  compileClientConfig(
    rawToken: string | undefined | null,
    payload: {
      mode?: string;
      protocol?: string;
      location_code?: string;
      use_warp?: boolean;
      selected_outbound_id?: string | null;
      personal_uri?: string | null;
    }
  ) {
    const { sub } = this.resolveAuthenticatedUser(rawToken);
    const requestedMode =
      payload.mode === 'download' ||
      payload.mode === 'static_ip' ||
      payload.mode === 'gaming'
        ? payload.mode
        : 'web_browsing';

    if (requestedMode === 'gaming') {
      if (!this.hasActiveGamingOutbounds()) {
        throw new StoreError(
          403,
          'بخش گیمینگ به زودی اضافه می‌شود.',
          'MODE_COMING_SOON'
        );
      }
      if (!tierHasGaming(sub.tier)) {
        throw new StoreError(
          403,
          'حالت گیمینگ کم‌پینگ نیازمند اشتراک گیمینگ، Pro یا Flow+ است.',
          'MODE_LOCKED'
        );
      }
    }

    if (requestedMode === 'static_ip' && !tierHasStaticIp(sub.tier)) {
      throw new StoreError(
        403,
        'حالت آی‌پی ثابت اختصاصی نیازمند اشتراک آی‌پی ثابت، Pro یا Flow+ است.',
        'MODE_LOCKED'
      );
    }

    const singboxOutbounds: Array<Record<string, unknown>> = [];
    const outboundTags: string[] = [];
    const usedTags = new Set<string>();

    const makeUniqueTag = (base: string): string => {
      if (!usedTags.has(base)) {
        usedTags.add(base);
        return base;
      }
      let idx = 2;
      while (usedTags.has(`${base} (${idx})`)) idx += 1;
      const candidate = `${base} (${idx})`;
      usedTags.add(candidate);
      return candidate;
    };

    let hasExplicitSelection = false;

    // 1. Optional personal URI (validated against Anti-SSRF)
    if (payload.personal_uri && typeof payload.personal_uri === 'string' && payload.personal_uri.trim()) {
      const parsed = parseDonatedUri(payload.personal_uri);
      const tag = makeUniqueTag(`Personal ${parsed.name}`);
      const obj = JSON.parse(parsed.config_json) as Record<string, unknown>;
      obj.tag = tag;
      outboundTags.push(tag);
      singboxOutbounds.push(obj);
      hasExplicitSelection = true;
    }

    // 2. Load active ecosystem outbounds (for gaming mode, prioritize gaming-allocated outbounds)
    const donatedSql =
      requestedMode === 'gaming'
        ? `SELECT id,
                  COALESCE(NULLIF(label, ''), NULLIF(name, ''), NULLIF(tag, ''), protocol) as display_name,
                  protocol, server_address, server_port, raw_link, config_json, is_official
           FROM donated_outbounds
           WHERE status IN ('active', 'approved')
             AND (allow_gaming = 1 OR assigned_tier = 'gaming' OR allocation_mode IN ('gaming_only', 'gaming', 'all'))
           ORDER BY is_official DESC, CASE WHEN latency_ms > 0 THEN latency_ms ELSE 9999 END ASC, speed_score DESC, id DESC`
        : `SELECT id,
                  COALESCE(NULLIF(label, ''), NULLIF(name, ''), NULLIF(tag, ''), protocol) as display_name,
                  protocol, server_address, server_port, raw_link, config_json, is_official
           FROM donated_outbounds
           WHERE status IN ('active', 'approved')
           ORDER BY is_official DESC, speed_score DESC, latency_ms ASC, id DESC`;
    const donatedRows = this.db.prepare(donatedSql).all() as Array<{
      id: number;
      display_name: string;
      protocol: string;
      server_address: string;
      server_port: number;
      raw_link: string | null;
      config_json: string | null;
      is_official: number;
    }>;

    // Prioritize selected_outbound_id if it references node-*
    const selId = payload.selected_outbound_id || '';
    if (selId.startsWith('node-')) {
      const targetId = Number(selId.slice('node-'.length));
      const idx = donatedRows.findIndex((r) => r.id === targetId);
      if (idx > 0) {
        const [picked] = donatedRows.splice(idx, 1);
        donatedRows.unshift(picked);
        hasExplicitSelection = true;
      } else if (idx === 0) {
        hasExplicitSelection = true;
      }
    }

    for (const row of donatedRows) {
      let obj: Record<string, unknown> | null = null;
      if (row.config_json && row.config_json.trim().startsWith('{') && row.config_json.trim() !== '{}') {
        try {
          obj = JSON.parse(row.config_json) as Record<string, unknown>;
        } catch {
          obj = null;
        }
      }
      if (!obj && row.raw_link) {
        try {
          const parsed = parseDonatedUri(row.raw_link);
          obj = JSON.parse(parsed.config_json) as Record<string, unknown>;
        } catch {
          obj = null;
        }
      }
      if (!obj) {
        obj = {
          type: row.protocol.toLowerCase(),
          server: row.server_address,
          server_port: row.server_port,
        };
      }
      const prefix = row.is_official === 1 ? '👑 ' : '🤝 ';
      const tag = makeUniqueTag(`${prefix}${row.display_name}`);
      obj.tag = tag;
      outboundTags.push(tag);
      singboxOutbounds.push(obj);
    }

    // 3. Core outbounds table (non-loopback)
    const coreRows = this.db
      .prepare(
        `SELECT id, tag, protocol, server_address, server_port, uuid
         FROM outbounds
         WHERE is_active = 1 AND server_address != '127.0.0.1'
         ORDER BY id ASC`
      )
      .all() as Array<{
      id: number;
      tag: string;
      protocol: string;
      server_address: string;
      server_port: number;
      uuid: string | null;
    }>;

    for (const c of coreRows) {
      const tag = makeUniqueTag(c.tag);
      const obj: Record<string, unknown> =
        c.protocol.toLowerCase() === 'vless'
          ? {
              type: 'vless',
              tag,
              server: c.server_address,
              server_port: c.server_port,
              uuid: c.uuid || '00000000-0000-0000-0000-000000000000',
              flow: '',
              packet_encoding: 'xudp',
            }
          : {
              type: c.protocol.toLowerCase(),
              tag,
              server: c.server_address,
              server_port: c.server_port,
            };
      if (selId === `core-${c.id}`) {
        outboundTags.unshift(tag);
        singboxOutbounds.unshift(obj);
        hasExplicitSelection = true;
      } else {
        outboundTags.push(tag);
        singboxOutbounds.push(obj);
      }
    }

    const selectDefault =
      hasExplicitSelection && outboundTags.length > 0 ? outboundTags[0] : 'Sentra Auto';

    const isGaming = requestedMode === 'gaming';

    const allOutbounds: Array<Record<string, unknown>> = [
      {
        type: 'selector',
        tag: 'Sentra Select',
        outbounds: ['Sentra Auto', ...outboundTags, 'direct'],
        default: selectDefault,
      },
      {
        type: 'urltest',
        tag: 'Sentra Auto',
        outbounds: outboundTags.length > 0 ? outboundTags : ['direct'],
        url: 'https://www.gstatic.com/generate_204',
        interval: isGaming ? '1m' : '3m',
        tolerance: isGaming ? 15 : 50,
      },
      ...singboxOutbounds,
      { type: 'direct', tag: 'direct' },
      { type: 'block', tag: 'block' },
      { type: 'dns', tag: 'dns-out' },
    ];

    const singboxConfig = {
      log: { level: isGaming ? 'warn' : 'info', timestamp: true },
      dns: isGaming
        ? {
            servers: [
              {
                tag: 'dns-remote',
                address: 'udp://1.1.1.1',
                strategy: 'ipv4_only',
                detour: 'Sentra Select',
              },
              {
                tag: 'dns-remote-backup',
                address: 'udp://8.8.8.8',
                strategy: 'ipv4_only',
                detour: 'Sentra Select',
              },
              { tag: 'dns-direct', address: 'local', detour: 'direct' },
            ],
            rules: [
              { outbound: 'any', server: 'dns-remote' },
              { domain_suffix: ['.ir'], server: 'dns-direct' },
            ],
            final: 'dns-remote',
            strategy: 'ipv4_only',
            independent_cache: true,
          }
        : {
            servers: [
              { tag: 'dns-remote', address: 'https://1.1.1.1/dns-query', detour: 'Sentra Select' },
              { tag: 'dns-direct', address: 'local', detour: 'direct' },
              { tag: 'dns-block', address: 'rcode://success' },
            ],
            rules: [
              { outbound: 'any', server: 'dns-direct' },
              { domain_suffix: ['.ir'], server: 'dns-direct' },
            ],
            final: 'dns-remote',
            strategy: 'prefer_ipv4',
          },
      inbounds: [
        isGaming
          ? {
              type: 'tun',
              tag: 'tun-in',
              interface_name: 'sentra0',
              inet4_address: '172.19.0.1/30',
              mtu: 1280,
              auto_route: true,
              strict_route: true,
              stack: 'system',
              endpoint_independent_nat: true,
              udp_timeout: '5m',
              sniff: false,
              sniff_override_destination: false,
            }
          : {
              type: 'tun',
              tag: 'tun-in',
              interface_name: 'sentra0',
              inet4_address: '172.19.0.1/30',
              mtu: 1400,
              auto_route: true,
              strict_route: true,
              stack: 'system',
              sniff: true,
            },
        {
          type: 'mixed',
          tag: 'mixed-in',
          listen: '127.0.0.1',
          listen_port: 2080,
          sniff: !isGaming,
        },
      ],
      outbounds: allOutbounds,
      route: {
        auto_detect_interface: true,
        final: 'Sentra Select',
        rules: [
          { protocol: 'dns', outbound: 'dns-out' },
          { domain_suffix: ['.ir', '.local'], outbound: 'direct' },
          { ip_is_private: true, outbound: 'direct' },
        ],
      },
      experimental: {
        clash_api: {
          external_controller: '127.0.0.1:9090',
          secret: 'sentra_internal_traffic_secret',
        },
      },
    };

    return {
      success: true,
      mode: requestedMode,
      tier: sub.tier,
      use_warp: isGaming || requestedMode === 'static_ip' ? false : Boolean(payload.use_warp),
      gaming_optimized: isGaming,
      active_outbounds_count: outboundTags.length,
      singbox_config: singboxConfig,
      outbounds: this.getActiveEcosystemOutboundsList(),
    };
  }

  generateWireguardGamingProfile(
    rawToken: string | undefined | null,
    serverHost = '127.0.0.1'
  ): {
    filename: string;
    config: string;
    client_public_key: string;
    client_address: string;
    tier: string;
  } {
    const { sub } = this.resolveAuthenticatedUser(rawToken);
    if (!this.hasActiveGamingOutbounds()) {
      throw new StoreError(
        403,
        'بخش گیمینگ به زودی اضافه می‌شود.',
        'MODE_COMING_SOON'
      );
    }
    if (!tierHasGaming(sub.tier)) {
      throw new StoreError(
        403,
        'کانفیگ گیمینگ WireGuard مختص کاربران دارای اشتراک گیمینگ، Pro یا Flow+ است.',
        'MODE_LOCKED'
      );
    }

    const salt = (process.env.WIREGUARD_KEY_SALT || 'sentra-gaming-wg-v1').trim();
    const clientSeed = crypto
      .createHash('sha256')
      .update(`${salt}:client:${sub.token}`)
      .digest();
    const clientPair = deriveX25519KeypairFromSeed(clientSeed);

    const envPub = (process.env.WIREGUARD_SERVER_PUBLIC_KEY || '').trim();
    const envPriv = (process.env.WIREGUARD_SERVER_PRIVATE_KEY || '').trim();
    let serverPub = envPub;
    if (!serverPub && envPriv) {
      const decoded = Buffer.from(envPriv, 'base64');
      if (decoded.length === 32) {
        serverPub = deriveX25519KeypairFromSeed(decoded).publicKeyB64;
      }
    }
    const cleanHost =
      !serverHost || serverHost === '0.0.0.0' ? '127.0.0.1' : serverHost.trim();
    if (!serverPub) {
      const fallbackSeed = crypto
        .createHash('sha256')
        .update(`sentra-wg-server-pub:${cleanHost}`)
        .digest();
      serverPub = deriveX25519KeypairFromSeed(fallbackSeed).publicKeyB64;
    }

    const ipDigest = crypto
      .createHash('sha256')
      .update(`sentra-wg-ip:${sub.token}`)
      .digest();
    const clientAddress = `10.66.${ipDigest[0]}.${(ipDigest[1] % 250) + 2}/32`;
    const wgPort = Number(process.env.WIREGUARD_PORT) > 0 ? Number(process.env.WIREGUARD_PORT) : 51820;
    const tokenPrefix = sub.token.slice(0, 8);

    const config = [
      '# ==============================================================================',
      '# Sentra Gaming - WireGuard Profile (iOS Ultra-Low Latency)',
      `# Tier: ${sub.tier} | Mode: gaming`,
      `# Client Public Key: ${clientPair.publicKeyB64}`,
      `# Generated: ${new Date().toISOString()}`,
      '# ==============================================================================',
      '[Interface]',
      `PrivateKey = ${clientPair.privateKeyB64}`,
      `Address = ${clientAddress}`,
      'DNS = 1.1.1.1, 8.8.8.8',
      'MTU = 1280',
      '',
      '[Peer]',
      `PublicKey = ${serverPub}`,
      `Endpoint = ${cleanHost}:${wgPort}`,
      'AllowedIPs = 0.0.0.0/0',
      'PersistentKeepalive = 25',
      '',
    ].join('\n');

    return {
      filename: `sentra-gaming-wg-${tokenPrefix}.conf`,
      config,
      client_public_key: clientPair.publicKeyB64,
      client_address: clientAddress,
      tier: sub.tier,
    };
  }

  getSubscriptionPayload(
    token: string,
    format?: string,
    userAgent = ''
  ): {
    contentType: string;
    body: string;
    subUserInfo: string;
    isSingbox: boolean;
  } {
    const { sub } = this.resolveAuthenticatedUser(token);
    const expireTs = Math.floor(Date.parse(sub.expires_at) / 1000) || 0;
    const subUserInfo = `upload=${sub.upload_bytes}; download=${sub.download_bytes}; total=${sub.traffic_limit_bytes}; expire=${expireTs}`;

    const lowerFormat = (format || '').toLowerCase();
    const lowerUa = userAgent.toLowerCase();
    const wantsSingbox =
      lowerFormat === 'singbox' ||
      lowerFormat === 'sing-box' ||
      lowerUa.includes('sing-box') ||
      lowerUa.includes('singbox');

    if (wantsSingbox) {
      const compiled = this.compileClientConfig(token, { mode: 'web_browsing' });
      return {
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(compiled.singbox_config, null, 2),
        subUserInfo,
        isSingbox: true,
      };
    }

    const outbounds = this.getActiveEcosystemOutboundsList();
    const seen = new Set<string>();
    const lines: string[] = [];

    for (const o of outbounds) {
      const prefix = o.is_official ? '👑 ' : '🤝 ';
      const taggedName = `${prefix}${o.name}`;
      let uri = (o.uri || '').trim();
      if (uri) {
        if (!uri.toLowerCase().startsWith('vmess://')) {
          const base = uri.split('#')[0];
          uri = `${base}#${encodeURIComponent(taggedName)}`;
        }
      } else {
        uri = `${o.protocol.toLowerCase()}://${o.server_address}:${o.server_port}#${encodeURIComponent(taggedName)}`;
      }
      if (!seen.has(uri)) {
        seen.add(uri);
        lines.push(uri);
      }
    }

    return {
      contentType: 'text/plain; charset=utf-8',
      body: Buffer.from(lines.join('\n'), 'utf8').toString('base64'),
      subUserInfo,
      isSingbox: false,
    };
  }

  removeDevice(rawToken: string | undefined | null, deviceId: string): { success: true } {
    const { user } = this.resolveAuthenticatedUser(rawToken);
    const cleaned = (deviceId || '').trim();
    if (!cleaned) {
      throw new StoreError(400, 'شناسه دستگاه نامعتبر است.');
    }

    const result = this.db
      .prepare('DELETE FROM user_devices WHERE user_id = ? AND device_id = ?')
      .run(user.id, cleaned);

    if (result.changes === 0) {
      throw new StoreError(404, 'دستگاه مورد نظر یافت نشد.');
    }

    return { success: true };
  }

  donateOutbound(
    rawToken: string | undefined | null,
    payload: { uri: string; name?: string; note?: string }
  ): { success: true; id: number; status: string; latency_ms: number; message: string } {
    const { user } = this.resolveAuthenticatedUser(rawToken);
    if (!payload.uri || typeof payload.uri !== 'string' || !payload.uri.trim()) {
      throw new StoreError(400, 'لینک کانفیگ نمی‌تواند خالی باشد.');
    }

    const parsed = parseDonatedUri(payload.uri);
    const dup = this.db
      .prepare('SELECT id FROM donated_outbounds WHERE fingerprint_sha256 = ? LIMIT 1')
      .get(parsed.fingerprint_sha256) as { id: number } | undefined;
    if (dup) {
      throw new StoreError(400, 'این سرور قبلاً در شبکه سنترا ثبت و فعال شده است.');
    }

    const label = (payload.name?.trim() || parsed.name).slice(0, 80);
    const note = payload.note ? payload.note.trim().slice(0, 240) : null;
    const nowIso = new Date().toISOString();

    const insert = this.db
      .prepare(
        `INSERT INTO donated_outbounds (
          donor_user_id, name, label, tag, protocol, server_address, server_port,
          config_json, assigned_tier, country_code, country_name, flag, raw_link,
          latency_ms, health_score, is_official, status, reward_days,
          allow_web, allow_download, allow_static_ip, speed_score, last_online_at,
          allocation_mode, fingerprint_sha256, user_note, created_at, approved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'web_browsing', 'XX', 'Global', '🌐', ?, 0, 100, 0, 'active', 0, 1, 1, 0, 85, ?, 'auto', ?, ?, ?, ?)`
      )
      .run(
        user.id,
        label,
        label,
        label,
        parsed.protocol,
        parsed.server_address,
        parsed.server_port,
        parsed.config_json,
        payload.uri.trim(),
        nowIso,
        parsed.fingerprint_sha256,
        note,
        nowIso,
        nowIso
      );

    return {
      success: true,
      id: Number(insert.lastInsertRowid),
      status: 'active',
      latency_ms: 0,
      message: 'اوتباند اهدایی شما با موفقیت ثبت و بلافاصله در کل اکوسیستم سنترا فعال شد.',
    };
  }

  addEcosystemOutbound(
    rawToken: string | undefined | null,
    payload: { uri: string; name?: string; note?: string; category?: string }
  ): { success: true; id: number; is_official: boolean; status: string; message: string } {
    const { user } = this.resolveAuthenticatedUser(rawToken);
    if (!payload.uri || typeof payload.uri !== 'string' || !payload.uri.trim()) {
      throw new StoreError(400, 'لینک کانفیگ نمی‌تواند خالی باشد.');
    }

    const parsed = parseDonatedUri(payload.uri);
    const isOfficial = user.role === 'admin' ? 1 : 0;
    const requestedCat = isOfficial === 1 ? (payload.category || 'both') : 'auto';
    const allowWeb = requestedCat === 'static_only' || requestedCat === 'gaming_only' ? 0 : 1;
    const allowDownload = allowWeb;
    const allowStatic =
      isOfficial === 1 && (requestedCat === 'static_only' || requestedCat === 'both' || requestedCat === 'all')
        ? 1
        : 0;
    const allowGaming =
      isOfficial === 1 && (requestedCat === 'gaming_only' || requestedCat === 'gaming' || requestedCat === 'all')
        ? 1
        : 0;
    const allocationMode = isOfficial === 1 ? requestedCat : 'auto';
    const assignedTier =
      allowGaming === 1 && allowWeb === 0
        ? 'gaming'
        : allowStatic === 1
        ? 'static_ip'
        : 'web_browsing';
    const label = (payload.name?.trim() || parsed.name).slice(0, 80);
    const note = payload.note ? payload.note.trim().slice(0, 240) : null;
    const nowIso = new Date().toISOString();

    const existing = this.db
      .prepare('SELECT id FROM donated_outbounds WHERE fingerprint_sha256 = ? LIMIT 1')
      .get(parsed.fingerprint_sha256) as { id: number } | undefined;

    if (existing) {
      this.db
        .prepare(
          `UPDATE donated_outbounds
           SET name = ?, label = ?, tag = ?, config_json = ?, raw_link = ?,
               status = 'active', allow_web = ?, allow_download = ?,
               allow_static_ip = CASE WHEN ? = 1 THEN 1 ELSE allow_static_ip END,
               allow_gaming = CASE WHEN ? = 1 THEN 1 ELSE allow_gaming END,
               allocation_mode = CASE WHEN ? = 1 THEN ? ELSE allocation_mode END,
               is_official = CASE WHEN ? = 1 THEN 1 ELSE is_official END,
               last_online_at = ?, approved_at = COALESCE(approved_at, ?)
           WHERE id = ?`
        )
        .run(
          label,
          label,
          label,
          parsed.config_json,
          payload.uri.trim(),
          allowWeb,
          allowDownload,
          allowStatic,
          allowGaming,
          isOfficial,
          allocationMode,
          isOfficial,
          nowIso,
          nowIso,
          existing.id
        );
      return {
        success: true,
        id: existing.id,
        is_official: isOfficial === 1,
        status: 'active',
        message: 'اوتباند با موفقیت بروزرسانی و در کل اکوسیستم سنترا فعال شد.',
      };
    }

    const insert = this.db
      .prepare(
        `INSERT INTO donated_outbounds (
          donor_user_id, name, label, tag, protocol, server_address, server_port,
          config_json, assigned_tier, country_code, country_name, flag, raw_link,
          latency_ms, health_score, is_official, status, reward_days,
          allow_web, allow_download, allow_static_ip, allow_gaming, speed_score, last_online_at,
          allocation_mode, fingerprint_sha256, user_note, created_at, approved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'XX', 'Global', '🌐', ?, 0, 100, ?, 'active', 0, ?, ?, ?, ?, 90, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        user.id,
        label,
        label,
        label,
        parsed.protocol,
        parsed.server_address,
        parsed.server_port,
        parsed.config_json,
        assignedTier,
        payload.uri.trim(),
        isOfficial,
        allowWeb,
        allowDownload,
        allowStatic,
        allowGaming,
        nowIso,
        allocationMode,
        parsed.fingerprint_sha256,
        note,
        nowIso,
        nowIso
      );

    return {
      success: true,
      id: Number(insert.lastInsertRowid),
      is_official: isOfficial === 1,
      status: 'active',
      message: 'اوتباند شما با موفقیت ثبت و بلافاصله در کل اکوسیستم سنترا فعال شد.',
    };
  }

  /** Test helper to simulate Admin adding or removing an official Gaming outbound from Telegram Bot */
  addOfficialGamingOutboundForTest(uri: string, name = 'Gaming-Frankfurt-01', latencyMs = 38): number {
    const parsed = parseDonatedUri(uri);
    const nowIso = new Date().toISOString();
    const res = this.db
      .prepare(
        `INSERT INTO donated_outbounds (
          donor_user_id, name, label, tag, protocol, server_address, server_port,
          config_json, assigned_tier, country_code, country_name, flag, raw_link,
          latency_ms, health_score, is_official, status, reward_days,
          allow_web, allow_download, allow_static_ip, allow_gaming, speed_score, last_online_at,
          allocation_mode, fingerprint_sha256, created_at, approved_at
        ) VALUES (
          (SELECT id FROM users ORDER BY id ASC LIMIT 1),
          ?, ?, ?, ?, ?, ?, ?, 'gaming', 'DE', 'Germany', '🇩🇪', ?, ?, 100, 1, 'active', 0,
          0, 0, 0, 1, 98, ?, 'gaming_only', ?, ?, ?
        )`
      )
      .run(
        name,
        name,
        name,
        parsed.protocol,
        parsed.server_address,
        parsed.server_port,
        parsed.config_json,
        uri.trim(),
        latencyMs,
        nowIso,
        parsed.fingerprint_sha256,
        nowIso,
        nowIso
      );
    return Number(res.lastInsertRowid);
  }

  setOutboundStatusForTest(id: number, status: 'active' | 'inactive'): void {
    this.db.prepare('UPDATE donated_outbounds SET status = ? WHERE id = ?').run(status, id);
  }

  getMyDonations(rawToken: string | undefined | null): { donations: DonatedRow[] } {
    const { user } = this.resolveAuthenticatedUser(rawToken);
    const donations = this.db
      .prepare(
        `SELECT id, COALESCE(NULLIF(label, ''), NULLIF(name, ''), tag) as name, protocol, server_address, server_port,
                country_code, flag, latency_ms, status, reward_days, user_note, rejection_reason,
                created_at, approved_at
         FROM donated_outbounds WHERE donor_user_id = ? ORDER BY id DESC`
      )
      .all(user.id) as unknown as DonatedRow[];

    return { donations };
  }

  /** Helper for unit tests to simulate subscription tier upgrades */
  setSubscriptionTierForTest(token: string, tier: string): void {
    this.db
      .prepare('UPDATE subscriptions SET tier = ? WHERE token = ?')
      .run(tier, token);
  }
}
