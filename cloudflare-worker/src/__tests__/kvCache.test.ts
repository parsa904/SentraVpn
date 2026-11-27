import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  KV_KEY_ACTIVE_NODES,
  KV_KEY_COMPILED_CFG_FLOW_PLUS,
  KV_KEY_COMPILED_CFG_FREE,
  KV_KEY_COMPILED_CFG_PRO,
  KV_KEY_SYSTEM_SETTINGS,
  L1_ACTIVE_NODES_TTL_MS,
  L1_SYSTEM_SETTINGS_TTL_MS,
  L2_ACTIVE_NODES_TTL_SEC,
  L2_SYSTEM_SETTINGS_TTL_SEC,
  resetKvL1CachesForTests,
} from '../kvCache.ts';
import { routeRequest } from '../routes.ts';
import {
  getTopicRoutingConfig,
  saveTopicRoute,
} from '../telegramTopics.ts';
import {
  getCachedActiveNodesPool,
  invalidateNodesCache,
  resetAllWorkerCachesForTests,
} from '../workerCache.ts';
import type { Env } from '../types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER_ROOT = path.resolve(__dirname, '../..');
const SCHEMA_SQL = fs.readFileSync(path.join(WORKER_ROOT, 'schema.sql'), 'utf8');

class InstrumentedSqliteD1 {
  sqlite: DatabaseSync;
  readCount = 0;
  writeCount = 0;
  sqlLog: string[] = [];

  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec(SCHEMA_SQL);
  }

  resetCounters() {
    this.readCount = 0;
    this.writeCount = 0;
    this.sqlLog = [];
  }

  private record(sql: string) {
    this.sqlLog.push(sql);
    const trimmed = sql.trim().toUpperCase();
    if (trimmed.startsWith('SELECT')) {
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
        if (trimmed.startsWith('SELECT')) {
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

interface MockKvPutLog {
  key: string;
  expirationTtl?: number;
}

class MockKvNamespace {
  store = new Map<string, string>();
  getCount = 0;
  putCount = 0;
  deleteCount = 0;
  puts: MockKvPutLog[] = [];
  deletes: string[] = [];
  failAll = false;

  resetCounters() {
    this.getCount = 0;
    this.putCount = 0;
    this.deleteCount = 0;
    this.puts = [];
    this.deletes = [];
  }

  async get(key: string, type?: string): Promise<unknown> {
    this.getCount += 1;
    if (this.failAll) {
      throw new Error('KV daily limit exceeded (simulated 429)');
    }
    const raw = this.store.get(key);
    if (raw === undefined) return null;
    if (type === 'json') {
      return JSON.parse(raw);
    }
    return raw;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.putCount += 1;
    this.puts.push({ key, expirationTtl: options?.expirationTtl });
    if (this.failAll) {
      throw new Error('KV write quota exceeded (simulated 429)');
    }
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.deleteCount += 1;
    this.deletes.push(key);
    if (this.failAll) {
      throw new Error('KV delete quota exceeded (simulated 429)');
    }
    this.store.delete(key);
  }
}

function seedBaseData(sqlite: DatabaseSync) {
  sqlite
    .prepare(
      `INSERT INTO users (id, user_uuid, telegram_id, username, first_name, role, status)
       VALUES (1, 'u-kv-1', 777001, 'kv_tester', 'KV', 'admin', 'active')`
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO subscriptions (id, user_id, tier, token, status, traffic_limit_bytes, max_concurrent_devices, expires_at)
       VALUES (1, 1, 'Sentra Pro', 'kv-sub-token-001', 'active', 10737418240, 3, '2030-01-01T00:00:00Z')`
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
         10, 'DE-KV-1', 'vless', '198.51.100.42', 443,
         '{"type":"vless","tag":"DE-KV-1","server":"198.51.100.42","server_port":443,"uuid":"11111111-1111-1111-1111-111111111111"}',
         45, 50.0, 90, 'web_browsing', 95,
         'active', 0, 'vless://11111111-1111-1111-1111-111111111111@198.51.100.42:443?security=tls#DE-KV-1',
         'fp-kv-10', 1, 'Germany KV', 'DE', 'Germany 🇩🇪', 1, 1, 0, 1, 1, 1, 'auto'
       )`
    )
    .run();
}

test('L1 RAM (5m) -> L2 KV (1h) -> L3 D1 flow for cache:active_nodes_v1 and cross-isolate ETag 304', async () => {
  resetAllWorkerCachesForTests();
  const d1 = new InstrumentedSqliteD1();
  const kv = new MockKvNamespace();
  seedBaseData(d1.sqlite);
  const db = d1 as unknown as D1Database;
  const kvNs = kv as unknown as KVNamespace;

  try {
    const t0 = 1_700_000_000_000;

    // 1. Cold start: L1 miss -> L2 miss -> L3 D1 load -> writes cache:active_nodes_v1 (TTL 3600)
    const snap1 = await getCachedActiveNodesPool(db, kvNs, t0);
    assert.equal(snap1.donated.length, 1);
    assert.equal(d1.readCount, 2, 'L3 loads donated_outbounds + outbounds in one batch');
    assert.equal(kv.getCount, 1);
    assert.equal(kv.putCount, 1);
    assert.equal(kv.puts[0].key, KV_KEY_ACTIVE_NODES);
    assert.equal(kv.puts[0].expirationTtl, L2_ACTIVE_NODES_TTL_SEC);

    // 2. Within 5 min L1 TTL: L1 HIT -> 0 KV reads, 0 D1 reads, 0 KV writes
    d1.resetCounters();
    kv.resetCounters();
    const snap2 = await getCachedActiveNodesPool(db, kvNs, t0 + L1_ACTIVE_NODES_TTL_MS - 1000);
    assert.equal(snap2.version, snap1.version);
    assert.equal(d1.readCount, 0);
    assert.equal(kv.getCount, 0);
    assert.equal(kv.putCount, 0);

    // 3. Simulate Worker Cold Start (clear L1 RAM only, KV still warm):
    //    L1 miss -> L2 KV HIT -> 0 D1 reads, 0 KV writes, IDENTICAL version hash!
    resetKvL1CachesForTests();
    d1.resetCounters();
    kv.resetCounters();
    const snap3 = await getCachedActiveNodesPool(db, kvNs, t0 + L1_ACTIVE_NODES_TTL_MS + 1000);
    assert.equal(snap3.version, snap1.version);
    assert.equal(d1.readCount, 0, 'L2 KV hit must perform ZERO D1 reads');
    assert.equal(kv.getCount, 1);
    assert.equal(kv.putCount, 0, 'L2 KV hit must perform ZERO KV writes');

    // 4. End-to-end /api/v1/client/config returns ETag, and after Worker Cold Start another isolate returns 304 from KV with 0 nodes D1 reads
    const env: Env = { DB: db, SENTRA_KV: kvNs };
    const r1 = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/client/config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sentra-Client': 'SentraVPN/1.0.0',
          'X-Subscription-Token': 'kv-sub-token-001',
        },
        body: JSON.stringify({ mode: 'web_browsing' }),
      }),
      env
    );
    assert.equal(r1.status, 200);
    const etag = r1.headers.get('ETag');
    assert.ok(etag);

    // Simulate cold isolate for the next user request with If-None-Match
    resetAllWorkerCachesForTests();
    d1.resetCounters();
    kv.resetCounters();
    const r2 = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/client/config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sentra-Client': 'SentraVPN/1.0.0',
          'X-Subscription-Token': 'kv-sub-token-001',
          'If-None-Match': etag!,
        },
        body: JSON.stringify({ mode: 'web_browsing' }),
      }),
      env
    );
    assert.equal(r2.status, 304);
    assert.equal(kv.getCount, 1);
    assert.equal(kv.putCount, 0);
    assert.equal(d1.writeCount, 0);
    // Only user/subscription auth touched D1; ZERO queries hit donated_outbounds or outbounds
    assert.equal(
      d1.sqlLog.some((q) => q.includes('donated_outbounds') || q.includes('FROM outbounds')),
      false,
      'Cold-start /api/v1/client/config request must load active nodes from L2 KV with ZERO node-table D1 reads'
    );
    assert.ok(kv.store.has(KV_KEY_ACTIVE_NODES));
    assert.ok(
      kv.store.has(KV_KEY_COMPILED_CFG_FREE) ||
        kv.store.has(KV_KEY_COMPILED_CFG_PRO) ||
        kv.store.has(KV_KEY_COMPILED_CFG_FLOW_PLUS),
      'Per-plan precompiled sing-box KV cache should be populated'
    );
  } finally {
    d1.sqlite.close();
  }
});

test('L1 RAM (10m) -> L2 KV (24h) -> L3 D1 flow for cache:system_settings_v1 and write-through on saveTopicRoute', async () => {
  resetAllWorkerCachesForTests();
  const d1 = new InstrumentedSqliteD1();
  const kv = new MockKvNamespace();
  const db = d1 as unknown as D1Database;
  const kvNs = kv as unknown as KVNamespace;

  try {
    // Admin binds /set_logs -> writes D1 + 1 single KV write-through (TTL 86400)
    await saveTopicRoute(db, 'logs', -100999888, 42, kvNs);
    assert.equal(kv.putCount, 1);
    assert.equal(kv.deleteCount, 0);
    assert.equal(kv.puts[0].key, KV_KEY_SYSTEM_SETTINGS);
    assert.equal(kv.puts[0].expirationTtl, L2_SYSTEM_SETTINGS_TTL_SEC);

    // Subsequent read hits L1 RAM (0 D1 reads, 0 KV reads)
    d1.resetCounters();
    kv.resetCounters();
    const cfg1 = await getTopicRoutingConfig(db, kvNs);
    assert.equal(cfg1.logGroupId, '-100999888');
    assert.equal(cfg1.topicLogsId, '42');
    assert.equal(d1.readCount, 0);
    assert.equal(kv.getCount, 0);

    // Cold isolate (L1 cleared) -> hits L2 KV (0 D1 reads, 0 KV writes)
    resetKvL1CachesForTests();
    d1.resetCounters();
    kv.resetCounters();
    const cfg2 = await getTopicRoutingConfig(db, kvNs);
    assert.equal(cfg2.logGroupId, '-100999888');
    assert.equal(cfg2.topicLogsId, '42');
    assert.equal(d1.readCount, 0);
    assert.equal(kv.getCount, 1);
    assert.equal(kv.putCount, 0);

    // Verify L1 TTL constant is 10 minutes
    assert.equal(L1_SYSTEM_SETTINGS_TTL_MS, 10 * 60_000);
  } finally {
    d1.sqlite.close();
  }
});

test('Strict Write Guard: unchanged QualityEngine health-report does ZERO KV writes, real change invalidates KV', async () => {
  resetAllWorkerCachesForTests();
  const d1 = new InstrumentedSqliteD1();
  const kv = new MockKvNamespace();
  seedBaseData(d1.sqlite);
  const db = d1 as unknown as D1Database;
  const kvNs = kv as unknown as KVNamespace;
  const env: Env = {
    DB: db,
    SENTRA_KV: kvNs,
    QUALITY_ENGINE_SECRET: 'qe-secret-123',
  };

  try {
    // Warm KV cache
    await getCachedActiveNodesPool(db, kvNs);
    assert.equal(kv.store.has(KV_KEY_ACTIVE_NODES), true);

    // 1. Unchanged health-report -> 0 D1 writes, 0 KV deletes, 0 KV puts
    d1.resetCounters();
    kv.resetCounters();
    const unchangedResp = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/nodes/health-report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Quality-Secret': 'qe-secret-123',
        },
        body: JSON.stringify({
          results: [
            {
              outbound_id: 10,
              latency_ms: 48,
              jitter_ms: 4,
              speed_mbps: 50,
              speed_score: 90,
              health_score: 95,
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
    assert.equal(unchangedResp.status, 200);
    assert.equal(d1.writeCount, 0);
    assert.equal(kv.deleteCount, 0, 'Unchanged health report must NEVER delete/write KV');
    assert.equal(kv.putCount, 0);

    // 2. Real change (health_score drops to 65) -> invalidates KV cache:active_nodes_v1
    kv.resetCounters();
    const changedResp = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/nodes/health-report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Quality-Secret': 'qe-secret-123',
        },
        body: JSON.stringify({
          results: [
            {
              outbound_id: 10,
              latency_ms: 190,
              jitter_ms: 25,
              speed_mbps: 12,
              speed_score: 65,
              health_score: 65,
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
    assert.equal(changedResp.status, 200);
    assert.equal(kv.deleteCount, 4);
    assert.deepEqual(kv.deletes, [
      KV_KEY_ACTIVE_NODES,
      KV_KEY_COMPILED_CFG_FREE,
      KV_KEY_COMPILED_CFG_PRO,
      KV_KEY_COMPILED_CFG_FLOW_PLUS,
    ]);
    assert.equal(kv.store.has(KV_KEY_ACTIVE_NODES), false);
  } finally {
    d1.sqlite.close();
  }
});

test('Graceful Fallback: missing SENTRA_KV or KV quota errors never crash and fall back to D1', async () => {
  resetAllWorkerCachesForTests();
  const d1 = new InstrumentedSqliteD1();
  const failingKv = new MockKvNamespace();
  failingKv.failAll = true;
  seedBaseData(d1.sqlite);
  const db = d1 as unknown as D1Database;
  const failingKvNs = failingKv as unknown as KVNamespace;

  try {
    // 1. Works cleanly when SENTRA_KV is undefined
    const poolNoKv = await getCachedActiveNodesPool(db, undefined);
    assert.equal(poolNoKv.donated.length, 1);

    // 2. Works cleanly when KV.get / KV.put / KV.delete ALL throw errors
    resetAllWorkerCachesForTests();
    const poolFailingKv = await getCachedActiveNodesPool(db, failingKvNs);
    assert.equal(poolFailingKv.donated.length, 1);

    // Invalidation & topic routing also survive KV failures gracefully
    await invalidateNodesCache(db, failingKvNs);
    await saveTopicRoute(db, 'support', -100111222, 99, failingKvNs);
    resetKvL1CachesForTests();
    const routing = await getTopicRoutingConfig(db, failingKvNs);
    assert.equal(routing.logGroupId, '-100111222');
    assert.equal(routing.topicSupportId, '99');

    // End-to-end HTTP request succeeds even when KV is failing
    const resp = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/client/config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sentra-Client': 'SentraVPN/1.0.0',
          'X-Subscription-Token': 'kv-sub-token-001',
        },
        body: JSON.stringify({ mode: 'web_browsing' }),
      }),
      { DB: db, SENTRA_KV: failingKvNs }
    );
    assert.equal(resp.status, 200);
  } finally {
    d1.sqlite.close();
  }
});
