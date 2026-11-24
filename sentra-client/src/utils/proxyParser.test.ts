import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APP_VERSION,
  parseProxyInput,
  parseAuthSessionResponse,
  formatBytes,
  formatSpeed,
  formatDuration,
  formatPing,
  formatRemainingDays,
  getLatencyTier,
  selectFastestHealthyServer,
  compareSemver,
  isNewerVersion,
  isSafeReleaseUrl,
  validateCredentialsForm,
  validateOtpCode,
  computeUsagePercent,
  countryCodeToFlag,
} from './proxyParser';
import { translations, t } from '../i18n/translations';

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

test('formats bytes, speeds, durations, pings, remaining days, and percentages deterministically', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024 * 1024 * 512), '512 MB');
  assert.equal(formatBytes(1024 ** 3 * 2.5), '2.50 GB');
  assert.equal(formatSpeed(0), '0 KB/s');
  assert.equal(formatSpeed(1024 * 1024 * 1.5), '1.50 MB/s');
  assert.equal(formatDuration(3661), '01:01:01');
  assert.equal(formatPing(null, 'en', false), '—');
  assert.equal(formatPing(null, 'en', true), 'Timeout');
  assert.equal(formatPing(null, 'fa', true), 'تایم‌اوت');
  assert.equal(formatPing(0), '—');
  assert.equal(formatPing(48.4), '48 ms');
  assert.equal(formatRemainingDays(14, 'en'), '14d left');
  assert.equal(formatRemainingDays(14, 'fa'), '14 روز باقی‌مانده');
  assert.equal(formatRemainingDays(0, 'en'), 'Expired');
  assert.equal(formatRemainingDays(0, 'fa'), 'منقضی شده');
  assert.equal(computeUsagePercent(500, 1000), 50);
  assert.equal(computeUsagePercent(2000, 1000), 100);
  assert.equal(countryCodeToFlag('DE'), '🇩🇪');
  assert.equal(countryCodeToFlag('XX'), '🌐');
});

test('classifies latency tiers accurately (<200ms green, 200-500ms fair, >500ms poor, timeout)', () => {
  assert.equal(getLatencyTier(null, false), 'idle');
  assert.equal(getLatencyTier(null, true), 'timeout');
  assert.equal(getLatencyTier(0, true), 'timeout');
  assert.equal(getLatencyTier(85, true), 'good');
  assert.equal(getLatencyTier(199, true), 'good');
  assert.equal(getLatencyTier(200, true), 'fair');
  assert.equal(getLatencyTier(500, true), 'fair');
  assert.equal(getLatencyTier(501, true), 'poor');
  assert.equal(getLatencyTier(1200, true), 'poor');
});

test('selectFastestHealthyServer picks lowest positive latency and skips offline/timeout nodes', () => {
  const nodes = [
    { id: 'n1', is_online: true, latency_ms: 120 },
    { id: 'n2', is_online: false, latency_ms: 20 },
    { id: 'n3', is_online: true, latency_ms: 340 },
    { id: 'n4', is_online: true, latency_ms: 90 },
  ];
  // Live pings override baseline: n4 timed out (null), n3 is fastest at 64ms
  const fastest = selectFastestHealthyServer(nodes, {
    n1: 145,
    n2: 18,
    n3: 64,
    n4: null,
  });
  assert.ok(fastest);
  assert.equal(fastest.node.id, 'n3');
  assert.equal(fastest.latencyMs, 64);

  // All timed out -> returns null
  const none = selectFastestHealthyServer(nodes, {
    n1: null,
    n2: null,
    n3: null,
    n4: null,
  });
  assert.equal(none, null);
});

test('compares semver versions and validates GitHub Release URLs safely', () => {
  assert.equal(APP_VERSION, '1.0.0');
  assert.equal(compareSemver('v1.2.0', '1.0.0'), 1);
  assert.equal(compareSemver('1.0.0', 'v1.0.0'), 0);
  assert.equal(compareSemver('0.9.9', '1.0.0'), -1);
  assert.equal(isNewerVersion('1.0.0', 'v1.0.1'), true);
  assert.equal(isNewerVersion('1.0.0', 'v1.0.0'), false);
  assert.equal(isNewerVersion('1.2.0', 'v1.1.9'), false);

  assert.equal(
    isSafeReleaseUrl('https://github.com/parsa904/SentraVpn/releases/tag/v1.2.0'),
    true
  );
  assert.equal(isSafeReleaseUrl('javascript:alert(1)'), false);
  assert.equal(isSafeReleaseUrl('https://evil.example.com/parsa904/SentraVpn/releases'), false);
  assert.equal(isSafeReleaseUrl('http://github.com/parsa904/SentraVpn/releases'), false);
});

test('validates credentials (8-char register rule) and 8-digit OTP in both EN and FA', () => {
  assert.ok(validateCredentialsForm('', '12345678', false, 'en'));
  assert.ok(validateCredentialsForm('ab', '12345678', true, 'fa'));
  assert.ok(validateCredentialsForm('valid_user', '1234567', true, 'en'));
  assert.ok(validateCredentialsForm('bad-user.name', 'secret123', true, 'en'));
  assert.equal(validateCredentialsForm('valid_user', 'secret123', true, 'en'), null);
  assert.equal(validateCredentialsForm('legacy.user', '1234', false, 'fa'), null);

  assert.ok(validateOtpCode('', 'en'));
  assert.ok(validateOtpCode('12345', 'fa'));
  assert.ok(validateOtpCode('1234abcd', 'en'));
  assert.equal(validateOtpCode('12345678', 'en'), null);
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

test('i18n translation dictionaries have 100% key parity between en and fa', () => {
  const enKeys = Object.keys(translations.en).sort();
  const faKeys = Object.keys(translations.fa).sort();
  assert.deepEqual(faKeys, enKeys);
  assert.equal(t('en', 'updateVersion', { version: 'v1.2.0' }), 'Version v1.2.0 is ready');
  assert.equal(t('fa', 'updateVersion', { version: 'v1.2.0' }), 'نسخه v1.2.0 آماده دانلود است');
});
