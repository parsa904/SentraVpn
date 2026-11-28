import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { routeRequest } from '../routes.ts';
import { handleTelegramWebhook } from '../telegramWebhook.ts';
import { resetAllWorkerCachesForTests } from '../workerCache.ts';
import {
  filterAllowedSublinkNodes,
  isAllowedSubscriptionContentType,
  readResponseTextWithLimit,
  validatePublicSubscriptionUrl,
} from '../../../.github/scripts/quality-check.ts';
import type { Env } from '../types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER_ROOT = path.resolve(__dirname, '../..');
const SCHEMA_SQL = fs.readFileSync(path.join(WORKER_ROOT, 'schema.sql'), 'utf8');
const MIGRATION_001 = fs.readFileSync(
  path.join(WORKER_ROOT, 'migrations/0001_initial_schema.sql'),
  'utf8'
);
const MIGRATION_002 = fs.readFileSync(
  path.join(WORKER_ROOT, 'migrations/002_add_indexes.sql'),
  'utf8'
);
const MIGRATION_003 = fs.readFileSync(
  path.join(WORKER_ROOT, 'migrations/003_plans_and_8digit_code.sql'),
  'utf8'
);

function createSqliteD1Adapter(initSql: string = SCHEMA_SQL): {
  db: D1Database;
  sqlite: DatabaseSync;
} {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(initSql);

  const db = {
    prepare(query: string) {
      let bound: unknown[] = [];
      const stmtObj = {
        bind(...values: unknown[]) {
          bound = values;
          return stmtObj;
        },
        async first<T = Record<string, unknown>>() {
          const row = sqlite.prepare(query).get(...(bound as never[])) as T | undefined;
          return row ?? null;
        },
        async all<T = Record<string, unknown>>() {
          const rows = sqlite.prepare(query).all(...(bound as never[])) as T[];
          return { results: rows, success: true, meta: {} };
        },
        async run() {
          const res = sqlite.prepare(query).run(...(bound as never[]));
          return {
            results: [],
            success: true,
            meta: {
              last_row_id: Number(res.lastInsertRowid || 0),
              changes: Number(res.changes || 0),
            },
          };
        },
      };
      return stmtObj;
    },
    async batch(statements: Array<{ all?: () => Promise<unknown>; run?: () => Promise<unknown> }>) {
      const results = [];
      for (const s of statements) {
        if (typeof s.all === 'function') {
          results.push(await s.all());
        } else if (typeof s.run === 'function') {
          results.push(await s.run());
        }
      }
      return results;
    },
  } as unknown as D1Database;

  return { db, sqlite };
}

test('Migration 003 applies cleanly on existing D1 schema and seeds quotas, connect_code index, and app_release_files', () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec(MIGRATION_001);
    sqlite.exec(MIGRATION_002);

    // Seed pre-003 rows to verify backfill
    sqlite
      .prepare(
        `INSERT INTO users (user_uuid, telegram_id, first_name, role, status)
         VALUES ('u-mig-1', 1001, 'LegacyPro', 'user', 'active')`
      )
      .run();
    const uRow = sqlite.prepare("SELECT id FROM users WHERE user_uuid = 'u-mig-1'").get() as {
      id: number;
    };
    sqlite
      .prepare(
        `INSERT INTO subscriptions (user_id, tier, token, status, expires_at)
         VALUES (?, 'Sentra Pro', 'tok_legacy_pro', 'active', '2027-01-01T00:00:00Z')`
      )
      .run(uRow.id);
    sqlite
      .prepare(
        `INSERT INTO subscription_sources (category, sub_url, tag)
         VALUES ('web_browsing', 'https://example.com/legacy-admin-sub.txt', 'Legacy Admin Sub')`
      )
      .run();

    // Apply 003 migration
    sqlite.exec(MIGRATION_003);

    const sub = sqlite
      .prepare(
        'SELECT plan_tier, connect_code, web_used_bytes, download_used_bytes, special_quota_bytes, special_used_bytes, has_used_special_trial FROM subscriptions WHERE token = ?'
      )
      .get('tok_legacy_pro') as Record<string, unknown>;
    assert.equal(sub.plan_tier, 'pro');
    assert.equal(sub.web_used_bytes, 0);
    assert.equal(sub.download_used_bytes, 0);
    assert.equal(sub.special_used_bytes, 0);
    assert.equal(sub.has_used_special_trial, 0);

    const src = sqlite
      .prepare('SELECT status, submitted_by_user_id FROM subscription_sources LIMIT 1')
      .get() as { status: string; submitted_by_user_id: number | null };
    assert.equal(src.status, 'active');
    assert.equal(src.submitted_by_user_id, null);

    const webSetting = sqlite
      .prepare("SELECT value FROM system_settings WHERE key = 'free_web_quota_gb'")
      .get() as { value: string };
    const dlSetting = sqlite
      .prepare("SELECT value FROM system_settings WHERE key = 'free_download_quota_gb'")
      .get() as { value: string };
    assert.equal(webSetting.value, '2');
    assert.equal(dlSetting.value, '3');

    // Verify app_release_files table exists and works
    sqlite
      .prepare(
        `INSERT INTO app_release_files (platform, version, github_url, telegram_file_id)
         VALUES ('android', 'v1.0.0', 'https://github.com/parsa904/sentravpn/releases/latest', 'FILE_123')`
      )
      .run();
    const rel = sqlite
      .prepare("SELECT version, telegram_file_id FROM app_release_files WHERE platform = 'android'")
      .get() as { version: string; telegram_file_id: string };
    assert.equal(rel.version, 'v1.0.0');
    assert.equal(rel.telegram_file_id, 'FILE_123');
  } finally {
    sqlite.close();
  }
});

test('Public /sub/* routes return 403; /api/v1/client/connect & /config enforce X-Sentra-Client, block V2Ray/browser UAs, and accept 8-digit connect_code', async () => {
  resetAllWorkerCachesForTests();
  const { db, sqlite } = createSqliteD1Adapter();
  try {
    sqlite
      .prepare(
        `INSERT INTO users (user_uuid, telegram_id, username, first_name, role, status)
         VALUES ('u-code-1', 777001, 'codeuser', 'CodeUser', 'user', 'active')`
      )
      .run();
    const uRow = sqlite.prepare("SELECT id FROM users WHERE user_uuid = 'u-code-1'").get() as {
      id: number;
    };
    sqlite
      .prepare(
        `INSERT INTO subscriptions (user_id, tier, plan_tier, connect_code, token, status, expires_at)
         VALUES (?, 'Sentra Lite', 'free', '48291037', 'tok_code_user_1', 'active', '2027-12-31T00:00:00Z')`
      )
      .run(uRow.id);
    sqlite
      .prepare(
        `INSERT INTO donated_outbounds (
           tag, protocol, server_address, server_port, config_json,
           status, fingerprint_sha256, is_official, country_code, country_name,
           allow_web, allow_download, latency_ms, health_score
         ) VALUES (
           'DE-CodeNode', 'vless', '198.51.100.44', 443,
           '{"type":"vless","server":"198.51.100.44","server_port":443,"uuid":"11111111-1111-4111-8111-111111111111"}',
           'active', 'fp-code-de-1', 1, 'DE', 'Germany 🇩🇪', 1, 1, 50, 95
         )`
      )
      .run();

    const env = { DB: db } as Env;

    // 1. /sub/* and /api/v1/sub/* permanently blocked with 403
    const sub1 = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/sub/tok_code_user_1'),
      env
    );
    assert.equal(sub1.status, 403);
    const sub2 = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/sub/tok_code_user_1?format=singbox'),
      env
    );
    assert.equal(sub2.status, 403);

    // 2. Missing X-Sentra-Client -> 403
    const noHdr = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/client/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connect_code: '48291037' }),
      }),
      env
    );
    assert.equal(noHdr.status, 403);

    // 3. Blocked V2Ray / Clash / CLI User-Agents -> 403 even with X-Sentra-Client
    for (const ua of ['v2rayN/6.39', 'ClashMeta/1.18', 'Hiddify/2.0', 'curl/8.4.0']) {
      const blockedUa = await routeRequest(
        new Request('https://sentra-core.kziepr.workers.dev/api/v1/client/config', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Sentra-Client': 'SentraVPN/1.0.0',
            'User-Agent': ua,
          },
          body: JSON.stringify({ connect_code: '48291037' }),
        }),
        env
      );
      assert.equal(blockedUa.status, 403, `Expected 403 for User-Agent: ${ua}`);
    }

    // 3b. Raw browser request lacking X-Sentra-Client -> 403
    const rawBrowser = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/client/config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0',
        },
        body: JSON.stringify({ connect_code: '48291037' }),
      }),
      env
    );
    assert.equal(rawBrowser.status, 403, 'Expected 403 for raw browser without X-Sentra-Client');

    // 4. Valid SentraVPN client + 8-digit connect_code -> 200 with sing-box config
    const okCfg = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/client/connect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sentra-Client': 'SentraVPN/1.0.0',
          'User-Agent': 'SentraVPN-Desktop/1.0.0',
        },
        body: JSON.stringify({ connect_code: '48291037', mode: 'web_browsing' }),
      }),
      env
    );
    assert.equal(okCfg.status, 200);
    const okJson = (await okCfg.json()) as {
      success: boolean;
      plan_tier: string;
      config: { outbounds: unknown[] };
    };
    assert.equal(okJson.success, true);
    assert.equal(okJson.plan_tier, 'free');
    assert.ok(Array.isArray(okJson.config.outbounds));

    // 5. POST /api/v1/auth/code-login accepts permanent 8-digit connect_code
    const loginResp = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/auth/code-login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sentra-Client': 'SentraVPN/1.0.0',
        },
        body: JSON.stringify({ connect_code: '48291037' }),
      }),
      env
    );
    assert.equal(loginResp.status, 200);
    const loginData = (await loginResp.json()) as {
      subscription: { connect_code: string; plan_tier: string; token: string };
    };
    assert.equal(loginData.subscription.connect_code, '48291037');
    assert.equal(loginData.subscription.plan_tier, 'free');
    assert.equal(loginData.subscription.token, 'tok_code_user_1');
  } finally {
    sqlite.close();
  }
});

test('Telegram Bot: Free/Pro/Flow+ account views, atomic 1GB trial double-click guard, 120k/180k upgrade, secure sublink donation, and release file delivery', async () => {
  resetAllWorkerCachesForTests();
  const { db, sqlite } = createSqliteD1Adapter();
  const originalFetch = globalThis.fetch;
  const tgCalls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const externalFetches: string[] = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith('https://api.telegram.org/')) {
      externalFetches.push(url);
      throw new Error(`Worker must NEVER fetch external user URL: ${url}`);
    }
    const method = url.split('/').pop() || '';
    const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    tgCalls.push({ method, body });
    return new Response(JSON.stringify({ ok: true, result: { message_id: tgCalls.length } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const env = {
    DB: db,
    TELEGRAM_BOT_TOKEN: '123456:TEST_TOKEN',
    ADMIN_TELEGRAM_ID: '888001',
    QUALITY_ENGINE_SECRET: 'qe-rel-secret',
  } as Env;

  const sendUpdate = async (update: Record<string, unknown>) => {
    const startIdx = tgCalls.length;
    const resp = await handleTelegramWebhook(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/telegram/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(update),
      }),
      env
    );
    assert.equal(resp.status, 200);
    return tgCalls.slice(startIdx);
  };

  try {
    const user = { id: 888002, first_name: 'Sara', username: 'sara_vpn' };
    const admin = { id: 888001, first_name: 'Admin', username: 'sentra_admin' };

    // 1. /start generates unique 8-digit connect_code and hides all V2Ray/sublink buttons
    const startCalls = await sendUpdate({
      update_id: 1,
      message: { message_id: 1, chat: { id: 888002, type: 'private' }, from: user, text: '/start' },
    });
    const subRow = sqlite
      .prepare('SELECT id, connect_code, plan_tier, has_used_special_trial FROM subscriptions LIMIT 1')
      .get() as { id: number; connect_code: string; plan_tier: string; has_used_special_trial: number };
    assert.match(subRow.connect_code, /^\d{8}$/);
    assert.equal(subRow.plan_tier, 'free');
    const startText = String(startCalls[0].body.text || '');
    assert.ok(startText.includes(subRow.connect_code));
    assert.equal(startText.includes('/sub/'), false);
    const kbJson = JSON.stringify(startCalls[0].body.reply_markup || {});
    assert.equal(kbJson.includes('دریافت کانفیگ'), false);
    assert.equal(kbJson.includes('دریافت لینک اشتراک'), false);

    // Link unified credentials for Sara so Account opens the full account panel
    sqlite
      .prepare('UPDATE users SET password_hash = ? WHERE telegram_id = ?')
      .run(
        'pbkdf2_sha256$15000$00112233445566778899aabbccddeeff$00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
        888002
      );

    // 2. Account view (Free) shows dynamic 2GB/3GB quotas + 1GB trial button
    const accFree = await sendUpdate({
      update_id: 2,
      message: { message_id: 2, chat: { id: 888002, type: 'private' }, from: user, text: '👤 حساب کاربری' },
    });
    const accFreeText = String(accFree[0].body.text || '');
    assert.ok(accFreeText.includes(subRow.connect_code));
    assert.ok(accFreeText.includes('سقف 2 GB'));
    assert.ok(accFreeText.includes('سقف 3 GB'));
    assert.ok(JSON.stringify(accFree[0].body.reply_markup).includes('user_activate_special_trial'));

    // 3. Activate 1GB Special Trial (no special nodes exist yet -> saved notice) + double-click guard
    const trial1 = await sendUpdate({
      update_id: 3,
      callback_query: {
        id: 'cb_trial_1',
        from: user,
        message: { message_id: 2, chat: { id: 888002, type: 'private' } },
        data: 'user_activate_special_trial',
      },
    });
    const trial1Texts = trial1.map((c) => String(c.body.text || '')).join('\n');
    assert.ok(trial1Texts.includes('ثبت و ذخیره شد'));
    const afterTrial = sqlite
      .prepare('SELECT has_used_special_trial, special_quota_bytes FROM subscriptions WHERE id = ?')
      .get(subRow.id) as { has_used_special_trial: number; special_quota_bytes: number };
    assert.equal(afterTrial.has_used_special_trial, 1);
    assert.equal(afterTrial.special_quota_bytes, 1073741824);

    // Second click must NOT re-grant or crash
    const trial2 = await sendUpdate({
      update_id: 4,
      callback_query: {
        id: 'cb_trial_2',
        from: user,
        message: { message_id: 2, chat: { id: 888002, type: 'private' } },
        data: 'user_activate_special_trial',
      },
    });
    assert.ok(trial2.some((c) => String(c.body.text || '').includes('پیش‌تر از تست رایگان')));
    // Account view no longer displays trial button
    const editCallAfterTrial = trial2.find((c) => c.method === 'editMessageText');
    assert.equal(
      JSON.stringify(editCallAfterTrial?.body.reply_markup || {}).includes('user_activate_special_trial'),
      false
    );

    // 4. Upgrade menu shows exact 2 plans (120,000 Pro / 180,000 Flow+) and approving 180k sets flow_plus
    const upgCalls = await sendUpdate({
      update_id: 5,
      message: { message_id: 3, chat: { id: 888002, type: 'private' }, from: user, text: '💎 ارتقای اشتراک' },
    });
    const upgText = String(upgCalls[0].body.text || '');
    assert.ok(upgText.includes('Sentra Pro'));
    assert.ok(upgText.includes('۱۲۰,۰۰۰ تومان'));
    assert.ok(upgText.includes('Sentra Flow+'));
    assert.ok(upgText.includes('۱۸۰,۰۰۰ تومان'));

    await sendUpdate({
      update_id: 6,
      callback_query: {
        id: 'cb_buy_flow',
        from: user,
        message: { message_id: 3, chat: { id: 888002, type: 'private' } },
        data: 'user_submit_receipt_flow',
      },
    });
    await sendUpdate({
      update_id: 7,
      message: {
        message_id: 4,
        chat: { id: 888002, type: 'private' },
        from: user,
        text: 'REF-FLOW-987654',
      },
    });
    const donRow = sqlite.prepare('SELECT id, amount FROM donations ORDER BY id DESC LIMIT 1').get() as {
      id: number;
      amount: number;
    };
    assert.equal(donRow.amount, 180000);

    await sendUpdate({
      update_id: 8,
      callback_query: {
        id: 'cb_approve_flow',
        from: admin,
        message: { message_id: 10, chat: { id: 888001, type: 'private' } },
        data: `adm_don_approve_${donRow.id}`,
      },
    });
    const flowSub = sqlite
      .prepare('SELECT plan_tier, special_quota_bytes FROM subscriptions WHERE id = ?')
      .get(subRow.id) as { plan_tier: string; special_quota_bytes: number };
    assert.equal(flowSub.plan_tier, 'flow_plus');
    assert.equal(flowSub.special_quota_bytes, 50 * 1024 * 1024 * 1024);

    // Account view for Flow+ displays ♾️ نامحدود and progress bar
    const accFlow = await sendUpdate({
      update_id: 9,
      message: { message_id: 5, chat: { id: 888002, type: 'private' }, from: user, text: '👤 حساب کاربری' },
    });
    const accFlowText = String(accFlow[0].body.text || '');
    assert.ok(accFlowText.includes('Sentra Flow+'));
    assert.ok(accFlowText.includes('♾️ نامحدود'));
    assert.ok(accFlowText.includes('░'));

    // 5. Donate menu shows exact 200GB/300GB reward note & 2 buttons; sublink security + zero worker fetch + 3/24h limit + admin approve
    const donateMenu = await sendUpdate({
      update_id: 10,
      message: { message_id: 6, chat: { id: 888002, type: 'private' }, from: user, text: '🤝 اهدای نود / سابلینک' },
    });
    const donateText = String(donateMenu[0].body.text || '');
    assert.ok(donateText.includes('۲۰۰ گیگابایت'));
    assert.ok(donateText.includes('۳۰۰ گیگابایت'));
    const donateKb = JSON.stringify(donateMenu[0].body.reply_markup);
    assert.ok(donateKb.includes('user_donate_single_node'));
    assert.ok(donateKb.includes('user_donate_sublink'));

    // Reject insecure/internal sublinks without touching external network
    for (const badUrl of [
      'http://insecure.example.com/sub.txt',
      'https://127.0.0.1/secret',
      'https://169.254.169.254/latest/meta-data',
      'https://user:pass@example.com/sub.txt',
      `https://example.com/${'a'.repeat(515)}`,
    ]) {
      await sendUpdate({
        update_id: 20,
        callback_query: {
          id: 'cb_sub_bad',
          from: user,
          message: { message_id: 6, chat: { id: 888002, type: 'private' } },
          data: 'user_donate_sublink',
        },
      });
      const resBad = await sendUpdate({
        update_id: 21,
        message: { message_id: 21, chat: { id: 888002, type: 'private' }, from: user, text: badUrl },
      });
      assert.ok(String(resBad[0].body.text || '').includes('🚫'), `Should block bad URL: ${badUrl}`);
    }

    // Submit 3 valid unique HTTPS sublinks -> saved as pending, admin notified, ZERO external fetches
    let firstSourceId = 0;
    for (let i = 1; i <= 3; i += 1) {
      await sendUpdate({
        update_id: 30 + i,
        callback_query: {
          id: `cb_sub_ok_${i}`,
          from: user,
          message: { message_id: 6, chat: { id: 888002, type: 'private' } },
          data: 'user_donate_sublink',
        },
      });
      const okSubCalls = await sendUpdate({
        update_id: 40 + i,
        message: {
          message_id: 40 + i,
          chat: { id: 888002, type: 'private' },
          from: user,
          text: `https://nodes.example.org/pool-${i}.txt`,
        },
      });
      assert.ok(okSubCalls.some((c) => c.body.chat_id === 888001 && JSON.stringify(c.body.reply_markup).includes('adm_subsrc_approve_')));
      if (i === 1) {
        const row = sqlite
          .prepare("SELECT id, status FROM subscription_sources WHERE sub_url = 'https://nodes.example.org/pool-1.txt'")
          .get() as { id: number; status: string };
        assert.equal(row.status, 'pending');
        firstSourceId = row.id;
      }
    }
    assert.equal(externalFetches.length, 0, 'Worker must NEVER fetch user-submitted sublinks');

    // 4th submission within 24h is rate-limited
    await sendUpdate({
      update_id: 50,
      callback_query: {
        id: 'cb_sub_4',
        from: user,
        message: { message_id: 6, chat: { id: 888002, type: 'private' } },
        data: 'user_donate_sublink',
      },
    });
    const rateLimitedSub = await sendUpdate({
      update_id: 51,
      message: {
        message_id: 51,
        chat: { id: 888002, type: 'private' },
        from: user,
        text: 'https://nodes.example.org/pool-4.txt',
      },
    });
    assert.ok(String(rateLimitedSub[0].body.text || '').includes('حداکثر تعداد مجاز'));

    // Admin approves first pending sublink -> status becomes 'active' and user gets notified
    const approveSubCalls = await sendUpdate({
      update_id: 52,
      callback_query: {
        id: 'cb_adm_sub_ok',
        from: admin,
        message: { message_id: 11, chat: { id: 888001, type: 'private' } },
        data: `adm_subsrc_approve_${firstSourceId}`,
      },
    });
    const approvedRow = sqlite
      .prepare('SELECT status FROM subscription_sources WHERE id = ?')
      .get(firstSourceId) as { status: string };
    assert.equal(approvedRow.status, 'active');
    assert.ok(approveSubCalls.some((c) => c.body.chat_id === 888002 && String(c.body.text || '').includes('تأیید و فعال شد')));

    // 6. Release sync API + Download App (GitHub URL buttons + Telegram sendDocument by file_id) + Admin manual upload
    const syncUnauth = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/releases/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: 'android', version: 'v2.0.0', github_url: 'https://github.com/parsa904/sentravpn/releases/download/v2.0.0/SentraVPN-Android-Universal.apk' }),
      }),
      env
    );
    assert.equal(syncUnauth.status, 401);

    const syncOk = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/releases/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Quality-Secret': 'qe-rel-secret',
        },
        body: JSON.stringify({
          platform: 'android',
          version: 'v2.0.0',
          github_url: 'https://github.com/parsa904/sentravpn/releases/download/v2.0.0/SentraVPN-Android-Universal.apk',
          telegram_file_id: 'BQAC_ANDROID_V2',
        }),
      }),
      env
    );
    assert.equal(syncOk.status, 200);

    const dlAndrCalls = await sendUpdate({
      update_id: 60,
      callback_query: {
        id: 'cb_dl_andr',
        from: user,
        message: { message_id: 7, chat: { id: 888002, type: 'private' } },
        data: 'user_dl_android',
      },
    });
    const linkMsg = dlAndrCalls.find((c) => c.method === 'sendMessage');
    const docMsg = dlAndrCalls.find((c) => c.method === 'sendDocument');
    assert.ok(linkMsg && JSON.stringify(linkMsg.body.reply_markup).includes('SentraVPN-Android-Universal.apk'));
    assert.ok(linkMsg && JSON.stringify(linkMsg.body.reply_markup).includes('SentraVPN-Android-ARMv8.apk'));
    assert.ok(docMsg && docMsg.body.document === 'BQAC_ANDROID_V2');

    // Admin manual file_id update for Windows
    await sendUpdate({
      update_id: 61,
      callback_query: {
        id: 'cb_adm_rel',
        from: admin,
        message: { message_id: 12, chat: { id: 888001, type: 'private' } },
        data: 'adm_rel_pick_windows',
      },
    });
    await sendUpdate({
      update_id: 62,
      message: {
        message_id: 62,
        chat: { id: 888001, type: 'private' },
        from: admin,
        caption: 'v2.0.1',
        document: {
          file_id: 'BQAC_WIN_MANUAL_201',
          file_unique_id: 'AQAD_WIN_201',
          file_name: 'SentraVPN-Windows-Setup-x64.exe',
        },
      },
    });
    const winRel = sqlite
      .prepare("SELECT version, telegram_file_id FROM app_release_files WHERE platform = 'windows'")
      .get() as { version: string; telegram_file_id: string };
    assert.equal(winRel.version, 'v2.0.1');
    assert.equal(winRel.telegram_file_id, 'BQAC_WIN_MANUAL_201');
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});

test('QualityEngine sublink security guards enforce HTTPS-only, 1MB stream cap, Content-Type allowlist, and protocol allowlist', async () => {
  // 1. HTTPS only & blocks private/internal IPs
  await assert.rejects(
    () => validatePublicSubscriptionUrl('http://example.com/sub.txt', async () => ({ address: '93.184.216.34' })),
    /Only HTTPS/
  );
  await assert.rejects(
    () => validatePublicSubscriptionUrl('https://internal.example.com/sub.txt', async () => ({ address: '10.0.0.5' })),
    /Blocked private/
  );
  await assert.rejects(
    () => validatePublicSubscriptionUrl('https://metadata.google.internal/computeMetadata', async () => ({ address: '169.254.169.254' })),
    /Blocked internal/
  );
  const okUrl = await validatePublicSubscriptionUrl(
    'https://public-nodes.example.org/list.txt',
    async () => ({ address: '93.184.216.34' })
  );
  assert.equal(okUrl.protocol, 'https:');

  // 2. Content-Type allowlist
  assert.equal(isAllowedSubscriptionContentType('text/plain; charset=utf-8'), true);
  assert.equal(isAllowedSubscriptionContentType('application/octet-stream'), true);
  assert.equal(isAllowedSubscriptionContentType('application/yaml'), true);
  assert.equal(isAllowedSubscriptionContentType(null), true);
  assert.equal(isAllowedSubscriptionContentType('text/html; charset=utf-8'), false);
  assert.equal(isAllowedSubscriptionContentType('image/png'), false);
  assert.equal(isAllowedSubscriptionContentType('application/zip'), false);

  // 3. 1 MB streaming size limit
  const smallResp = new Response('hello-sentra', {
    headers: { 'content-type': 'text/plain' },
  });
  assert.equal(await readResponseTextWithLimit(smallResp, 1024), 'hello-sentra');

  const bigChunk = new Uint8Array(600 * 1024);
  const oversizedStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bigChunk);
      controller.enqueue(bigChunk);
      controller.close();
    },
  });
  const bigResp = new Response(oversizedStream, {
    headers: { 'content-type': 'text/plain' },
  });
  await assert.rejects(() => readResponseTextWithLimit(bigResp, 1_048_576), /exceeds 1048576 bytes/);

  // 4. Allowed protocol filter
  const filtered = filterAllowedSublinkNodes([
    { protocol: 'vless' },
    { protocol: 'vmess' },
    { protocol: 'trojan' },
    { protocol: 'hysteria2' },
    { protocol: 'shadowsocks' },
    { protocol: 'tuic' },
    { protocol: 'http' },
    { protocol: 'socks' },
    { protocol: 'direct' },
  ]);
  assert.deepEqual(
    filtered.map((n) => n.protocol),
    ['vless', 'vmess', 'trojan', 'hysteria2', 'shadowsocks', 'tuic']
  );
});
