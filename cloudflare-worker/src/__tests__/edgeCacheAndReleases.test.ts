import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import { routeRequest } from '../routes.ts';
import {
  resetEdgeOriginForTests,
  setEdgeCacheOverrideForTests,
} from '../edgeCache.ts';
import { resetAllWorkerCachesForTests } from '../workerCache.ts';
import type { Env } from '../types.ts';

function toSqlParams(values: unknown[]): SQLInputValue[] {
  return values.map((v) =>
    v === undefined ? null : (v as SQLInputValue)
  );
}

function createCountingSqliteD1(sqlite: DatabaseSync): {
  db: D1Database;
  getReadCount: () => number;
  resetReadCount: () => void;
} {
  let readCount = 0;

  const makeStmt = (sql: string, bound: unknown[] = []) => {
    const stmtObj = {
      bind(...values: unknown[]) {
        return makeStmt(sql, values);
      },
      async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
        readCount += 1;
        const row = sqlite.prepare(sql).get(...toSqlParams(bound)) as Record<string, unknown> | undefined;
        if (!row) return null;
        if (colName) return (row[colName] as T) ?? null;
        return row as T;
      },
      async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        readCount += 1;
        const results = sqlite.prepare(sql).all(...toSqlParams(bound)) as T[];
        return {
          results,
          success: true,
          meta: {
            duration: 1,
            size_after: 0,
            rows_read: results.length,
            rows_written: 0,
            last_row_id: 0,
            changed_db: false,
            changes: 0,
          },
        };
      },
      async run(): Promise<D1Result> {
        const info = sqlite.prepare(sql).run(...toSqlParams(bound));
        const changes = Number(info.changes || 0);
        return {
          results: [],
          success: true,
          meta: {
            duration: 1,
            size_after: 0,
            rows_read: 0,
            rows_written: changes,
            last_row_id: Number(info.lastInsertRowid || 0),
            changed_db: changes > 0,
            changes,
          },
        };
      },
      async raw<T = unknown[]>(): Promise<T[]> {
        readCount += 1;
        const rows = sqlite.prepare(sql).all(...toSqlParams(bound)) as Record<string, unknown>[];
        return rows.map((r) => Object.values(r)) as T[];
      },
      _sql: sql,
      _bound: bound,
    };
    return stmtObj;
  };

  const db = {
    prepare(sql: string) {
      return makeStmt(sql);
    },
    async batch(statements: Array<{ _sql: string; _bound: unknown[] }>) {
      const results: D1Result[] = [];
      for (const s of statements) {
        const trimmed = s._sql.trim().toUpperCase();
        if (trimmed.startsWith('SELECT') || trimmed.startsWith('PRAGMA')) {
          readCount += 1;
          const rows = sqlite.prepare(s._sql).all(...toSqlParams(s._bound));
          results.push({
            results: rows,
            success: true,
            meta: {
              duration: 1,
              size_after: 0,
              rows_read: rows.length,
              rows_written: 0,
              last_row_id: 0,
              changed_db: false,
              changes: 0,
            },
          });
        } else {
          const info = sqlite.prepare(s._sql).run(...toSqlParams(s._bound));
          const changes = Number(info.changes || 0);
          results.push({
            results: [],
            success: true,
            meta: {
              duration: 1,
              size_after: 0,
              rows_read: 0,
              rows_written: changes,
              last_row_id: Number(info.lastInsertRowid || 0),
              changed_db: changes > 0,
              changes,
            },
          });
        }
      }
      return results;
    },
    async exec(sql: string) {
      sqlite.exec(sql);
      return { count: 1, duration: 1 };
    },
    async dump() {
      return new ArrayBuffer(0);
    },
  } as unknown as D1Database;

  return {
    db,
    getReadCount: () => readCount,
    resetReadCount: () => {
      readCount = 0;
    },
  };
}

function createInMemoryEdgeCache(): {
  cache: Cache;
  store: Map<string, { status: number; headers: Array<[string, string]>; body: ArrayBuffer }>;
  deleteLog: string[];
} {
  const store = new Map<
    string,
    { status: number; headers: Array<[string, string]>; body: ArrayBuffer }
  >();
  const deleteLog: string[] = [];

  const keyOf = (req: RequestInfo | URL): string =>
    typeof req === 'string' ? req : req instanceof URL ? req.toString() : req.url;

  const cache = {
    async match(req: RequestInfo | URL): Promise<Response | undefined> {
      const entry = store.get(keyOf(req));
      if (!entry) return undefined;
      return new Response(entry.body.slice(0), {
        status: entry.status,
        headers: new Headers(entry.headers),
      });
    },
    async put(req: RequestInfo | URL, res: Response): Promise<void> {
      const body = await res.clone().arrayBuffer();
      const headers: Array<[string, string]> = [];
      res.headers.forEach((v, k) => headers.push([k, v]));
      store.set(keyOf(req), { status: res.status, headers, body });
    },
    async delete(req: RequestInfo | URL): Promise<boolean> {
      const k = keyOf(req);
      deleteLog.push(k);
      return store.delete(k);
    },
  } as unknown as Cache;

  return { cache, store, deleteLog };
}

function setupTestDb(): DatabaseSync {
  const sqlite = new DatabaseSync(':memory:');
  const schemaPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf-8');
  sqlite.exec(schemaSql);
  return sqlite;
}

test('Cloudflare Edge Cache serves /api/v1/nodes/active, /client/locations, /client/version, and /client/rule-sets with zero D1 reads on HIT and purges cleanly on mutation', async () => {
  const sqlite = setupTestDb();
  const { db, getReadCount, resetReadCount } = createCountingSqliteD1(sqlite);
  const { cache, deleteLog } = createInMemoryEdgeCache();

  setEdgeCacheOverrideForTests(cache);
  resetEdgeOriginForTests();
  resetAllWorkerCachesForTests();

  const env: Env = {
    DB: db,
    JWT_SECRET: 'edge-jwt-secret',
    QUALITY_ENGINE_SECRET: 'edge-qe-secret',
    TELEGRAM_BOT_TOKEN: '123:edge-token',
    ADMIN_TELEGRAM_ID: '999001',
  };

  try {
    // Seed 1 active node
    sqlite
      .prepare(
        `INSERT INTO donated_outbounds
           (tag, protocol, server_address, server_port, config_json, country_code, country_name, status, latency_ms, health_score, is_official, allow_web, allow_download, fingerprint_sha256)
         VALUES
           ('DE-Edge-1', 'vless', '1.2.3.4', 443, '{"type":"vless","tag":"DE-Edge-1","server":"1.2.3.4","server_port":443}', 'DE', 'آلمان 🇩🇪', 'active', 65, 95, 1, 1, 1, 'fp-edge-1')`
      )
      .run();

    // 1. Unauthenticated /api/v1/nodes/active MUST return 401 and never touch cache
    const unauthNodes = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/nodes/active'),
      env
    );
    assert.equal(unauthNodes.status, 401);

    // 2. First authorized GET /api/v1/nodes/active -> MISS + Cache-Control: public, max-age=180
    resetReadCount();
    const nodesMiss = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/nodes/active', {
        headers: { 'X-Quality-Secret': 'edge-qe-secret' },
      }),
      env
    );
    assert.equal(nodesMiss.status, 200);
    assert.equal(nodesMiss.headers.get('X-Sentra-Cache'), 'MISS');
    assert.equal(nodesMiss.headers.get('Cache-Control'), 'public, max-age=180');
    assert.ok(getReadCount() > 0);
    const nodesBody1 = (await nodesMiss.json()) as { count: number };
    assert.equal(nodesBody1.count, 1);

    // 3. Second authorized GET /api/v1/nodes/active -> HIT + ZERO D1 reads
    resetReadCount();
    const nodesHit = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/nodes/active', {
        headers: { 'X-Quality-Secret': 'edge-qe-secret' },
      }),
      env
    );
    assert.equal(nodesHit.status, 200);
    assert.equal(nodesHit.headers.get('X-Sentra-Cache'), 'HIT');
    assert.equal(getReadCount(), 0, 'Edge Cache HIT must consume 0 D1 reads');

    // 4. GET /api/v1/client/locations -> MISS then HIT with 0 D1 reads & 180s TTL
    resetReadCount();
    const locMiss = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/client/locations'),
      env
    );
    assert.equal(locMiss.status, 200);
    assert.equal(locMiss.headers.get('X-Sentra-Cache'), 'MISS');
    assert.equal(locMiss.headers.get('Cache-Control'), 'public, max-age=180');

    resetReadCount();
    const locHit = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/client/locations'),
      env
    );
    assert.equal(locHit.status, 200);
    assert.equal(locHit.headers.get('X-Sentra-Cache'), 'HIT');
    assert.equal(getReadCount(), 0);

    // 5. POST /api/v1/nodes/health-report updates latency/status -> purges Edge Cache for nodes & locations
    const hrResp = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/nodes/health-report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Quality-Secret': 'edge-qe-secret',
        },
        body: JSON.stringify({
          results: [
            {
              outbound_id: 1,
              is_healthy: true,
              latency_ms: 42,
              health_score: 99,
            },
          ],
        }),
      }),
      env
    );
    assert.equal(hrResp.status, 200);
    assert.ok(
      deleteLog.some((u) => u.includes('/__edge_cache/v1/nodes/active')),
      'health-report must purge /api/v1/nodes/active edge cache'
    );
    assert.ok(
      deleteLog.some((u) => u.includes('/__edge_cache/v1/client/locations')),
      'health-report must purge /api/v1/client/locations edge cache'
    );

    const nodesAfterPurge = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/nodes/active', {
        headers: { 'X-Quality-Secret': 'edge-qe-secret' },
      }),
      env
    );
    assert.equal(nodesAfterPurge.headers.get('X-Sentra-Cache'), 'MISS');

    // 6. GET /api/v1/client/version -> MISS (600s), HIT (0 reads), then purged by POST /api/v1/releases/sync
    const verMiss = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/client/version'),
      env
    );
    assert.equal(verMiss.status, 200);
    assert.equal(verMiss.headers.get('X-Sentra-Cache'), 'MISS');
    assert.equal(verMiss.headers.get('Cache-Control'), 'public, max-age=600');

    resetReadCount();
    const verHit = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/client/version'),
      env
    );
    assert.equal(verHit.headers.get('X-Sentra-Cache'), 'HIT');
    assert.equal(getReadCount(), 0);

    const syncRes = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/releases/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Quality-Secret': 'edge-qe-secret',
        },
        body: JSON.stringify({
          platform: 'android',
          version: 'v3.1.0',
          github_url: 'https://github.com/parsa904/SentraVpn/releases/download/v3.1.0/SentraVPN-Android-Universal.apk',
          telegram_file_id: 'BQAC_EDGE_V310',
        }),
      }),
      env
    );
    assert.equal(syncRes.status, 200);

    const verFresh = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/client/version'),
      env
    );
    assert.equal(verFresh.headers.get('X-Sentra-Cache'), 'MISS');
    const verBody = (await verFresh.json()) as {
      latest_version: string;
      releases: { android: { version: string; telegram_cached: boolean } };
    };
    assert.equal(verBody.latest_version, 'v3.1.0');
    assert.equal(verBody.releases.android.telegram_cached, true);

    // 7. GET /api/v1/client/rule-sets & /api/v1/client/rule-sets/iran-direct -> MISS then HIT (600s)
    const rsMiss = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/client/rule-sets/iran-direct'),
      env
    );
    assert.equal(rsMiss.status, 200);
    assert.equal(rsMiss.headers.get('X-Sentra-Cache'), 'MISS');
    assert.equal(rsMiss.headers.get('Cache-Control'), 'public, max-age=600');
    const rsBody = (await rsMiss.json()) as { version: number; rules: unknown[] };
    assert.equal(rsBody.version, 3);
    assert.ok(Array.isArray(rsBody.rules) && rsBody.rules.length > 0);

    const rsHit = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/client/rule-sets/iran-direct'),
      env
    );
    assert.equal(rsHit.headers.get('X-Sentra-Cache'), 'HIT');
  } finally {
    setEdgeCacheOverrideForTests(undefined);
    resetEdgeOriginForTests();
    sqlite.close();
  }
});

test('Telegram auto-captures APK/EXE/ZIP file_id from admin private chat, management group, and RELEASES_CHANNEL_ID channel_post, and delivers instantly to users (even if app_release_files table was initially absent)', async () => {
  const sqlite = setupTestDb();
  // Drop app_release_files to verify ensureSchemaColumns auto-creates it safely on production DBs!
  sqlite.exec('DROP TABLE IF EXISTS app_release_files;');

  const { db } = createCountingSqliteD1(sqlite);
  const { cache, deleteLog } = createInMemoryEdgeCache();
  setEdgeCacheOverrideForTests(cache);
  resetEdgeOriginForTests();
  resetAllWorkerCachesForTests();

  // Configure management group for group-upload test
  sqlite
    .prepare(
      `INSERT INTO system_settings (key, value) VALUES ('log_group_id', '-100777888'), ('topic_logs_id', '42')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run();

  const env: Env = {
    DB: db,
    JWT_SECRET: 'tg-rel-jwt',
    QUALITY_ENGINE_SECRET: 'tg-rel-qe',
    TELEGRAM_BOT_TOKEN: '123:tg-rel-token',
    ADMIN_TELEGRAM_ID: '900001',
    RELEASES_CHANNEL_ID: '-100555444',
  };

  const sentCalls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (urlStr.startsWith('https://api.telegram.org/')) {
      const method = urlStr.split('/').pop() || '';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      sentCalls.push({ method, body });
      return new Response(JSON.stringify({ ok: true, result: { message_id: sentCalls.length } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  const postWebhook = async (update: Record<string, unknown>) => {
    sentCalls.length = 0;
    const res = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/telegram/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(update),
      }),
      env
    );
    assert.equal(res.status, 200);
    return [...sentCalls];
  };

  const adminUser = { id: 900001, first_name: 'Admin' };
  const normalUser = { id: 900002, first_name: 'Sara' };

  try {
    // 1. Before any file_id is cached -> tapping user_dl_android returns GitHub Releases fallback (parsa904/SentraVpn) without sendDocument
    const fallbackCalls = await postWebhook({
      update_id: 1,
      callback_query: {
        id: 'cb_fb_1',
        from: normalUser,
        message: { message_id: 10, chat: { id: 900002, type: 'private' } },
        data: 'user_dl_android',
      },
    });
    assert.equal(
      fallbackCalls.some((c) => c.method === 'sendDocument'),
      false,
      'Must NOT call sendDocument when no telegram_file_id is cached'
    );
    const fbMsg = fallbackCalls.find((c) => c.method === 'sendMessage');
    assert.ok(fbMsg);
    assert.ok(
      JSON.stringify(fbMsg.body.reply_markup).includes(
        'https://github.com/parsa904/SentraVpn/releases/latest/download/SentraVPN-Android-Universal.apk'
      )
    );

    // 2. Admin forwards an APK directly in private chat (no menu state required!) -> auto-cached & confirmed
    const privApkCalls = await postWebhook({
      update_id: 2,
      message: {
        message_id: 20,
        chat: { id: 900001, type: 'private' },
        from: adminUser,
        caption: 'انتشار نسخه v2.4.0',
        document: {
          file_id: 'BQAC_PRIV_APK_240',
          file_unique_id: 'AQAD_240',
          file_name: 'SentraVPN-Android-Universal.apk',
        },
      },
    });
    const privReply = privApkCalls.find((c) => c.method === 'sendMessage');
    assert.ok(privReply && String(privReply.body.text || '').includes('✅ <b>فایل نسخه جدید در سرور تلگرام کش شد</b>'));
    assert.ok(deleteLog.some((u) => u.includes('/__edge_cache/v1/client/version')));

    const savedAndr = sqlite
      .prepare("SELECT version, telegram_file_id FROM app_release_files WHERE platform = 'android'")
      .get() as { version: string; telegram_file_id: string };
    assert.equal(savedAndr.version, 'v2.4.0');
    assert.equal(savedAndr.telegram_file_id, 'BQAC_PRIV_APK_240');

    // 3. User clicks Android download -> INSTANT sendDocument with telegram_file_id FIRST!
    const fastAndrCalls = await postWebhook({
      update_id: 3,
      callback_query: {
        id: 'cb_fast_andr',
        from: normalUser,
        message: { message_id: 11, chat: { id: 900002, type: 'private' } },
        data: 'user_dl_android',
      },
    });
    const docIdx = fastAndrCalls.findIndex((c) => c.method === 'sendDocument');
    assert.ok(docIdx >= 0, 'Must immediately call sendDocument with cached telegram_file_id');
    assert.equal(fastAndrCalls[docIdx].body.document, 'BQAC_PRIV_APK_240');
    assert.ok(String(fastAndrCalls[docIdx].body.caption || '').includes('v2.4.0'));
    assert.ok(String(fastAndrCalls[docIdx].body.caption || '').includes('راهنمای نصب'));

    // 4. Admin uploads Windows EXE in the management group logs topic -> auto-cached & confirmed in topic
    const grpExeCalls = await postWebhook({
      update_id: 4,
      message: {
        message_id: 30,
        message_thread_id: 42,
        chat: { id: -100777888, type: 'supergroup' },
        from: adminUser,
        document: {
          file_id: 'BQAC_GRP_WIN_241',
          file_unique_id: 'AQAD_WIN_241',
          file_name: 'SentraVPN-Windows-Setup-x64-v2.4.1.exe',
        },
      },
    });
    const grpReply = grpExeCalls.find((c) => c.method === 'sendMessage');
    assert.ok(grpReply && String(grpReply.body.text || '').includes('فایل نسخه جدید در سرور تلگرام کش شد'));
    assert.equal(grpReply.body.message_thread_id, 42);

    const savedWin1 = sqlite
      .prepare("SELECT version, telegram_file_id FROM app_release_files WHERE platform = 'windows'")
      .get() as { version: string; telegram_file_id: string };
    assert.equal(savedWin1.version, 'v2.4.1');
    assert.equal(savedWin1.telegram_file_id, 'BQAC_GRP_WIN_241');

    // 5. Channel post in RELEASES_CHANNEL_ID updates Windows file_id silently (no reply posted in channel)
    const chanCalls = await postWebhook({
      update_id: 5,
      channel_post: {
        message_id: 99,
        chat: { id: -100555444, type: 'channel' },
        caption: 'SentraVPN Windows Portable v2.5.0',
        document: {
          file_id: 'BQAC_CHAN_WIN_250',
          file_unique_id: 'AQAD_WIN_250',
          file_name: 'SentraVPN-Windows-Portable-x64.zip',
        },
      },
    });
    assert.equal(chanCalls.length, 0, 'Channel post auto-capture must not spam replies in the channel');
    const savedWin2 = sqlite
      .prepare("SELECT version, telegram_file_id FROM app_release_files WHERE platform = 'windows'")
      .get() as { version: string; telegram_file_id: string };
    assert.equal(savedWin2.version, 'v2.5.0');
    assert.equal(savedWin2.telegram_file_id, 'BQAC_CHAN_WIN_250');
  } finally {
    globalThis.fetch = originalFetch;
    setEdgeCacheOverrideForTests(undefined);
    resetEdgeOriginForTests();
    sqlite.close();
  }
});
