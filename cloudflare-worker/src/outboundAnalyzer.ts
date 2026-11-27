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

export interface SingboxTransportConfig {
  type: 'ws' | 'grpc' | 'httpupgrade' | 'http';
  path?: string;
  headers?: Record<string, string>;
  host?: string[];
  service_name?: string;
  max_early_data?: number;
  early_data_header_name?: string;
}

export interface SingboxOutboundConfig {
  type: 'vless' | 'vmess' | 'trojan' | 'hysteria2' | 'tuic' | 'shadowsocks';
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
  congestion_control?: 'cubic' | 'new_reno' | 'bbr';
  udp_relay_mode?: 'native' | 'quic';
  zero_rtt_handshake?: boolean;
  obfs?: {
    type: 'salamander';
    password: string;
  };
  tls?: SingboxTlsConfig;
  transport?: SingboxTransportConfig;
}

export interface ParsedProxy {
  tag: string;
  protocol: AllowedProtocol;
  server_address: string;
  server_port: number;
  config_json: SingboxOutboundConfig;
  compiled_outbound_json: string;
  fingerprint_sha256: string;
  country_code: string;
  country_name: string;
  raw_link: string;
}

export type AllowedProtocol =
  | 'vless'
  | 'vmess'
  | 'trojan'
  | 'hysteria2'
  | 'tuic'
  | 'shadowsocks';

export type AllowedTransport = 'tcp' | 'ws' | 'grpc' | 'httpupgrade' | 'http';

export const ALLOWED_PROTOCOLS = new Set<AllowedProtocol>([
  'vless',
  'vmess',
  'trojan',
  'hysteria2',
  'tuic',
  'shadowsocks',
]);

export const ALLOWED_TRANSPORTS = new Set<AllowedTransport>([
  'tcp',
  'ws',
  'grpc',
  'httpupgrade',
  'http',
]);

export const INCOMPATIBLE_TRANSPORTS = new Set<string>([
  'xhttp',
  'splithttp',
  'kcp',
  'mkcp',
  'quic',
  'h3',
  'http3',
  'domainsocket',
  'meek',
]);

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

const ALLOWED_VMESS_SECURITIES = new Set([
  'auto',
  'aes-128-gcm',
  'chacha20-poly1305',
  'zero',
]);

const ALLOWED_TUIC_CONGESTION = new Set(['cubic', 'new_reno', 'bbr']);

const ALLOWED_VLESS_FLOWS = new Set(['xtls-rprx-vision']);

const REALITY_PBK_PATTERN = /^[A-Za-z0-9+/_-]{3,128}={0,2}$/;
const HEX_SID_PATTERN = /^[0-9a-fA-F]{0,16}$/;
const VALID_SNI_PATTERN =
  /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/;
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export function normalizeProtocolName(rawProtocol: string): AllowedProtocol | null {
  const clean = (rawProtocol || '').trim().toLowerCase();
  if (clean === 'hy2' || clean === 'hysteria2') return 'hysteria2';
  if (clean === 'ss' || clean === 'shadowsocks') return 'shadowsocks';
  if (ALLOWED_PROTOCOLS.has(clean as AllowedProtocol)) {
    return clean as AllowedProtocol;
  }
  return null;
}

export function normalizeAndValidateTransport(rawTransport: string | null | undefined): AllowedTransport {
  const clean = (rawTransport || '').trim().toLowerCase();
  if (!clean || clean === 'tcp' || clean === 'raw' || clean === 'none') {
    return 'tcp';
  }
  if (clean === 'h2' || clean === 'http2') {
    return 'http';
  }
  if (ALLOWED_TRANSPORTS.has(clean as AllowedTransport)) {
    return clean as AllowedTransport;
  }
  if (INCOMPATIBLE_TRANSPORTS.has(clean)) {
    throw new Error(
      `ترنسپورت «${clean}» در هسته فعلی sing-box 1.14+ پشتیبانی نمی‌شود. ترنسپورت‌های مجاز: tcp (raw)، ws، grpc، httpupgrade و http.`
    );
  }
  throw new Error(
    `ترنسپورت ناشناخته یا ناسازگار «${clean}» در هسته فعلی پشتیبانی نمی‌شود. ترنسپورت‌های مجاز: tcp (raw)، ws، grpc، httpupgrade و http.`
  );
}

function assertValidServerHost(host: string): string {
  const clean = host.trim().replace(/^\[|\]$/g, '');
  if (!clean || clean.length > 253 || /\s/.test(clean)) {
    throw new Error('آدرس سرور (Host) نامعتبر است.');
  }
  if (isBlockedHost(clean)) {
    throw new Error('آدرس سرور به محدوده محلی یا خصوصی تعلق دارد و مسدود شد.');
  }
  return clean;
}

function assertValidServerPort(rawPort: unknown): number {
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('پورت سرور باید عددی صحیح بین ۱ تا ۶۵۵۳۵ باشد.');
  }
  return port;
}

function isValidRealitySni(sni: string): boolean {
  const clean = sni.trim();
  if (!clean || IPV4_PATTERN.test(clean) || clean.includes(':')) {
    return false;
  }
  return VALID_SNI_PATTERN.test(clean);
}

function assertValidRealitySettings(params: {
  publicKey: string;
  serverName: string;
  shortId: string;
}): void {
  const pbk = params.publicKey.trim();
  const sni = params.serverName.trim();
  const sid = params.shortId.trim();

  if (!pbk || !REALITY_PBK_PATTERN.test(pbk) || ['none', 'null', 'undefined'].includes(pbk.toLowerCase())) {
    throw new Error(
      'تنظیمات Reality ناقص است: کلید عمومی معتبر (pbk / public_key) یافت نشد.'
    );
  }
  if (!sni || !isValidRealitySni(sni)) {
    throw new Error(
      'تنظیمات Reality ناقص است: دامنه SNI معتبر (server_name) مشخص نشده است.'
    );
  }
  if (sid && !HEX_SID_PATTERN.test(sid)) {
    throw new Error(
      'تنظیمات Reality نامعتبر است: مقدار short_id (sid) باید هگزادسیمال و حداکثر ۱۶ کاراکتر باشد.'
    );
  }
}

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
        cloned.tls.reality.public_key = String(cloned.tls.reality.public_key || '').trim();
        cloned.tls.reality.short_id = String(cloned.tls.reality.short_id || '').trim();
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
 * Strictly validates and normalizes an outbound object to the canonical
 * sing-box 1.14+ schema, stripping any deprecated or Xray-only fields.
 */
export function validateSingboxOutboundStrict(
  rawObj: unknown
): { ok: true; outbound: SingboxOutboundConfig; compiledJson: string } | { ok: false; error: string } {
  try {
    if (!rawObj || typeof rawObj !== 'object' || Array.isArray(rawObj)) {
      return { ok: false, error: 'ساختار اوتباند sing-box باید یک آبجکت JSON معتبر باشد.' };
    }
    const obj = rawObj as Record<string, unknown>;
    const rawProto = String(obj.type || obj.protocol || '').trim().toLowerCase();
    const protocol = normalizeProtocolName(rawProto);
    if (!protocol) {
      return {
        ok: false,
        error: `پروتکل «${rawProto || 'نامشخص'}» در لیست سفید هسته sing-box 1.14+ پشتیبانی نمی‌شود. پروتکل‌های مجاز: vless، vmess، trojan، hysteria2، tuic و shadowsocks.`,
      };
    }

    const server = assertValidServerHost(String(obj.server || ''));
    const server_port = assertValidServerPort(obj.server_port);
    const tag = String(obj.tag || `sentra-${protocol}`).trim().slice(0, 128) || `sentra-${protocol}`;

    const canonical: SingboxOutboundConfig = {
      type: protocol,
      tag,
      server,
      server_port,
    };

    // Protocol-specific required fields (only valid sing-box 1.14+ fields)
    if (protocol === 'vless') {
      const uuid = String(obj.uuid || '').trim();
      if (!uuid || uuid.length < 2 || /\s/.test(uuid)) {
        return { ok: false, error: 'کانفیگ VLESS فاقد شناسه UUID معتبر است.' };
      }
      canonical.uuid = uuid;
      const rawFlow = String(obj.flow || '').trim().toLowerCase();
      if (rawFlow) {
        const normalizedFlow = rawFlow === 'xtls-rprx-vision-udp443' ? 'xtls-rprx-vision' : rawFlow;
        if (!ALLOWED_VLESS_FLOWS.has(normalizedFlow)) {
          return {
            ok: false,
            error: `مقدار flow «${rawFlow}» در هسته sing-box 1.14+ پشتیبانی نمی‌شود.`,
          };
        }
        canonical.flow = normalizedFlow;
      }
      const pktEnc = String(obj.packet_encoding || 'xudp').trim().toLowerCase();
      if (pktEnc === 'xudp' || pktEnc === 'packetaddr') {
        canonical.packet_encoding = pktEnc;
      }
    } else if (protocol === 'vmess') {
      const uuid = String(obj.uuid || '').trim();
      if (!uuid || uuid.length < 2 || /\s/.test(uuid)) {
        return { ok: false, error: 'کانفیگ VMess فاقد شناسه UUID معتبر است.' };
      }
      const rawSec = String(obj.security || 'auto').trim().toLowerCase();
      if (rawSec === 'none') {
        return { ok: false, error: 'روش رمزنگاری «none» در VMess به دلایل امنیتی مسدود است.' };
      }
      const security = ALLOWED_VMESS_SECURITIES.has(rawSec) ? rawSec : 'auto';
      const alterId = Number.isInteger(Number(obj.alter_id)) ? Math.max(0, Number(obj.alter_id)) : 0;
      canonical.uuid = uuid;
      canonical.security = security;
      canonical.alter_id = alterId;
    } else if (protocol === 'trojan') {
      const password = String(obj.password || '').trim();
      if (!password) {
        return { ok: false, error: 'کانفیگ Trojan فاقد رمز عبور (password) معتبر است.' };
      }
      canonical.password = password;
    } else if (protocol === 'hysteria2') {
      const password = String(obj.password || '').trim();
      if (!password) {
        return { ok: false, error: 'کانفیگ Hysteria2 فاقد رمز عبور (password) معتبر است.' };
      }
      canonical.password = password;
      if (obj.obfs && typeof obj.obfs === 'object' && !Array.isArray(obj.obfs)) {
        const obfsObj = obj.obfs as Record<string, unknown>;
        const obfsType = String(obfsObj.type || '').trim().toLowerCase();
        const obfsPass = String(obfsObj.password || '').trim();
        if (obfsType === 'salamander' && obfsPass) {
          canonical.obfs = { type: 'salamander', password: obfsPass };
        }
      }
    } else if (protocol === 'tuic') {
      const uuid = String(obj.uuid || '').trim();
      const password = String(obj.password || '').trim();
      if (!uuid || !password) {
        return { ok: false, error: 'کانفیگ TUIC نیازمند هر دو فیلد uuid و password است.' };
      }
      canonical.uuid = uuid;
      canonical.password = password;
      const cc = String(obj.congestion_control || 'bbr').trim().toLowerCase();
      canonical.congestion_control = (ALLOWED_TUIC_CONGESTION.has(cc) ? cc : 'bbr') as
        | 'cubic'
        | 'new_reno'
        | 'bbr';
      const udpRelay = String(obj.udp_relay_mode || '').trim().toLowerCase();
      if (udpRelay === 'native' || udpRelay === 'quic') {
        canonical.udp_relay_mode = udpRelay;
      }
      if (obj.zero_rtt_handshake === true) {
        canonical.zero_rtt_handshake = true;
      }
    } else if (protocol === 'shadowsocks') {
      const method = String(obj.method || '').trim().toLowerCase();
      const password = String(obj.password || '').trim();
      if (!method || method === 'none' || method === 'plain') {
        return { ok: false, error: 'کانفیگ Shadowsocks نیازمند الگوریتم رمزنگاری AEAD یا 2022 معتبر است.' };
      }
      if (!password) {
        return { ok: false, error: 'کانفیگ Shadowsocks فاقد رمز عبور (password) است.' };
      }
      canonical.method = method;
      canonical.password = password;
    }

    // Strict Transport Whitelist (only for protocols supporting V2Ray transport in sing-box 1.14+)
    const rawTransportObj =
      obj.transport && typeof obj.transport === 'object' && !Array.isArray(obj.transport)
        ? (obj.transport as Record<string, unknown>)
        : null;
    const rawTransportStr =
      typeof obj.network === 'string'
        ? obj.network
        : rawTransportObj && typeof rawTransportObj.type === 'string'
        ? rawTransportObj.type
        : '';

    if (rawTransportStr) {
      const normalizedTransport = normalizeAndValidateTransport(rawTransportStr);
      if (normalizedTransport !== 'tcp') {
        if (protocol === 'hysteria2' || protocol === 'tuic' || protocol === 'shadowsocks') {
          return {
            ok: false,
            error: `ترنسپورت «${normalizedTransport}» برای پروتکل «${protocol}» در هسته sing-box 1.14+ مجاز نیست.`,
          };
        }

        const transport: SingboxTransportConfig = { type: normalizedTransport };
        if (rawTransportObj) {
          if (normalizedTransport === 'ws' || normalizedTransport === 'httpupgrade') {
            if (typeof rawTransportObj.path === 'string' && rawTransportObj.path.trim()) {
              transport.path = rawTransportObj.path.trim();
            }
            const headersObj =
              rawTransportObj.headers &&
              typeof rawTransportObj.headers === 'object' &&
              !Array.isArray(rawTransportObj.headers)
                ? (rawTransportObj.headers as Record<string, unknown>)
                : null;
            if (headersObj) {
              const cleanHeaders: Record<string, string> = {};
              for (const [k, v] of Object.entries(headersObj)) {
                if (typeof v === 'string' && v.trim()) {
                  cleanHeaders[k] = v.trim();
                }
              }
              if (Object.keys(cleanHeaders).length > 0) {
                transport.headers = cleanHeaders;
              }
            }
            if (normalizedTransport === 'ws') {
              const ed = Number(rawTransportObj.max_early_data);
              if (Number.isInteger(ed) && ed > 0 && ed <= 4096) {
                transport.max_early_data = ed;
              }
              if (
                typeof rawTransportObj.early_data_header_name === 'string' &&
                rawTransportObj.early_data_header_name.trim()
              ) {
                transport.early_data_header_name = rawTransportObj.early_data_header_name.trim();
              }
            }
          } else if (normalizedTransport === 'grpc') {
            const svc = String(rawTransportObj.service_name || rawTransportObj.path || '')
              .trim()
              .replace(/^\/+/, '');
            if (svc) {
              transport.service_name = svc;
            }
          } else if (normalizedTransport === 'http') {
            if (typeof rawTransportObj.path === 'string' && rawTransportObj.path.trim()) {
              transport.path = rawTransportObj.path.trim();
            }
            if (Array.isArray(rawTransportObj.host)) {
              const hosts = rawTransportObj.host
                .map((h) => String(h || '').trim())
                .filter(Boolean);
              if (hosts.length > 0) transport.host = hosts;
            } else if (typeof rawTransportObj.host === 'string' && rawTransportObj.host.trim()) {
              transport.host = [rawTransportObj.host.trim()];
            }
          }
        }
        canonical.transport = transport;
      }
    }

    // Strict TLS / Reality / uTLS standardization for sing-box 1.14+
    const rawTls =
      obj.tls && typeof obj.tls === 'object' && !Array.isArray(obj.tls)
        ? (obj.tls as Record<string, unknown>)
        : null;

    if (rawTls && rawTls.enabled === true) {
      const tls: SingboxTlsConfig = { enabled: true };
      const serverName = String(rawTls.server_name || '').trim();
      if (serverName) {
        tls.server_name = serverName;
      }
      if (rawTls.insecure === true) {
        tls.insecure = true;
      }
      if (Array.isArray(rawTls.alpn)) {
        const alpnList = rawTls.alpn.map((a) => String(a || '').trim()).filter(Boolean);
        if (alpnList.length > 0) tls.alpn = alpnList;
      }

      const rawUtls =
        rawTls.utls && typeof rawTls.utls === 'object' && !Array.isArray(rawTls.utls)
          ? (rawTls.utls as Record<string, unknown>)
          : null;
      if (rawUtls && rawUtls.enabled === true) {
        tls.utls = {
          enabled: true,
          fingerprint: normalizeFingerprint(String(rawUtls.fingerprint || 'chrome')),
        };
      }

      const rawReality =
        rawTls.reality && typeof rawTls.reality === 'object' && !Array.isArray(rawTls.reality)
          ? (rawTls.reality as Record<string, unknown>)
          : null;
      if (rawReality && rawReality.enabled === true) {
        const pbk = String(rawReality.public_key || '').trim();
        const sid = String(rawReality.short_id || '').trim();
        assertValidRealitySettings({
          publicKey: pbk,
          serverName: tls.server_name || '',
          shortId: sid,
        });
        tls.reality = {
          enabled: true,
          public_key: pbk,
          short_id: sid,
        };
        // Mandatory uTLS for Reality in sing-box 1.14+
        tls.utls = {
          enabled: true,
          fingerprint: normalizeFingerprint(tls.utls?.fingerprint || 'chrome'),
        };
      }

      canonical.tls = tls;
    } else if (protocol === 'trojan' || protocol === 'hysteria2' || protocol === 'tuic') {
      canonical.tls = {
        enabled: true,
        server_name: server,
      };
    }

    // VLESS requires TLS or Reality
    if (protocol === 'vless' && !canonical.tls?.enabled) {
      return {
        ok: false,
        error: 'کانفیگ VLESS بدون رمزنگاری TLS یا Reality در سنترا مجاز نیست.',
      };
    }

    // Note: VLESS Vision flow cannot be combined with non-TCP transports in sing-box 1.14+
    if (protocol === 'vless' && canonical.flow && canonical.transport) {
      delete canonical.flow;
    }

    const finalOutbound = enforceRealityUtls(canonical);
    return {
      ok: true,
      outbound: finalOutbound,
      compiledJson: JSON.stringify(finalOutbound),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'ساختار کانفیگ با استاندارد sing-box 1.14+ سازگار نیست.',
    };
  }
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
  protocol: AllowedProtocol;
  server_address: string;
  server_port: number;
  config_json: SingboxOutboundConfig;
  compiled_outbound_json: string;
} {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('لینک پروکسی ساختار URL معتبر ندارد.');
  }

  const scheme = url.protocol.replace(':', '').toLowerCase();
  const protocol = normalizeProtocolName(scheme);
  if (!protocol || protocol === 'vmess' || protocol === 'shadowsocks') {
    throw new Error(
      `پروتکل «${scheme}» در لیست سفید هسته sing-box 1.14+ پشتیبانی نمی‌شود. پروتکل‌های مجاز: vless، vmess، trojan، hysteria2، tuic و shadowsocks.`
    );
  }

  const server_address = assertValidServerHost(url.hostname);
  const server_port = assertValidServerPort(url.port ? Number(url.port) : 443);
  const tag = url.hash ? safeDecodeURIComponent(url.hash.slice(1)).trim() || 'sentra-node' : 'sentra-node';

  const rawConfig: Record<string, unknown> = {
    type: protocol,
    tag,
    server: server_address,
    server_port,
  };

  if (protocol === 'vless') {
    rawConfig.uuid = safeDecodeURIComponent(url.username);
    rawConfig.packet_encoding = 'xudp';
  } else if (protocol === 'trojan' || protocol === 'hysteria2') {
    const password = url.password
      ? safeDecodeURIComponent(url.password)
      : safeDecodeURIComponent(url.username);
    rawConfig.password = password;
    if (protocol === 'hysteria2') {
      const obfsType = (url.searchParams.get('obfs') || '').trim().toLowerCase();
      const obfsPass = (url.searchParams.get('obfs-password') || '').trim();
      if (obfsType === 'salamander' && obfsPass) {
        rawConfig.obfs = { type: 'salamander', password: obfsPass };
      }
    }
  } else if (protocol === 'tuic') {
    rawConfig.uuid = safeDecodeURIComponent(url.username);
    rawConfig.password = safeDecodeURIComponent(url.password);
    rawConfig.congestion_control = (url.searchParams.get('congestion_control') || 'bbr').trim();
    const udpRelay = (url.searchParams.get('udp_relay_mode') || '').trim();
    if (udpRelay) rawConfig.udp_relay_mode = udpRelay;
  }

  // Strict transport check BEFORE compiling
  const rawNetType = (url.searchParams.get('type') || url.searchParams.get('net') || '').trim().toLowerCase();
  const normalizedTransport = normalizeAndValidateTransport(rawNetType);
  const pathParam = (url.searchParams.get('path') || '').trim();
  const hostParam = (url.searchParams.get('host') || '').trim();
  const serviceName = (url.searchParams.get('serviceName') || '').trim();

  if (normalizedTransport !== 'tcp') {
    if (normalizedTransport === 'ws' || normalizedTransport === 'httpupgrade') {
      const transport: Record<string, unknown> = { type: normalizedTransport };
      if (pathParam) transport.path = pathParam;
      if (hostParam) transport.headers = { Host: hostParam };
      rawConfig.transport = transport;
    } else if (normalizedTransport === 'grpc') {
      const transport: Record<string, unknown> = { type: 'grpc' };
      if (serviceName || pathParam) {
        transport.service_name = serviceName || pathParam.replace(/^\/+/, '');
      }
      rawConfig.transport = transport;
    } else if (normalizedTransport === 'http') {
      const transport: Record<string, unknown> = { type: 'http' };
      if (pathParam) transport.path = pathParam;
      if (hostParam) transport.host = [hostParam];
      rawConfig.transport = transport;
    }
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
    rawConfig.flow = flow;
  }

  const isReality = securityParam === 'reality' || Boolean(pbk);
  const needsTls =
    isReality ||
    securityParam === 'tls' ||
    protocol === 'trojan' ||
    protocol === 'hysteria2' ||
    protocol === 'tuic' ||
    Boolean(sni);

  if (needsTls) {
    const tls: SingboxTlsConfig = {
      enabled: true,
    };
    if (sni) {
      tls.server_name = sni;
    } else if (!isReality && (protocol === 'trojan' || protocol === 'hysteria2' || protocol === 'tuic')) {
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
      assertValidRealitySettings({
        publicKey: pbk,
        serverName: sni,
        shortId: sid,
      });
      tls.reality = {
        enabled: true,
        public_key: pbk,
        short_id: sid,
      };
      tls.utls = {
        enabled: true,
        fingerprint: normalizeFingerprint(fpParam || 'chrome'),
      };
    }
    rawConfig.tls = tls;
  }

  const validated = validateSingboxOutboundStrict(rawConfig);
  if (!validated.ok) {
    throw new Error(validated.error);
  }

  return {
    tag: validated.outbound.tag,
    protocol: validated.outbound.type,
    server_address: validated.outbound.server,
    server_port: validated.outbound.server_port,
    config_json: validated.outbound,
    compiled_outbound_json: validated.compiledJson,
  };
}

function parseVmessUri(raw: string): {
  tag: string;
  protocol: AllowedProtocol;
  server_address: string;
  server_port: number;
  config_json: SingboxOutboundConfig;
  compiled_outbound_json: string;
} {
  const b64 = raw.slice('vmess://'.length).trim();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(decodeBase64Flexible(b64)) as Record<string, unknown>;
  } catch {
    throw new Error('محتوای vmess معتبر نیست.');
  }

  const server_address = assertValidServerHost(String(json.add || ''));
  const server_port = assertValidServerPort(json.port || 443);

  const tag = String(json.ps || 'sentra-vmess').trim() || 'sentra-vmess';
  const uuid = String(json.id || '').trim();
  const security = String(json.scy || 'auto').trim();
  const fp = String(json.fp || '').trim();

  const rawNet = String(json.net || 'tcp').trim().toLowerCase();
  const normalizedTransport = normalizeAndValidateTransport(rawNet);

  const rawConfig: Record<string, unknown> = {
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
      server_name: String(json.sni || json.host || server_address).trim(),
    };
    if (fp) {
      tls.utls = { enabled: true, fingerprint: normalizeFingerprint(fp) };
    }
    rawConfig.tls = tls;
  }

  if (normalizedTransport === 'ws' || normalizedTransport === 'httpupgrade') {
    const transport: Record<string, unknown> = { type: normalizedTransport };
    if (json.path) transport.path = String(json.path).trim();
    if (json.host) transport.headers = { Host: String(json.host).trim() };
    rawConfig.transport = transport;
  } else if (normalizedTransport === 'grpc') {
    rawConfig.transport = {
      type: 'grpc',
      service_name: String(json.path || '').trim().replace(/^\/+/, ''),
    };
  } else if (normalizedTransport === 'http') {
    const transport: Record<string, unknown> = { type: 'http' };
    if (json.path) transport.path = String(json.path).trim();
    if (json.host) transport.host = [String(json.host).trim()];
    rawConfig.transport = transport;
  }

  const validated = validateSingboxOutboundStrict(rawConfig);
  if (!validated.ok) {
    throw new Error(validated.error);
  }

  return {
    tag: validated.outbound.tag,
    protocol: validated.outbound.type,
    server_address: validated.outbound.server,
    server_port: validated.outbound.server_port,
    config_json: validated.outbound,
    compiled_outbound_json: validated.compiledJson,
  };
}

function parseShadowsocksUri(raw: string): {
  tag: string;
  protocol: AllowedProtocol;
  server_address: string;
  server_port: number;
  config_json: SingboxOutboundConfig;
  compiled_outbound_json: string;
} {
  const withoutScheme = raw.slice('ss://'.length).trim();
  const hashIdx = withoutScheme.indexOf('#');
  const mainPart = hashIdx >= 0 ? withoutScheme.slice(0, hashIdx) : withoutScheme;
  const tag =
    hashIdx >= 0
      ? safeDecodeURIComponent(withoutScheme.slice(hashIdx + 1)).trim() || 'sentra-ss'
      : 'sentra-ss';

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

    let parsedHost: URL;
    try {
      parsedHost = new URL(`http://${hostPort}`);
    } catch {
      throw new Error('آدرس یا پورت سرور Shadowsocks نامعتبر است.');
    }
    server_address = assertValidServerHost(parsedHost.hostname);
    server_port = assertValidServerPort(parsedHost.port ? Number(parsedHost.port) : 443);
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

    let parsedHost: URL;
    try {
      parsedHost = new URL(`http://${hostPort}`);
    } catch {
      throw new Error('آدرس یا پورت سرور Shadowsocks نامعتبر است.');
    }
    server_address = assertValidServerHost(parsedHost.hostname);
    server_port = assertValidServerPort(parsedHost.port ? Number(parsedHost.port) : 443);
  }

  const validated = validateSingboxOutboundStrict({
    type: 'shadowsocks',
    tag,
    server: server_address,
    server_port,
    method,
    password,
  });
  if (!validated.ok) {
    throw new Error(validated.error);
  }

  return {
    tag: validated.outbound.tag,
    protocol: validated.outbound.type,
    server_address: validated.outbound.server,
    server_port: validated.outbound.server_port,
    config_json: validated.outbound,
    compiled_outbound_json: validated.compiledJson,
  };
}

function parseRawSingboxJson(raw: string): {
  tag: string;
  protocol: AllowedProtocol;
  server_address: string;
  server_port: number;
  config_json: SingboxOutboundConfig;
  compiled_outbound_json: string;
} {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error('ساختار JSON کانفیگ sing-box معتبر نیست.');
  }

  const validated = validateSingboxOutboundStrict(obj);
  if (!validated.ok) {
    throw new Error(validated.error);
  }

  return {
    tag: validated.outbound.tag,
    protocol: validated.outbound.type,
    server_address: validated.outbound.server,
    server_port: validated.outbound.server_port,
    config_json: validated.outbound,
    compiled_outbound_json: validated.compiledJson,
  };
}

/**
 * Parses a single proxy URI or sing-box JSON outbound against the strict
 * sing-box 1.14+ protocol & transport whitelist, injects mandatory Reality uTLS,
 * rejects private/SSRF hosts and incomplete Reality configs with clear Persian
 * error messages, detects country, and computes SHA-256 deduplication hash.
 */
export async function parseOutboundInput(rawInput: string): Promise<ParsedProxy> {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    throw new Error('ورودی لینک یا کانفیگ خالی است.');
  }

  let parsed: {
    tag: string;
    protocol: AllowedProtocol;
    server_address: string;
    server_port: number;
    config_json: SingboxOutboundConfig;
    compiled_outbound_json: string;
  };

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    parsed = parseRawSingboxJson(trimmed);
  } else if (/^vmess:\/\//i.test(trimmed)) {
    parsed = parseVmessUri(trimmed);
  } else if (/^ss:\/\//i.test(trimmed)) {
    parsed = parseShadowsocksUri(trimmed);
  } else if (/^(vless|trojan|hy2|hysteria2|tuic):\/\//i.test(trimmed)) {
    parsed = parseStandardUri(trimmed);
  } else if (/^([a-z0-9+.-]+):\/\//i.test(trimmed)) {
    const scheme = trimmed.split('://')[0].toLowerCase();
    throw new Error(
      `پروتکل «${scheme}» در لیست سفید هسته sing-box 1.14+ پشتیبانی نمی‌شود. پروتکل‌های مجاز: vless، vmess، trojan، hysteria2، tuic و shadowsocks.`
    );
  } else {
    throw new Error(
      'فرمت لینک پشتیبانی نمی‌شود. پروتکل‌های مجاز: vless://، vmess://، trojan://، hy2://، tuic://، ss:// یا JSON استاندارد sing-box.'
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
 * Decodes a subscription payload (plain lines or Base64) and extracts all valid
 * sing-box 1.14+ whitelisted proxy lines.
 */
export async function parseSubscriptionPayload(rawBody: string): Promise<{
  nodes: ParsedProxy[];
  skipped: number;
  rejectionReasons: string[];
}> {
  let text = rawBody.trim();
  const looksLikeUriList = /^(vless|vmess|trojan|hy2|hysteria2|tuic|ss):\/\//im.test(text);
  if (!looksLikeUriList && !text.startsWith('{')) {
    try {
      const decoded = decodeBase64Flexible(text);
      if (/^(vless|vmess|trojan|hy2|hysteria2|tuic|ss|wireguard|wg|socks|http):\/\//im.test(decoded)) {
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
  const rejectionReasons: string[] = [];
  let skipped = 0;

  for (const line of lines) {
    try {
      const node = await parseOutboundInput(line);
      if (seen.has(node.fingerprint_sha256)) continue;
      seen.add(node.fingerprint_sha256);
      nodes.push(node);
    } catch (err) {
      skipped += 1;
      if (rejectionReasons.length < 25) {
        rejectionReasons.push(err instanceof Error ? err.message : 'کانفیگ نامعتبر');
      }
    }
  }

  return { nodes, skipped, rejectionReasons };
}

/**
 * Strict security & sing-box 1.14+ schema audit matching QualityEngine.
 */
export function auditOutboundSecurity(
  protocol: string,
  config: SingboxOutboundConfig | Record<string, unknown>
): { passed: boolean; reason: string | null } {
  const normalizedProto = normalizeProtocolName(protocol);
  if (!normalizedProto) {
    return {
      passed: false,
      reason: `پروتکل «${protocol}» در لیست سفید sing-box 1.14+ مجاز نیست.`,
    };
  }
  const validated = validateSingboxOutboundStrict({
    ...(config as Record<string, unknown>),
    type: normalizedProto,
  });
  if (!validated.ok) {
    return { passed: false, reason: validated.error };
  }
  return { passed: true, reason: null };
}
