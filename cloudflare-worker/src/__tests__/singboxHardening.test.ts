import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  runSingboxCheck,
  validateNodeStage1,
  validatePlanBundlesStage2,
} from '../../../.github/scripts/quality-check.ts';
import {
  KV_KEY_ACTIVE_NODES,
  KV_KEY_COMPILED_CFG_FLOW_PLUS,
  KV_KEY_COMPILED_CFG_FREE,
  KV_KEY_COMPILED_CFG_PRO,
} from '../kvCache.ts';
import {
  parseOutboundInput,
  parseSubscriptionPayload,
  validateSingboxOutboundStrict,
} from '../outboundAnalyzer.ts';
import { routeRequest } from '../routes.ts';
import { compilePlanTierSingboxConfig } from '../singboxCompiler.ts';
import type { DonatedOutboundRow, Env } from '../types.ts';
import { resetAllWorkerCachesForTests } from '../workerCache.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER_ROOT = path.resolve(__dirname, '../..');
const SCHEMA_SQL = fs.readFileSync(path.join(WORKER_ROOT, 'schema.sql'), 'utf8');
const MIGRATION_004_SQL = fs.readFileSync(
  path.join(WORKER_ROOT, 'migrations', '004_precompiled_outbounds.sql'),
  'utf8'
);

class SqliteD1Adapter {
  sqlite: DatabaseSync;
  sqlLog: string[] = [];

  constructor(initSql = SCHEMA_SQL) {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec(initSql);
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
        self.sqlLog.push(sql);
        const row = self.sqlite.prepare(sql).get(...(params as any[]));
        return (row ?? null) as T;
      },
      async all<T = unknown>() {
        self.sqlLog.push(sql);
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
        self.sqlLog.push(sql);
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

class MemoryKv {
  store = new Map<string, string>();
  gets: string[] = [];
  puts: string[] = [];
  deletes: string[] = [];

  async get(key: string, type?: string): Promise<unknown> {
    this.gets.push(key);
    const val = this.store.get(key);
    if (val === undefined) return null;
    return type === 'json' ? JSON.parse(val) : val;
  }

  async put(key: string, value: string): Promise<void> {
    this.puts.push(key);
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.deletes.push(key);
    this.store.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Layer 1: Strict Whitelist & sing-box 1.14+ Canonicalization
// ---------------------------------------------------------------------------

test('Layer 1: strict whitelist accepts all 6 allowed protocols and 5 allowed transports', async () => {
  const vlessReality = await parseOutboundInput(
    'vless://11111111-2222-3333-4444-555555555555@203.0.113.10:443?security=reality&sni=www.microsoft.com&pbk=AbCdEf1234567890&sid=a1b2&type=tcp#DE-VLESS'
  );
  assert.equal(vlessReality.protocol, 'vless');
  assert.ok(vlessReality.compiled_outbound_json);
  assert.equal(JSON.parse(vlessReality.compiled_outbound_json).type, 'vless');

  const vlessWs = await parseOutboundInput(
    'vless://11111111-2222-3333-4444-555555555555@203.0.113.11:443?security=tls&sni=cdn.example.com&type=ws&path=/ws&host=cdn.example.com#NL-WS'
  );
  assert.equal(vlessWs.config_json.transport?.type, 'ws');

  const vlessGrpc = await parseOutboundInput(
    'vless://11111111-2222-3333-4444-555555555555@203.0.113.12:443?security=tls&sni=grpc.example.com&type=grpc&serviceName=tun#FI-GRPC'
  );
  assert.equal(vlessGrpc.config_json.transport?.type, 'grpc');

  const vlessHttpUpgrade = await parseOutboundInput(
    'vless://11111111-2222-3333-4444-555555555555@203.0.113.13:443?security=tls&sni=up.example.com&type=httpupgrade&path=/up#SE-UP'
  );
  assert.equal(vlessHttpUpgrade.config_json.transport?.type, 'httpupgrade');

  const vlessH2 = await parseOutboundInput(
    'vless://11111111-2222-3333-4444-555555555555@203.0.113.14:443?security=tls&sni=h2.example.com&type=h2&path=/h2#FR-H2'
  );
  assert.equal(vlessH2.config_json.transport?.type, 'http');

  const vmessJson = Buffer.from(
    JSON.stringify({
      v: '2',
      ps: 'US-VMess',
      add: '203.0.113.15',
      port: '443',
      id: '22222222-2222-3333-4444-555555555555',
      aid: '0',
      scy: 'auto',
      net: 'ws',
      tls: 'tls',
      sni: 'vm.example.com',
      path: '/vm',
    }),
    'utf8'
  ).toString('base64');
  const vmess = await parseOutboundInput(`vmess://${vmessJson}`);
  assert.equal(vmess.protocol, 'vmess');

  const trojan = await parseOutboundInput(
    'trojan://supersecret@203.0.113.16:443?sni=tr.example.com&type=tcp#GB-Trojan'
  );
  assert.equal(trojan.protocol, 'trojan');

  const hy2 = await parseOutboundInput(
    'hy2://hy2pass@203.0.113.17:443?sni=hy2.example.com#CA-HY2'
  );
  assert.equal(hy2.protocol, 'hysteria2');

  const tuic = await parseOutboundInput(
    'tuic://33333333-2222-3333-4444-555555555555:tuicpass@203.0.113.18:443?sni=tuic.example.com#JP-TUIC'
  );
  assert.equal(tuic.protocol, 'tuic');

  const ssCreds = Buffer.from('chacha20-ietf-poly1305:mysecretpass', 'utf8').toString('base64');
  const ss = await parseOutboundInput(`ss://${ssCreds}@203.0.113.19:8388#SG-SS`);
  assert.equal(ss.protocol, 'shadowsocks');
});

test('Layer 1: explicitly rejects xhttp, splithttp, kcp, mkcp, quic, wireguard, and incomplete Reality with Persian errors', async () => {
  const incompatibleLinks = [
    {
      label: 'xhttp',
      uri: 'vless://11111111-2222-3333-4444-555555555555@203.0.113.20:443?security=tls&sni=x.example.com&type=xhttp#XHTTP',
      pattern: /xhttp|سازگار نیست/,
    },
    {
      label: 'splithttp',
      uri: 'vless://11111111-2222-3333-4444-555555555555@203.0.113.21:443?security=tls&sni=x.example.com&type=splithttp#SPLIT',
      pattern: /splithttp|سازگار نیست/,
    },
    {
      label: 'kcp',
      uri: 'vless://11111111-2222-3333-4444-555555555555@203.0.113.22:443?security=tls&sni=x.example.com&type=kcp#KCP',
      pattern: /kcp|سازگار نیست/,
    },
    {
      label: 'mkcp',
      uri: 'vless://11111111-2222-3333-4444-555555555555@203.0.113.23:443?security=tls&sni=x.example.com&type=mkcp#MKCP',
      pattern: /mkcp|سازگار نیست/,
    },
    {
      label: 'quic',
      uri: 'vless://11111111-2222-3333-4444-555555555555@203.0.113.24:443?security=tls&sni=x.example.com&type=quic#QUIC',
      pattern: /quic|سازگار نیست/,
    },
    {
      label: 'wireguard',
      uri: 'wireguard://privkey@203.0.113.25:51820#WG',
      pattern: /پشتیبانی نمی‌شود|لیست سفید/,
    },
    {
      label: 'Reality missing pbk',
      uri: 'vless://11111111-2222-3333-4444-555555555555@203.0.113.26:443?security=reality&sni=www.microsoft.com#NoPbk',
      pattern: /کلید عمومی|pbk/,
    },
    {
      label: 'Reality missing sni',
      uri: 'vless://11111111-2222-3333-4444-555555555555@203.0.113.27:443?security=reality&pbk=AbCdEf12345#NoSni',
      pattern: /SNI|دامنه/,
    },
    {
      label: 'Reality IP as sni',
      uri: 'vless://11111111-2222-3333-4444-555555555555@203.0.113.28:443?security=reality&sni=1.1.1.1&pbk=AbCdEf12345#IpSni',
      pattern: /SNI|دامنه/,
    },
  ];

  for (const tc of incompatibleLinks) {
    await assert.rejects(
      () => parseOutboundInput(tc.uri),
      tc.pattern,
      `Expected ${tc.label} to be rejected with Persian message`
    );
  }

  // Raw JSON outbound with Xray-only / deprecated fields or unsupported transport
  const badJson = validateSingboxOutboundStrict({
    type: 'vless',
    tag: 'bad-xhttp',
    server: '203.0.113.30',
    server_port: 443,
    uuid: '11111111-2222-3333-4444-555555555555',
    transport: { type: 'xhttp', path: '/x' },
  });
  assert.equal(badJson.ok, false);

  // Batch subscription collects Persian rejectionReasons for skipped nodes
  const batch = await parseSubscriptionPayload(
    [
      'vless://11111111-2222-3333-4444-555555555555@203.0.113.40:443?security=reality&sni=www.microsoft.com&pbk=GoodKey123#Good',
      'vless://11111111-2222-3333-4444-555555555555@203.0.113.41:443?security=tls&sni=x.com&type=xhttp#BadXhttp',
    ].join('\n')
  );
  assert.equal(batch.nodes.length, 1);
  assert.equal(batch.skipped, 1);
  assert.equal(batch.rejectionReasons.length, 1);
  assert.match(batch.rejectionReasons[0], /xhttp|سازگار نیست/);
});

// ---------------------------------------------------------------------------
// Layer 2: Migration 004 & Per-Plan Precompiled KV Cache (<1ms + ETag 304)
// ---------------------------------------------------------------------------

test('Layer 2: Migration 004 upgrades pre-004 donated_outbounds cleanly, preserves rows, and allows quarantined status', () => {
  const pre004Schema = `
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_uuid TEXT NOT NULL UNIQUE
    );
    CREATE TABLE donated_outbounds (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      donor_user_id           INTEGER,
      tag                     TEXT NOT NULL,
      protocol                TEXT NOT NULL,
      server_address          TEXT NOT NULL,
      server_port             INTEGER NOT NULL,
      config_json             TEXT NOT NULL,
      latency_ms              INTEGER NOT NULL DEFAULT 9999,
      speed_mbps              REAL NOT NULL DEFAULT 0.0,
      assigned_tier           TEXT NOT NULL DEFAULT 'web_browsing'
                              CHECK(assigned_tier IN ('web_browsing', 'download', 'gaming', 'static_ip', 'rejected')),
      health_score            INTEGER NOT NULL DEFAULT 100,
      status                  TEXT NOT NULL DEFAULT 'active'
                              CHECK(status IN ('pending', 'active', 'inactive', 'rejected')),
      fail_count              INTEGER NOT NULL DEFAULT 0,
      reward_granted          INTEGER NOT NULL DEFAULT 0,
      raw_link                TEXT,
      rejection_reason        TEXT,
      declared_or_detected_gb INTEGER NOT NULL DEFAULT 0,
      bytes_served            INTEGER NOT NULL DEFAULT 0,
      first_used_at           TEXT,
      monthly_reward_granted  INTEGER NOT NULL DEFAULT 0,
      fingerprint_sha256      TEXT,
      offline_since           TEXT,
      clawback_executed       INTEGER NOT NULL DEFAULT 0,
      is_official             INTEGER NOT NULL DEFAULT 0,
      label                   TEXT,
      country_code            TEXT NOT NULL DEFAULT 'XX',
      country_name            TEXT NOT NULL DEFAULT 'جهانی 🌍',
      allow_web               INTEGER NOT NULL DEFAULT 1,
      allow_download          INTEGER NOT NULL DEFAULT 1,
      allow_gaming            INTEGER NOT NULL DEFAULT 0,
      allow_static_ip         INTEGER NOT NULL DEFAULT 0,
      gemini_ok               INTEGER NOT NULL DEFAULT 0,
      trading_safe            INTEGER NOT NULL DEFAULT 0,
      speed_score             INTEGER NOT NULL DEFAULT 50,
      jitter_ms               INTEGER NOT NULL DEFAULT 0,
      last_online_at          TEXT,
      allocation_mode         TEXT NOT NULL DEFAULT 'auto',
      last_checked_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (donor_user_id) REFERENCES users(id) ON DELETE SET NULL
    );
  `;

  const db = new DatabaseSync(':memory:');
  try {
    db.exec(pre004Schema);
    db.prepare(`INSERT INTO users (id, user_uuid) VALUES (1, 'u-mig-1')`).run();
    const cfg = JSON.stringify({
      type: 'vless',
      tag: 'Legacy-Node',
      server: '198.51.100.77',
      server_port: 443,
      uuid: '11111111-2222-3333-4444-555555555555',
    });
    db.prepare(
      `INSERT INTO donated_outbounds (id, donor_user_id, tag, protocol, server_address, server_port, config_json, status, fingerprint_sha256)
       VALUES (5, 1, 'Legacy-Node', 'vless', '198.51.100.77', 443, ?, 'active', 'fp-legacy-5')`
    ).run(cfg);

    // Apply 004 migration
    db.exec(MIGRATION_004_SQL);

    const migrated = db
      .prepare(`SELECT id, config_json, compiled_outbound_json, validation_error, status FROM donated_outbounds WHERE id = 5`)
      .get() as Record<string, unknown>;
    assert.equal(migrated.id, 5);
    assert.equal(migrated.compiled_outbound_json, cfg, 'Existing config_json must backfill compiled_outbound_json');
    assert.equal(migrated.validation_error, null);

    // Confirm 'quarantined' status & validation_error now succeed
    db.prepare(
      `UPDATE donated_outbounds SET status = 'quarantined', validation_error = 'sing-box check failed: invalid transport' WHERE id = 5`
    ).run();
    const updated = db
      .prepare(`SELECT status, validation_error FROM donated_outbounds WHERE id = 5`)
      .get() as Record<string, unknown>;
    assert.equal(updated.status, 'quarantined');
    assert.equal(updated.validation_error, 'sing-box check failed: invalid transport');
  } finally {
    db.close();
  }
});

test('Layer 2: per-plan precompiled KV caches serve /api/v1/client/connect & /config without raw-link re-parsing and honor ETag 304', async () => {
  resetAllWorkerCachesForTests();
  const d1 = new SqliteD1Adapter();
  const kv = new MemoryKv();

  try {
    d1.sqlite
      .prepare(
        `INSERT INTO users (id, user_uuid, telegram_id, username, first_name, role, status)
         VALUES (1, 'u-plan-1', 5551001, 'pro_user', 'Pro', 'user', 'active')`
      )
      .run();
    d1.sqlite
      .prepare(
        `INSERT INTO subscriptions (id, user_id, tier, plan_tier, connect_code, token, status, traffic_limit_bytes, max_concurrent_devices, expires_at)
         VALUES (1, 1, 'Sentra Pro', 'pro', '44556677', 'tok-plan-pro-1', 'active', 53687091200, 3, '2030-01-01T00:00:00Z')`
      )
      .run();

    const precompiledJson = JSON.stringify({
      type: 'vless',
      tag: 'DE-Precomp',
      server: '198.51.100.88',
      server_port: 443,
      uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      tls: { enabled: true, server_name: 'edge.example.com' },
    });

    // Note: intentionally give raw_link an INVALID value to prove /connect NEVER re-parses raw_link!
    d1.sqlite
      .prepare(
        `INSERT INTO donated_outbounds (
           id, tag, protocol, server_address, server_port, config_json, compiled_outbound_json,
           latency_ms, speed_mbps, speed_score, assigned_tier, health_score, status, raw_link,
           fingerprint_sha256, is_official, country_code, country_name, allow_web, allow_download, allow_gaming, allow_static_ip
         ) VALUES (
           21, 'DE-Precomp', 'vless', '198.51.100.88', 443, ?, ?,
           35, 40.0, 92, 'web_browsing', 98, 'active', 'UNPARSEABLE_RAW_LINK_MUST_BE_IGNORED',
           'fp-precomp-21', 1, 'DE', 'Germany 🇩🇪', 1, 1, 1, 1
         )`
      )
      .run(precompiledJson, precompiledJson);

    // Also insert a quarantined node to prove it is NEVER included in compiled configs
    d1.sqlite
      .prepare(
        `INSERT INTO donated_outbounds (
           id, tag, protocol, server_address, server_port, config_json, compiled_outbound_json,
           validation_error, latency_ms, speed_mbps, speed_score, assigned_tier, health_score, status,
           fingerprint_sha256, is_official, country_code, country_name, allow_web, allow_download
         ) VALUES (
           22, 'BAD-Quarantined', 'vless', '198.51.100.99', 443, ?, ?,
           'xhttp unsupported', 20, 50.0, 95, 'web_browsing', 99, 'quarantined',
           'fp-quar-22', 1, 'US', 'USA', 1, 1
         )`
      )
      .run(precompiledJson, precompiledJson);

    const env: Env = {
      DB: d1 as unknown as D1Database,
      SENTRA_KV: kv as unknown as KVNamespace,
    };

    const res1 = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/client/connect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sentra-Client': 'SentraVPN/1.0.0',
        },
        body: JSON.stringify({ connect_code: '44556677', mode: 'web_browsing' }),
      }),
      env
    );

    assert.equal(res1.status, 200);
    const etag = res1.headers.get('ETag');
    assert.ok(etag, 'Response must include ETag');
    assert.ok(kv.store.has(KV_KEY_COMPILED_CFG_PRO), 'Pro compiled plan config must be stored in KV');

    const body1 = (await res1.json()) as {
      config: { outbounds: Array<{ tag: string; type: string; server?: string }> };
    };
    const proxyTags = body1.config.outbounds.map((o) => o.tag);
    assert.ok(
      body1.config.outbounds.some((o) => o.server === '198.51.100.88'),
      'Precompiled active outbound must be present'
    );
    assert.equal(
      proxyTags.some((t) => t.includes('BAD-Quarantined')),
      false,
      'Quarantined node must never appear in compiled config'
    );

    // Cold isolate with If-None-Match -> 304 Not Modified straight from L2 KV!
    resetAllWorkerCachesForTests();
    d1.sqlLog = [];
    const res304 = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/client/connect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sentra-Client': 'SentraVPN/1.0.0',
          'If-None-Match': etag!,
        },
        body: JSON.stringify({ connect_code: '44556677', mode: 'web_browsing' }),
      }),
      env
    );
    assert.equal(res304.status, 304);
    assert.equal(
      d1.sqlLog.some((q) => q.includes('donated_outbounds')),
      false,
      '304 ETag hit must NOT read donated_outbounds from D1'
    );
  } finally {
    d1.sqlite.close();
  }
});

// ---------------------------------------------------------------------------
// Layer 3: QualityEngine 2-Stage sing-box check + Quarantine & Smart Alerting
// ---------------------------------------------------------------------------

test('Layer 3: QualityEngine Stage-1 & Stage-2 sing-box check catches errors/warnings and validates all 3 plan tiers', async () => {
  const goodOutbound = {
    type: 'vless',
    tag: 'DE-Good',
    server: '198.51.100.55',
    server_port: 443,
    uuid: '11111111-2222-3333-4444-555555555555',
    tls: {
      enabled: true,
      server_name: 'www.microsoft.com',
      utls: { enabled: true, fingerprint: 'chrome' },
      reality: { enabled: true, public_key: 'AbCdEf123456', short_id: 'a1b2' },
    },
  };

  // Stage 1 passes when executor exits cleanly with no warnings
  const passRes = await validateNodeStage1(goodOutbound, {
    singboxAvailable: true,
    executor: async () => ({ stdout: '', stderr: '' }),
  });
  assert.equal(passRes.ok, true);

  // Stage 1 fails when sing-box emits WARN / DEPRECATED even on exit code 0
  const warnRes = await validateNodeStage1(goodOutbound, {
    singboxAvailable: true,
    executor: async () => ({
      stdout: '',
      stderr: 'WARN[0000] legacy inbound field is deprecated in sing-box 1.14',
    }),
  });
  assert.equal(warnRes.ok, false);
  if (!warnRes.ok) {
    assert.match(warnRes.error, /deprecated|WARN/i);
  }

  // Stage 1 fails on non-zero exit code
  const errRes = await runSingboxCheck(
    { log: { level: 'warn' }, inbounds: [], outbounds: [], route: {} },
    {
      singboxAvailable: true,
      executor: async () => {
        const e = new Error('exit 1') as Error & { stderr?: string };
        e.stderr = 'FATAL[0000] decode config: unknown field "xhttp"';
        throw e;
      },
    }
  );
  assert.equal(errRes.ok, false);
  assert.match(errRes.error || '', /unknown field/);

  // Stage 2 checks all 3 tiers (free, pro, flow_plus)
  const healthyRows: DonatedOutboundRow[] = [
    {
      id: 101,
      donor_user_id: null,
      tag: 'DE-Good',
      protocol: 'vless',
      server_address: '198.51.100.55',
      server_port: 443,
      config_json: JSON.stringify(goodOutbound),
      compiled_outbound_json: JSON.stringify(goodOutbound),
      validation_error: null,
      latency_ms: 45,
      speed_mbps: 40,
      assigned_tier: 'web_browsing',
      health_score: 96,
      status: 'active',
      fail_count: 0,
      reward_granted: 0,
      raw_link: null,
      rejection_reason: null,
      declared_or_detected_gb: 0,
      bytes_served: 0,
      first_used_at: null,
      monthly_reward_granted: 0,
      fingerprint_sha256: 'fp-101',
      offline_since: null,
      clawback_executed: 0,
      is_official: 1,
      label: 'DE-Good',
      country_code: 'DE',
      country_name: 'Germany',
      allow_web: 1,
      allow_download: 1,
      allow_gaming: 1,
      allow_static_ip: 1,
      gemini_ok: 1,
      trading_safe: 1,
      speed_score: 90,
      jitter_ms: 5,
      last_online_at: null,
      allocation_mode: 'auto',
      last_checked_at: '',
      created_at: '',
      updated_at: '',
    },
  ];

  const bundles = await validatePlanBundlesStage2(healthyRows, {
    singboxAvailable: true,
    executor: async () => ({ stdout: '', stderr: '' }),
  });
  assert.deepEqual(
    bundles.map((b) => ({ tier: b.plan_tier, passed: b.passed, count: b.node_count })),
    [
      { tier: 'free', passed: true, count: 1 },
      { tier: 'pro', passed: true, count: 1 },
      { tier: 'flow_plus', passed: true, count: 1 },
    ]
  );

  // Also ensure compilePlanTierSingboxConfig includes all required sing-box 1.14+ top-level sections
  const compiledFree = compilePlanTierSingboxConfig([], healthyRows, 'free');
  assert.ok(Array.isArray(compiledFree.config.inbounds));
  assert.ok(Array.isArray(compiledFree.config.outbounds));
  assert.ok(compiledFree.config.route && typeof compiledFree.config.route === 'object');
});

test('Layer 3: health-report quarantines invalid nodes, logs to Turso without Telegram spam, and alerts Telegram ONLY when a plan hits 0 capacity or bundle check fails', async () => {
  resetAllWorkerCachesForTests();
  const d1 = new SqliteD1Adapter();
  const kv = new MemoryKv();

  const telegramCalls: Array<{ url: string; body: string }> = [];
  const tursoCalls: Array<{ url: string; body: string }> = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = typeof init?.body === 'string' ? init.body : '';
    if (url.includes('api.telegram.org')) {
      telegramCalls.push({ url, body });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (url.includes('turso.io')) {
      tursoCalls.push({ url, body });
      return new Response(JSON.stringify({ results: [{ type: 'ok' }] }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;

  try {
    // Configure Telegram topic routing so Telegram alerts COULD fire if triggered
    d1.sqlite
      .prepare(`INSERT INTO system_settings (key, value) VALUES ('log_group_id', '-100123456'), ('topic_logs_id', '77')`)
      .run();

    // Seed TWO active nodes covering all plan tiers
    const validCfg = JSON.stringify({
      type: 'vless',
      tag: 'Node-A',
      server: '198.51.100.10',
      server_port: 443,
      uuid: '11111111-1111-1111-1111-111111111111',
      tls: { enabled: true, server_name: 'a.example.com' },
    });
    for (const id of [1, 2]) {
      d1.sqlite
        .prepare(
          `INSERT INTO donated_outbounds (
             id, tag, protocol, server_address, server_port, config_json, compiled_outbound_json,
             latency_ms, speed_mbps, speed_score, assigned_tier, health_score, status,
             fingerprint_sha256, is_official, country_code, country_name, allow_web, allow_download, allow_gaming, allow_static_ip
           ) VALUES (
             ?, ?, 'vless', ?, 443, ?, ?,
             40, 30.0, 88, 'web_browsing', 92, 'active',
             ?, 1, 'DE', 'Germany', 1, 1, 1, 1
           )`
        )
        .run(id, `Node-${id}`, `198.51.100.${10 + id}`, validCfg, validCfg, `fp-q-${id}`);
    }

    const env: Env = {
      DB: d1 as unknown as D1Database,
      SENTRA_KV: kv as unknown as KVNamespace,
      QUALITY_ENGINE_SECRET: 'qe-hardening-secret',
      TELEGRAM_BOT_TOKEN: '123456:fake-bot-token',
      TURSO_DATABASE_URL: 'libsql://sentra-test.turso.io',
      TURSO_AUTH_TOKEN: 'turso-test-token',
    };

    const waitUntilPromises: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(p: Promise<unknown>) {
        waitUntilPromises.push(p);
      },
      passThroughOnException() {},
    } as unknown as ExecutionContext;

    // Case A: Quarantine Node 2 while Node 1 stays active & bundles pass ->
    // Turso receives quarantine log, Telegram receives ZERO spam!
    const respA = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/nodes/health-report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Quality-Secret': 'qe-hardening-secret',
        },
        body: JSON.stringify({
          results: [
            {
              outbound_id: 2,
              latency_ms: 9999,
              jitter_ms: 0,
              speed_mbps: 0,
              speed_score: 0,
              health_score: 0,
              gemini_ok: false,
              trading_safe: false,
              is_healthy: false,
              security_passed: false,
              quarantined: true,
              validation_error: 'sing-box check failed: xhttp unsupported',
            },
          ],
          bundle_checks: [
            { plan_tier: 'free', passed: true, node_count: 1, error: null },
            { plan_tier: 'pro', passed: true, node_count: 1, error: null },
            { plan_tier: 'flow_plus', passed: true, node_count: 1, error: null },
          ],
        }),
      }),
      env,
      ctx
    );
    await Promise.allSettled(waitUntilPromises);

    assert.equal(respA.status, 200);
    const node2Row = d1.sqlite
      .prepare(`SELECT status, validation_error FROM donated_outbounds WHERE id = 2`)
      .get() as Record<string, unknown>;
    assert.equal(node2Row.status, 'quarantined');
    assert.equal(node2Row.validation_error, 'sing-box check failed: xhttp unsupported');
    assert.equal(telegramCalls.length, 0, 'Routine node quarantine must NOT spam Telegram topic_logs_id');
    assert.ok(
      tursoCalls.some((c) => c.body.includes('quarantined_summary') || c.body.includes('telemetry_logs')),
      'Quarantine summary should be persisted to Turso telemetry_logs'
    );
    assert.deepEqual(kv.deletes, [
      KV_KEY_ACTIVE_NODES,
      KV_KEY_COMPILED_CFG_FREE,
      KV_KEY_COMPILED_CFG_PRO,
      KV_KEY_COMPILED_CFG_FLOW_PLUS,
    ]);

    // Case B: Quarantine the last remaining Node 1 -> plan capacity drops to 0 -> Telegram MUST alert!
    waitUntilPromises.length = 0;
    const respB = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/nodes/health-report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Quality-Secret': 'qe-hardening-secret',
        },
        body: JSON.stringify({
          results: [
            {
              outbound_id: 1,
              latency_ms: 9999,
              jitter_ms: 0,
              speed_mbps: 0,
              speed_score: 0,
              health_score: 0,
              gemini_ok: false,
              trading_safe: false,
              is_healthy: false,
              security_passed: false,
              quarantined: true,
              validation_error: 'sing-box check failed: invalid reality key',
            },
          ],
          bundle_checks: [
            { plan_tier: 'free', passed: false, node_count: 0, error: 'empty bundle' },
            { plan_tier: 'pro', passed: false, node_count: 0, error: 'empty bundle' },
            { plan_tier: 'flow_plus', passed: false, node_count: 0, error: 'empty bundle' },
          ],
        }),
      }),
      env,
      ctx
    );
    await Promise.allSettled(waitUntilPromises);

    assert.equal(respB.status, 200);
    assert.ok(
      telegramCalls.length >= 1,
      'Telegram topic_logs_id MUST receive critical alert when plan capacity hits 0 or bundle check fails'
    );
  } finally {
    globalThis.fetch = originalFetch;
    d1.sqlite.close();
  }
});
