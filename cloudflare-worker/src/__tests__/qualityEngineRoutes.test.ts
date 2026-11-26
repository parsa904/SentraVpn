import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { routeRequest } from '../routes.ts';
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

test('GET /api/v1/nodes/active returns both donated/official nodes and subscription_sources with secret auth', async () => {
  const { db, sqlite } = createSqliteD1Adapter();
  try {
    sqlite
      .prepare(
        `INSERT INTO donated_outbounds (
           tag, protocol, server_address, server_port, config_json,
           status, fingerprint_sha256, is_official, allocation_mode
         ) VALUES ('DE-Official', 'vless', '198.51.100.10', 443, '{"type":"vless"}', 'active', 'fp_official_1', 1, 'all')`
      )
      .run();

    sqlite
      .prepare(
        `INSERT INTO subscription_sources (category, sub_url, tag, total_nodes, healthy_nodes)
         VALUES ('gaming', 'https://example.com/gaming-sub.txt', 'Gaming Sub', 10, 4)`
      )
      .run();

    const env = {
      DB: db,
      QUALITY_ENGINE_SECRET: 'qe_super_secret_123',
      PUBLIC_BASE_URL: 'https://sentra-core.kziepr.workers.dev',
    } as Env;

    // 1. Unauthorized without secret
    const unauthResp = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/nodes/active'),
      env
    );
    assert.equal(unauthResp.status, 401);

    // 2. Authorized returns both nodes and subscription_sources
    const okResp = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/nodes/active', {
        headers: { 'X-Quality-Secret': 'qe_super_secret_123' },
      }),
      env
    );
    assert.equal(okResp.status, 200);
    const body = (await okResp.json()) as {
      success: boolean;
      nodes: Array<{ id: number; tag: string; fingerprint_sha256: string }>;
      subscription_sources: Array<{ id: number; category: string; sub_url: string }>;
    };
    assert.equal(body.success, true);
    assert.equal(body.nodes.length, 1);
    assert.equal(body.nodes[0].tag, 'DE-Official');
    assert.equal(body.nodes[0].fingerprint_sha256, 'fp_official_1');
    assert.equal(body.subscription_sources.length, 1);
    assert.equal(body.subscription_sources[0].category, 'gaming');
    assert.equal(body.subscription_sources[0].sub_url, 'https://example.com/gaming-sub.txt');
  } finally {
    sqlite.close();
  }
});

test('POST /api/v1/nodes/health-report updates donated_outbounds, subscription_sources, and upserts discovered nodes', async () => {
  const { db, sqlite } = createSqliteD1Adapter();
  try {
    sqlite
      .prepare(
        `INSERT INTO donated_outbounds (
           tag, protocol, server_address, server_port, config_json,
           status, fingerprint_sha256, is_official, allocation_mode
         ) VALUES ('DE-Official', 'vless', '198.51.100.10', 443, '{"type":"vless"}', 'active', 'fp_official_1', 1, 'auto')`
      )
      .run();
    const nodeRow = sqlite
      .prepare('SELECT id FROM donated_outbounds WHERE fingerprint_sha256 = ?')
      .get('fp_official_1') as { id: number };

    sqlite
      .prepare(
        `INSERT INTO subscription_sources (category, sub_url, tag, total_nodes, healthy_nodes)
         VALUES ('gaming', 'https://example.com/gaming-sub.txt', 'Gaming Sub', 0, 0)`
      )
      .run();
    const srcRow = sqlite
      .prepare('SELECT id FROM subscription_sources WHERE sub_url = ?')
      .get('https://example.com/gaming-sub.txt') as { id: number };

    const env = {
      DB: db,
      QUALITY_ENGINE_SECRET: 'qe_super_secret_123',
      PUBLIC_BASE_URL: 'https://sentra-core.kziepr.workers.dev',
    } as Env;

    const resp = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/nodes/health-report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Quality-Secret': 'qe_super_secret_123',
        },
        body: JSON.stringify({
          checked_at: new Date().toISOString(),
          runner: 'github-actions-quality-engine',
          results: [
            {
              outbound_id: nodeRow.id,
              latency_ms: 48,
              jitter_ms: 6,
              speed_mbps: 25.4,
              speed_score: 92,
              health_score: 100,
              gemini_ok: true,
              trading_safe: true,
              is_healthy: true,
              security_passed: true,
              error_msg: null,
            },
          ],
          subscription_reports: [
            {
              source_id: srcRow.id,
              category: 'gaming',
              total_nodes: 12,
              healthy_nodes: 5,
              error_msg: null,
              discovered_nodes: [
                {
                  tag: 'Gaming-Sub-NL',
                  protocol: 'vless',
                  server_address: '203.0.113.44',
                  server_port: 443,
                  config_json: '{"type":"vless","server":"203.0.113.44","server_port":443}',
                  raw_link: 'vless://11111111-1111-4111-8111-111111111111@203.0.113.44:443?security=tls#Gaming-Sub-NL',
                  fingerprint_sha256: 'fp_sub_gaming_nl_001',
                  country_code: 'NL',
                  country_name: 'Netherlands 🇳🇱',
                  latency_ms: 55,
                  jitter_ms: 8,
                  speed_mbps: 22.1,
                  speed_score: 88,
                  health_score: 93,
                  gemini_ok: true,
                  trading_safe: false,
                },
              ],
            },
          ],
        }),
      }),
      env
    );

    assert.equal(resp.status, 200);
    const summary = (await resp.json()) as {
      success: boolean;
      updated: number;
      subscription_sources_updated: number;
      discovered_nodes_added: number;
    };
    assert.equal(summary.success, true);
    assert.equal(summary.updated, 1);
    assert.equal(summary.subscription_sources_updated, 1);
    assert.equal(summary.discovered_nodes_added, 1);

    const updatedSrc = sqlite
      .prepare('SELECT total_nodes, healthy_nodes FROM subscription_sources WHERE id = ?')
      .get(srcRow.id) as { total_nodes: number; healthy_nodes: number };
    assert.equal(updatedSrc.total_nodes, 12);
    assert.equal(updatedSrc.healthy_nodes, 5);

    const insertedSubNode = sqlite
      .prepare(
        'SELECT tag, status, is_official, allow_gaming, latency_ms FROM donated_outbounds WHERE fingerprint_sha256 = ?'
      )
      .get('fp_sub_gaming_nl_001') as {
      tag: string;
      status: string;
      is_official: number;
      allow_gaming: number;
      latency_ms: number;
    };
    assert.ok(insertedSubNode);
    assert.equal(insertedSubNode.tag, 'Gaming-Sub-NL');
    assert.equal(insertedSubNode.status, 'active');
    assert.equal(insertedSubNode.is_official, 1);
    assert.equal(insertedSubNode.allow_gaming, 1);
    assert.equal(insertedSubNode.latency_ms, 55);
  } finally {
    sqlite.close();
  }
});
