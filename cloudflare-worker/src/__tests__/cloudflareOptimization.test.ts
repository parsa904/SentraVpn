import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  ERROR_DEDUP_WINDOW_MS,
  MAX_ERROR_DEDUP_KEYS,
  checkIngestionRateAndDedup,
  getDedupCacheSizeForTests,
  resetErrorReporterThrottleForTests,
} from '../errorReporter.ts';
import { routeRequest } from '../routes.ts';
import { pruneStaleRecords } from '../telegramTopics.ts';
import {
  resetAllWorkerCachesForTests,
} from '../workerCache.ts';
import type { Env } from '../types.ts';

interface InstrumentedDb {
  db: D1Database;
  sqlite: DatabaseSync;
  sqlLog: string[];
  batchCalls: number;
  writeCount: number;
  resetCounters: () => void;
}

function createInstrumentedSqliteD1(): InstrumentedDb {
  const sqlite = new DatabaseSync(':memory:');
  const schemaPath = path.resolve(import.meta.dirname, '../../schema.sql');
  const migrationPath = path.resolve(import.meta.dirname, '../../migrations/002_add_indexes.sql');
  for (const filePath of [schemaPath, migrationPath]) {
    const sql = fs.readFileSync(filePath, 'utf8');
    for (const stmt of sql.split(';').map((s) => s.trim()).filter(Boolean)) {
      sqlite.exec(stmt);
    }
  }

  const state = {
    sqlLog: [] as string[],
    batchCalls: 0,
    writeCount: 0,
  };

  const track = (query: string) => {
    state.sqlLog.push(query);
    if (/^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)/i.test(query)) {
      state.writeCount += 1;
    }
  };

  const db = {
    prepare(query: string) {
      let params: unknown[] = [];
      const stmtObj = {
        bind(...args: unknown[]) {
          params = args;
          return stmtObj;
        },
        async first<T = Record<string, unknown>>() {
          track(query);
          const row = sqlite.prepare(query).get(...(params as never[])) as T | undefined;
          return row ?? null;
        },
        async all<T = Record<string, unknown>>() {
          track(query);
          if (/^\s*SELECT/i.test(query)) {
            const rows = sqlite.prepare(query).all(...(params as never[])) as T[];
            return { success: true, results: rows, meta: { changes: 0 } };
          }
          const info = sqlite.prepare(query).run(...(params as never[]));
          return {
            success: true,
            results: [] as T[],
            meta: { last_row_id: Number(info.lastInsertRowid), changes: Number(info.changes) },
          };
        },
        async run() {
          track(query);
          const info = sqlite.prepare(query).run(...(params as never[]));
          return {
            success: true,
            meta: { last_row_id: Number(info.lastInsertRowid), changes: Number(info.changes) },
          };
        },
      };
      return stmtObj;
    },
    async batch<T = Record<string, unknown>>(stmts: Array<{ all: () => Promise<unknown> }>) {
      state.batchCalls += 1;
      const results = [];
      for (const s of stmts) {
        results.push(await s.all());
      }
      return results as Array<D1Result<T>>;
    },
  } as unknown as D1Database;

  return {
    db,
    sqlite,
    get sqlLog() {
      return state.sqlLog;
    },
    get batchCalls() {
      return state.batchCalls;
    },
    get writeCount() {
      return state.writeCount;
    },
    resetCounters() {
      state.sqlLog.length = 0;
      state.batchCalls = 0;
      state.writeCount = 0;
    },
  };
}

test('002_add_indexes.sql creates all required D1 indexes and worker src has zero runtime DDL', () => {
  const { sqlite } = createInstrumentedSqliteD1();
  try {
    const indexes = (
      sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);

    const expected = [
      'idx_users_telegram_id',
      'idx_users_role',
      'idx_subscriptions_token',
      'idx_subscriptions_user_status',
      'idx_donated_status_official_health',
      'idx_donated_fingerprint',
      'idx_donated_status_updated_at',
      'idx_telegram_states_telegram_id',
      'idx_telegram_states_updated_at',
      'idx_donations_status_user',
      'idx_tickets_user_status',
      'idx_outbounds_active_mode',
      'idx_device_sessions_sub_active',
    ];
    for (const idx of expected) {
      assert.ok(indexes.includes(idx), `Missing expected index: ${idx}`);
    }
  } finally {
    sqlite.close();
  }

  // Ensure zero runtime D1 CREATE TABLE IF NOT EXISTS in hot-path cloudflare-worker/src/*.ts
  // (tursoClient.ts targets remote Turso HTTP only; supportSessions.ts uses a WeakSet-cached
  //  one-time lazy `ensureSchemaColumns` guard invoked strictly on support session flows)
  const srcDir = path.resolve(import.meta.dirname, '..');
  for (const entry of fs.readdirSync(srcDir)) {
    if (!entry.endsWith('.ts')) continue;
    const content = fs.readFileSync(path.join(srcDir, entry), 'utf8');
    if (entry === 'tursoClient.ts') {
      assert.equal(/\benv\.DB\b/.test(content), false, 'tursoClient.ts must never touch Cloudflare D1 (env.DB)');
      continue;
    }
    if (entry === 'supportSessions.ts') {
      assert.equal(
        /\bWeakSet\b/.test(content) && /\bensureSchemaColumns\b/.test(content),
        true,
        'supportSessions.ts must guard ensureSchemaColumns with a per-isolate WeakSet cache'
      );
      continue;
    }
    assert.equal(
      /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/i.test(content),
      false,
      `Found prohibited runtime DDL in ${entry}`
    );
  }
});

test('/sub/:token and /api/v1/client/config use isolate RAM cache, ETag/304 Not Modified, Cache-Control, and zero D1 writes', async () => {
  resetAllWorkerCachesForTests();
  const inst = createInstrumentedSqliteD1();
  const { db, sqlite } = inst;

  try {
    sqlite
      .prepare(
        `INSERT INTO users (user_uuid, telegram_id, username, first_name, role, status)
         VALUES ('u-opt-1', 10001, 'optuser', 'Opt', 'user', 'active')`
      )
      .run();
    const uRow = sqlite.prepare("SELECT id FROM users WHERE user_uuid = 'u-opt-1'").get() as {
      id: number;
    };
    sqlite
      .prepare(
        `INSERT INTO subscriptions (user_id, tier, token, status, expires_at)
         VALUES (?, 'Sentra Pro', 'opt-sub-token-001', 'active', '2027-12-31T00:00:00Z')`
      )
      .run(uRow.id);
    sqlite
      .prepare(
        `INSERT INTO donated_outbounds (
           tag, protocol, server_address, server_port, config_json,
           status, fingerprint_sha256, is_official, country_code, country_name,
           allow_web, allow_download, latency_ms, health_score
         ) VALUES (
           'DE-Fast', 'vless', '198.51.100.20', 443,
           '{"type":"vless","server":"198.51.100.20","server_port":443,"uuid":"11111111-1111-4111-8111-111111111111"}',
           'active', 'fp-opt-de-1', 1, 'DE', 'Germany 🇩🇪', 1, 1, 45, 98
         )`
      )
      .run();

    const env = {
      DB: db,
      QUALITY_ENGINE_SECRET: 'qe-opt-secret',
    } as Env;

    // 1. Public /sub/:token is permanently disabled (403 Forbidden, 0 D1 reads/writes)
    inst.resetCounters();
    const disabledSubResp = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/sub/opt-sub-token-001?format=singbox', {
        headers: { 'CF-Connecting-IP': '198.51.100.1' },
      }),
      env
    );
    assert.equal(disabledSubResp.status, 403);
    assert.equal(inst.writeCount, 0);

    // 2. First POST /api/v1/client/config with X-Sentra-Client populates isolate cache
    inst.resetCounters();
    const cfgResp1 = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/client/config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sentra-Client': 'SentraVPN/1.0.0',
          'X-Subscription-Token': 'opt-sub-token-001',
          'CF-Connecting-IP': '198.51.100.1',
        },
        body: JSON.stringify({ mode: 'web_browsing' }),
      }),
      env
    );
    assert.equal(cfgResp1.status, 200);
    assert.equal(cfgResp1.headers.get('Cache-Control'), 'private, max-age=1800');
    const cfgEtag = cfgResp1.headers.get('ETag');
    assert.ok(cfgEtag && cfgEtag.startsWith('W/"'), `Expected weak ETag, got ${cfgEtag}`);
    assert.equal(inst.writeCount, 0, 'POST /api/v1/client/config must perform ZERO D1 writes');
    assert.equal(inst.batchCalls, 1, 'Pool load should use 1 batched read');

    // 3. Second POST /api/v1/client/config with If-None-Match returns 304 and hits RAM cache (0 node reads, 0 writes)
    inst.resetCounters();
    const cfgResp2 = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/client/config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sentra-Client': 'SentraVPN/1.0.0',
          'X-Subscription-Token': 'opt-sub-token-001',
          'If-None-Match': cfgEtag,
          'CF-Connecting-IP': '198.51.100.1',
        },
        body: JSON.stringify({ mode: 'web_browsing' }),
      }),
      env
    );
    assert.equal(cfgResp2.status, 304);
    assert.equal(cfgResp2.headers.get('ETag'), cfgEtag);
    assert.equal(inst.writeCount, 0);
    assert.equal(
      inst.sqlLog.some((q) => /FROM donated_outbounds/i.test(q)),
      false,
      'Repeat /api/v1/client/config request within 5 min must serve nodes from isolate RAM cache'
    );
  } finally {
    sqlite.close();
  }
});

test('POST /api/v1/nodes/health-report uses Diff-Only Writes + db.batch() and invalidates isolate cache', async () => {
  resetAllWorkerCachesForTests();
  const inst = createInstrumentedSqliteD1();
  const { db, sqlite } = inst;

  try {
    sqlite
      .prepare(
        `INSERT INTO donated_outbounds (
           tag, protocol, server_address, server_port, config_json,
           status, fingerprint_sha256, is_official, allocation_mode, health_score, gemini_ok, trading_safe
         ) VALUES ('DE-Diff', 'vless', '198.51.100.30', 443, '{"type":"vless"}', 'active', 'fp-diff-1', 1, 'auto', 80, 0, 0)`
      )
      .run();
    const node = sqlite.prepare("SELECT id FROM donated_outbounds WHERE fingerprint_sha256 = 'fp-diff-1'").get() as {
      id: number;
    };

    const env = {
      DB: db,
      QUALITY_ENGINE_SECRET: 'qe-diff-secret',
    } as Env;

    const payload = {
      checked_at: new Date().toISOString(),
      results: [
        {
          outbound_id: node.id,
          latency_ms: 42,
          jitter_ms: 4,
          speed_mbps: 30,
          speed_score: 95,
          health_score: 95,
          gemini_ok: true,
          trading_safe: true,
          is_healthy: true,
          security_passed: true,
          error_msg: null,
        },
      ],
      subscription_reports: [],
    };

    // First report changes health_score (80 -> 95), gemini_ok (0 -> 1), trading_safe (0 -> 1), allow_static_ip (0 -> 1)
    inst.resetCounters();
    const resp1 = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/nodes/health-report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Quality-Secret': 'qe-diff-secret',
        },
        body: JSON.stringify(payload),
      }),
      env
    );
    assert.equal(resp1.status, 200);
    const body1 = (await resp1.json()) as { db_writes: number; writes_skipped: number };
    assert.equal(body1.db_writes, 1);
    assert.equal(body1.writes_skipped, 0);
    assert.ok(inst.batchCalls >= 2, 'Expected read batch + write batch');

    // Second identical report must skip the D1 UPDATE completely (0 writes!)
    inst.resetCounters();
    const resp2 = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/nodes/health-report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Quality-Secret': 'qe-diff-secret',
        },
        body: JSON.stringify(payload),
      }),
      env
    );
    assert.equal(resp2.status, 200);
    const body2 = (await resp2.json()) as { db_writes: number; writes_skipped: number };
    assert.equal(body2.db_writes, 0);
    assert.equal(body2.writes_skipped, 1);
    assert.equal(inst.writeCount, 0, 'Unchanged health report must execute ZERO D1 writes');
  } finally {
    sqlite.close();
  }
});

test('in-memory IP rate limiter protects /api/v1/logs/report and /sub/* with 429 and zero D1 writes', async () => {
  resetAllWorkerCachesForTests();
  const inst = createInstrumentedSqliteD1();
  const env = { DB: inst.db } as Env;

  try {
    // 15 allowed requests from the same IP across platforms (staying under per-platform 10/min cap),
    // then 16th returns 429 from the IP limiter BEFORE JSON parsing
    for (let i = 0; i < 15; i += 1) {
      const resp = await routeRequest(
        new Request('https://sentra-core.kziepr.workers.dev/api/v1/logs/report', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'CF-Connecting-IP': '203.0.113.77',
          },
          body: JSON.stringify({
            platform: i % 2 === 0 ? 'android' : 'windows',
            moduleOrFile: 'test.ts',
            actionOrRoute: 'test',
            errorName: 'Err',
            errorMessage: `Unique test error ${i}`,
          }),
        }),
        env
      );
      assert.notEqual(resp.status, 429);
    }

    inst.resetCounters();
    const blockedLogs = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/logs/report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CF-Connecting-IP': '203.0.113.77',
        },
        body: '{invalid-json',
      }),
      env
    );
    assert.equal(blockedLogs.status, 429);
    assert.ok(Number(blockedLogs.headers.get('Retry-After')) >= 1);
    assert.equal(inst.writeCount, 0);

    // 30 allowed requests on /api/v1/client/config, 31st returns 429 immediately (0 D1 reads/writes)
    for (let i = 0; i < 30; i += 1) {
      const resp = await routeRequest(
        new Request('https://sentra-core.kziepr.workers.dev/api/v1/client/config', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Sentra-Client': 'SentraVPN/1.0.0',
            'CF-Connecting-IP': '203.0.113.88',
          },
          body: JSON.stringify({ connect_code: '99999999' }),
        }),
        env
      );
      assert.equal(resp.status, 401);
    }

    inst.resetCounters();
    const blockedSub = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/client/config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sentra-Client': 'SentraVPN/1.0.0',
          'CF-Connecting-IP': '203.0.113.88',
        },
        body: JSON.stringify({ connect_code: '99999999' }),
      }),
      env
    );
    assert.equal(blockedSub.status, 429);
    assert.equal(inst.sqlLog.length, 0, 'Rate-limited /api/v1/client/config request must not touch D1');
  } finally {
    inst.sqlite.close();
  }
});

test('errorReporter enforces 5-minute RAM dedup window and strict 100-key FIFO cap', () => {
  resetErrorReporterThrottleForTests();
  assert.equal(ERROR_DEDUP_WINDOW_MS, 5 * 60_000);
  assert.equal(MAX_ERROR_DEDUP_KEYS, 100);

  const t0 = 1_700_000_000_000;
  const sample = {
    platform: 'windows' as const,
    moduleOrFile: 'vpn_manager.rs',
    errorName: 'TunError',
    errorMessage: 'Failed to open TUN adapter',
  };

  assert.equal(checkIngestionRateAndDedup(sample, 'win:1', t0).allowed, true);
  // Still deduplicated at 4 minutes 59 seconds
  assert.deepEqual(checkIngestionRateAndDedup(sample, 'win:1', t0 + 299_000), {
    allowed: false,
    reason: 'deduplicated',
  });
  // Allowed again after 5 minutes
  assert.equal(checkIngestionRateAndDedup(sample, 'win:1', t0 + 300_001).allowed, true);

  // Fill > 100 distinct error fingerprints across clients and verify strict 100-key cap
  resetErrorReporterThrottleForTests();
  for (let i = 0; i < 130; i += 1) {
    checkIngestionRateAndDedup(
      {
        platform: 'android',
        moduleOrFile: 'core.ts',
        errorName: 'Err',
        errorMessage: `Distinct error #${i}`,
      },
      `android:client-${i}`,
      t0 + i
    );
  }
  assert.equal(getDedupCacheSizeForTests(), 100);
});

test('pruneStaleRecords deletes old telegram_states (>24h), dead outbounds (>14d), and old ip_registrations (>7d) in one batch', async () => {
  const inst = createInstrumentedSqliteD1();
  const { db, sqlite } = inst;

  try {
    // Old & fresh telegram_states
    sqlite
      .prepare(
        `INSERT INTO telegram_states (telegram_id, state_type, payload_json, updated_at)
         VALUES (111, 'support', '{}', datetime('now', '-30 hours')),
                (222, 'support', '{}', datetime('now', '-2 hours'))`
      )
      .run();

    // Old inactive/rejected outbounds (>14d), recent inactive (3d), and old active (30d - must stay!)
    sqlite
      .prepare(
        `INSERT INTO donated_outbounds (
           tag, protocol, server_address, server_port, config_json, status, fingerprint_sha256, updated_at
         ) VALUES
           ('OldDead', 'vless', '1.1.1.1', 443, '{}', 'inactive', 'fp-old-dead', datetime('now', '-20 days')),
           ('OldRej', 'vless', '1.1.1.2', 443, '{}', 'rejected', 'fp-old-rej', datetime('now', '-16 days')),
           ('RecentDead', 'vless', '1.1.1.3', 443, '{}', 'inactive', 'fp-rec-dead', datetime('now', '-3 days')),
           ('OldActive', 'vless', '1.1.1.4', 443, '{}', 'active', 'fp-old-active', datetime('now', '-40 days'))`
      )
      .run();

    // Old & fresh ip_registrations
    sqlite
      .prepare(
        `INSERT INTO ip_registrations (ip, created_at)
         VALUES ('198.51.100.1', datetime('now', '-10 days')),
                ('198.51.100.2', datetime('now', '-1 days'))`
      )
      .run();

    inst.resetCounters();
    const res = await pruneStaleRecords(db);
    assert.equal(inst.batchCalls, 1, 'pruneStaleRecords must execute in 1 db.batch() call');
    assert.equal(res.deletedStates, 1);
    assert.equal(res.deletedOutbounds, 2);
    assert.equal(res.deletedIpRegistrations, 1);

    const remainingStates = sqlite.prepare('SELECT telegram_id FROM telegram_states').all() as Array<{
      telegram_id: number;
    }>;
    assert.deepEqual(remainingStates.map((r) => r.telegram_id), [222]);

    const remainingNodes = sqlite
      .prepare('SELECT tag FROM donated_outbounds ORDER BY tag ASC')
      .all() as Array<{ tag: string }>;
    assert.deepEqual(remainingNodes.map((r) => r.tag), ['OldActive', 'RecentDead']);
  } finally {
    sqlite.close();
  }
});
