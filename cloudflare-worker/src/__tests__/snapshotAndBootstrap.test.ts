import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  resetEdgeOriginForTests,
  setEdgeCacheOverrideForTests,
} from '../edgeCache.ts';
import { signTelegramInitDataForTests } from '../miniAppAuth.ts';
import { routeRequest } from '../routes.ts';
import {
  clearSnapshotRamCacheForTests,
  getOrBuildNodesSnapshot,
  KV_KEY_NODES_SNAPSHOT,
  rebuildNodesSnapshot,
} from '../snapshot.ts';
import {
  bumpSubscriptionAccountRev,
  ensureSchemaColumns,
} from '../supportSessions.ts';
import { resetAllWorkerCachesForTests } from '../workerCache.ts';
import type { Env } from '../types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER_ROOT = path.resolve(__dirname, '../..');
const SCHEMA_SQL = fs.readFileSync(path.join(WORKER_ROOT, 'schema.sql'), 'utf8');

class InstrumentedD1 {
  sqlite: DatabaseSync;
  readCount = 0;
  writeCount = 0;
  sqlLog: string[] = [];

  constructor(customSql?: string) {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec(customSql ?? SCHEMA_SQL);
  }

  resetCounters() {
    this.readCount = 0;
    this.writeCount = 0;
    this.sqlLog = [];
  }

  private record(sql: string) {
    this.sqlLog.push(sql);
    const trimmed = sql.trim().toUpperCase();
    if (trimmed.startsWith('SELECT') || trimmed.startsWith('PRAGMA')) {
      this.readCount += 1;
    } else {
      this.writeCount += 1;
    }
  }

  prepare(sql: string) {
    let params: unknown[] = [];
    const self = this;
    const stmt = {
      bind(...args: unknown[]) {
        params = args;
        return stmt;
      },
      async first<T = unknown>() {
        self.record(sql);
        const row = self.sqlite.prepare(sql).get(...(params as any[]));
        return (row ?? null) as T;
      },
      async all<T = unknown>() {
        self.record(sql);
        const trimmed = sql.trim().toUpperCase();
        if (trimmed.startsWith('SELECT') || trimmed.startsWith('PRAGMA')) {
          const rows = self.sqlite.prepare(sql).all(...(params as any[]));
          return { results: rows as T[], success: true, meta: {} };
        }
        const res = self.sqlite.prepare(sql).run(...(params as any[]));
        return {
          results: [] as T[],
          success: true,
          meta: {
            last_row_id: Number(res.lastInsertRowid ?? 0),
            changes: Number(res.changes ?? 0),
          },
        };
      },
      async run() {
        self.record(sql);
        const res = self.sqlite.prepare(sql).run(...(params as any[]));
        return {
          success: true,
          meta: {
            last_row_id: Number(res.lastInsertRowid ?? 0),
            changes: Number(res.changes ?? 0),
          },
        };
      },
    };
    return stmt;
  }

  async batch<T = unknown>(statements: Array<{ all: () => Promise<any> }>) {
    const out = [];
    for (const s of statements) {
      out.push(await s.all());
    }
    return out as D1Result<T>[];
  }
}

class MockKv {
  store = new Map<string, string>();
  getCount = 0;
  putCount = 0;
  deleteCount = 0;

  resetCounters() {
    this.getCount = 0;
    this.putCount = 0;
    this.deleteCount = 0;
  }

  async get(key: string, type?: string): Promise<unknown> {
    this.getCount += 1;
    const raw = this.store.get(key);
    if (raw === undefined) return null;
    if (type === 'json') return JSON.parse(raw);
    return raw;
  }

  async put(key: string, value: string): Promise<void> {
    this.putCount += 1;
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.deleteCount += 1;
    this.store.delete(key);
  }
}

class InMemoryEdgeCache {
  entries = new Map<string, Response>();

  private keyOf(req: RequestInfo | URL): string {
    if (typeof req === 'string') return req;
    if (req instanceof URL) return req.toString();
    return req.url;
  }

  async match(req: RequestInfo | URL): Promise<Response | undefined> {
    const hit = this.entries.get(this.keyOf(req));
    return hit ? hit.clone() : undefined;
  }

  async put(req: RequestInfo | URL, resp: Response): Promise<void> {
    this.entries.set(this.keyOf(req), resp.clone());
  }

  async delete(req: RequestInfo | URL): Promise<boolean> {
    return this.entries.delete(this.keyOf(req));
  }
}

function seedFixture(sqlite: DatabaseSync) {
  sqlite
    .prepare(
      `INSERT INTO users (id, user_uuid, telegram_id, username, first_name, role, status)
       VALUES (1, 'u-sync-1', 551100, 'sync_user', 'Ali', 'user', 'active')`
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO subscriptions (
         id, user_id, tier, plan_tier, connect_code, token, status,
         traffic_limit_bytes, max_concurrent_devices, account_rev, expires_at
       ) VALUES (
         1, 1, 'Sentra Pro', 'pro', '44556677', 'tok-sync-001', 'active',
         214748364800, 3, 1, '2030-01-01T00:00:00Z'
       )`
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO donated_outbounds (
         id, tag, protocol, server_address, server_port, config_json,
         latency_ms, speed_mbps, speed_score, assigned_tier, health_score,
         status, fail_count, raw_link, fingerprint_sha256, is_official, label,
         country_code, country_name, allow_web, allow_download, allow_gaming, allow_static_ip,
         gemini_ok, trading_safe, allocation_mode
       ) VALUES (
         20, 'NL-SNAP-1', 'vless', '198.51.100.88', 443,
         '{"type":"vless","tag":"NL-SNAP-1","server":"198.51.100.88","server_port":443,"uuid":"22222222-2222-2222-2222-222222222222"}',
         42, 65.0, 92, 'web_browsing', 96,
         'active', 0, 'vless://22222222-2222-2222-2222-222222222222@198.51.100.88:443?security=tls#NL-SNAP-1',
         'fp-snap-20', 1, 'Netherlands Core', 'NL', 'Netherlands 🇳🇱', 1, 1, 1, 1, 1, 1, 'all'
       )`
    )
    .run();
}

test('NodesSnapshot cold-start D1 fallback -> KV/Edge/RAM hierarchy and rebuild invalidation', async () => {
  resetAllWorkerCachesForTests();
  resetEdgeOriginForTests();
  const d1 = new InstrumentedD1();
  const kv = new MockKv();
  const edge = new InMemoryEdgeCache();
  setEdgeCacheOverrideForTests(edge as unknown as Cache);
  seedFixture(d1.sqlite);

  const env: Env = {
    DB: d1 as unknown as D1Database,
    SENTRA_KV: kv as unknown as KVNamespace,
  };

  try {
    // 1. Cold start: builds from D1 once, writes KV (`SENTRA_NODES_SNAPSHOT`) + Edge + RAM
    const first = await getOrBuildNodesSnapshot(env, 'https://sentra-core.kziepr.workers.dev');
    assert.equal(first.source, 'd1-cold');
    assert.equal(first.snapshot.healthy_count, 1);
    assert.ok(first.snapshot.nodes_rev.length >= 6);
    assert.equal(first.snapshot.tiers.free.node_count, 1);
    assert.equal(first.snapshot.tiers.pro.node_count, 1);
    assert.equal(first.snapshot.tiers.special.node_count, 1);
    assert.equal(kv.store.has(KV_KEY_NODES_SNAPSHOT), true);

    // 2. Warm RAM hit: 0 D1 reads, 0 KV reads
    d1.resetCounters();
    kv.resetCounters();
    const fromRam = await getOrBuildNodesSnapshot(env, 'https://sentra-core.kziepr.workers.dev');
    assert.equal(fromRam.source, 'ram');
    assert.equal(fromRam.snapshot.nodes_rev, first.snapshot.nodes_rev);
    assert.equal(d1.readCount, 0);
    assert.equal(kv.getCount, 0);

    // 3. Clear RAM only -> Edge Cache HIT (0 D1 reads, 0 KV reads)
    clearSnapshotRamCacheForTests(env.DB);
    d1.resetCounters();
    kv.resetCounters();
    const fromEdge = await getOrBuildNodesSnapshot(env, 'https://sentra-core.kziepr.workers.dev');
    assert.equal(fromEdge.source, 'edge');
    assert.equal(fromEdge.snapshot.nodes_rev, first.snapshot.nodes_rev);
    assert.equal(d1.readCount, 0);
    assert.equal(kv.getCount, 0);

    // 4. Clear RAM + Edge -> KV HIT (0 D1 reads, 1 KV read)
    clearSnapshotRamCacheForTests(env.DB);
    edge.entries.clear();
    d1.resetCounters();
    kv.resetCounters();
    const fromKv = await getOrBuildNodesSnapshot(env, 'https://sentra-core.kziepr.workers.dev');
    assert.equal(fromKv.source, 'kv');
    assert.equal(fromKv.snapshot.nodes_rev, first.snapshot.nodes_rev);
    assert.equal(d1.readCount, 0);
    assert.equal(kv.getCount, 1);

    // 5. Explicit rebuild updates nodes_rev, writes KV, and invalidates Edge Cache
    const rebuilt = await rebuildNodesSnapshot(
      env,
      'https://sentra-core.kziepr.workers.dev',
      Date.now() + 5000
    );
    assert.notEqual(rebuilt.nodes_rev, first.snapshot.nodes_rev);
    assert.equal(kv.store.has(KV_KEY_NODES_SNAPSHOT), true);
  } finally {
    clearSnapshotRamCacheForTests(env.DB);
    setEdgeCacheOverrideForTests(undefined);
    d1.sqlite.close();
  }
});

test('GET /api/v1/bootstrap supports Telegram Mini App & Client auth with ETag/304 HIT-304, account_rev bump & health-report invalidation', async () => {
  resetAllWorkerCachesForTests();
  resetEdgeOriginForTests();
  const d1 = new InstrumentedD1();
  const kv = new MockKv();
  const edge = new InMemoryEdgeCache();
  setEdgeCacheOverrideForTests(edge as unknown as Cache);
  seedFixture(d1.sqlite);

  const botToken = '123456:TEST-BOT-TOKEN-FOR-SYNC';
  const env: Env = {
    DB: d1 as unknown as D1Database,
    SENTRA_KV: kv as unknown as KVNamespace,
    TELEGRAM_BOT_TOKEN: botToken,
    QUALITY_ENGINE_SECRET: 'qe-sync-secret',
    BOT_USERNAME: 'SentraVPNBot',
  };

  try {
    // A. Client Token Auth -> 200 OK with ETag & unified snapshot
    const c1 = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/bootstrap', {
        method: 'GET',
        headers: { 'X-Subscription-Token': 'tok-sync-001' },
      }),
      env
    );
    assert.equal(c1.status, 200);
    const clientEtag = c1.headers.get('ETag');
    assert.ok(clientEtag && clientEtag.startsWith('W/"'));
    const c1Body = (await c1.json()) as any;
    assert.equal(c1Body.success, true);
    assert.equal(c1Body.auth_source, 'client_token');
    assert.equal(c1Body.subscription.plan_tier, 'pro');
    assert.equal(c1Body.sync.account_rev, 1);
    assert.equal(c1Body.nodes_snapshot.tier, 'pro');
    assert.equal(c1Body.nodes_snapshot.node_count, 1);

    // B. Repeat Client request with If-None-Match -> 304 Not Modified (HIT-304)
    const c2 = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/bootstrap', {
        method: 'GET',
        headers: {
          'X-Subscription-Token': 'tok-sync-001',
          'If-None-Match': clientEtag!,
        },
      }),
      env
    );
    assert.equal(c2.status, 304);
    assert.equal(c2.headers.get('X-Sentra-Cache'), 'HIT-304');
    assert.equal(await c2.text(), '');

    // C. Connect Code Auth works identically
    const ccResp = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/bootstrap', {
        method: 'GET',
        headers: { 'X-Connect-Code': '44556677' },
      }),
      env
    );
    assert.equal(ccResp.status, 200);
    const ccBody = (await ccResp.json()) as any;
    assert.equal(ccBody.auth_source, 'connect_code');
    assert.equal(ccBody.subscription.connect_code, '44556677');

    // D. Telegram Mini App initData Auth -> 200 OK -> 304 HIT-304
    const nowSec = Math.floor(Date.now() / 1000);
    const initData = await signTelegramInitDataForTests(
      {
        auth_date: String(nowSec),
        query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
        user: JSON.stringify({ id: 551100, first_name: 'Ali', username: 'ali_tg' }),
      },
      botToken
    );

    const m1 = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/bootstrap', {
        method: 'GET',
        headers: { 'X-Telegram-Init-Data': initData },
      }),
      env
    );
    assert.equal(m1.status, 200);
    const miniEtag = m1.headers.get('ETag')!;
    assert.ok(miniEtag);
    const m1Body = (await m1.json()) as any;
    assert.equal(m1Body.auth_source, 'telegram_miniapp');
    assert.equal(m1Body.sync.account_rev, 1);

    const m2 = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/bootstrap', {
        method: 'GET',
        headers: {
          'X-Telegram-Init-Data': initData,
          'If-None-Match': miniEtag,
        },
      }),
      env
    );
    assert.equal(m2.status, 304);
    assert.equal(m2.headers.get('X-Sentra-Cache'), 'HIT-304');

    // E. Updating credentials via Mini App bumps account_rev -> old ETag returns fresh 200 OK!
    const credResp = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/miniapp/credentials', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Init-Data': initData,
        },
        body: JSON.stringify({
          username: 'ali_synced_99',
          password: 'StrongPassword99!',
          confirm_password: 'StrongPassword99!',
        }),
      }),
      env
    );
    assert.equal(credResp.status, 200);
    const credBody = (await credResp.json()) as any;
    assert.equal(credBody.account_rev, 2);

    const m3 = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/bootstrap', {
        method: 'GET',
        headers: {
          'X-Telegram-Init-Data': initData,
          'If-None-Match': miniEtag,
        },
      }),
      env
    );
    assert.equal(m3.status, 200);
    const miniEtag2 = m3.headers.get('ETag')!;
    assert.notEqual(miniEtag2, miniEtag);
    const m3Body = (await m3.json()) as any;
    assert.equal(m3Body.sync.account_rev, 2);
    assert.equal(m3Body.user.username, 'ali_synced_99');

    // F. QualityEngine health-report change rebuilds snapshot (new nodes_rev) -> old ETag returns fresh 200 OK!
    const hrResp = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/nodes/health-report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Quality-Secret': 'qe-sync-secret',
        },
        body: JSON.stringify({
          results: [
            {
              outbound_id: 20,
              latency_ms: 140,
              jitter_ms: 15,
              speed_mbps: 25,
              speed_score: 72,
              health_score: 74,
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

    const m4 = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/bootstrap', {
        method: 'GET',
        headers: {
          'X-Telegram-Init-Data': initData,
          'If-None-Match': miniEtag2,
        },
      }),
      env
    );
    assert.equal(m4.status, 200);
    const m4Body = (await m4.json()) as any;
    assert.notEqual(m4Body.sync.nodes_rev, m3Body.sync.nodes_rev);
  } finally {
    clearSnapshotRamCacheForTests(env.DB);
    setEdgeCacheOverrideForTests(undefined);
    d1.sqlite.close();
  }
});

test('Edge-cached GET /api/v1/client/locations & /api/v1/client/version return 304 HIT-304 on If-None-Match', async () => {
  resetAllWorkerCachesForTests();
  resetEdgeOriginForTests();
  const d1 = new InstrumentedD1();
  const kv = new MockKv();
  const edge = new InMemoryEdgeCache();
  setEdgeCacheOverrideForTests(edge as unknown as Cache);
  seedFixture(d1.sqlite);

  const env: Env = {
    DB: d1 as unknown as D1Database,
    SENTRA_KV: kv as unknown as KVNamespace,
  };

  try {
    const loc1 = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/client/locations'),
      env
    );
    assert.equal(loc1.status, 200);
    assert.equal(loc1.headers.get('X-Sentra-Cache'), 'MISS');
    const locEtag = loc1.headers.get('ETag')!;
    assert.ok(locEtag);

    d1.resetCounters();
    const loc2 = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/client/locations', {
        headers: { 'If-None-Match': locEtag },
      }),
      env
    );
    assert.equal(loc2.status, 304);
    assert.equal(loc2.headers.get('X-Sentra-Cache'), 'HIT-304');
    assert.equal(d1.readCount, 0);

    const ver1 = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/client/version'),
      env
    );
    assert.equal(ver1.status, 200);
    const verEtag = ver1.headers.get('ETag')!;
    assert.ok(verEtag);

    d1.resetCounters();
    const ver2 = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/client/version', {
        headers: { 'If-None-Match': verEtag },
      }),
      env
    );
    assert.equal(ver2.status, 304);
    assert.equal(ver2.headers.get('X-Sentra-Cache'), 'HIT-304');
    assert.equal(d1.readCount, 0);
  } finally {
    clearSnapshotRamCacheForTests(env.DB);
    setEdgeCacheOverrideForTests(undefined);
    d1.sqlite.close();
  }
});

test('Legacy subscriptions table without account_rev auto-heals via ensureSchemaColumns and bumpSubscriptionAccountRev', async () => {
  resetAllWorkerCachesForTests();
  const legacySql = SCHEMA_SQL.replace(/account_rev\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+1,\s*/i, '');
  const d1 = new InstrumentedD1(legacySql);
  d1.sqlite
    .prepare(
      `INSERT INTO users (id, user_uuid, telegram_id, first_name, role, status)
       VALUES (1, 'u-legacy-1', 990011, 'Legacy', 'user', 'active')`
    )
    .run();
  d1.sqlite
    .prepare(
      `INSERT INTO subscriptions (id, user_id, tier, plan_tier, connect_code, token, status, traffic_limit_bytes, max_concurrent_devices, expires_at)
       VALUES (1, 1, 'Sentra Lite', 'free', '11223344', 'tok-legacy-1', 'active', 0, 2, '2030-01-01T00:00:00Z')`
    )
    .run();

  try {
    await ensureSchemaColumns(d1 as unknown as D1Database);
    const bumped = await bumpSubscriptionAccountRev(d1 as unknown as D1Database, 1);
    assert.equal(bumped, 2);

    const resp = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/bootstrap', {
        headers: { 'X-Subscription-Token': 'tok-legacy-1' },
      }),
      { DB: d1 as unknown as D1Database }
    );
    assert.equal(resp.status, 200);
    const body = (await resp.json()) as any;
    assert.equal(body.sync.account_rev, 2);
  } finally {
    clearSnapshotRamCacheForTests(d1 as unknown as D1Database);
    d1.sqlite.close();
  }
});
