import { isBlockedHost, sha256Hex } from './security.ts';

export interface SingboxTlsConfig {
  enabled: boolean;
  server_name?: string;
  insecure?: boolean;
  alpn?: string[];
  utls?: {
    enabled: boolean;
    fingerprint: string;
  };
  reality?: {
    enabled: boolean;
    public_key: string;
    short_id: string;
  };
}

export interface SingboxOutboundConfig {
  type: string;
  tag: string;
  server: string;
  server_port: number;
  uuid?: string;
  password?: string;
  method?: string;
  flow?: string;
  alter_id?: number;
  security?: string;
  packet_encoding?: string;
  private_key?: string;
  peer_public_key?: string;
  local_address?: string[];
  reserved?: number[];
  mtu?: number;
  congestion_control?: string;
  tls?: SingboxTlsConfig;
  transport?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ParsedProxy {
  tag: string;
  protocol: string;
  server_address: string;
  server_port: number;
  config_json: SingboxOutboundConfig;
  fingerprint_sha256: string;
  country_code: string;
  country_name: string;
  raw_link: string;
}

const ALLOWED_UTLS_FINGERPRINTS = new Set([
  'chrome',
  'firefox',
  'safari',
  'edge',
  'ios',
  'android',
  '360',
  'qq',
  'random',
  'randomized',
]);

function normalizeFingerprint(rawFp: string | null | undefined): string {
  const clean = (rawFp || '').trim().toLowerCase();
  if (clean && ALLOWED_UTLS_FINGERPRINTS.has(clean)) {
    return clean;
  }
  return 'chrome';
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

export function decodeBase64Flexible(input: string): string {
  const cleaned = input.trim().replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  const padded = cleaned.padEnd(Math.ceil(cleaned.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Ensures any Reality-enabled outbound strictly includes a valid uTLS configuration
 * (`utls: { enabled: true, fingerprint: fp || "chrome" }`), required by sing-box 1.12+/1.14+.
 */
export function enforceRealityUtls(
  config: SingboxOutboundConfig,
  explicitFp?: string | null
): SingboxOutboundConfig {
  const cloned: SingboxOutboundConfig = structuredClone(config);
  const fp = explicitFp ? normalizeFingerprint(explicitFp) : null;

  if (cloned.tls) {
    const isReality = Boolean(cloned.tls.reality?.enabled);
    if (isReality) {
      cloned.tls.enabled = true;
      const existingFp = cloned.tls.utls?.fingerprint;
      cloned.tls.utls = {
        enabled: true,
        fingerprint: normalizeFingerprint(fp || existingFp || 'chrome'),
      };
      if (cloned.tls.reality) {
        cloned.tls.reality.public_key = String(cloned.tls.reality.public_key || '');
        cloned.tls.reality.short_id = String(cloned.tls.reality.short_id || '');
      }
    } else if (fp && cloned.tls.enabled) {
      cloned.tls.utls = {
        enabled: true,
        fingerprint: fp,
      };
    }
  }

  return cloned;
}

/**
 * Computes a deterministic SHA-256 deduplication fingerprint matching Sentra's
 * outbound_analyzer.rs deep fingerprinting logic (host + port + protocol + secret).
 */
export async function computeOutboundFingerprint(
  serverAddress: string,
  serverPort: number,
  protocol: string,
  config: SingboxOutboundConfig
): Promise<string> {
  const secret =
    (typeof config.uuid === 'string' && config.uuid) ||
    (typeof config.password === 'string' && config.password) ||
    (typeof config.private_key === 'string' && config.private_key) ||
    (typeof config.tls?.reality?.public_key === 'string' && config.tls.reality.public_key) ||
    '';

  const canonical = `${serverAddress.trim().toLowerCase()}:${serverPort}:${protocol.trim().toLowerCase()}:${secret.trim()}`;
  return sha256Hex(canonical);
}

const COUNTRY_HINTS: Array<{ code: string; name: string; patterns: RegExp }> = [
  { code: 'DE', name: 'آلمان 🇩🇪', patterns: /🇩🇪|\bgermany\b|\bfrankfurt\b|\bhetzner\b|\bde[-_\s]?\d*\b/i },
  { code: 'NL', name: 'هلند 🇳🇱', patterns: /🇳🇱|\bnetherlands\b|\bamsterdam\b|\bnl[-_\s]?\d*\b/i },
  { code: 'FI', name: 'فنلاند 🇫🇮', patterns: /🇫🇮|\bfinland\b|\bhelsinki\b|\bfi[-_\s]?\d*\b/i },
  { code: 'US', name: 'آمریکا 🇺🇸', patterns: /🇺🇸|\busa\b|\bunited states\b|\bnew york\b|\blos angeles\b|\bus[-_\s]?\d*\b/i },
  { code: 'GB', name: 'انگلستان 🇬🇧', patterns: /🇬🇧|\buk\b|\blondon\b|\bbritain\b|\bgb[-_\s]?\d*\b/i },
  { code: 'FR', name: 'فرانسه 🇫🇷', patterns: /🇫🇷|\bfrance\b|\bparis\b|\bfr[-_\s]?\d*\b/i },
  { code: 'TR', name: 'ترکیه 🇹🇷', patterns: /🇹🇷|\bturkey\b|\bistanbul\b|\btr[-_\s]?\d*\b/i },
  { code: 'SG', name: 'سنگاپور 🇸🇬', patterns: /🇸🇬|\bsingapore\b|\bsg[-_\s]?\d*\b/i },
  { code: 'AE', name: 'امارات 🇦🇪', patterns: /🇦🇪|\bdubai\b|\buae\b|\bae[-_\s]?\d*\b/i },
  { code: 'SE', name: 'سوئد 🇸🇪', patterns: /🇸🇪|\bsweden\b|\bstockholm\b|\bse[-_\s]?\d*\b/i },
  { code: 'CH', name: 'سوئیس 🇨🇭', patterns: /🇨🇭|\bswitzerland\b|\bzurich\b|\bch[-_\s]?\d*\b/i },
  { code: 'CA', name: 'کانادا 🇨🇦', patterns: /🇨🇦|\bcanada\b|\btoronto\b|\bca[-_\s]?\d*\b/i },
  { code: 'JP', name: 'ژاپن 🇯🇵', patterns: /🇯🇵|\bjapan\b|\btokyo\b|\bjp[-_\s]?\d*\b/i },
  { code: 'PL', name: 'لهستان 🇵🇱', patterns: /🇵🇱|\bpoland\b|\bwarsaw\b|\bpl[-_\s]?\d*\b/i },
];

export function detectCountryFromTag(tag: string): { country_code: string; country_name: string } {
  for (const hint of COUNTRY_HINTS) {
    if (hint.patterns.test(tag)) {
      return { country_code: hint.code, country_name: hint.name };
    }
  }
  return { country_code: 'XX', country_name: 'جهانی 🌍' };
}

function parseStandardUri(raw: string): {
  tag: string;
  protocol: string;
  server_address: string;
  server_port: number;
  config_json: SingboxOutboundConfig;
} {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('لینک پروکسی ساختار URL معتبر ندارد.');
  }

  const scheme = url.protocol.replace(':', '').toLowerCase();
  const protocol =
    scheme === 'hy2' || scheme === 'hysteria2'
      ? 'hysteria2'
      : scheme === 'wg' || scheme === 'wireguard'
      ? 'wireguard'
      : scheme;

  const server_address = url.hostname.replace(/^\[|\]$/g, '');
  if (!server_address) {
    throw new Error('آدرس سرور در لینک یافت نشد.');
  }
  if (isBlockedHost(server_address)) {
    throw new Error('آدرس سرور به محدوده محلی یا خصوصی تعلق دارد و مسدود شد.');
  }

  const defaultPort = protocol === 'wireguard' ? 51820 : 443;
  const server_port = url.port ? Number(url.port) : defaultPort;
  if (!Number.isInteger(server_port) || server_port < 1 || server_port > 65535) {
    throw new Error('پورت سرور نامعتبر است.');
  }

  const tag = url.hash ? safeDecodeURIComponent(url.hash.slice(1)).trim() || 'sentra-node' : 'sentra-node';

  const config: SingboxOutboundConfig = {
    type: protocol,
    tag,
    server: server_address,
    server_port,
  };

  if (protocol === 'vless') {
    config.uuid = safeDecodeURIComponent(url.username);
    config.packet_encoding = 'xudp';
  } else if (protocol === 'trojan' || protocol === 'hysteria2') {
    const password = url.password
      ? safeDecodeURIComponent(url.password)
      : safeDecodeURIComponent(url.username);
    config.password = password;
  } else if (protocol === 'tuic') {
    config.uuid = safeDecodeURIComponent(url.username);
    config.password = safeDecodeURIComponent(url.password);
    config.congestion_control = url.searchParams.get('congestion_control') || 'bbr';
  } else if (protocol === 'wireguard') {
    const privKey = safeDecodeURIComponent(url.username);
    if (privKey) config.private_key = privKey;
  }

  const securityParam = (url.searchParams.get('security') || '').trim().toLowerCase();
  const sni = (url.searchParams.get('sni') || url.searchParams.get('peer') || '').trim();
  const pbk = (url.searchParams.get('pbk') || '').trim();
  const sid = (url.searchParams.get('sid') || '').trim();
  const fpParam = (url.searchParams.get('fp') || '').trim();
  const flow = (url.searchParams.get('flow') || '').trim();
  const alpnRaw = (url.searchParams.get('alpn') || '').trim();
  const insecureParam = (url.searchParams.get('insecure') || url.searchParams.get('allowInsecure') || '').trim();

  if (protocol === 'vless' && flow) {
    config.flow = flow;
  }

  const isReality = securityParam === 'reality' || Boolean(pbk);
  const needsTls =
    isReality ||
    securityParam === 'tls' ||
    protocol === 'trojan' ||
    protocol === 'hysteria2' ||
    protocol === 'tuic' ||
    Boolean(sni);

  if (needsTls && protocol !== 'wireguard') {
    const tls: SingboxTlsConfig = {
      enabled: true,
    };
    if (sni) {
      tls.server_name = sni;
    } else if (isReality) {
      tls.server_name = server_address;
    }
    if (insecureParam === '1' || insecureParam.toLowerCase() === 'true') {
      tls.insecure = true;
    }
    if (alpnRaw) {
      const alpnList = alpnRaw
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean);
      if (alpnList.length > 0) tls.alpn = alpnList;
    }
    if (fpParam) {
      tls.utls = {
        enabled: true,
        fingerprint: normalizeFingerprint(fpParam),
      };
    }
    if (isReality) {
      tls.reality = {
        enabled: true,
        public_key: pbk,
        short_id: sid,
      };
      // Mandatory uTLS injection for Reality (sing-box 1.12+/1.14+ requirement)
      tls.utls = {
        enabled: true,
        fingerprint: normalizeFingerprint(fpParam || 'chrome'),
      };
    }
    config.tls = tls;
  }

  // WireGuard query params
  if (protocol === 'wireguard') {
    const publicKey = (url.searchParams.get('publickey') || url.searchParams.get('pbk') || '').trim();
    const addressRaw = (url.searchParams.get('address') || '10.66.66.2/32').trim();
    const mtuRaw = Number(url.searchParams.get('mtu') || 1280);
    const reservedRaw = (url.searchParams.get('reserved') || '').trim();
    if (publicKey) config.peer_public_key = publicKey;
    config.local_address = addressRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (Number.isFinite(mtuRaw) && mtuRaw >= 576 && mtuRaw <= 1500) {
      config.mtu = mtuRaw;
    }
    if (reservedRaw) {
      const nums = reservedRaw
        .split(',')
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isInteger(n) && n >= 0 && n <= 255);
      if (nums.length === 3) config.reserved = nums;
    }
  }

  // Transport (ws, grpc, httpupgrade, http)
  const netType = (url.searchParams.get('type') || '').trim().toLowerCase();
  const pathParam = (url.searchParams.get('path') || '').trim();
  const hostParam = (url.searchParams.get('host') || '').trim();
  const serviceName = (url.searchParams.get('serviceName') || '').trim();

  if (netType === 'ws' || netType === 'httpupgrade') {
    const transport: Record<string, unknown> = { type: netType };
    if (pathParam) transport.path = pathParam;
    if (hostParam) transport.headers = { Host: hostParam };
    config.transport = transport;
  } else if (netType === 'grpc') {
    const transport: Record<string, unknown> = { type: 'grpc' };
    if (serviceName || pathParam) {
      transport.service_name = serviceName || pathParam.replace(/^\/+/, '');
    }
    config.transport = transport;
  } else if (netType === 'http' || netType === 'h2') {
    const transport: Record<string, unknown> = { type: 'http' };
    if (pathParam) transport.path = pathParam;
    if (hostParam) transport.host = [hostParam];
    config.transport = transport;
  }

  const normalizedConfig = enforceRealityUtls(config, fpParam || null);
  return {
    tag,
    protocol,
    server_address,
    server_port,
    config_json: normalizedConfig,
  };
}

function parseVmessUri(raw: string): {
  tag: string;
  protocol: string;
  server_address: string;
  server_port: number;
  config_json: SingboxOutboundConfig;
} {
  const b64 = raw.slice('vmess://'.length).trim();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(decodeBase64Flexible(b64)) as Record<string, unknown>;
  } catch {
    throw new Error('محتوای vmess معتبر نیست.');
  }

  const server_address = String(json.add || '').trim();
  if (!server_address) throw new Error('آدرس سرور در لینک VMess یافت نشد.');
  if (isBlockedHost(server_address)) {
    throw new Error('آدرس سرور VMess به محدوده محلی یا خصوصی تعلق دارد.');
  }

  const server_port = Number(json.port || 443);
  if (!Number.isInteger(server_port) || server_port < 1 || server_port > 65535) {
    throw new Error('پورت VMess نامعتبر است.');
  }

  const tag = String(json.ps || 'sentra-vmess').trim() || 'sentra-vmess';
  const uuid = String(json.id || '').trim();
  const security = String(json.scy || 'auto').trim();
  const fp = String(json.fp || '').trim();

  const config: SingboxOutboundConfig = {
    type: 'vmess',
    tag,
    server: server_address,
    server_port,
    uuid,
    security,
    alter_id: Number(json.aid || 0) || 0,
  };

  if (String(json.tls || '').toLowerCase() === 'tls') {
    const tls: SingboxTlsConfig = {
      enabled: true,
      server_name: String(json.sni || json.host || server_address),
    };
    if (fp) {
      tls.utls = { enabled: true, fingerprint: normalizeFingerprint(fp) };
    }
    config.tls = tls;
  }

  const net = String(json.net || 'tcp').toLowerCase();
  if (net === 'ws' || net === 'httpupgrade') {
    const transport: Record<string, unknown> = { type: net };
    if (json.path) transport.path = String(json.path);
    if (json.host) transport.headers = { Host: String(json.host) };
    config.transport = transport;
  } else if (net === 'grpc') {
    config.transport = {
      type: 'grpc',
      service_name: String(json.path || ''),
    };
  }

  return {
    tag,
    protocol: 'vmess',
    server_address,
    server_port,
    config_json: config,
  };
}

function parseShadowsocksUri(raw: string): {
  tag: string;
  protocol: string;
  server_address: string;
  server_port: number;
  config_json: SingboxOutboundConfig;
} {
  const withoutScheme = raw.slice('ss://'.length).trim();
  const hashIdx = withoutScheme.indexOf('#');
  const mainPart = hashIdx >= 0 ? withoutScheme.slice(0, hashIdx) : withoutScheme;
  const tag =
    hashIdx >= 0
      ? safeDecodeURIComponent(withoutScheme.slice(hashIdx + 1)).trim() || 'sentra-ss'
      : 'sentra-ss';

  // Strip optional plugin query string for host/port parsing
  const queryIdx = mainPart.indexOf('?');
  const corePart = queryIdx >= 0 ? mainPart.slice(0, queryIdx) : mainPart;

  let method = 'aes-256-gcm';
  let password = '';
  let server_address = '';
  let server_port = 443;

  const atIdx = corePart.lastIndexOf('@');
  if (atIdx >= 0) {
    const userinfoRaw = corePart.slice(0, atIdx);
    const hostPort = corePart.slice(atIdx + 1);
    let userinfo = userinfoRaw;
    if (!userinfoRaw.includes(':')) {
      try {
        userinfo = decodeBase64Flexible(userinfoRaw);
      } catch {
        userinfo = userinfoRaw;
      }
    }
    const colonIdx = userinfo.indexOf(':');
    if (colonIdx < 0) throw new Error('فرمت احراز هویت Shadowsocks معتبر نیست.');
    method = userinfo.slice(0, colonIdx);
    password = userinfo.slice(colonIdx + 1);

    const parsedHost = new URL(`http://${hostPort}`);
    server_address = parsedHost.hostname.replace(/^\[|\]$/g, '');
    server_port = parsedHost.port ? Number(parsedHost.port) : 443;
  } else {
    const decoded = decodeBase64Flexible(corePart);
    const decodedAt = decoded.lastIndexOf('@');
    if (decodedAt < 0) throw new Error('فرمت لینک Shadowsocks نامعتبر است.');
    const cred = decoded.slice(0, decodedAt);
    const hostPort = decoded.slice(decodedAt + 1);
    const colonIdx = cred.indexOf(':');
    if (colonIdx < 0) throw new Error('روش رمزنگاری Shadowsocks یافت نشد.');
    method = cred.slice(0, colonIdx);
    password = cred.slice(colonIdx + 1);

    const parsedHost = new URL(`http://${hostPort}`);
    server_address = parsedHost.hostname.replace(/^\[|\]$/g, '');
    server_port = parsedHost.port ? Number(parsedHost.port) : 443;
  }

  if (!server_address || isBlockedHost(server_address)) {
    throw new Error('آدرس سرور Shadowsocks نامعتبر یا در محدوده خصوصی است.');
  }

  const config: SingboxOutboundConfig = {
    type: 'shadowsocks',
    tag,
    server: server_address,
    server_port,
    method,
    password,
  };

  return {
    tag,
    protocol: 'shadowsocks',
    server_address,
    server_port,
    config_json: config,
  };
}

function parseRawSingboxJson(raw: string): {
  tag: string;
  protocol: string;
  server_address: string;
  server_port: number;
  config_json: SingboxOutboundConfig;
} {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error('ساختار JSON کانفیگ sing-box معتبر نیست.');
  }

  const protocol = String(obj.type || obj.protocol || '').trim().toLowerCase();
  const server_address = String(obj.server || '').trim();
  const server_port = Number(obj.server_port || 443);
  const tag = String(obj.tag || 'sentra-singbox').trim() || 'sentra-singbox';

  if (!protocol || !server_address) {
    throw new Error('فیلدهای type و server در JSON الزامی هستند.');
  }
  if (isBlockedHost(server_address)) {
    throw new Error('آدرس سرور به محدوده محلی یا خصوصی تعلق دارد.');
  }
  if (!Number.isInteger(server_port) || server_port < 1 || server_port > 65535) {
    throw new Error('پورت سرور در JSON نامعتبر است.');
  }

  const normalized = enforceRealityUtls(obj as SingboxOutboundConfig);
  normalized.type = protocol;
  normalized.tag = tag;
  normalized.server = server_address;
  normalized.server_port = server_port;

  return {
    tag,
    protocol,
    server_address,
    server_port,
    config_json: normalized,
  };
}

/**
 * Parses a single proxy URI or sing-box JSON outbound, injects Reality uTLS if needed,
 * blocks private/SSRF addresses, detects country, and generates SHA-256 deduplication hash.
 */
export async function parseOutboundInput(rawInput: string): Promise<ParsedProxy> {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    throw new Error('ورودی لینک یا کانفیگ خالی است.');
  }

  let parsed: {
    tag: string;
    protocol: string;
    server_address: string;
    server_port: number;
    config_json: SingboxOutboundConfig;
  };

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    parsed = parseRawSingboxJson(trimmed);
  } else if (trimmed.startsWith('vmess://')) {
    parsed = parseVmessUri(trimmed);
  } else if (trimmed.startsWith('ss://')) {
    parsed = parseShadowsocksUri(trimmed);
  } else if (
    /^(vless|trojan|hy2|hysteria2|tuic|wireguard|wg):\/\//i.test(trimmed)
  ) {
    parsed = parseStandardUri(trimmed);
  } else {
    throw new Error(
      'فرمت لینک پشتیبانی نمی‌شود. فرمت‌های مجاز: vless://, vmess://, trojan://, hy2://, tuic://, wireguard://, ss:// یا JSON سینگ‌باکس.'
    );
  }

  const fingerprint_sha256 = await computeOutboundFingerprint(
    parsed.server_address,
    parsed.server_port,
    parsed.protocol,
    parsed.config_json
  );
  const country = detectCountryFromTag(parsed.tag);

  return {
    ...parsed,
    fingerprint_sha256,
    country_code: country.country_code,
    country_name: country.country_name,
    raw_link: trimmed,
  };
}

/**
 * Decodes a subscription payload (plain lines or Base64) and extracts all valid proxy lines.
 */
export async function parseSubscriptionPayload(rawBody: string): Promise<{
  nodes: ParsedProxy[];
  skipped: number;
}> {
  let text = rawBody.trim();
  const looksLikeUriList = /^(vless|vmess|trojan|hy2|hysteria2|tuic|ss|wireguard|wg):\/\//im.test(text);
  if (!looksLikeUriList && !text.startsWith('{')) {
    try {
      const decoded = decodeBase64Flexible(text);
      if (/^(vless|vmess|trojan|hy2|hysteria2|tuic|ss|wireguard|wg):\/\//im.test(decoded)) {
        text = decoded;
      }
    } catch {
      // Keep raw text
    }
  }

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));

  const nodes: ParsedProxy[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  for (const line of lines) {
    try {
      const node = await parseOutboundInput(line);
      if (seen.has(node.fingerprint_sha256)) continue;
      seen.add(node.fingerprint_sha256);
      nodes.push(node);
    } catch {
      skipped += 1;
    }
  }

  return { nodes, skipped };
}

/**
 * Security audit matching sentra-core's QualityEngine::audit_security.
 */
export function auditOutboundSecurity(
  protocol: string,
  config: SingboxOutboundConfig
): { passed: boolean; reason: string | null } {
  const proto = protocol.toLowerCase();
  if (proto === 'vless') {
    const tlsEnabled = Boolean(config.tls?.enabled);
    const realityEnabled = Boolean(config.tls?.reality?.enabled);
    if (!tlsEnabled && !realityEnabled) {
      return { passed: false, reason: 'VLESS outbound requires TLS or Reality encryption' };
    }
    if (realityEnabled && (!config.tls?.utls?.enabled || !config.tls?.utls?.fingerprint)) {
      return { passed: false, reason: 'Reality outbound requires uTLS fingerprint enabled' };
    }
  } else if (proto === 'vmess') {
    if (String(config.security || 'auto').toLowerCase() === 'none') {
      return { passed: false, reason: 'VMess security "none" is prohibited' };
    }
  } else if (proto === 'shadowsocks') {
    const method = String(config.method || '').toLowerCase();
    if (!method || method === 'none' || method === 'plain') {
      return { passed: false, reason: 'Shadowsocks requires AEAD or 2022 cipher' };
    }
  } else if (proto === 'http' || proto === 'socks') {
    if (!config.tls?.enabled) {
      return { passed: false, reason: 'Plaintext HTTP/SOCKS outbounds without TLS are blocked' };
    }
  } else if (!['trojan', 'hysteria2', 'tuic', 'wireguard'].includes(proto)) {
    return { passed: false, reason: `Unsupported protocol: ${proto}` };
  }

  return { passed: true, reason: null };
}
