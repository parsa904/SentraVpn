import assert from 'node:assert/strict';
import test from 'node:test';
import {
  initClientSentry,
  isClientSentryEnabled,
  sanitizeSentryRecord,
} from './sentry';

test('initClientSentry stays silently disabled when SENTRY_DSN_CLIENT is empty', () => {
  const initialized = initClientSentry('');
  assert.equal(initialized, false);
  assert.equal(isClientSentryEnabled(), false);
});

test('sanitizeSentryRecord redacts subscription tokens, auth headers, and proxy credentials', () => {
  const cleaned = sanitizeSentryRecord({
    platform: 'android',
    appVersion: '1.0.0',
    subscription_token: 'super-secret-sub-token',
    authorization: 'Bearer abcdef1234567890',
    endpoint: 'https://sentra-core.kziepr.workers.dev/sub/my-private-token?format=singbox',
    proxy_uri: 'vless://11111111-2222-3333-4444-555555555555@198.51.100.10:443',
    http_status: 502,
  });

  assert.equal(cleaned.platform, 'android');
  assert.equal(cleaned.appVersion, '1.0.0');
  assert.equal(cleaned.http_status, 502);
  assert.equal(cleaned.subscription_token, '[REDACTED]');
  assert.equal(cleaned.authorization, '[REDACTED]');
  assert.ok(!String(cleaned.endpoint).includes('my-private-token'));
  assert.ok(!String(cleaned.proxy_uri).includes('11111111-2222-3333-4444-555555555555'));
});
