import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectClientPlatform,
  reportClientError,
  resetClientErrorReporterForTests,
  sanitizeClientSecrets,
} from './errorReporter';

test('detectClientPlatform identifies Android vs Windows user agents', () => {
  assert.equal(
    detectClientPlatform(
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36'
    ),
    'android'
  );
  assert.equal(
    detectClientPlatform(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36'
    ),
    'windows'
  );
});

test('sanitizeClientSecrets redacts Bearer headers, /sub/ tokens, bot tokens, and proxy credentials', () => {
  const raw =
    'Authorization: Bearer jwt_secret_12345 failed on https://sentra-core.kziepr.workers.dev/sub/tok_999888?token=abc vless://uuid-1234@1.2.3.4:443';
  const clean = sanitizeClientSecrets(raw);

  assert.equal(clean.includes('jwt_secret_12345'), false);
  assert.equal(clean.includes('tok_999888'), false);
  assert.equal(clean.includes('token=abc'), false);
  assert.equal(clean.includes('uuid-1234'), false);
  assert.match(clean, /Authorization: Bearer \[REDACTED\]/);
  assert.match(clean, /\/sub\/\[REDACTED\]/);
});

test('reportClientError posts sanitized payload, deduplicates repeats, blocks recursion, and never throws', async () => {
  resetClientErrorReporterForTests();
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body || '{}')) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({ success: true, accepted: true }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    // 1. Sends sanitized error report
    const sent1 = await reportClientError({
      moduleOrFile: 'sentra-client/src/services/api.ts',
      actionOrRoute: 'GET /sub/secret_client_tok_42',
      error: new Error('Invalid config with Bearer my_jwt_987654'),
      context: { http_status: 500 },
    });
    assert.equal(sent1, true);
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /\/api\/v1\/telemetry\/error$/);
    assert.equal(requests[0].body.actionOrRoute, 'GET /sub/[REDACTED]');
    assert.equal(String(requests[0].body.errorMessage).includes('my_jwt_987654'), false);

    // 2. Deduplicates identical repeat within 60s
    const sent2 = await reportClientError({
      moduleOrFile: 'sentra-client/src/services/api.ts',
      actionOrRoute: 'GET /sub/secret_client_tok_42',
      error: new Error('Invalid config with Bearer my_jwt_987654'),
    });
    assert.equal(sent2, false);
    assert.equal(requests.length, 1);

    // 3. Skips self-reporting telemetry endpoint errors (no feedback loop)
    const selfErr = await reportClientError({
      moduleOrFile: 'sentra-client/src/services/api.ts',
      actionOrRoute: 'POST /api/v1/telemetry/error',
      error: new Error('503 Service Unavailable'),
    });
    assert.equal(selfErr, false);
    assert.equal(requests.length, 1);

    // 4. Never throws on network outage
    globalThis.fetch = (async () => {
      throw new Error('Offline network error');
    }) as typeof fetch;

    const offlineSent = await reportClientError({
      moduleOrFile: 'sentra-client/src/App.tsx',
      actionOrRoute: 'connect_vpn',
      error: new Error('Unique offline test error'),
    });
    assert.equal(offlineSent, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
