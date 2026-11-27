import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import worker from '../index.ts';
import {
  buildSentryEnvelope,
  parseSentryDsn,
  reportErrorToTelegram,
  resetErrorReporterThrottleForTests,
  sendToSentry,
} from '../errorReporter.ts';
import { routeRequest } from '../routes.ts';
import { saveTopicRoute, sendDatabaseBackup } from '../telegramTopics.ts';
import {
  logTelemetryToTurso,
  normalizeTursoPipelineUrl,
  resetTursoSchemaFlagsForTests,
  saveD1BackupMirrorToTurso,
  TURSO_MAX_BACKUPS_RETAINED,
} from '../tursoClient.ts';
import { resetAllWorkerCachesForTests } from '../workerCache.ts';
import type { Env } from '../types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER_ROOT = path.resolve(__dirname, '../..');
const SCHEMA_SQL = fs.readFileSync(path.join(WORKER_ROOT, 'schema.sql'), 'utf8');

function createSqliteD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(SCHEMA_SQL);
  const db = {
    prepare(sql: string) {
      let params: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          params = args;
          return stmt;
        },
        async first<T = unknown>() {
          const row = sqlite.prepare(sql).get(...(params as any[]));
          return (row ?? null) as T;
        },
        async all<T = unknown>() {
          const trimmed = sql.trim().toUpperCase();
          if (trimmed.startsWith('SELECT')) {
            return { results: sqlite.prepare(sql).all(...(params as any[])) as T[], success: true, meta: {} };
          }
          const res = sqlite.prepare(sql).run(...(params as any[]));
          return {
            results: [] as T[],
            success: true,
            meta: { last_row_id: Number(res.lastInsertRowid ?? 0), changes: Number(res.changes ?? 0) },
          };
        },
        async run() {
          const res = sqlite.prepare(sql).run(...(params as any[]));
          return {
            success: true,
            meta: { last_row_id: Number(res.lastInsertRowid ?? 0), changes: Number(res.changes ?? 0) },
          };
        },
      };
      return stmt;
    },
    async batch<T = unknown>(stmts: Array<{ all: () => Promise<any> }>) {
      const out = [];
      for (const s of stmts) out.push(await s.all());
      return out as D1Result<T>[];
    },
  } as unknown as D1Database;
  return { sqlite, db };
}

test('parseSentryDsn & buildSentryEnvelope produce valid sanitized Envelope API payloads', () => {
  const parsed = parseSentryDsn('https://abcdef1234567890abcdef12345678@o450123.ingest.us.sentry.io/987654');
  assert.ok(parsed);
  assert.equal(parsed.publicKey, 'abcdef1234567890abcdef12345678');
  assert.equal(parsed.projectId, '987654');
  assert.equal(
    parsed.envelopeUrl,
    'https://o450123.ingest.us.sentry.io/api/987654/envelope/'
  );

  assert.equal(parseSentryDsn(''), null);
  assert.equal(parseSentryDsn('not-a-url'), null);
  assert.equal(parseSentryDsn('https://sentry.io/123'), null);
  assert.equal(parseSentryDsn('https://abc@sentry.io/not-a-number'), null);

  const envelope = buildSentryEnvelope(
    parsed,
    {
      platform: 'worker',
      appVersion: 'worker-v1',
      moduleOrFile: 'routes.ts',
      actionOrRoute: 'GET /sub/secret-user-token-999',
      errorName: 'RuntimeError',
      errorMessage: 'Auth failed Authorization: Bearer super-secret-jwt-value',
      context: {
        subscription_token: 'must-redact-me',
        status_code: 500,
      },
    },
    ['turso-secret-token-xyz']
  );

  const lines = envelope.split('\n');
  assert.equal(lines.length, 3);
  const header = JSON.parse(lines[0]);
  const itemHeader = JSON.parse(lines[1]);
  const event = JSON.parse(lines[2]);

  assert.equal(itemHeader.type, 'event');
  assert.equal(header.event_id, event.event_id);
  assert.equal(event.tags.sentra_platform, 'worker');
  assert.equal(event.extra.subscription_token, '[REDACTED]');
  assert.equal(event.extra.status_code, '500');
  assert.ok(!lines[2].includes('secret-user-token-999'));
  assert.ok(!lines[2].includes('super-secret-jwt-value'));
});

test('reportErrorToTelegram dispatches Telegram, Sentry Envelope, and Turso telemetry_logs in parallel with graceful fallback', async () => {
  resetAllWorkerCachesForTests();
  resetErrorReporterThrottleForTests();
  resetTursoSchemaFlagsForTests();

  const { sqlite, db } = createSqliteD1();
  await saveTopicRoute(db, 'logs', -100555666, 77);

  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    if (init?.headers && typeof init.headers === 'object') {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k.toLowerCase()] = String(v);
      }
    }
    const body = typeof init?.body === 'string' ? init.body : '[non-string]';
    calls.push({ url, headers, body });

    if (url.includes('api.telegram.org')) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (url.includes('/api/12345/envelope/')) {
      return new Response(JSON.stringify({ id: 'evt1' }), { status: 200 });
    }
    if (url.includes('/v2/pipeline')) {
      return new Response(JSON.stringify({ results: [{ type: 'ok' }] }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  try {
    const env: Env = {
      DB: db,
      TELEGRAM_BOT_TOKEN: '123456789:ABCDEF_FAKE_BOT_TOKEN_1234567890',
      SENTRY_DSN_WORKER: 'https://11112222333344445555666677778888@o99.ingest.sentry.io/12345',
      TURSO_DATABASE_URL: 'libsql://sentra-db-org.turso.io',
      TURSO_AUTH_TOKEN: 'turso_jwt_secret_token_999',
    };

    const ok = await reportErrorToTelegram(env, {
      platform: 'android',
      appVersion: '1.2.3',
      moduleOrFile: 'vpn_manager.rs',
      actionOrRoute: 'connect_vpn',
      errorName: 'SingboxCrash',
      errorMessage: 'Failed with token turso_jwt_secret_token_999',
    });

    assert.equal(ok, true);
    assert.equal(calls.length, 3, 'Must dispatch to Telegram, Sentry, and Turso in parallel');

    const sentryCall = calls.find((c) => c.url.includes('/api/12345/envelope/'));
    assert.ok(sentryCall);
    assert.equal(sentryCall.headers['content-type'], 'application/x-sentry-envelope');
    assert.ok(sentryCall.headers['x-sentry-auth'].includes('sentry_key=11112222333344445555666677778888'));
    assert.ok(!sentryCall.body.includes('turso_jwt_secret_token_999'));

    const tursoCall = calls.find((c) => c.url === 'https://sentra-db-org.turso.io/v2/pipeline');
    assert.ok(tursoCall);
    assert.equal(tursoCall.headers['authorization'], 'Bearer turso_jwt_secret_token_999');
    const tursoPayload = JSON.parse(tursoCall.body);
    assert.ok(
      tursoPayload.requests.some((r: any) =>
        String(r.stmt?.sql || '').includes('CREATE TABLE IF NOT EXISTS telemetry_logs')
      )
    );
    assert.ok(
      tursoPayload.requests.some((r: any) =>
        String(r.stmt?.sql || '').includes('INSERT INTO telemetry_logs')
      )
    );
    assert.ok(!tursoCall.body.includes('turso_jwt_secret_token_999'));

    // Graceful fallback: Sentry & Turso outage must NEVER prevent Telegram delivery
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('api.telegram.org')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error('Simulated Sentry/Turso outage');
    }) as typeof fetch;

    const fallbackOk = await reportErrorToTelegram(env, {
      platform: 'worker',
      moduleOrFile: 'index.ts',
      actionOrRoute: 'fetch',
      errorName: 'TestErr',
      errorMessage: 'Still reaches Telegram',
    });
    assert.equal(fallbackOk, true);

    // sendToSentry returns false cleanly when DSN is empty
    assert.equal(await sendToSentry({ DB: db }, {
      platform: 'worker',
      moduleOrFile: 'test',
      actionOrRoute: 'test',
      errorName: 'Err',
      errorMessage: 'msg',
    }), false);
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});

test('Turso client converts libsql:// to https://, logs QualityEngine health history, and mirrors 12h D1 backup retaining last 14 snapshots', async () => {
  resetAllWorkerCachesForTests();
  resetTursoSchemaFlagsForTests();

  assert.equal(
    normalizeTursoPipelineUrl('libsql://my-db-user.turso.io/'),
    'https://my-db-user.turso.io/v2/pipeline'
  );
  assert.equal(
    normalizeTursoPipelineUrl('https://my-db-user.turso.io'),
    'https://my-db-user.turso.io/v2/pipeline'
  );
  assert.equal(normalizeTursoPipelineUrl('http://insecure.turso.io'), null);

  const { sqlite, db } = createSqliteD1();
  sqlite
    .prepare(
      `INSERT INTO donated_outbounds (
         id, tag, protocol, server_address, server_port, config_json,
         latency_ms, speed_mbps, speed_score, assigned_tier, health_score,
         status, fail_count, raw_link, fingerprint_sha256, is_official, label,
         country_code, country_name, allow_web, allow_download, allow_gaming, allow_static_ip,
         gemini_ok, trading_safe, allocation_mode
       ) VALUES (
         1, 'NL-1', 'vless', '198.51.100.1', 443, '{}',
         50, 40, 85, 'web_browsing', 90,
         'active', 0, 'vless://x@198.51.100.1:443', 'fp-1', 1, 'NL-1',
         'NL', 'Netherlands', 1, 1, 0, 1, 1, 1, 'auto'
       )`
    )
    .run();
  await saveTopicRoute(db, 'backups', -100777888, 99);

  const originalFetch = globalThis.fetch;
  const tursoPipelines: Array<{ url: string; requests: any[] }> = [];
  let telegramBackupCalled = false;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/v2/pipeline')) {
      const parsed = JSON.parse(String(init?.body || '{}'));
      tursoPipelines.push({ url, requests: parsed.requests || [] });
      return new Response(JSON.stringify({ results: [{ type: 'ok' }] }), { status: 200 });
    }
    if (url.includes('api.telegram.org') && url.includes('/sendDocument')) {
      telegramBackupCalled = true;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  try {
    const env: Env = {
      DB: db,
      TELEGRAM_BOT_TOKEN: '123456789:ABCDEF_BACKUP_TOKEN_1234567890',
      QUALITY_ENGINE_SECRET: 'qe-secret-abc',
      TURSO_DATABASE_URL: 'libsql://sentra-mirror.turso.io',
      TURSO_AUTH_TOKEN: 'turso_token_mirror_123',
    };

    // 1. QualityEngine health-report logs node health history to Turso telemetry_logs
    const hrResp = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/nodes/health-report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Quality-Secret': 'qe-secret-abc',
        },
        body: JSON.stringify({
          results: [
            {
              outbound_id: 1,
              latency_ms: 48,
              jitter_ms: 3,
              speed_mbps: 45,
              speed_score: 88,
              health_score: 90,
              gemini_ok: true,
              trading_safe: true,
              is_healthy: true,
              security_passed: true,
            },
          ],
        }),
      }),
      env
    );
    assert.equal(hrResp.status, 200);
    assert.equal(tursoPipelines.length, 1);
    const healthInsert = tursoPipelines[0].requests.find((r) =>
      String(r.stmt?.sql || '').includes('INSERT INTO telemetry_logs')
    );
    assert.ok(healthInsert);
    assert.equal(healthInsert.stmt.args[0].value, 'github-actions');
    assert.equal(healthInsert.stmt.args[1].value, 'node_health_report');

    // 2. Scheduled 12-hour cron runs Telegram backup AND Turso d1_backups Cloud Mirror with 14-backup pruning
    tursoPipelines.length = 0;
    const backupRes = await sendDatabaseBackup(env);
    assert.equal(backupRes.ok, true);
    assert.equal(backupRes.tursoMirrored, true);
    assert.equal(telegramBackupCalled, true);
    assert.equal(tursoPipelines.length, 1);

    const backupReqs = tursoPipelines[0].requests;
    assert.ok(
      backupReqs.some((r) => String(r.stmt?.sql || '').includes('CREATE TABLE IF NOT EXISTS d1_backups'))
    );
    assert.ok(
      backupReqs.some((r) => String(r.stmt?.sql || '').includes('INSERT INTO d1_backups (payload_json) VALUES (?)'))
    );
    const pruneReq = backupReqs.find((r) =>
      String(r.stmt?.sql || '').includes('DELETE FROM d1_backups WHERE id NOT IN')
    );
    assert.ok(pruneReq);
    assert.equal(pruneReq.stmt.args[0].value, String(TURSO_MAX_BACKUPS_RETAINED));

    // 3. Scheduled handler runs cleanly with Turso outage (graceful fallback)
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v2/pipeline')) {
        throw new Error('Turso unreachable');
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    await worker.scheduled({} as ScheduledController, env, {} as ExecutionContext);
    assert.equal(await saveD1BackupMirrorToTurso(env, '{}'), false);
    assert.equal(
      await logTelemetryToTurso(env, { platform: 'worker', eventType: 'test', details: 'x' }),
      false
    );
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});
