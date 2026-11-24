import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseProxyInput,
  parseAuthSessionResponse,
  formatBytes,
  formatSpeed,
  formatDuration,
  formatPing,
  validateCredentialsForm,
  validateOtpCode,
  computeUsagePercent,
  countryCodeToFlag,
} from './proxyParser';

test('parses VLESS URI with fragment and detects Germany flag', () => {
  const uri =
    'vless://11111111-2222-3333-4444-555555555555@fra.example.com:443?security=reality&type=tcp#Frankfurt-DE-01';
  const parsed = parseProxyInput(uri);
  assert.equal(parsed.protocol, 'VLESS');
  assert.equal(parsed.server_address, 'fra.example.com');
  assert.equal(parsed.server_port, 443);
  assert.equal(parsed.name, 'Frankfurt-DE-01');
  assert.equal(parsed.country_code, 'DE');
  assert.equal(parsed.is_subscription, false);
});

test('parses VMess base64 JSON URI', () => {
  const json = JSON.stringify({
    v: '2',
    ps: 'Amsterdam-NL-Node',
    add: 'nl.example.org',
    port: '8443',
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  });
  const encoded = Buffer.from(json, 'utf8').toString('base64');
  const parsed = parseProxyInput(`vmess://${encoded}`);
  assert.equal(parsed.protocol, 'VMESS');
  assert.equal(parsed.server_address, 'nl.example.org');
  assert.equal(parsed.server_port, 8443);
  assert.equal(parsed.name, 'Amsterdam-NL-Node');
  assert.equal(parsed.country_code, 'NL');
});

test('parses Hysteria2, Trojan, TUIC, Shadowsocks, and WireGuard URIs', () => {
  const hy2 = parseProxyInput('hy2://secret@fi.node.net:8443/?sni=fi.node.net#Helsinki');
  assert.equal(hy2.protocol, 'HYSTERIA2');
  assert.equal(hy2.server_port, 8443);
  assert.equal(hy2.country_code, 'FI');

  const trojan = parseProxyInput('trojan://pass@uk.server.net:443#London-UK');
  assert.equal(trojan.protocol, 'TROJAN');
  assert.equal(trojan.country_code, 'GB');

  const tuic = parseProxyInput('tuic://uuid:pass@sg.node.io:2096#Singapore');
  assert.equal(tuic.protocol, 'TUIC');
  assert.equal(tuic.server_port, 2096);
  assert.equal(tuic.country_code, 'SG');

  const ss = parseProxyInput('ss://YWVzLTI1Ni1nY206cGFzcw@tr.host.net:8388#Istanbul');
  assert.equal(ss.protocol, 'SHADOWSOCKS');
  assert.equal(ss.server_address, 'tr.host.net');
  assert.equal(ss.server_port, 8388);
  assert.equal(ss.country_code, 'TR');

  const wg = parseProxyInput('wireguard://privkey@ch.wg.net:51820?publickey=abc#Zurich');
  assert.equal(wg.protocol, 'WIREGUARD');
  assert.equal(wg.server_port, 51820);
  assert.equal(wg.country_code, 'CH');
});

test('parses subscription URL cleanly', () => {
  const sub = parseProxyInput('https://sub.example.com/api/v1/sub/token123#MySub');
  assert.equal(sub.protocol, 'SUBSCRIPTION');
  assert.equal(sub.is_subscription, true);
  assert.equal(sub.server_address, 'sub.example.com');
  assert.equal(sub.name, 'MySub');
});

test('rejects unsupported protocols and empty inputs', () => {
  assert.throws(() => parseProxyInput(''), /لینک/);
  assert.throws(() => parseProxyInput('ftp://example.com:21'), /پروتکل/);
});

test('formats bytes, speeds, durations, pings, and percentages deterministically', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024 * 1024 * 512), '512 MB');
  assert.equal(formatBytes(1024 ** 3 * 2.5), '2.50 GB');
  assert.equal(formatSpeed(0), '0 KB/s');
  assert.equal(formatSpeed(1024 * 1024 * 1.5), '1.50 MB/s');
  assert.equal(formatDuration(3661), '01:01:01');
  assert.equal(formatPing(null), '—');
  assert.equal(formatPing(0), '—');
  assert.equal(formatPing(48.4), '48 ms');
  assert.equal(computeUsagePercent(500, 1000), 50);
  assert.equal(computeUsagePercent(2000, 1000), 100);
  assert.equal(countryCodeToFlag('DE'), '🇩🇪');
  assert.equal(countryCodeToFlag('XX'), '🌐');
});

test('validates credentials (8-char register rule) and 8-digit OTP strictly', () => {
  assert.ok(validateCredentialsForm('', '12345678', false));
  assert.ok(validateCredentialsForm('ab', '12345678', true));
  assert.ok(validateCredentialsForm('valid_user', '1234567', true));
  assert.ok(validateCredentialsForm('bad-user.name', 'secret123', true));
  assert.equal(validateCredentialsForm('valid_user', 'secret123', true), null);
  assert.equal(validateCredentialsForm('legacy.user', '1234', false), null);

  assert.ok(validateOtpCode(''));
  assert.ok(validateOtpCode('12345'));
  assert.ok(validateOtpCode('1234abcd'));
  assert.equal(validateOtpCode('12345678'), null);
});

test('parses nested Sentra Core auth responses and flat session payloads', () => {
  const nested = parseAuthSessionResponse({
    access_token: 'jwt_sentra_abc123',
    user: { username: 'ali_dev', first_name: 'Ali' },
    subscription: {
      token: 'sentra_sub_token_001',
      tier: 'Sentra Pro',
      expires_at: '2026-12-31T00:00:00Z',
    },
  });
  assert.deepEqual(nested, {
    auth_token: 'jwt_sentra_abc123',
    subscription_token: 'sentra_sub_token_001',
    username: 'ali_dev',
    tier: 'Sentra Pro',
    expires_at: '2026-12-31T00:00:00Z',
  });

  const flat = parseAuthSessionResponse(
    { subscription_token: 'sentra_flat', tier: 'Sentra Lite' },
    'fallback_u'
  );
  assert.equal(flat?.subscription_token, 'sentra_flat');
  assert.equal(flat?.username, 'fallback_u');

  assert.equal(parseAuthSessionResponse({}), null);
});
