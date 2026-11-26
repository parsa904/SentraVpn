import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IR_SPLIT_TUNNEL_DOMAINS,
  compileClientSingboxConfig,
} from '../singboxCompiler.ts';
import type { DonatedOutboundRow, OutboundRow } from '../types.ts';

function sampleRealityOutbound(id: number, overrides: Partial<DonatedOutboundRow> = {}): DonatedOutboundRow {
  return {
    id,
    donor_user_id: null,
    tag: `DE-Reality-${id}`,
    protocol: 'vless',
    server_address: `203.0.113.${10 + id}`,
    server_port: 443,
    config_json: JSON.stringify({
      type: 'vless',
      tag: `DE-Reality-${id}`,
      server: `203.0.113.${10 + id}`,
      server_port: 443,
      uuid: '11111111-2222-3333-4444-555555555555',
      tls: {
        enabled: true,
        server_name: 'www.microsoft.com',
        reality: {
          enabled: true,
          public_key: 'PublicKey123',
          short_id: 'ab12',
        },
      },
    }),
    latency_ms: 45,
    speed_mbps: 25,
    assigned_tier: 'web_browsing',
    health_score: 98,
    status: 'active',
    fail_count: 0,
    raw_link: null,
    rejection_reason: null,
    fingerprint_sha256: `fp-${id}`,
    offline_since: null,
    is_official: 1,
    label: `DE-Reality-${id}`,
    country_code: 'DE',
    country_name: 'آلمان 🇩🇪',
    allow_web: 1,
    allow_download: 1,
    allow_gaming: 0,
    allow_static_ip: 0,
    gemini_ok: 1,
    trading_safe: 1,
    speed_score: 95,
    jitter_ms: 8,
    last_online_at: new Date().toISOString(),
    allocation_mode: 'both',
    last_checked_at: new Date().toISOString(),
    ...overrides,
  };
}

test('compileClientSingboxConfig strictly conforms to sing-box 1.14+ schema', () => {
  const config = compileClientSingboxConfig([], [sampleRealityOutbound(1)], {
    mode: 'web_browsing',
  });
  const serialized = JSON.stringify(config);

  // 1. Strictly NO deprecated `independent_cache`, NO `_sentra_meta`, NO `dns-out`
  assert.equal('_sentra_meta' in config, false);
  assert.equal(serialized.includes('independent_cache'), false);
  assert.equal(serialized.includes('"dns-out"'), false);
  assert.equal(serialized.includes('"_sentra_meta"'), false);

  // 2. Uses `type: "fakeip"` directly inside `dns.servers` (no legacy top-level dns.fakeip)
  const dns = config.dns as { servers: Array<Record<string, unknown>>; fakeip?: unknown };
  assert.equal(dns.fakeip, undefined);
  const fakeipServer = dns.servers.find((s) => s.type === 'fakeip');
  assert.ok(fakeipServer, 'Expected type: "fakeip" inside dns.servers');
  assert.equal(fakeipServer.tag, 'dns-fakeip');

  // 3. Uses modern route rule_actions (`sniff` and `hijack-dns`)
  const route = config.route as { rules: Array<Record<string, unknown>> };
  assert.ok(
    route.rules.some((r) => r.action === 'sniff'),
    'Expected sniff rule action'
  );
  assert.ok(
    route.rules.some((r) => r.protocol === 'dns' && r.action === 'hijack-dns'),
    'Expected hijack-dns rule action'
  );

  // 4. Preserves Iranian .ir & bank Split Tunneling -> direct
  const irRouteRule = route.rules.find(
    (r) => Array.isArray(r.domain_suffix) && r.outbound === 'direct'
  );
  assert.ok(irRouteRule, 'Expected .ir split-tunneling route rule');
  for (const domain of ['.ir', 'shaparak.ir', 'mellatbank.ir', 'bmi.ir']) {
    assert.ok((irRouteRule.domain_suffix as string[]).includes(domain));
  }
  assert.ok(IR_SPLIT_TUNNEL_DOMAINS.includes('.ir'));

  // 5. Enforces mandatory uTLS chrome on Reality outbounds even if stored JSON lacked utls
  const outbounds = config.outbounds as Array<Record<string, unknown>>;
  const vlessNode = outbounds.find((o) => o.type === 'vless') as {
    tls?: { utls?: { enabled: boolean; fingerprint: string } };
  };
  assert.deepEqual(vlessNode?.tls?.utls, { enabled: true, fingerprint: 'chrome' });
});

test('compileClientSingboxConfig merges healthy donated_outbounds and active outbounds directly without bridge interfaces', () => {
  const coreNodes: OutboundRow[] = [
    {
      id: 10,
      tag: 'NL-Core-Reality',
      protocol: 'vless',
      mode_category: 'web_browsing',
      server_address: '198.51.100.25',
      server_port: 443,
      uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      password: null,
      network_transport: 'tcp',
      tls_enabled: 1,
      tls_sni: 'learn.microsoft.com',
      reality_public_key: 'CorePubKey123',
      reality_short_id: 'cd34',
      min_tier: 'Sentra Lite',
      country_code: 'NL',
      is_active: 1,
      weight: 10,
    },
    {
      id: 11,
      tag: 'Inactive-Core-Node',
      protocol: 'vless',
      mode_category: 'web_browsing',
      server_address: '198.51.100.26',
      server_port: 443,
      uuid: 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff',
      password: null,
      network_transport: 'tcp',
      tls_enabled: 1,
      tls_sni: 'learn.microsoft.com',
      reality_public_key: null,
      reality_short_id: null,
      min_tier: 'Sentra Lite',
      country_code: 'DE',
      is_active: 0,
      weight: 1,
    },
  ];

  const donatedNodes: DonatedOutboundRow[] = [
    sampleRealityOutbound(1, { status: 'active', label: 'DE-Healthy-1' }),
    sampleRealityOutbound(2, { status: 'inactive', label: 'DE-Dead-2' }),
  ];

  const config = compileClientSingboxConfig(coreNodes, donatedNodes, {
    mode: 'web_browsing',
  });
  const serialized = JSON.stringify(config);

  assert.equal(serialized.includes('tun-web'), false);
  assert.equal(serialized.includes('tun-dl'), false);
  assert.equal(serialized.includes('independent_cache'), false);
  assert.equal(serialized.includes('_sentra_meta'), false);

  const outbounds = config.outbounds as Array<{ tag: string; type: string }>;
  const tags = outbounds.map((o) => o.tag);
  assert.ok(tags.includes('👑 DE-Healthy-1'));
  assert.ok(tags.includes('NL-Core-Reality'));
  assert.equal(tags.includes('👑 DE-Dead-2'), false);
  assert.equal(tags.includes('Inactive-Core-Node'), false);
});
