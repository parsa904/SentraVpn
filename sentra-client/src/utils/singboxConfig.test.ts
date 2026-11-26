import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractSingboxConfig,
  translateNetworkErrorToPersian,
  validateSingbox114Config,
} from './singboxConfig';

test('extractSingboxConfig supports both /api/v1/client/config wrapper and raw /sub/{token} JSON', () => {
  const sampleSingbox114 = {
    log: { level: 'info', timestamp: true },
    dns: {
      servers: [
        { type: 'fakeip', tag: 'dns-fakeip', inet4_range: '198.18.0.0/15', inet6_range: 'fc00::/18' },
        { type: 'https', tag: 'dns-doh', server: '1.1.1.1', server_port: 443, path: '/dns-query', detour: 'Sentra Select' },
        { type: 'local', tag: 'dns-direct' },
      ],
      rules: [{ domain_suffix: ['.ir'], server: 'dns-direct' }],
      final: 'dns-doh',
      strategy: 'prefer_ipv4',
    },
    inbounds: [
      { type: 'tun', tag: 'tun-in', address: ['172.19.0.1/30'], auto_route: true, strict_route: true, stack: 'mixed' },
    ],
    outbounds: [
      { type: 'selector', tag: 'Sentra Select', outbounds: ['direct'], default: 'direct' },
      { type: 'direct', tag: 'direct' },
    ],
    route: {
      auto_detect_interface: true,
      default_domain_resolver: 'dns-direct',
      rules: [
        { action: 'sniff', timeout: '300ms' },
        { protocol: 'dns', action: 'hijack-dns' },
      ],
      final: 'Sentra Select',
    },
  };

  // 1. Wrapped response from POST /api/v1/client/config
  const fromApi = extractSingboxConfig({
    success: true,
    singbox_schema: '1.14+',
    config: sampleSingbox114,
    singbox_config: sampleSingbox114,
  });
  const checkApi = validateSingbox114Config(fromApi);
  assert.equal(checkApi.valid, true);
  assert.equal(checkApi.errors.length, 0);

  // 2. Raw response from GET /sub/{token}?format=singbox
  const fromSub = extractSingboxConfig(sampleSingbox114);
  const checkSub = validateSingbox114Config(fromSub);
  assert.equal(checkSub.valid, true);
  assert.equal(checkSub.errors.length, 0);
});

test('validateSingbox114Config normalizes legacy 1.10 fields into strict sing-box 1.14+ format', () => {
  const legacy = {
    dns: {
      servers: [
        { tag: 'dns-fakeip', address: 'fakeip' },
        { tag: 'dns-remote', address: 'https://1.1.1.1/dns-query', detour: 'Sentra Select' },
        { tag: 'dns-direct', address: 'local' },
      ],
      independent_cache: true,
    },
    inbounds: [
      {
        type: 'tun',
        tag: 'tun-in',
        inet4_address: '172.19.0.1/30',
        sniff: true,
      },
    ],
    outbounds: [
      { type: 'direct', tag: 'direct' },
      { type: 'dns', tag: 'dns-out' },
      { type: 'block', tag: 'block' },
    ],
    route: {
      rules: [
        { protocol: 'dns', outbound: 'dns-out' },
        { ip_version: 6, outbound: 'block' },
      ],
      final: 'direct',
    },
  };

  const result = validateSingbox114Config(legacy);
  assert.equal(result.valid, true);

  const dns = result.config.dns as { servers: Array<Record<string, unknown>>; independent_cache?: unknown };
  assert.equal(dns.independent_cache, undefined);
  assert.equal(dns.servers[0].type, 'fakeip');
  assert.equal(dns.servers[1].type, 'https');
  assert.equal(dns.servers[2].type, 'local');

  const inbounds = result.config.inbounds as Array<Record<string, unknown>>;
  assert.deepEqual(inbounds[0].address, ['172.19.0.1/30']);
  assert.equal(inbounds[0].sniff, undefined);

  const outbounds = result.config.outbounds as Array<Record<string, unknown>>;
  assert.equal(outbounds.length, 1);
  assert.equal(outbounds[0].type, 'direct');

  const route = result.config.route as { rules: Array<Record<string, unknown>> };
  assert.equal(route.rules[0].action, 'hijack-dns');
  assert.equal(route.rules[1].action, 'reject');
});

test('translateNetworkErrorToPersian produces clear Persian errors for network, timeout, and HTTP statuses', () => {
  assert.ok(translateNetworkErrorToPersian(new TypeError('Failed to fetch')).includes('ارتباط با سرور مرکزی سنترا'));
  assert.ok(translateNetworkErrorToPersian(new Error('The operation was aborted')).includes('Timeout'));
  assert.ok(translateNetworkErrorToPersian(null, 401).includes('توکن اشتراک معتبر نیست'));
  assert.ok(translateNetworkErrorToPersian(null, 404).includes('یافت نشد'));
  assert.ok(translateNetworkErrorToPersian(null, 503).includes('503'));
});
