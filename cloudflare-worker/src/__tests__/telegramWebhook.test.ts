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
    assert.ok(String(sentCalls[2].body.text).includes('⛔ دسترسی غیرمجاز'));
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});

test('User panel reply buttons, inline callbacks, and multi-step telegram_states FSM work end-to-end', async () => {
  const { db, sqlite } = createSqliteD1Adapter();
  const originalFetch = globalThis.fetch;
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = url.split('/').pop() || '';
    const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    calls.push({ method, body });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 70 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const env = {
    DB: db,
    TELEGRAM_BOT_TOKEN: '123456:TEST_TOKEN',
    PUBLIC_BASE_URL: 'https://sentra-core.kziepr.workers.dev',
    PRO_SUBSCRIPTION_PRICE: '180000',
  } as Env;

  const sendUpdate = async (update: Record<string, unknown>) => {
    const before = calls.length;
    const req = new Request('https://sentra-core.kziepr.workers.dev/api/v1/telegram/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(update),
    });
    const resp = await handleTelegramWebhook(req, env);
    assert.equal(resp.status, 200);
    return calls.slice(before);
  };

  try {
    const user = { id: 555001, first_name: 'Nima', username: 'nima_u' };

    // 1. /start
    await sendUpdate({
      update_id: 401,
      message: { message_id: 1, chat: { id: 555001, type: 'private' }, from: user, text: '/start' },
    });

    // 2. Unlinked user tapping Account sees ONLY the 2 unified auth inline buttons
    const unlinkedAccountCalls = await sendUpdate({
      update_id: 402,
      message: { message_id: 2, chat: { id: 555001, type: 'private' }, from: user, text: '👤 حساب کاربری' },
    });
    const unlinkedMarkup = unlinkedAccountCalls[0].body.reply_markup as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
    const unlinkedButtons = unlinkedMarkup.inline_keyboard.flat();
    assert.equal(unlinkedButtons.length, 2);
    assert.equal(unlinkedButtons[0].callback_data, 'auth_register_new');
    assert.equal(unlinkedButtons[1].callback_data, 'auth_login_app');

    // Mark user as registered with unified credentials, then Account shows 8-digit code & zero /sub/ links
    sqlite
      .prepare('UPDATE users SET password_hash = ? WHERE telegram_id = ?')
      .run('pbkdf2_sha256$15000$00112233445566778899aabbccddeeff$00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff', 555001);

    const accountCalls = await sendUpdate({
      update_id: 4021,
      message: { message_id: 21, chat: { id: 555001, type: 'private' }, from: user, text: '👤 حساب کاربری' },
    });
    assert.ok(String(accountCalls[0].body.text).includes('کد اتصال ۸ رقمی'));
    assert.ok(String(accountCalls[0].body.text).includes('باقیمانده'));
    assert.equal(String(accountCalls[0].body.text).includes('/sub/'), false);

    // Deprecated button text gently redirects to account view (never sends /sub/ links)
    const subCalls = await sendUpdate({
      update_id: 403,
      message: { message_id: 3, chat: { id: 555001, type: 'private' }, from: user, text: '🔑 دریافت کانفیگ و کد اتصال' },
    });
    assert.equal(String(subCalls[0].body.text).includes('/sub/'), false);
    assert.ok(String(subCalls[0].body.text).includes('کد اتصال ۸ رقمی'));

    const guideCalls = await sendUpdate({
      update_id: 404,
      message: { message_id: 4, chat: { id: 555001, type: 'private' }, from: user, text: '📖 راهنمای اتصال' },
    });
    assert.ok(String(guideCalls[0].body.text).includes('راهنمای اتصال'));

    const dlCalls = await sendUpdate({
      update_id: 405,
      message: { message_id: 5, chat: { id: 555001, type: 'private' }, from: user, text: '📥 دانلود اپلیکیشن' },
    });
    assert.ok(String(dlCalls[0].body.text).includes('دانلود اپلیکیشن رسمی SentraVPN'));

    // 3. Inline callback: answerCallbackQuery MUST be called first
    const cbGuide = await sendUpdate({
      update_id: 406,
      callback_query: {
        id: 'cb_guide_android',
        from: user,
        message: { message_id: 70, chat: { id: 555001, type: 'private' } },
        data: 'user_guide_android',
      },
    });
    assert.equal(cbGuide[0].method, 'answerCallbackQuery');
    assert.equal(cbGuide[0].body.callback_query_id, 'cb_guide_android');
    assert.equal(cbGuide[1].method, 'editMessageText');
    assert.ok(String(cbGuide[1].body.text).includes('راهنمای اتصال در اندروید'));

    // 4. Support ticket multi-step FSM -> inserts into support_tickets
    const cbTicket = await sendUpdate({
      update_id: 407,
      callback_query: {
        id: 'cb_tkt_new',
        from: user,
        message: { message_id: 70, chat: { id: 555001, type: 'private' } },
        data: 'user_ticket_new_connection',
      },
    });
    assert.equal(cbTicket[0].method, 'answerCallbackQuery');
    assert.ok(String(cbTicket[1].body.text).includes('ثبت تیکت پشتیبانی'));

    const ticketReply = await sendUpdate({
      update_id: 408,
      message: {
        message_id: 6,
        chat: { id: 555001, type: 'private' },
        from: user,
        text: 'سرعت دانلود روی اینترنت همراه اول پایین است',
      },
    });
    assert.ok(String(ticketReply[0].body.text).includes('TKT-'));
    const ticketRow = sqlite
      .prepare('SELECT ticket_number, category, status FROM support_tickets LIMIT 1')
      .get() as { ticket_number: string; category: string; status: string };
    assert.ok(ticketRow);
    assert.equal(ticketRow.category, 'connection');
    assert.equal(ticketRow.status, 'open');

    // 5. Payment receipt multi-step FSM (photo upload) -> inserts into donations with 120,000 Toman Pro price
    const cbReceipt = await sendUpdate({
      update_id: 409,
      callback_query: {
        id: 'cb_rcpt_pro',
        from: user,
        message: { message_id: 70, chat: { id: 555001, type: 'private' } },
        data: 'user_submit_receipt_pro',
      },
    });
    assert.equal(cbReceipt[0].method, 'answerCallbackQuery');
    assert.ok(String(cbReceipt[1].body.text).includes('120,000'));

    const receiptReply = await sendUpdate({
      update_id: 410,
      message: {
        message_id: 7,
        chat: { id: 555001, type: 'private' },
        from: user,
        photo: [{ file_id: 'AgAC_RECEIPT_123', file_unique_id: 'AQAD_UNIQ_123' }],
      },
    });
    assert.ok(String(receiptReply[0].body.text).includes('#DON-'));
    const donationRow = sqlite
      .prepare('SELECT amount, receipt_file_id, status FROM donations LIMIT 1')
      .get() as { amount: number; receipt_file_id: string; status: string };
    assert.ok(donationRow);
    assert.equal(donationRow.amount, 120000);
    assert.equal(donationRow.receipt_file_id, 'AgAC_RECEIPT_123');
    assert.equal(donationRow.status, 'pending');

    // 6. Active FSM state is automatically cleared if user clicks a main menu button instead
    await sendUpdate({
      update_id: 411,
      callback_query: {
        id: 'cb_donate',
        from: user,
        message: { message_id: 70, chat: { id: 555001, type: 'private' } },
        data: 'user_donate_single_node',
      },
    });
    const escapeFsmCalls = await sendUpdate({
      update_id: 412,
      message: {
        message_id: 8,
        chat: { id: 555001, type: 'private' },
        from: user,
        text: '🎫 پشتیبانی',
      },
    });
    assert.ok(String(escapeFsmCalls[0].body.text).includes('پشتیبانی Sentra Platform'));
    const remainingState = sqlite
      .prepare('SELECT * FROM telegram_states WHERE telegram_id = ?')
      .get(555001);
    assert.equal(remainingState, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});

test('callback_query always awaits answerCallbackQuery first and sends clear fallback error on D1 failure', async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const methods: string[] = [];
  const sentTexts: string[] = [];
  const logged: unknown[][] = [];

  console.error = (...args: unknown[]) => logged.push(args);
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = String(input).split('/').pop() || '';
    methods.push(method);
    const body = JSON.parse(String(init?.body || '{}')) as { text?: string };
    if (body.text) sentTexts.push(body.text);
    return new Response(JSON.stringify({ ok: true, result: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const brokenDb = {
    prepare() {
      return {
        bind() {
          return this;
        },
        async first() {
          throw new Error('D1_SQL_FAILURE');
        },
        async all() {
          throw new Error('D1_SQL_FAILURE');
        },
        async run() {
          throw new Error('D1_SQL_FAILURE');
        },
      };
    },
  } as unknown as D1Database;

  try {
    const req = new Request('https://sentra-core.kziepr.workers.dev/api/v1/telegram/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        update_id: 501,
        callback_query: {
          id: 'cb_broken_db',
          from: { id: 555999, first_name: 'BrokenDbUser' },
          message: { message_id: 90, chat: { id: 555999, type: 'private' } },
          data: 'user_account',
        },
      }),
    });

    const resp = await handleTelegramWebhook(req, {
      DB: brokenDb,
      TELEGRAM_BOT_TOKEN: '123456:TEST_TOKEN',
    } as Env);

    assert.equal(resp.status, 200);
    assert.equal(methods[0], 'answerCallbackQuery', 'answerCallbackQuery must run before D1 queries');
    assert.ok(sentTexts.some((t) => t.includes('خطایی در پردازش')));
    assert.ok(
      logged.some((args) => args.some((a) => JSON.stringify(a).includes('D1_SQL_FAILURE'))),
      'Expected D1 error to be logged with console.error'
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
});

test('Admin panel guard, official node ingestion, subscription sources CRUD, pending approvals, and error reporting', async () => {
  const { db, sqlite } = createSqliteD1Adapter();
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://example.com/')) {
      return new Response(
        'vless://11111111-1111-4111-8111-111111111111@sub-node.example.com:443?security=tls&type=ws#SubNodeDE',
        { status: 200, headers: { 'Content-Type': 'text/plain' } }
      );
    }
    const method = url.split('/').pop() || '';
    const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    calls.push({ url, method, body });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 120 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const env = {
    DB: db,
    TELEGRAM_BOT_TOKEN: '123456:TEST_TOKEN',
    ADMIN_TELEGRAM_ID: '999001',
    PUBLIC_BASE_URL: 'https://sentra-core.kziepr.workers.dev',
  } as Env;

  const sendUpdate = async (update: Record<string, unknown>, customEnv: Env = env) => {
    const before = calls.length;
    const req = new Request('https://sentra-core.kziepr.workers.dev/api/v1/telegram/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(update),
    });
    const resp = await handleTelegramWebhook(req, customEnv);
    assert.equal(resp.status, 200);
    return calls.slice(before);
  };

  try {
    const adminUser = { id: 999001, first_name: 'RootAdmin', username: 'root_admin' };
    const regularUser = { id: 999002, first_name: 'NormalUser', username: 'normal_user' };

    // Seed both users via /start
    await sendUpdate({
      update_id: 601,
      message: { message_id: 1, chat: { id: 999001, type: 'private' }, from: adminUser, text: '/start' },
    });
    await sendUpdate({
      update_id: 602,
      message: { message_id: 2, chat: { id: 999002, type: 'private' }, from: regularUser, text: '/start' },
    });

    // 1. Non-admin guard on /admin, adm_stats, and admin_panel_home callbacks
    const deniedCmd = await sendUpdate({
      update_id: 603,
      message: { message_id: 3, chat: { id: 999002, type: 'private' }, from: regularUser, text: '/admin' },
    });
    assert.ok(String(deniedCmd[0].body.text).includes('⛔ دسترسی غیرمجاز'));

    const deniedCb1 = await sendUpdate({
      update_id: 604,
      callback_query: {
        id: 'cb_deny_1',
        from: regularUser,
        message: { message_id: 120, chat: { id: 999002, type: 'private' } },
        data: 'adm_stats',
      },
    });
    assert.equal(deniedCb1[0].method, 'answerCallbackQuery');
    assert.ok(deniedCb1.some((c) => String(c.body.text || '').includes('⛔ دسترسی غیرمجاز')));

    const deniedCb2 = await sendUpdate({
      update_id: 605,
      callback_query: {
        id: 'cb_deny_2',
        from: regularUser,
        message: { message_id: 120, chat: { id: 999002, type: 'private' } },
        data: 'admin_panel_home',
      },
    });
    assert.equal(deniedCb2[0].method, 'answerCallbackQuery');
    assert.ok(deniedCb2.some((c) => String(c.body.text || '').includes('⛔ دسترسی غیرمجاز')));

    // 2. Official node ingestion (is_official = 1, status = 'active', fingerprint_sha256)
    await sendUpdate({
      update_id: 606,
      callback_query: {
        id: 'cb_add_node',
        from: adminUser,
        message: { message_id: 120, chat: { id: 999001, type: 'private' } },
        data: 'adm_add_node',
      },
    });
    await sendUpdate({
      update_id: 607,
      callback_query: {
        id: 'cb_alloc_free',
        from: adminUser,
        message: { message_id: 120, chat: { id: 999001, type: 'private' } },
        data: 'adm_ob_alloc_free_only',
      },
    });
    const addOfficialReply = await sendUpdate({
      update_id: 608,
      message: {
        message_id: 10,
        chat: { id: 999001, type: 'private' },
        from: adminUser,
        text: 'vless://22222222-2222-4222-8222-222222222222@official.example.com:443?security=tls&type=ws#OfficialDE',
      },
    });
    assert.ok(addOfficialReply.some((c) => String(c.body.text || '').includes('با موفقیت اضافه شد')));
    const officialNode = sqlite
      .prepare(
        'SELECT protocol, status, is_official, fingerprint_sha256 FROM donated_outbounds WHERE server_address = ?'
      )
      .get('official.example.com') as {
      protocol: string;
      status: string;
      is_official: number;
      fingerprint_sha256: string;
    };
    assert.ok(officialNode);
    assert.equal(officialNode.protocol, 'vless');
    assert.equal(officialNode.status, 'active');
    assert.equal(officialNode.is_official, 1);
    assert.equal(officialNode.fingerprint_sha256.length, 64);

    // 3. Subscription sources CRUD (list -> add -> select category -> submit URL -> delete)
    await sendUpdate({
      update_id: 609,
      callback_query: {
        id: 'cb_sub_sources',
        from: adminUser,
        message: { message_id: 120, chat: { id: 999001, type: 'private' } },
        data: 'adm_sub_sources',
      },
    });
    await sendUpdate({
      update_id: 610,
      callback_query: {
        id: 'cb_subsrc_add',
        from: adminUser,
        message: { message_id: 120, chat: { id: 999001, type: 'private' } },
        data: 'adm_subsrc_add',
      },
    });
    await sendUpdate({
      update_id: 611,
      callback_query: {
        id: 'cb_subsrc_cat',
        from: adminUser,
        message: { message_id: 120, chat: { id: 999001, type: 'private' } },
        data: 'adm_subsrc_cat_gaming',
      },
    });
    const addSubSrcReply = await sendUpdate({
      update_id: 612,
      message: {
        message_id: 11,
        chat: { id: 999001, type: 'private' },
        from: adminUser,
        text: 'https://example.com/sub-gaming.txt',
      },
    });
    assert.ok(addSubSrcReply.some((c) => String(c.body.text || '').includes('منبع سابسکریپشن')));
    const subSourceRow = sqlite
      .prepare('SELECT id, sub_url, category FROM subscription_sources WHERE sub_url = ?')
      .get('https://example.com/sub-gaming.txt') as { id: number; sub_url: string; category: string };
    assert.ok(subSourceRow);
    assert.equal(subSourceRow.category, 'gaming');

    const delSubSrcReply = await sendUpdate({
      update_id: 613,
      callback_query: {
        id: 'cb_subsrc_del',
        from: adminUser,
        message: { message_id: 120, chat: { id: 999001, type: 'private' } },
        data: `adm_subsrc_del_${subSourceRow.id}`,
      },
    });
    assert.equal(delSubSrcReply[0].method, 'answerCallbackQuery');
    const deletedSubSource = sqlite
      .prepare('SELECT id FROM subscription_sources WHERE id = ?')
      .get(subSourceRow.id);
    assert.equal(deletedSubSource, undefined);

    // 4. Pending donated outbounds approval & rejection with donor notification
    const regularUserRow = sqlite
      .prepare('SELECT id FROM users WHERE telegram_id = ?')
      .get(999002) as { id: number };

    // User selects single-node donation via FSM -> inserted as status = 'pending'
    await sendUpdate({
      update_id: 614,
      callback_query: {
        id: 'cb_user_donate_ob',
        from: regularUser,
        message: { message_id: 120, chat: { id: 999002, type: 'private' } },
        data: 'user_donate_single_node',
      },
    });
    await sendUpdate({
      update_id: 615,
      message: {
        message_id: 12,
        chat: { id: 999002, type: 'private' },
        from: regularUser,
        text: 'vless://33333333-3333-4333-8333-333333333333@donor-ok.example.com:443?security=tls&type=ws#DonorOK',
      },
    });
    const pendingNode1 = sqlite
      .prepare('SELECT id, status, is_official FROM donated_outbounds WHERE server_address = ?')
      .get('donor-ok.example.com') as { id: number; status: string; is_official: number };
    assert.ok(pendingNode1);
    assert.equal(pendingNode1.status, 'pending');
    assert.equal(pendingNode1.is_official, 0);

    // Seed a second pending donated node to test rejection
    sqlite
      .prepare(
        `INSERT INTO donated_outbounds (
           donor_user_id, tag, protocol, server_address, server_port, config_json,
           status, fingerprint_sha256, is_official, label
         ) VALUES (?, 'DonorReject', 'vless', 'donor-rej.example.com', 443, '{}', 'pending', 'fp_reject_test', 0, 'DonorReject')`
      )
      .run(regularUserRow.id);
    const pendingNode2 = sqlite
      .prepare('SELECT id FROM donated_outbounds WHERE server_address = ?')
      .get('donor-rej.example.com') as { id: number };

    const listPendingNodes = await sendUpdate({
      update_id: 616,
      callback_query: {
        id: 'cb_pending_nodes',
        from: adminUser,
        message: { message_id: 120, chat: { id: 999001, type: 'private' } },
        data: 'adm_pending_nodes',
      },
    });
    assert.ok(listPendingNodes.some((c) => String(c.body.text || '').includes('نودهای اهدایی')));

    const approveNodeCalls = await sendUpdate({
      update_id: 617,
      callback_query: {
        id: 'cb_approve_node',
        from: adminUser,
        message: { message_id: 120, chat: { id: 999001, type: 'private' } },
        data: `adm_node_approve_${pendingNode1.id}`,
      },
    });
    assert.equal(
      (
        sqlite
          .prepare('SELECT status FROM donated_outbounds WHERE id = ?')
          .get(pendingNode1.id) as { status: string }
      ).status,
      'active'
    );
    assert.ok(
      approveNodeCalls.some(
        (c) => c.method === 'sendMessage' && c.body.chat_id === 999002 && String(c.body.text).includes('تأیید')
      ),
      'Expected donor approval notification'
    );

    const rejectNodeCalls = await sendUpdate({
      update_id: 618,
      callback_query: {
        id: 'cb_reject_node',
        from: adminUser,
        message: { message_id: 120, chat: { id: 999001, type: 'private' } },
        data: `adm_node_reject_${pendingNode2.id}`,
      },
    });
    assert.equal(
      (
        sqlite
          .prepare('SELECT status FROM donated_outbounds WHERE id = ?')
          .get(pendingNode2.id) as { status: string }
      ).status,
      'rejected'
    );
    assert.ok(
      rejectNodeCalls.some(
        (c) => c.method === 'sendMessage' && c.body.chat_id === 999002 && String(c.body.text).includes('رد شد')
      ),
      'Expected donor rejection notification'
    );

    // 5. Pending financial donations approval (upgrades subscription + notifies user) & rejection
    sqlite
      .prepare(
        `INSERT INTO donations (user_id, amount, receipt_file_id, file_unique_id, status)
         VALUES (?, 120000, 'file_approve_1', 'uniq_approve_1', 'pending')`
      )
      .run(regularUserRow.id);
    const donApprove = sqlite
      .prepare('SELECT id FROM donations WHERE file_unique_id = ?')
      .get('uniq_approve_1') as { id: number };

    sqlite
      .prepare(
        `INSERT INTO donations (user_id, amount, receipt_file_id, file_unique_id, status)
         VALUES (?, 180000, 'file_reject_2', 'uniq_reject_2', 'pending')`
      )
      .run(regularUserRow.id);
    const donReject = sqlite
      .prepare('SELECT id FROM donations WHERE file_unique_id = ?')
      .get('uniq_reject_2') as { id: number };

    const listPendingDonations = await sendUpdate({
      update_id: 619,
      callback_query: {
        id: 'cb_pending_don',
        from: adminUser,
        message: { message_id: 120, chat: { id: 999001, type: 'private' } },
        data: 'adm_pending_donations',
      },
    });
    assert.ok(listPendingDonations.some((c) => String(c.body.text || '').includes('فیش‌های مالی')));

    const approveDonCalls = await sendUpdate({
      update_id: 620,
      callback_query: {
        id: 'cb_don_approve',
        from: adminUser,
        message: { message_id: 120, chat: { id: 999001, type: 'private' } },
        data: `adm_don_approve_${donApprove.id}`,
      },
    });
    const donApprovedRow = sqlite
      .prepare('SELECT status, subscription_granted FROM donations WHERE id = ?')
      .get(donApprove.id) as { status: string; subscription_granted: number };
    assert.equal(donApprovedRow.status, 'approved');
    assert.equal(donApprovedRow.subscription_granted, 1);

    const upgradedSub = sqlite
      .prepare('SELECT tier, status FROM subscriptions WHERE user_id = ?')
      .get(regularUserRow.id) as { tier: string; status: string };
    assert.equal(upgradedSub.tier, 'Sentra Pro');
    assert.equal(upgradedSub.status, 'active');
    assert.ok(
      approveDonCalls.some(
        (c) => c.method === 'sendMessage' && c.body.chat_id === 999002 && String(c.body.text).includes('Sentra Pro')
      ),
      'Expected user subscription upgrade notification'
    );

    const rejectDonCalls = await sendUpdate({
      update_id: 621,
      callback_query: {
        id: 'cb_don_reject',
        from: adminUser,
        message: { message_id: 120, chat: { id: 999001, type: 'private' } },
        data: `adm_don_reject_${donReject.id}`,
      },
    });
    assert.equal(
      (
        sqlite
          .prepare('SELECT status FROM donations WHERE id = ?')
          .get(donReject.id) as { status: string }
      ).status,
      'rejected'
    );
    assert.ok(
      rejectDonCalls.some(
        (c) => c.method === 'sendMessage' && c.body.chat_id === 999002 && String(c.body.text).includes('رد شد')
      ),
      'Expected user donation rejection notification'
    );

    // 6. Admin detailed SQL error reporting on D1 failure
    const originalError = console.error;
    console.error = () => {};
    try {
      const brokenDb = {
        prepare() {
          return {
            bind() {
              return this;
            },
            async first() {
              throw new Error('SQLITE_CORRUPT_ADMIN_TEST');
            },
            async all() {
              throw new Error('SQLITE_CORRUPT_ADMIN_TEST');
            },
            async run() {
              throw new Error('SQLITE_CORRUPT_ADMIN_TEST');
            },
          };
        },
      } as unknown as D1Database;

      const adminErrCalls = await sendUpdate(
        {
          update_id: 622,
          callback_query: {
            id: 'cb_admin_err',
            from: adminUser,
            message: { message_id: 120, chat: { id: 999001, type: 'private' } },
            data: 'adm_stats',
          },
        },
        { ...env, DB: brokenDb }
      );
      assert.ok(
        adminErrCalls.some(
          (c) =>
            String(c.body.text || '').includes('خطای پنل مدیریت') &&
            String(c.body.text || '').includes('SQLITE_CORRUPT_ADMIN_TEST')
        ),
        'Expected detailed admin SQL error message'
      );
    } finally {
      console.error = originalError;
    }
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});
