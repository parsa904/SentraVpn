import { enforceRealityUtls, type SingboxOutboundConfig } from './outboundAnalyzer.ts';
import type {
  ConnectionMode,
  DonatedOutboundRow,
  OutboundRow,
  SubscriptionRow,
  WarpAccountRow,
} from './types.ts';

export const IR_SPLIT_TUNNEL_DOMAINS = [
  '.ir',
  '.gov.ir',
  '.co.ir',
  'shaparak.ir',
  'divar.ir',
  'digikala.com',
  'snapp.ir',
  'tamin.ir',
  'bmi.ir',
  'bki.ir',
  'mellatbank.ir',
  'tejaratbank.ir',
  'banksepah.ir',
  'saderatbank.ir',
  'bankmelli.ir',
  'parsian-bank.ir',
  'pasargadbank.ir',
  'samanbank.ir',
] as const;

export function tierHasStaticIp(tier: string): boolean {
  const lower = tier.trim().toLowerCase();
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
  const lower = tier.trim().toLowerCase();
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

function buildCoreOutboundNode(ob: OutboundRow, tag: string): SingboxOutboundConfig {
  switch (ob.protocol.toLowerCase()) {
    case 'vless': {
      const node: SingboxOutboundConfig = {
        type: 'vless',
        tag,
        server: ob.server_address,
        server_port: ob.server_port,
        uuid: ob.uuid || '00000000-0000-0000-0000-000000000000',
        flow: '',
        packet_encoding: 'xudp',
      };
      if (ob.tls_enabled === 1) {
        node.tls = {
          enabled: true,
          server_name: ob.tls_sni || 'learn.microsoft.com',
          utls: {
            enabled: true,
            fingerprint: 'chrome',
          },
          ...(ob.reality_public_key
            ? {
                reality: {
                  enabled: true,
                  public_key: ob.reality_public_key,
                  short_id: ob.reality_short_id || '',
                },
              }
            : {}),
        };
      }
      return enforceRealityUtls(node);
    }
    case 'trojan':
      return {
        type: 'trojan',
        tag,
        server: ob.server_address,
        server_port: ob.server_port,
        password: ob.password || 'sentra_pass',
        tls: {
          enabled: true,
          server_name: ob.tls_sni || ob.server_address,
          utls: { enabled: true, fingerprint: 'chrome' },
        },
      };
    case 'hysteria2':
      return {
        type: 'hysteria2',
        tag,
        server: ob.server_address,
        server_port: ob.server_port,
        password: ob.password || 'sentra_pass',
        tls: {
          enabled: true,
          server_name: ob.tls_sni || ob.server_address,
        },
      };
    case 'http':
      return {
        type: 'http',
        tag,
        server: ob.server_address,
        server_port: ob.server_port,
      };
    default:
      return {
        type: 'socks',
        tag,
        server: ob.server_address,
        server_port: ob.server_port,
        version: '5',
      };
  }
}

export interface CompileClientOptions {
  mode?: ConnectionMode;
  preferFirstAsDefault?: boolean;
  includeClashApi?: boolean;
}

/**
 * Compiles a strict sing-box 1.12+ / 1.14+ compliant client configuration JSON:
 * - Uses typed `dns.servers` with `{ type: "fakeip", tag: "dns-fakeip", ... }`
 * - Uses modern `route.rules` actions (`{ action: "sniff" }`, `{ protocol: "dns", action: "hijack-dns" }`)
 *   instead of deprecated `dns-out` outbound and inbound `sniff` fields
 * - Preserves Iranian `.ir` & bank domain Split Tunneling (`direct`)
 * - Strictly omits deprecated `independent_cache` and non-schema `_sentra_meta`
 * - Enforces mandatory uTLS (`fingerprint: "chrome"` default) on all Reality outbounds
 */
export function compileClientSingboxConfig(
  outbounds: OutboundRow[],
  donatedOutbounds: DonatedOutboundRow[],
  options: CompileClientOptions = {}
): Record<string, unknown> {
  const mode: ConnectionMode = options.mode || 'web_browsing';
  const isGaming = mode === 'gaming';
  const preferFirstAsDefault = Boolean(options.preferFirstAsDefault);

  const outboundTags: string[] = [];
  const concreteOutbounds: Record<string, unknown>[] = [];
  const usedTags = new Set<string>(['Sentra Select', 'Sentra Auto', 'direct']);

  const makeUniqueTag = (base: string): string => {
    const clean = base.trim() || 'Sentra Node';
    if (!usedTags.has(clean)) {
      usedTags.add(clean);
      return clean;
    }
    let idx = 2;
    while (usedTags.has(`${clean} (${idx})`)) {
      idx += 1;
    }
    const candidate = `${clean} (${idx})`;
    usedTags.add(candidate);
    return candidate;
  };

  // 1. Official & community donated outbounds
  for (const dob of donatedOutbounds) {
    try {
      const parsed = JSON.parse(dob.config_json) as SingboxOutboundConfig;
      const normalized = enforceRealityUtls(parsed);
      const displayBase =
        dob.label && dob.label.trim().length > 0 ? dob.label.trim() : dob.tag;
      const prefix = dob.is_official === 1 ? '👑 ' : '🤝 ';
      const tag = makeUniqueTag(`${prefix}${displayBase}`);
      normalized.tag = tag;
      outboundTags.push(tag);
      concreteOutbounds.push(normalized);
    } catch {
      // Skip malformed stored config_json
    }
  }

  // 2. Non-loopback core outbounds
  const hasRealNodes =
    outboundTags.length > 0 || outbounds.some((ob) => ob.server_address !== '127.0.0.1');

  for (const ob of outbounds) {
    if (hasRealNodes && ob.server_address === '127.0.0.1') continue;
    const tag = makeUniqueTag(ob.tag);
    outboundTags.push(tag);
    concreteOutbounds.push(buildCoreOutboundNode(ob, tag));
  }

  // Fallback node only if pool is completely empty
  if (outboundTags.length === 0) {
    const fallbackTag = makeUniqueTag('Sentra Direct Fallback');
    outboundTags.push(fallbackTag);
    concreteOutbounds.push({
      type: 'direct',
      tag: fallbackTag,
    });
  }

  const selectorOutbounds = ['Sentra Auto', ...outboundTags, 'direct'];
  const defaultTarget = preferFirstAsDefault ? outboundTags[0] || 'Sentra Auto' : 'Sentra Auto';

  const allOutbounds: Record<string, unknown>[] = [
    {
      type: 'selector',
      tag: 'Sentra Select',
      outbounds: selectorOutbounds,
      default: defaultTarget,
    },
    {
      type: 'urltest',
      tag: 'Sentra Auto',
      outbounds: outboundTags,
      url: 'https://cp.cloudflare.com/generate_204',
      interval: isGaming ? '1m' : '30s',
      tolerance: isGaming ? 15 : 50,
    },
    ...concreteOutbounds,
    {
      type: 'direct',
      tag: 'direct',
    },
  ];

  // sing-box 1.12+ / 1.14+ typed DNS configuration (NO `independent_cache`, NO legacy `address: "fakeip"`)
  const dnsConfig: Record<string, unknown> = isGaming
    ? {
        servers: [
          {
            type: 'udp',
            tag: 'dns-remote',
            server: '1.1.1.1',
            server_port: 53,
            detour: 'Sentra Select',
          },
          {
            type: 'udp',
            tag: 'dns-remote-backup',
            server: '8.8.8.8',
            server_port: 53,
            detour: 'Sentra Select',
          },
          {
            type: 'local',
            tag: 'dns-direct',
          },
        ],
        rules: [
          {
            domain_suffix: [...IR_SPLIT_TUNNEL_DOMAINS],
            server: 'dns-direct',
          },
          {
            clash_mode: 'Direct',
            server: 'dns-direct',
          },
        ],
        final: 'dns-remote',
        strategy: 'ipv4_only',
      }
    : {
        servers: [
          {
            type: 'fakeip',
            tag: 'dns-fakeip',
            inet4_range: '198.18.0.0/15',
            inet6_range: 'fc00::/18',
          },
          {
            type: 'https',
            tag: 'dns-doh',
            server: '1.1.1.1',
            server_port: 443,
            path: '/dns-query',
            detour: 'Sentra Select',
          },
          {
            type: 'https',
            tag: 'dns-doh-google',
            server: '8.8.8.8',
            server_port: 443,
            path: '/dns-query',
            detour: 'Sentra Select',
          },
          {
            type: 'local',
            tag: 'dns-direct',
          },
        ],
        rules: [
          {
            domain_suffix: [...IR_SPLIT_TUNNEL_DOMAINS],
            server: 'dns-direct',
          },
          {
            clash_mode: 'Direct',
            server: 'dns-direct',
          },
          {
            clash_mode: 'Global',
            server: 'dns-fakeip',
          },
          {
            query_type: ['A', 'AAAA'],
            server: 'dns-fakeip',
          },
        ],
        final: 'dns-doh',
        strategy: 'prefer_ipv4',
      };

  // sing-box 1.12+/1.14+ TUN inbound (uses `address` array; sniffing moved to route rule_actions)
  const tunInbound: Record<string, unknown> = isGaming
    ? {
        type: 'tun',
        tag: 'tun-in',
        interface_name: 'sentra-tun',
        address: ['172.19.0.1/30'],
        mtu: 1280,
        auto_route: true,
        strict_route: true,
        stack: 'system',
        endpoint_independent_nat: true,
        udp_timeout: '5m',
      }
    : {
        type: 'tun',
        tag: 'tun-in',
        interface_name: 'sentra-tun',
        address: ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'],
        mtu: 9000,
        auto_route: true,
        strict_route: true,
        stack: 'mixed',
      };

  // Modern sing-box 1.11+/1.14+ rule_actions: sniff + hijack-dns (replaces deprecated dns-out)
  const routeRules: Record<string, unknown>[] = [];
  if (!isGaming) {
    routeRules.push({
      action: 'sniff',
      timeout: '300ms',
    });
  }
  routeRules.push(
    {
      protocol: 'dns',
      action: 'hijack-dns',
    },
    {
      ip_is_private: true,
      outbound: 'direct',
    },
    {
      domain_suffix: [...IR_SPLIT_TUNNEL_DOMAINS],
      outbound: 'direct',
    },
    {
      clash_mode: 'Direct',
      outbound: 'direct',
    },
    {
      clash_mode: 'Global',
      outbound: 'Sentra Select',
    }
  );

  const config: Record<string, unknown> = {
    log: {
      level: isGaming ? 'warn' : 'info',
      timestamp: true,
    },
    dns: dnsConfig,
    inbounds: [tunInbound],
    outbounds: allOutbounds,
    route: {
      auto_detect_interface: true,
      default_domain_resolver: 'dns-direct',
      rules: routeRules,
      final: 'Sentra Select',
    },
  };

  if (options.includeClashApi !== false) {
    config.experimental = {
      clash_api: {
        external_controller: '127.0.0.1:9090',
      },
      cache_file: {
        enabled: true,
        store_fakeip: !isGaming,
      },
    };
  }

  return config;
}

/**
 * Compiles the Linux Bridge VPS sing-box 1.14+ server config served by GET /api/v1/bridge/config.
 * Mirrors sentra-core/src/bridge_sync.rs without deprecated fields.
 */
export function compileBridgeSingboxConfig(params: {
  webOutbounds: DonatedOutboundRow[];
  downloadOutbounds: DonatedOutboundRow[];
  staticIpOutbounds: DonatedOutboundRow[];
  gamingOutbounds: DonatedOutboundRow[];
  coreOutbounds: OutboundRow[];
  warpAccount: WarpAccountRow | null;
}): Record<string, unknown> {
  const singboxOutbounds: Record<string, unknown>[] = [
    { type: 'direct', tag: 'direct-out' },
  ];
  const insertedTags = new Set<string>(['direct-out']);

  const webTags: string[] = [];
  const dlTags: string[] = [];
  const staticTags: string[] = [];
  const gamingTags: string[] = [];

  const registerDonatedPool = (
    rows: DonatedOutboundRow[],
    prefix: string,
    targetList: string[]
  ) => {
    for (const dob of rows) {
      try {
        const parsed = enforceRealityUtls(JSON.parse(dob.config_json) as SingboxOutboundConfig);
        const tag = `${prefix}-${dob.country_code.toLowerCase()}-${dob.id}`;
        if (!insertedTags.has(tag)) {
          insertedTags.add(tag);
          parsed.tag = tag;
          singboxOutbounds.push(parsed);
        }
        if (!targetList.includes(tag)) {
          targetList.push(tag);
        }
      } catch {
        // skip invalid config_json
      }
    }
  };

  registerDonatedPool(params.webOutbounds, 'out-web', webTags);
  registerDonatedPool(params.downloadOutbounds, 'out-dl', dlTags);
  registerDonatedPool(params.staticIpOutbounds, 'out-static', staticTags);
  registerDonatedPool(params.gamingOutbounds, 'out-game', gamingTags);

  for (const ob of params.coreOutbounds) {
    if (ob.is_active !== 1 || ob.server_address === '127.0.0.1') continue;
    const tag = `out-core-${ob.country_code.toLowerCase()}-${ob.id}`;
    if (!insertedTags.has(tag)) {
      insertedTags.add(tag);
      singboxOutbounds.push(buildCoreOutboundNode(ob, tag));
    }
    if (ob.mode_category === 'static_ip') {
      if (!staticTags.includes(tag)) staticTags.push(tag);
      if (!webTags.includes(tag)) webTags.push(tag);
      if (!dlTags.includes(tag)) dlTags.push(tag);
    } else if (ob.mode_category === 'gaming') {
      if (!gamingTags.includes(tag)) gamingTags.push(tag);
      if (!webTags.includes(tag)) webTags.push(tag);
    } else if (ob.mode_category === 'download') {
      if (!dlTags.includes(tag)) dlTags.push(tag);
      if (!webTags.includes(tag)) webTags.push(tag);
    } else {
      if (!webTags.includes(tag)) webTags.push(tag);
      if (!dlTags.includes(tag)) dlTags.push(tag);
      if (!gamingTags.includes(tag)) gamingTags.push(tag);
    }
  }

  let staticTarget = 'direct-out';
  if (staticTags.length > 1) {
    singboxOutbounds.push({
      type: 'urltest',
      tag: 'out-static-auto',
      outbounds: staticTags,
      url: 'https://api.binance.com/api/v3/ping',
      interval: '5m',
      tolerance: 30,
    });
    staticTarget = 'out-static-auto';
  } else if (staticTags.length === 1) {
    staticTarget = staticTags[0];
  } else if (webTags.length > 0) {
    staticTarget = webTags[0];
  }

  let webTarget = 'direct-out';
  if (webTags.length > 0) {
    singboxOutbounds.push({
      type: 'urltest',
      tag: 'out-web-auto',
      outbounds: webTags,
      url: 'https://cp.cloudflare.com/generate_204',
      interval: '3m',
      tolerance: 50,
    });
    webTarget = 'out-web-auto';
  } else if (dlTags.length > 0) {
    webTarget = dlTags[0];
  }

  let dlTarget = 'direct-out';
  if (dlTags.length > 0) {
    singboxOutbounds.push({
      type: 'urltest',
      tag: 'out-dl-auto',
      outbounds: dlTags,
      url: 'https://cp.cloudflare.com/generate_204',
      interval: '3m',
      tolerance: 50,
    });
    dlTarget = 'out-dl-auto';
  } else if (webTags.length > 0) {
    dlTarget = webTags[0];
  }

  let gamingTarget = 'direct-out';
  if (gamingTags.length > 0) {
    singboxOutbounds.push({
      type: 'urltest',
      tag: 'out-gaming-auto',
      outbounds: gamingTags,
      url: 'https://cp.cloudflare.com/generate_204',
      interval: '1m',
      tolerance: 15,
    });
    gamingTarget = 'out-gaming-auto';
  } else if (webTags.length > 0) {
    gamingTarget = webTarget;
  }

  const inbounds: Record<string, unknown>[] = [
    {
      type: 'tun',
      tag: 'tun-web',
      interface_name: 'tun-web',
      address: ['10.10.0.1/30'],
      auto_route: false,
      strict_route: false,
      stack: 'system',
    },
    {
      type: 'tun',
      tag: 'tun-dl',
      interface_name: 'tun-dl',
      address: ['10.10.1.1/30'],
      auto_route: false,
      strict_route: false,
      stack: 'system',
    },
    {
      type: 'tun',
      tag: 'tun-static',
      interface_name: 'tun-static',
      address: ['10.10.2.1/30'],
      auto_route: false,
      strict_route: false,
      stack: 'system',
    },
    {
      type: 'tun',
      tag: 'tun-gaming',
      interface_name: 'tun-gaming',
      address: ['10.10.3.1/30'],
      mtu: 1280,
      endpoint_independent_nat: true,
      udp_timeout: '5m',
      auto_route: false,
      strict_route: false,
      stack: 'system',
    },
  ];

  const routeRules: Record<string, unknown>[] = [
    { protocol: 'dns', action: 'hijack-dns' },
    { inbound: ['tun-web'], outbound: webTarget },
    { inbound: ['tun-dl'], outbound: dlTarget },
    { inbound: ['tun-static'], outbound: staticTarget },
    { inbound: ['tun-gaming'], outbound: gamingTarget },
  ];

  if (params.warpAccount) {
    let reserved: number[] = [0, 0, 0];
    try {
      const parsedRes = JSON.parse(params.warpAccount.reserved) as unknown;
      if (Array.isArray(parsedRes) && parsedRes.length === 3) {
        reserved = parsedRes.map((n) => Number(n) || 0);
      }
    } catch {
      reserved = [0, 0, 0];
    }

    singboxOutbounds.push(
      {
        type: 'wireguard',
        tag: 'out-web-warp',
        server: '162.159.192.1',
        server_port: 2408,
        local_address: [
          `${params.warpAccount.ipv4_address}/32`,
          `${params.warpAccount.ipv6_address}/128`,
        ],
        private_key: params.warpAccount.private_key,
        peer_public_key: 'bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=',
        reserved,
        mtu: 1280,
        detour: webTarget,
      },
      {
        type: 'wireguard',
        tag: 'out-dl-warp',
        server: '162.159.192.1',
        server_port: 2408,
        local_address: [
          `${params.warpAccount.ipv4_address}/32`,
          `${params.warpAccount.ipv6_address}/128`,
        ],
        private_key: params.warpAccount.private_key,
        peer_public_key: 'bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=',
        reserved,
        mtu: 1280,
        detour: dlTarget,
      }
    );

    inbounds.push(
      {
        type: 'tun',
        tag: 'tun-web-warp',
        interface_name: 'tun-web-warp',
        address: ['10.10.10.1/30'],
        auto_route: false,
        strict_route: false,
        stack: 'system',
      },
      {
        type: 'tun',
        tag: 'tun-dl-warp',
        interface_name: 'tun-dl-warp',
        address: ['10.10.11.1/30'],
        auto_route: false,
        strict_route: false,
        stack: 'system',
      }
    );

    routeRules.splice(
      1,
      0,
      { inbound: ['tun-web-warp'], outbound: 'out-web-warp' },
      { inbound: ['tun-dl-warp'], outbound: 'out-dl-warp' }
    );
  }

  return {
    log: {
      level: 'warn',
      timestamp: true,
    },
    dns: {
      servers: [
        { type: 'udp', tag: 'dns-cf', server: '1.1.1.1', server_port: 53 },
        { type: 'local', tag: 'dns-local' },
      ],
      final: 'dns-cf',
    },
    inbounds,
    outbounds: singboxOutbounds,
    route: {
      auto_detect_interface: true,
      default_domain_resolver: 'dns-local',
      rules: routeRules,
      final: 'direct-out',
    },
  };
}

export function buildSubscriptionUserInfoHeader(sub: SubscriptionRow): string {
  const expireEpoch = Math.floor(Date.parse(sub.expires_at) / 1000) || 0;
  return `upload=${sub.upload_bytes}; download=${sub.download_bytes}; total=${sub.traffic_limit_bytes}; expire=${expireEpoch}`;
}

export function compileV2RaySubscriptionBase64(
  donatedOutbounds: DonatedOutboundRow[],
  coreOutbounds: OutboundRow[]
): string {
  const lines: string[] = [];
  for (const dob of donatedOutbounds) {
    if (dob.raw_link && /^(vless|vmess|trojan|hy2|hysteria2|tuic|ss|wireguard|wg):\/\//i.test(dob.raw_link)) {
      lines.push(dob.raw_link.trim());
    }
  }
  for (const ob of coreOutbounds) {
    if (ob.server_address === '127.0.0.1' && lines.length > 0) continue;
    const encodedTag = encodeURIComponent(ob.tag);
    if (ob.protocol === 'vless') {
      const sni = ob.tls_sni || 'learn.microsoft.com';
      const pbk = ob.reality_public_key ? `&security=reality&pbk=${encodeURIComponent(ob.reality_public_key)}&sid=${encodeURIComponent(ob.reality_short_id || '')}&fp=chrome` : '&security=tls&fp=chrome';
      lines.push(`vless://${ob.uuid || '00000000-0000-0000-0000-000000000000'}@${ob.server_address}:${ob.server_port}?type=${ob.network_transport}&sni=${encodeURIComponent(sni)}${pbk}#${encodedTag}`);
    } else if (ob.protocol === 'trojan') {
      lines.push(`trojan://${encodeURIComponent(ob.password || 'sentra_pass')}@${ob.server_address}:${ob.server_port}?sni=${encodeURIComponent(ob.tls_sni || ob.server_address)}&fp=chrome#${encodedTag}`);
    } else if (ob.protocol === 'hysteria2') {
      lines.push(`hysteria2://${encodeURIComponent(ob.password || 'sentra_pass')}@${ob.server_address}:${ob.server_port}?sni=${encodeURIComponent(ob.tls_sni || ob.server_address)}#${encodedTag}`);
    }
  }

  const rawText = lines.join('\n');
  const bytes = new TextEncoder().encode(rawText);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export async function generateWireguardGamingProfile(params: {
  subscription: SubscriptionRow;
  serverHost: string;
  serverPublicKey: string;
  port: number;
  keySalt: string;
}): Promise<{ filename: string; config: string }> {
  // Derive deterministic client interface key material per subscription token (no secrets hardcoded)
  const seed = new TextEncoder().encode(`${params.keySalt}:${params.subscription.token}:wg-gaming`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', seed));
  // Clamp Curve25519 scalar per RFC 7748
  digest[0] &= 248;
  digest[31] &= 127;
  digest[31] |= 64;
  let bin = '';
  for (let i = 0; i < digest.length; i += 1) {
    bin += String.fromCharCode(digest[i]);
  }
  const clientPrivateKey = btoa(bin);

  const octet3 = (digest[1] % 250) + 1;
  const octet4 = (digest[2] % 250) + 2;
  const shortId = params.subscription.token.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 14) || 'client';

  const config = [
    `# Sentra Gaming WireGuard Profile (iOS / Low-Latency UDP)`,
    `# Tier: ${params.subscription.tier}`,
    `[Interface]`,
    `PrivateKey = ${clientPrivateKey}`,
    `Address = 10.66.${octet3}.${octet4}/32`,
    `DNS = 1.1.1.1, 8.8.8.8`,
    `MTU = 1280`,
    ``,
    `[Peer]`,
    `PublicKey = ${params.serverPublicKey}`,
    `AllowedIPs = 0.0.0.0/0, ::/0`,
    `Endpoint = ${params.serverHost}:${params.port}`,
    `PersistentKeepalive = 15`,
    ``,
  ].join('\n');

  return {
    filename: `sentra-gaming-${shortId}.conf`,
    config,
  };
}
