import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { handleTelegramWebhook } from '../telegramWebhook.ts';
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

test('/start inserts user + subscription against real schema.sql and awaits sendMessage before 200 OK', async () => {
  const { db, sqlite } = createSqliteD1Adapter();
  const originalFetch = globalThis.fetch;
  let fetchCompletedBeforeResponse = false;
  const sentCalls: Array<{ url: string; body: Record<string, unknown> }> = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    await new Promise((r) => setTimeout(r, 15));
    const url = String(input);
    const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    sentCalls.push({ url, body });
    fetchCompletedBeforeResponse = true;
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const req = new Request('https://sentra-core.kziepr.workers.dev/api/v1/telegram/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        update_id: 101,
        message: {
          message_id: 1,
          chat: { id: 9001, type: 'private' },
          from: { id: 9001, first_name: 'Ali', username: 'ali_sentra' },
          text: '/start',
        },
      }),
    });

    const resp = await handleTelegramWebhook(req, {
      DB: db,
      TELEGRAM_BOT_TOKEN: '123456:TEST_TOKEN',
    } as Env);

    assert.equal(resp.status, 200);
    assert.equal(fetchCompletedBeforeResponse, true);
    assert.equal(sentCalls.length, 1);
    assert.ok(sentCalls[0].url.includes('/sendMessage'));
    assert.equal(sentCalls[0].body.chat_id, 9001);

    const userRow = sqlite
      .prepare('SELECT id, telegram_id, username, role, status FROM users WHERE telegram_id = ?')
      .get(9001) as { id: number; telegram_id: number; username: string; role: string; status: string };
    assert.ok(userRow);
    assert.equal(userRow.username, 'ali_sentra');
    assert.equal(userRow.status, 'active');

    const subRow = sqlite
      .prepare('SELECT user_id, tier, status, traffic_limit_bytes FROM subscriptions WHERE user_id = ?')
      .get(userRow.id) as { user_id: number; tier: string; status: string; traffic_limit_bytes: number };
    assert.ok(subRow);
    assert.equal(subRow.tier, 'Sentra Lite');
    assert.equal(subRow.status, 'active');
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});

test('logs MISSING TELEGRAM_BOT_TOKEN when bot token is empty', async () => {
  const { db, sqlite } = createSqliteD1Adapter();
  const originalError = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => logged.push(args);

  try {
    const req = new Request('https://sentra-core.kziepr.workers.dev/api/v1/telegram/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        update_id: 102,
        message: {
          message_id: 2,
          chat: { id: 9002, type: 'private' },
          from: { id: 9002, first_name: 'Sara' },
          text: '/start',
        },
      }),
    });

    const resp = await handleTelegramWebhook(req, { DB: db } as Env);
    assert.equal(resp.status, 200);
    assert.ok(
      logged.some((args) => args.some((a) => String(a).includes('MISSING TELEGRAM_BOT_TOKEN'))),
      'Expected MISSING TELEGRAM_BOT_TOKEN to be logged'
    );
  } finally {
    console.error = originalError;
    sqlite.close();
  }
});

test('logs full Telegram API error when ok: false and sends fallback error reply on D1 failure', async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const logged: unknown[][] = [];
  const sentTexts: string[] = [];

  console.error = (...args: unknown[]) => logged.push(args);
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as { text?: string };
    sentTexts.push(body.text || '');
    return new Response(
      JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }) as typeof fetch;

  const brokenDb = {
    prepare() {
      return {
        bind() {
          return this;
        },
        async first() {
          throw new Error('D1_ERROR: no such table: users');
        },
        async run() {
          throw new Error('D1_ERROR: no such table: users');
        },
      };
    },
  } as unknown as D1Database;

  try {
    const req = new Request('https://sentra-core.kziepr.workers.dev/api/v1/telegram/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        update_id: 103,
        message: {
          message_id: 3,
          chat: { id: 9003, type: 'private' },
          from: { id: 9003, first_name: 'Reza' },
          text: '/start',
        },
      }),
    });

    const resp = await handleTelegramWebhook(req, {
      DB: brokenDb,
      TELEGRAM_BOT_TOKEN: '123456:TEST_TOKEN',
    } as Env);

    assert.equal(resp.status, 200);
    assert.equal(sentTexts.length, 1);
    assert.ok(sentTexts[0].includes('خطایی در اتصال به دیتابیس'));
    assert.ok(
      logged.some((args) =>
        args.some((a) => (a instanceof Error ? a.message : JSON.stringify(a)).includes('D1_ERROR'))
      ),
      'Expected D1 error to be logged'
    );
    assert.ok(
      logged.some((args) =>
        args.some((a) =>
          (a instanceof Error ? a.message : JSON.stringify(a)).includes('Bad Request: chat not found')
        )
      ),
      'Expected Telegram API ok:false description to be logged'
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
});

test('DB role="admin" shows 🛠 پنل مدیریت in /start and opens /admin panel with nodes, subscriptions, and stats', async () => {
  const { db, sqlite } = createSqliteD1Adapter();
  const originalFetch = globalThis.fetch;
  const sentCalls: Array<{ url: string; body: Record<string, unknown> }> = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    sentCalls.push({ url, body });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 50 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    // Seed an existing admin user in DB without setting any ADMIN_* env var
    sqlite
      .prepare(
        `INSERT INTO users (user_uuid, telegram_id, username, first_name, role, status, outbound_reward_banned)
         VALUES ('uuid-db-admin', 777001, 'dbadmin', 'AdminUser', 'admin', 'active', 0)`
      )
      .run();

    const sendUpdate = async (update: Record<string, unknown>, envOverrides: Partial<Env> = {}) => {
      const req = new Request('https://sentra-core.kziepr.workers.dev/api/v1/telegram/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(update),
      });
      return await handleTelegramWebhook(req, {
        DB: db,
        TELEGRAM_BOT_TOKEN: '123456:TEST_TOKEN',
        ...envOverrides,
      } as Env);
    };

    // 1. /start as DB admin -> keyboard includes '🛠 پنل مدیریت'
    const startResp = await sendUpdate({
      update_id: 201,
      message: {
        message_id: 10,
        chat: { id: 777001, type: 'private' },
        from: { id: 777001, first_name: 'AdminUser', username: 'dbadmin' },
        text: '/start',
      },
    });
    assert.equal(startResp.status, 200);
    const startMarkup = sentCalls[0].body.reply_markup as { keyboard: Array<Array<{ text: string }>> };
    const flatButtons = startMarkup.keyboard.flat().map((b) => b.text);
    assert.ok(flatButtons.includes('🛠 پنل مدیریت'), 'Expected 🛠 پنل مدیریت in main menu for DB admin');

    // 2. Clicking '🛠 پنل مدیریت' opens admin panel with Add Node, Subscriptions, Stats
    await sendUpdate({
      update_id: 202,
      message: {
        message_id: 11,
        chat: { id: 777001, type: 'private' },
        from: { id: 777001, first_name: 'AdminUser', username: 'dbadmin' },
        text: '🛠 پنل مدیریت',
      },
    });
    const panelMsg = sentCalls[1].body;
    assert.ok(String(panelMsg.text).includes('پنل مدیریت'));
    const inlineData = (
      panelMsg.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }
    ).inline_keyboard
      .flat()
      .map((b) => b.callback_data);
    assert.ok(inlineData.includes('adm_add_node'));
    assert.ok(inlineData.includes('adm_manage_subs'));
    assert.ok(inlineData.includes('adm_stats'));

    // 3. /admin also opens admin panel
    await sendUpdate({
      update_id: 203,
      message: {
        message_id: 12,
        chat: { id: 777001, type: 'private' },
        from: { id: 777001, first_name: 'AdminUser', username: 'dbadmin' },
        text: '/admin',
      },
    });
    assert.ok(String(sentCalls[2].body.text).includes('پنل مدیریت'));

    // 4. Stats callback returns live stats
    await sendUpdate({
      update_id: 204,
      callback_query: {
        id: 'cb_stats',
        from: { id: 777001, first_name: 'AdminUser' },
        message: { message_id: 50, chat: { id: 777001, type: 'private' } },
        data: 'adm_stats',
      },
    });
    const statsCall = sentCalls.find((c) => c.url.includes('/editMessageText'));
    assert.ok(statsCall && String(statsCall.body.text).includes('آمار زنده'));

    // 5. Manage subscriptions callback lists subscriptions
    await sendUpdate({
      update_id: 205,
      callback_query: {
        id: 'cb_subs',
        from: { id: 777001, first_name: 'AdminUser' },
        message: { message_id: 50, chat: { id: 777001, type: 'private' } },
        data: 'adm_manage_subs',
      },
    });
    const subsCall = sentCalls.filter((c) => c.url.includes('/editMessageText')).at(-1);
    assert.ok(subsCall && String(subsCall.body.text).includes('مدیریت سابسکریپشن‌ها'));
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});

test('env.ADMIN_TELEGRAM_ID grants admin menu and non-admin users are denied /admin', async () => {
  const { db, sqlite } = createSqliteD1Adapter();
  const originalFetch = globalThis.fetch;
  const sentCalls: Array<{ url: string; body: Record<string, unknown> }> = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    sentCalls.push({ url, body });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 60 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const env = {
      DB: db,
      TELEGRAM_BOT_TOKEN: '123456:TEST_TOKEN',
      ADMIN_TELEGRAM_ID: '888001',
    } as Env;

    // 1. Admin via env.ADMIN_TELEGRAM_ID runs /start
    await handleTelegramWebhook(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/telegram/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          update_id: 301,
          message: {
            message_id: 20,
            chat: { id: 888001, type: 'private' },
            from: { id: 888001, first_name: 'EnvAdmin' },
            text: '/start',
          },
        }),
      }),
      env
    );
    const adminButtons = (
      sentCalls[0].body.reply_markup as { keyboard: Array<Array<{ text: string }>> }
    ).keyboard
      .flat()
      .map((b) => b.text);
    assert.ok(adminButtons.includes('🛠 پنل مدیریت'));

    const envAdminRow = sqlite
      .prepare('SELECT role FROM users WHERE telegram_id = ?')
      .get(888001) as { role: string };
    assert.equal(envAdminRow.role, 'admin');

    // 2. Non-admin runs /start -> no admin button
    await handleTelegramWebhook(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/telegram/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          update_id: 302,
          message: {
            message_id: 21,
            chat: { id: 888002, type: 'private' },
            from: { id: 888002, first_name: 'RegularUser' },
            text: '/start',
          },
        }),
      }),
      env
    );
    const userButtons = (
      sentCalls[1].body.reply_markup as { keyboard: Array<Array<{ text: string }>> }
    ).keyboard
      .flat()
      .map((b) => b.text);
    assert.ok(!userButtons.includes('🛠 پنل مدیریت'));

    // 3. Non-admin tries /admin -> access denied
    await handleTelegramWebhook(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/telegram/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          update_id: 303,
          message: {
            message_id: 22,
            chat: { id: 888002, type: 'private' },
            from: { id: 888002, first_name: 'RegularUser' },
            text: '/admin',
          },
        }),
      }),
      env
    );
    assert.ok(String(sentCalls[2].body.text).includes('دسترسی به پنل مدیریت ندارید'));
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});
