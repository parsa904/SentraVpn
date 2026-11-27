import assert from 'node:assert/strict';
import test from 'node:test';
import {
  auditOutboundSecurity,
  enforceRealityUtls,
  parseOutboundInput,
  parseSubscriptionPayload,
} from '../outboundAnalyzer.ts';

test('parseOutboundInput injects mandatory uTLS chrome for VLESS Reality when fp is omitted', async () => {
  const uri =
    'vless://11111111-2222-3333-4444-555555555555@203.0.113.10:443?security=reality&sni=www.microsoft.com&pbk=AbCdEf1234567890&sid=a1b2&flow=xtls-rprx-vision#DE-Fast-Node';

  const parsed = await parseOutboundInput(uri);
  assert.equal(parsed.protocol, 'vless');
  assert.equal(parsed.server_address, '203.0.113.10');
  assert.equal(parsed.server_port, 443);
  assert.equal(parsed.country_code, 'DE');
  assert.equal(parsed.config_json.flow, 'xtls-rprx-vision');
  assert.deepEqual(parsed.config_json.tls?.utls, {
    enabled: true,
    fingerprint: 'chrome',
  });
  assert.deepEqual(parsed.config_json.tls?.reality, {
    enabled: true,
    public_key: 'AbCdEf1234567890',
    short_id: 'a1b2',
  });
  assert.equal(parsed.fingerprint_sha256.length, 64);
  assert.equal(auditOutboundSecurity(parsed.protocol, parsed.config_json).passed, true);
});

test('parseOutboundInput preserves explicit fp query parameter (e.g., firefox)', async () => {
  const uri =
    'vless://11111111-2222-3333-4444-555555555555@203.0.113.11:443?security=reality&sni=yahoo.com&pbk=KeyXYZ&sid=01&fp=firefox#NL-Node';

  const parsed = await parseOutboundInput(uri);
  assert.deepEqual(parsed.config_json.tls?.utls, {
    enabled: true,
    fingerprint: 'firefox',
  });
  assert.equal(parsed.country_code, 'NL');
});

test('SHA-256 fingerprint deduplicates identical servers even when tag or SNI changes', async () => {
  const linkA =
    'vless://aaaa1111-2222-3333-4444-555555555555@198.51.100.5:443?security=reality&sni=a.com&pbk=PBK1#NodeAlpha';
  const linkB =
    'vless://aaaa1111-2222-3333-4444-555555555555@198.51.100.5:443?security=reality&sni=b.com&pbk=PBK1#RenamedNode';

  const a = await parseOutboundInput(linkA);
  const b = await parseOutboundInput(linkB);
  assert.equal(a.fingerprint_sha256, b.fingerprint_sha256);
});

test('enforceRealityUtls backfills chrome fingerprint for raw Reality JSON missing utls', () => {
  const raw = enforceRealityUtls({
    type: 'vless',
    tag: 'raw-reality',
    server: '203.0.113.20',
    server_port: 443,
    uuid: 'uuid-1',
    tls: {
      enabled: true,
      server_name: 'example.com',
      reality: { enabled: true, public_key: 'pubkey', short_id: '01' },
    },
  });

  assert.deepEqual(raw.tls?.utls, { enabled: true, fingerprint: 'chrome' });
});

test('parseOutboundInput blocks SSRF / loopback / RFC1918 / metadata addresses', async () => {
  await assert.rejects(
    () => parseOutboundInput('vless://uuid@127.0.0.1:443?security=tls#local'),
    /محلی|خصوصی/
  );
  await assert.rejects(
    () => parseOutboundInput('vless://uuid@169.254.169.254:443?security=tls#metadata'),
    /محلی|خصوصی/
  );
  await assert.rejects(
    () => parseOutboundInput('trojan://secret@10.0.0.5:443#internal'),
    /محلی|خصوصی/
  );
});

test('parseSubscriptionPayload decodes Base64 subscriptions and deduplicates nodes', async () => {
  const rawList = [
    'vless://u1@203.0.113.1:443?security=reality&sni=www.microsoft.com&pbk=PK1#DE-One',
    'vless://u1@203.0.113.1:443?security=reality&sni=www.microsoft.com&pbk=PK1#DE-Duplicate',
    'trojan://pass123@203.0.113.2:443?sni=example.org&fp=safari#FI-Two',
    'invalid-line',
  ].join('\n');
  const encoded = Buffer.from(rawList, 'utf8').toString('base64');

  const result = await parseSubscriptionPayload(encoded);
  assert.equal(result.nodes.length, 2);
  assert.equal(result.skipped, 1);
  assert.equal(result.nodes[0].config_json.tls?.utls?.fingerprint, 'chrome');
  assert.equal(result.nodes[1].config_json.tls?.utls?.fingerprint, 'safari');
});
