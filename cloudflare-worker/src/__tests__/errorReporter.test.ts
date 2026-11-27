import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  formatAiReadyErrorMessage,
  resetErrorReporterThrottleForTests,
  sanitizeSecrets,
} from '../errorReporter.ts';
import { routeRequest } from '../routes.ts';
import { saveTopicRoute } from '../telegramTopics.ts';
import type { Env } from '../types.ts';

function createSqliteD1Adapter(): { db: D1Database; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(':memory:');
  const schemaPath = path.resolve(import.meta.dirname, '../../schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  for (const stmt of sql.split(';').map((s) => s.trim()).filter(Boolean)) {
    sqlite.exec(stmt);
  }

  const db = {
    prepare(query: string) {
      let params: unknown[] = [];
      const stmtObj = {
        bind(...args: unknown[]) {
          params = args;
          return stmtObj;
        },
        async first<T = Record<string, unknown>>() {
          const row = sqlite.prepare(query).get(...(params as never[])) as T | undefined;
          return row ?? null;
        },
        async all<T = Record<string, unknown>>() {
          const rows = sqlite.prepare(query).all(...(params as never[])) as T[];
          return { results: rows };
        },
        async run() {
          const info = sqlite.prepare(query).run(...(params as never[]));
          return {
            success: true,
            meta: { last_row_id: Number(info.lastInsertRowid) },
          };
        },
      };
      return stmtObj;
    },
  } as unknown as D1Database;

  return { db, sqlite };
}

test('sanitizeSecrets redacts Telegram tokens, QUALITY_ENGINE_SECRET, Bearer headers, /sub/ tokens, and proxy credentials', () => {
  const botToken = '123456789:AAH_super_secret_bot_token_XYZ987654';
  const qualitySecret = 'qe_ultra_secret_987654321';
  const input = [
    `Request to https://api.telegram.org/bot${botToken}/sendMessage failed`,
    `Authorization: Bearer jwt_sentra_abc123def456`,
    `X-Quality-Secret: ${qualitySecret}`,
    `GET https://sentra-core.kziepr.workers.dev/sub/sub_live_secret_token_99?format=singbox&token=qtok123`,
    `vless://11111111-2222-3333-4444-555555555555@example.com:443?security=reality`,
    `{"password":"mySecretPassword","subscription_token":"sub_json_999"}`,
  ].join('\n');

  const sanitized = sanitizeSecrets(input, [botToken, qualitySecret]);

  assert.equal(sanitized.includes(botToken), false);
  assert.equal(sanitized.includes(qualitySecret), false);
  assert.equal(sanitized.includes('jwt_sentra_abc123def456'), false);
  assert.equal(sanitized.includes('sub_live_secret_token_99'), false);
  assert.equal(sanitized.includes('qtok123'), false);
  assert.equal(sanitized.includes('11111111-2222-3333-4444-555555555555'), false);
  assert.equal(sanitized.includes('mySecretPassword'), false);
  assert.equal(sanitized.includes('sub_json_999'), false);
  assert.match(sanitized, /\/sub\/\[REDACTED\]/);
  assert.match(sanitized, /Authorization: Bearer \[REDACTED\]/);
});

test('formatAiReadyErrorMessage escapes HTML, wraps copyable <pre><code> block, and preserves closing tags on huge stack traces', () => {
  const hugeStack = Array.from({ length: 120 }, (_, i) =>
    `    at frame_${i} (<script>alert(&bad)</script>:10:${i})`
  ).join('\n');

  const html = formatAiReadyErrorMessage(
    {
      platform: 'android',
      appVersion: '1.0.0',
      moduleOrFile: 'android/SentraVpnService.kt',
      actionOrRoute: 'startVpnTunnel',
      errorName: 'IllegalStateException',
      errorMessage: 'Failed <tun> & /sub/secret_tok_777',
      stackTrace: hugeStack,
      context: {
        android_sdk: 34,
        http_status: 502,
        subscription_token: 'must_not_appear',
      },
      timestamp: '2026-11-27T10:00:00.000Z',
    },
    ['custom_env_secret_12345']
  );

  assert.ok(html.length <= 4096, `Expected Telegram HTML <= 4096 chars, got ${html.length}`);
  assert.ok(html.includes('<pre><code>'), 'Expected <pre><code> opening tag');
  assert.ok(html.endsWith('</code></pre>'), 'Expected intact </code></pre> closing tag');
  assert.equal(html.includes('<script>'), false, 'Expected raw <script> to be escaped');
  assert.ok(html.includes('&lt;tun&gt; &amp; /sub/[REDACTED]'));
  assert.equal(html.includes('secret_tok_777'), false);
  assert.equal(html.includes('must_not_appear'), false);
  assert.match(html, /subscription_token: \[REDACTED\]/);
  assert.match(html, /platform: android/);
  assert.match(html, /appVersion: 1\.0\.0/);
  assert.match(html, /android_sdk: 34/);
});

test('POST /api/v1/telemetry/error validates auth/schema, deduplicates, rate-limits, and forwards to topic_logs_id', async () => {
  resetErrorReporterThrottleForTests();
  const { db, sqlite } = createSqliteD1Adapter();
  const originalFetch = globalThis.fetch;
  const tgPosts: Array<Record<string, unknown>> = [];

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    if (typeof init?.body === 'string') {
      tgPosts.push(JSON.parse(init.body) as Record<string, unknown>);
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: tgPosts.length } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const env = {
    DB: db,
    TELEGRAM_BOT_TOKEN: '987654321:AAH_TEST_TOKEN_SECRET_VALUE_999',
    QUALITY_ENGINE_SECRET: 'qe_secret_test_value_123',
  } as Env;

  try {
    await saveTopicRoute(db, 'logs', -100555999, 42);

    // 1. Rejects external platform: 'worker'
    const badPlatformResp = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/telemetry/error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform: 'worker',
          moduleOrFile: 'index.ts',
          actionOrRoute: 'fetch',
          errorName: 'Error',
          errorMessage: 'spoofed worker error',
        }),
      }),
      env
    );
    assert.equal(badPlatformResp.status, 400);

    // 2. Rejects github-actions without X-Quality-Secret
    const unauthCiResp = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/telemetry/error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform: 'github-actions',
          moduleOrFile: '.github/scripts/quality-check.ts',
          actionOrRoute: 'main()',
          errorName: 'Error',
          errorMessage: 'Unauthorized CI report',
        }),
      }),
      env
    );
    assert.equal(unauthCiResp.status, 401);

    // 3. Accepts github-actions WITH valid X-Quality-Secret
    const authCiResp = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/telemetry/error', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Quality-Secret': 'qe_secret_test_value_123',
        },
        body: JSON.stringify({
          platform: 'github-actions',
          appVersion: 'abc1234',
          moduleOrFile: '.github/scripts/quality-check.ts',
          actionOrRoute: 'probeGeminiAndTrading',
          errorName: 'SpawnError',
          errorMessage: 'sing-box exited with code 1 while using qe_secret_test_value_123',
          context: { singbox_exit: 1 },
        }),
      }),
      env
    );
    assert.equal(authCiResp.status, 202);
    assert.equal(tgPosts.length, 1);
    assert.equal(tgPosts[0].chat_id, -100555999);
    assert.equal(tgPosts[0].message_thread_id, 42);
    assert.equal(String(tgPosts[0].text).includes('qe_secret_test_value_123'), false);
    assert.match(String(tgPosts[0].text), /platform: github-actions/);
    assert.match(String(tgPosts[0].text), /<pre><code>/);

    // 4. Accepts Windows client report and deduplicates identical repeat
    const winPayload = JSON.stringify({
      platform: 'windows',
      appVersion: '1.0.0',
      moduleOrFile: 'sentra-client/src-tauri/src/vpn_manager.rs',
      actionOrRoute: 'windows_singbox_spawn',
      errorName: 'SingboxSpawnError',
      errorMessage: 'Access denied launching sing-box.exe',
      context: { os: 'windows', arch: 'x86_64' },
    });

    const firstWin = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/telemetry/error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.10' },
        body: winPayload,
      }),
      env
    );
    assert.equal(firstWin.status, 202);
    assert.equal(tgPosts.length, 2);

    const dupWin = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/telemetry/error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.10' },
        body: winPayload,
      }),
      env
    );
    assert.equal(dupWin.status, 202);
    const dupJson = (await dupWin.json()) as { deduplicated?: boolean };
    assert.equal(dupJson.deduplicated, true);
    assert.equal(tgPosts.length, 2, 'Deduplicated error should not send a second Telegram message');

    // 5. Rejects oversized > 16KB body with 413
    const hugeResp = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/telemetry/error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform: 'android',
          moduleOrFile: 'App.tsx',
          actionOrRoute: 'render',
          errorName: 'Error',
          errorMessage: 'x'.repeat(18_000),
        }),
      }),
      env
    );
    assert.equal(hugeResp.status, 413);
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});
