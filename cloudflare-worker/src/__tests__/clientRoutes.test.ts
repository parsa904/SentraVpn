import assert from 'node:assert/strict';
import test from 'node:test';
import { routeRequest } from '../routes.ts';
import type { Env } from '../types.ts';

function createClientMockDb() {
  const user = {
    id: 10,
    user_uuid: 'u-10',
    telegram_id: 123456,
    username: 'ali_sentra',
    email: null,
    password_hash: null,
    first_name: 'Ali',
    last_name: null,
    role: 'user',
    status: 'active',
    auth_code: null,
    auth_code_expires_at: null,
    link_code: null,
    link_code_expires_at: null,
    outbound_reward_banned: 0,
  };

  const sub = {
    id: 20,
    user_id: 10,
    tier: 'Sentra Lite',
    token: 'sub-token-xyz-123',
    status: 'active',
    upload_bytes: 1024,
    download_bytes: 2048,
    traffic_limit_bytes: 10 * 1024 * 1024 * 1024,
    speed_limit_bps: 0,
    max_concurrent_devices: 3,
    web_browsing_used_mb: 120,
    download_used_mb: 45,
    static_ip_used_mb: 0,
    expires_at: new Date(Date.now() + 15 * 86400_000).toISOString(),
  };

  const devices: Array<{
    id: number;
    subscription_id: number;
    device_identifier: string;
    device_name: string;
    os: string;
    is_active: number;
    last_seen_at: string;
    created_at: string;
  }> = [];

  const donatedOutbounds: Array<Record<string, unknown>> = [
    {
      id: 1,
      donor_user_id: null,
      tag: 'Germany DE-1',
      label: 'Germany Fast',
      protocol: 'vless',
      server_address: '198.51.100.10',
      server_port: 443,
      assigned_tier: 'web_browsing',
      country_code: 'DE',
      country_name: 'Germany 🇩🇪',
      latency_ms: 48,
      health_score: 96,
      is_official: 1,
      status: 'active',
      raw_link: 'vless://11111111-1111-1111-1111-111111111111@198.51.100.10:443?security=tls#DE',
      fingerprint_sha256: 'fp-official-1',
      reward_granted: 0,
      rejection_reason: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
  ];

  let clientState: { personal_configs_json: string; preferences_json: string; updated_at: string } | null = null;

  return {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...params: unknown[]) {
          args = params;
          return stmt;
        },
        async first<T = unknown>() {
          if (sql.includes('FROM subscriptions WHERE token = ?')) {
            return (args[0] === sub.token ? sub : null) as T;
          }
          if (sql.includes('FROM users WHERE id = ?')) {
            return (args[0] === user.id ? user : null) as T;
          }
          if (sql.includes('FROM client_states WHERE user_id = ?')) {
            return clientState as T;
          }
          if (sql.includes('COUNT(*) AS cnt FROM donated_outbounds')) {
            return { cnt: 0 } as T;
          }
          if (sql.includes('COUNT(*) AS cnt FROM outbounds')) {
            return { cnt: 0 } as T;
          }
          if (sql.includes('SELECT id FROM donated_outbounds WHERE fingerprint_sha256 = ?')) {
            const match = donatedOutbounds.find((r) => r.fingerprint_sha256 === args[0]);
            return (match ? { id: match.id } : null) as T;
          }
          return null as T;
        },
        async all<T = unknown>() {
          if (sql.includes('FROM device_sessions')) {
            return { results: devices as T[] };
          }
          if (sql.includes('FROM donated_outbounds') && sql.includes('WHERE donor_user_id = ?')) {
            return {
              results: donatedOutbounds.filter((r) => r.donor_user_id === args[0]) as T[],
            };
          }
          if (sql.includes('FROM donated_outbounds')) {
            return {
              results: donatedOutbounds.filter((r) => r.status === 'active') as T[],
            };
          }
          return { results: [] as T[] };
        },
        async run() {
          if (sql.includes('INSERT INTO device_sessions')) {
            const devId = String(args[1]);
            const existing = devices.find((d) => d.device_identifier === devId);
            if (!existing) {
              devices.push({
                id: devices.length + 1,
                subscription_id: Number(args[0]),
                device_identifier: devId,
                device_name: String(args[2]),
                os: String(args[3]),
                is_active: 1,
                last_seen_at: new Date().toISOString(),
                created_at: new Date().toISOString(),
              });
            }
          } else if (sql.includes('DELETE FROM device_sessions')) {
            const devId = String(args[1]);
            const idx = devices.findIndex((d) => d.device_identifier === devId);
            if (idx >= 0) devices.splice(idx, 1);
          } else if (sql.includes('INSERT INTO client_states')) {
            clientState = {
              personal_configs_json: String(args[1]),
              preferences_json: String(args[2]),
              updated_at: new Date().toISOString(),
            };
          } else if (sql.includes('INSERT INTO donated_outbounds')) {
            const nextId = donatedOutbounds.length + 1;
            donatedOutbounds.push({
              id: nextId,
              donor_user_id: args[0],
              tag: args[1],
              protocol: args[2],
              server_address: args[3],
              server_port: args[4],
              config_json: args[5],
              status: args[6],
              raw_link: args[7],
              fingerprint_sha256: args[8],
              is_official: args[9],
              label: args[10],
              country_code: args[11],
              country_name: args[12],
              latency_ms: 0,
              reward_granted: 0,
              rejection_reason: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            });
            return { success: true, meta: { last_row_id: nextId } };
          }
          return { success: true, meta: { last_row_id: 1 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
}

function makeEnv(db: D1Database): Env {
  return {
    DB: db,
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_WEBHOOK_SECRET: 'test-secret',
    QUALITY_ENGINE_SECRET: 'quality-secret',
    BOT_USERNAME: 'SentraVpnBot',
    PUBLIC_BASE_URL: 'https://sentra-core.kziepr.workers.dev',
  };
}

test('GET /api/v1/client/bootstrap returns user, subscription, devices, modes, outbounds, and registers device', async () => {
  const db = createClientMockDb();
  const env = makeEnv(db);

  const req = new Request('https://sentra-core.kziepr.workers.dev/api/v1/client/bootstrap', {
    headers: {
      'X-Subscription-Token': 'sub-token-xyz-123',
      'X-Device-Id': 'win-pc-001',
      'User-Agent': 'SentraConnect/1.0.0 (Windows NT 10.0)',
    },
  });

  const resp = await routeRequest(req, env);
  assert.equal(resp.status, 200);
  const body = (await resp.json()) as Record<string, any>;
  assert.equal(body.success, true);
  assert.equal(body.bot_username, 'SentraVpnBot');
  assert.equal(body.user.username, 'ali_sentra');
  assert.equal(body.subscription.tier, 'Sentra Lite');
  assert.equal(body.devices.length, 1);
  assert.equal(body.devices[0].device_id, 'win-pc-001');
  assert.equal(body.outbounds.length, 1);
  assert.equal(body.modes.length, 4);
});

test('PUT & GET /api/v1/client/sync-state persists personal configs and preferences', async () => {
  const db = createClientMockDb();
  const env = makeEnv(db);

  const putReq = new Request('https://sentra-core.kziepr.workers.dev/api/v1/client/sync-state', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Subscription-Token': 'sub-token-xyz-123',
    },
    body: JSON.stringify({
      personal_configs: [{ id: 'p1', name: 'My Node', uri: 'vless://abc@1.1.1.1:443' }],
      preferences: { routing_mode: 'tunnel', auto_reconnect: true },
    }),
  });
  const putResp = await routeRequest(putReq, env);
  assert.equal(putResp.status, 200);

  const getReq = new Request('https://sentra-core.kziepr.workers.dev/api/v1/client/sync-state', {
    headers: { 'X-Subscription-Token': 'sub-token-xyz-123' },
  });
  const getResp = await routeRequest(getReq, env);
  assert.equal(getResp.status, 200);
  const body = (await getResp.json()) as Record<string, any>;
  assert.equal(body.personal_configs.length, 1);
  assert.equal(body.preferences.routing_mode, 'tunnel');
});

test('POST /api/v1/client/outbounds/donate and GET my-donations work end-to-end', async () => {
  const db = createClientMockDb();
  const env = makeEnv(db);

  const donateReq = new Request('https://sentra-core.kziepr.workers.dev/api/v1/client/outbounds/donate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Subscription-Token': 'sub-token-xyz-123',
    },
    body: JSON.stringify({
      uri: 'vless://22222222-2222-2222-2222-222222222222@203.0.113.55:443?security=tls&sni=example.com#NL-Fast',
      name: 'NL Community',
    }),
  });
  const donateResp = await routeRequest(donateReq, env);
  assert.equal(donateResp.status, 201);

  const listReq = new Request('https://sentra-core.kziepr.workers.dev/api/v1/client/outbounds/my-donations', {
    headers: { 'X-Subscription-Token': 'sub-token-xyz-123' },
  });
  const listResp = await routeRequest(listReq, env);
  assert.equal(listResp.status, 200);
  const listBody = (await listResp.json()) as Record<string, any>;
  assert.equal(listBody.donations.length, 1);
  assert.equal(listBody.donations[0].name, 'NL Community');
});

test('GET /api/v1/client/version returns exact Android and Windows release filenames', async () => {
  const db = createClientMockDb();
  const env = makeEnv(db);

  const resp = await routeRequest(
    new Request('https://sentra-core.kziepr.workers.dev/api/v1/client/version'),
    env
  );
  assert.equal(resp.status, 200);
  const body = (await resp.json()) as Record<string, any>;
  assert.equal(body.success, true);
  assert.ok(body.downloads.android_universal.endsWith('SentraVPN-Android-Universal.apk'));
  assert.ok(body.downloads.windows_setup_x64.endsWith('SentraVPN-Windows-Setup-x64.exe'));
  assert.ok(body.downloads.windows_portable_x64.endsWith('SentraVPN-Windows-Portable-x64.zip'));
});
