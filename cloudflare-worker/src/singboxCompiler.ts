import {
  enforceRealityUtls,
  validateSingboxOutboundStrict,
  type SingboxOutboundConfig,
} from './outboundAnalyzer.ts';
import type {
  ConnectionMode,
  DonatedOutboundRow,
  OutboundRow,
  PlanTier,
  SubscriptionRow,
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

export function resolvePlanTier(sub: Pick<SubscriptionRow, 'tier' | 'plan_tier'>): 'free' | 'pro' | 'flow_plus' {
  const explicit = (sub.plan_tier || '').trim().toLowerCase();
  if (explicit === 'flow_plus') return 'flow_plus';
  if (explicit === 'pro') return 'pro';
  if (explicit === 'free') {
    const legacy = (sub.tier || '').trim().toLowerCase();
    if (legacy.includes('flow')) return 'flow_plus';
    if (legacy.includes('pro') || legacy.includes('static')) return 'pro';
    return 'free';
  }
  const legacy = (sub.tier || '').trim().toLowerCase();
  if (legacy.includes('flow')) return 'flow_plus';
  if (legacy.includes('pro') || legacy.includes('static') || legacy.includes('gaming')) return 'pro';
  return 'free';
}

export function tierHasStaticIp(tier: string, planTier?: string | null): boolean {
  const normalizedPlan = (planTier || '').trim().toLowerCase();
  if (normalizedPlan === 'pro' || normalizedPlan === 'flow_plus') return true;

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

export function tierHasGaming(tier: string, planTier?: string | null): boolean {
  const normalizedPlan = (planTier || '').trim().toLowerCase();
  if (normalizedPlan === 'flow_plus') return true;
  if (normalizedPlan === 'pro') return false;

  const lower = tier.trim().toLowerCase();
  if (!lower || lower === 'sentra lite' || lower === 'lite' || lower === 'free' || lower === 'sentra pro' || lower === 'pro') {
    return false;
  }
  return (
    lower.includes('gaming') ||
    lower.includes('game') ||
    lower.includes('flow') ||
    lower.includes('ultra') ||
    lower.includes('vip') ||
    lower.includes('all')
  );
}

export function subscriptionHasSpecialTrialCredit(
  sub: Pick<SubscriptionRow, 'special_quota_bytes' | 'special_used_bytes'>
): boolean {
  const quota = Number(sub.special_quota_bytes || 0);
  const used = Number(sub.special_used_bytes || 0);
  return quota > 0 && used < quota;
}

export function subscriptionCanAccessSpecialMode(
  sub: Pick<SubscriptionRow, 'tier' | 'plan_tier' | 'special_quota_bytes' | 'special_used_bytes'>,
  mode: 'static_ip' | 'gaming'
): { allowed: boolean; isTrial: boolean; quotaExceeded: boolean } {
  const plan = resolvePlanTier(sub);
  const specialQuota = Number(sub.special_quota_bytes || 0);
  const specialUsed = Number(sub.special_used_bytes || 0);

  if (plan === 'flow_plus') {
    const quotaExceeded = specialQuota > 0 && specialUsed >= specialQuota;
    return { allowed: !quotaExceeded, isTrial: false, quotaExceeded };
  }

  if (plan === 'pro') {
    if (mode !== 'static_ip') {
      return { allowed: false, isTrial: false, quotaExceeded: false };
    }
    const quotaExceeded = specialQuota > 0 && specialUsed >= specialQuota;
    return { allowed: !quotaExceeded, isTrial: false, quotaExceeded };
  }

  // Free plan: allowed ONLY when one-time 1GB special trial credit is active & remaining
  if (specialQuota > 0) {
    const quotaExceeded = specialUsed >= specialQuota;
    return { allowed: !quotaExceeded, isTrial: true, quotaExceeded };
  }

  return { allowed: false, isTrial: false, quotaExceeded: false };
}

function buildCoreOutboundNode(ob: OutboundRow, tag: string): SingboxOutboundConfig | null {
  switch (ob.protocol.toLowerCase()) {
    case 'vless': {
      const node: SingboxOutboundConfig = {
        type: 'vless',
        tag,
        server: ob.server_address,
        server_port: ob.server_port,
        uuid: ob.uuid || '00000000-0000-0000-0000-000000000000',
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
    case 'vmess':
      return {
        type: 'vmess',
        tag,
        server: ob.server_address,
        server_port: ob.server_port,
        uuid: ob.uuid || '00000000-0000-0000-0000-000000000000',
        security: 'auto',
        alter_id: 0,
      };
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
    case 'tuic':
      return {
        type: 'tuic',
        tag,
        server: ob.server_address,
        server_port: ob.server_port,
        uuid: ob.uuid || '00000000-0000-0000-0000-000000000000',
        password: ob.password || 'sentra_pass',
        congestion_control: 'bbr',
        tls: {
          enabled: true,
          server_name: ob.tls_sni || ob.server_address,
        },
      };
    case 'shadowsocks':
      return {
        type: 'shadowsocks',
        tag,
        server: ob.server_address,
        server_port: ob.server_port,
        method: 'aes-256-gcm',
        password: ob.password || 'sentra_pass',
      };
    default:
      return null;
  }
}

export interface CompileClientOptions {
  mode?: ConnectionMode;
  preferFirstAsDefault?: boolean;
  includeClashApi?: boolean;
  onError?: (source: string, errorDetails: string) => void;
}

/**
 * Compiles a strict sing-box 1.12+ / 1.14+ compliant client configuration JSON:
 * - Reads ONLY precompiled `compiled_outbound_json` (legacy fallback: `config_json`)
 *   and never re-parses raw proxy links at request time
 * - Validates every outbound against the strict sing-box 1.14+ protocol/transport whitelist
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

  // 1. Healthy precompiled official & community donated outbounds (never re-parses raw_link)
  for (const dob of donatedOutbounds) {
    if (dob.status && dob.status !== 'active') continue;
    const rawJson =
      dob.compiled_outbound_json && dob.compiled_outbound_json.trim().length > 0
        ? dob.compiled_outbound_json
        : dob.config_json;
    try {
      const parsed = JSON.parse(rawJson) as Record<string, unknown>;
      const validated = validateSingboxOutboundStrict(parsed);
      if (!validated.ok) {
        options.onError?.(
          'singboxCompiler.ts',
          `Skipped non-compliant outbound (id=${dob.id}, tag=${dob.tag}): ${validated.error}`
        );
        continue;
      }
      const normalized = validated.outbound;
      const displayBase =
        dob.label && dob.label.trim().length > 0 ? dob.label.trim() : dob.tag;
      const prefix = dob.is_official === 1 ? '👑 ' : '🤝 ';
      const tag = makeUniqueTag(`${prefix}${displayBase}`);
      normalized.tag = tag;
      outboundTags.push(tag);
      concreteOutbounds.push(normalized as unknown as Record<string, unknown>);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      options.onError?.(
        'singboxCompiler.ts',
        `Malformed precompiled outbound JSON (id=${dob.id}, tag=${dob.tag}): ${detail}`
      );
    }
  }

  // 2. Active non-loopback core outbounds (strictly whitelisted protocols)
  const activeCoreOutbounds = outbounds.filter((ob) => ob.is_active !== 0);
  const hasRealNodes =
    outboundTags.length > 0 ||
    activeCoreOutbounds.some((ob) => ob.server_address !== '127.0.0.1');

  for (const ob of activeCoreOutbounds) {
    if (hasRealNodes && ob.server_address === '127.0.0.1') continue;
    const built = buildCoreOutboundNode(ob, ob.tag);
    if (!built) continue;
    const tag = makeUniqueTag(ob.tag);
    built.tag = tag;
    outboundTags.push(tag);
    concreteOutbounds.push(built as unknown as Record<string, unknown>);
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

/**
 * Wraps a single validated outbound inside a minimal sing-box 1.14+ skeleton
 * suitable for Stage-1 isolated `sing-box check -c <file>` validation in QualityEngine.
 */
export function compileSingleNodeCheckConfig(
  outbound: SingboxOutboundConfig
): Record<string, unknown> {
  const safeOutbound = {
    ...outbound,
    tag: 'node-check',
  };
  return {
    log: { level: 'warn' },
    dns: {
      servers: [
        {
          type: 'local',
          tag: 'dns-local',
        },
      ],
      final: 'dns-local',
    },
    inbounds: [
      {
        type: 'socks',
        tag: 'socks-in',
        listen: '127.0.0.1',
        listen_port: 10808,
      },
    ],
    outbounds: [
      safeOutbound,
      {
        type: 'direct',
        tag: 'direct',
      },
    ],
    route: {
      default_domain_resolver: 'dns-local',
      final: 'node-check',
    },
  };
}

/**
 * Filters healthy active donated outbounds for a given plan tier:
 * - `free`: web_browsing / download nodes
 * - `pro`: web_browsing / download + static_ip nodes
 * - `flow_plus`: all active nodes (web_browsing, download, static_ip, gaming)
 */
export function filterDonatedForPlanTier(
  donated: DonatedOutboundRow[],
  planTier: PlanTier
): DonatedOutboundRow[] {
  const active = donated.filter((row) => !row.status || row.status === 'active');
  if (planTier === 'flow_plus') {
    return active;
  }
  if (planTier === 'pro') {
    return active.filter(
      (row) =>
        row.allow_web === 1 ||
        row.allow_download === 1 ||
        row.allow_static_ip === 1 ||
        row.assigned_tier === 'web_browsing' ||
        row.assigned_tier === 'download' ||
        row.assigned_tier === 'static_ip'
    );
  }
  return active.filter(
    (row) =>
      row.allow_web === 1 ||
      row.allow_download === 1 ||
      row.assigned_tier === 'web_browsing' ||
      row.assigned_tier === 'download'
  );
}

/**
 * Compiles the canonical prebuilt sing-box 1.14+ JSON bundle for a plan tier
 * (`free`, `pro`, `flow_plus`), stored in L1 RAM + L2 Cloudflare KV
 * (`cache:compiled_cfg_free_v1`, `cache:compiled_cfg_pro_v1`, `cache:compiled_cfg_flow_plus_v1`)
 * and verified end-to-end by QualityEngine Stage-2 `sing-box check`.
 */
export function compilePlanTierSingboxConfig(
  coreOutbounds: OutboundRow[],
  donatedOutbounds: DonatedOutboundRow[],
  planTier: PlanTier,
  options: Omit<CompileClientOptions, 'mode'> = {}
): { config: Record<string, unknown>; json: string; nodeCount: number } {
  const tierDonated = filterDonatedForPlanTier(donatedOutbounds, planTier);
  const tierCore = coreOutbounds.filter((ob) => {
    if (ob.is_active === 0) return false;
    if (planTier === 'flow_plus') return true;
    if (planTier === 'pro') return ob.mode_category !== 'gaming';
    return ob.mode_category === 'web_browsing' || ob.mode_category === 'download' || ob.mode_category === 'all';
  });

  const config = compileClientSingboxConfig(tierCore, tierDonated, {
    ...options,
    mode: 'web_browsing',
    includeClashApi: options.includeClashApi ?? true,
  });

  const outboundsArr = Array.isArray(config.outbounds)
    ? (config.outbounds as Array<Record<string, unknown>>)
    : [];
  const concreteCount = outboundsArr.filter(
    (o) => o.type !== 'selector' && o.type !== 'urltest' && o.type !== 'direct'
  ).length;

  return {
    config,
    json: JSON.stringify(config),
    nodeCount: concreteCount,
  };
}
