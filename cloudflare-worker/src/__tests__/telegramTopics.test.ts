import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import worker from '../index.ts';
import { routeRequest } from '../routes.ts';
import {
  buildBackupFilename,
  dispatchErrorAlert,
  extractSupportUid,
  getTopicRoutingConfig,
  saveTopicRoute,
  sendDatabaseBackup,
  sendErrorAlert,
  sendToTopic,
} from '../telegramTopics.ts';
import { handleTelegramWebhook } from '../telegramWebhook.ts';
import type { Env } from '../types.ts';

function createSqliteD1Adapter(options?: { skipSystemSettings?: boolean }): {
  db: D1Database;
  sqlite: DatabaseSync;
} {
  const sqlite = new DatabaseSync(':memory:');
  const schemaPath = path.resolve(import.meta.dirname, '../../schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  for (const stmt of sql.split(';').map((s) => s.trim()).filter(Boolean)) {
    if (options?.skipSystemSettings && /system_settings/i.test(stmt)) {
      continue;
    }
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

test('pure helpers: extractSupportUid and buildBackupFilename work deterministically', () => {
  assert.equal(extractSupportUid('🆔 شناسه کاربر: #UID_88442211\nمتن پیام'), 88442211);
  assert.equal(extractSupportUid('no uid here'), null);
  assert.equal(extractSupportUid('#UID_12'), null);

  const fixed = new Date('2026-11-27T09:05:00.000Z');
  assert.equal(buildBackupFilename(fixed), 'sentra-backup-2026-11-27-09-05.json');
});

test('auto-creates system_settings table on demand without manual migration', async () => {
  const { db, sqlite } = createSqliteD1Adapter({ skipSystemSettings: true });
  try {
    await saveTopicRoute(db, 'logs', -1001234567890, 101);
    const cfg = await getTopicRoutingConfig(db);
    assert.equal(cfg.logGroupId, '-1001234567890');
    assert.equal(cfg.topicLogsId, '101');
  } finally {
    sqlite.close();
  }
});

test('group admin commands bind topics, reject non-admins, and ignore regular group messages', async () => {
  const { db, sqlite } = createSqliteD1Adapter();
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body || '{}')) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({ ok: true, result: { message_id: calls.length } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const env = {
    DB: db,
    TELEGRAM_BOT_TOKEN: '123456:TEST_TOKEN',
    ADMIN_TELEGRAM_ID: '777777',
  } as Env;

  const sendUpdate = async (message: Record<string, unknown>) =>
    handleTelegramWebhook(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/telegram/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ update_id: Math.floor(Math.random() * 100000), message }),
      }),
      env
    );

  try {
    // 1. Regular chat or /start in group must be completely ignored
    await sendUpdate({
      message_id: 1,
      chat: { id: -100999888, type: 'supergroup' },
      from: { id: 555111, first_name: 'NormalUser' },
      text: 'سلام بچه‌ها',
    });
    await sendUpdate({
      message_id: 2,
      chat: { id: -100999888, type: 'supergroup' },
      from: { id: 555111, first_name: 'NormalUser' },
      text: '/start',
    });
    assert.equal(calls.length, 0);

    // 2. Non-admin calling /set_logs gets rejected
    await sendUpdate({
      message_id: 3,
      message_thread_id: 12,
      chat: { id: -100999888, type: 'supergroup' },
      from: { id: 555111, first_name: 'NormalUser' },
      text: '/set_logs',
    });
    assert.equal(calls.length, 1);
    assert.match(String(calls[0].body.text), /دسترسی غیرمجاز/);
    assert.equal(calls[0].body.message_thread_id, 12);

    // 3. Admin binds logs, backups, and support topics
    await sendUpdate({
      message_id: 4,
      message_thread_id: 101,
      chat: { id: -100999888, type: 'supergroup' },
      from: { id: 777777, first_name: 'Admin' },
      text: '/set_logs@sentraconnect_bot',
    });
    await sendUpdate({
      message_id: 5,
      message_thread_id: 202,
      chat: { id: -100999888, type: 'supergroup' },
      from: { id: 777777, first_name: 'Admin' },
      text: '/set_backups',
    });
    await sendUpdate({
      message_id: 6,
      message_thread_id: 303,
      chat: { id: -100999888, type: 'supergroup' },
      from: { id: 777777, first_name: 'Admin' },
      text: '/set_support',
    });

    const cfg = await getTopicRoutingConfig(db);
    assert.equal(cfg.logGroupId, '-100999888');
    assert.equal(cfg.topicLogsId, '101');
    assert.equal(cfg.topicBackupsId, '202');
    assert.equal(cfg.topicSupportId, '303');
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});

test('two-way support routes user ticket to support topic and forwards admin reply back to user', async () => {
  const { db, sqlite } = createSqliteD1Adapter();
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body || '{}')) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({ ok: true, result: { message_id: calls.length } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const env = {
    DB: db,
    TELEGRAM_BOT_TOKEN: '123456:TEST_TOKEN',
    ADMIN_TELEGRAM_ID: '777777',
  } as Env;

  try {
    await saveTopicRoute(db, 'logs', -100555666, 10);
    await saveTopicRoute(db, 'support', -100555666, 30);

    // User clicks new support ticket button
    await handleTelegramWebhook(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/telegram/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          update_id: 201,
          callback_query: {
            id: 'cb-sup-1',
            from: { id: 445566, first_name: 'Reza', username: 'reza_user' },
            message: { message_id: 10, chat: { id: 445566, type: 'private' } },
            data: 'user_ticket_new_connection',
          },
        }),
      }),
      env
    );

    calls.length = 0;

    // User sends support message
    await handleTelegramWebhook(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/telegram/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          update_id: 202,
          message: {
            message_id: 11,
            chat: { id: 445566, type: 'private' },
            from: { id: 445566, first_name: 'Reza', username: 'reza_user' },
            text: 'سرور آلمان روی همراه اول وصل نمی‌شود.',
          },
        }),
      }),
      env
    );

    const supportPost = calls.find(
      (c) => c.body.chat_id === -100555666 && c.body.message_thread_id === 30
    );
    assert.ok(supportPost, 'Expected ticket forwarded to support topic');
    assert.match(String(supportPost.body.text), /#UID_445566/);
    assert.match(String(supportPost.body.text), /@reza_user/);

    calls.length = 0;

    // Admin replies in support topic
    await handleTelegramWebhook(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/telegram/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          update_id: 203,
          message: {
            message_id: 99,
            message_thread_id: 30,
            chat: { id: -100555666, type: 'supergroup' },
            from: { id: 777777, first_name: 'Admin' },
            text: 'لطفاً اپلیکیشن را آپدیت کنید و دوباره تست بزنید.',
            reply_to_message: {
              message_id: 88,
              text: String(supportPost.body.text),
            },
          },
        }),
      }),
      env
    );

    const dmToUser = calls.find((c) => c.body.chat_id === 445566);
    assert.ok(dmToUser, 'Expected admin reply forwarded to user private chat');
    assert.match(String(dmToUser.body.text), /پاسخ تیم پشتیبانی/);
    assert.match(String(dmToUser.body.text), /اپلیکیشن را آپدیت کنید/);

    const topicConfirm = calls.find(
      (c) => c.body.chat_id === -100555666 && c.body.message_thread_id === 30
    );
    assert.ok(topicConfirm, 'Expected confirmation posted in support topic');
    assert.match(String(topicConfirm.body.text), /پاسخ به کاربر ارسال شد/);

    const ticket = sqlite
      .prepare('SELECT status FROM support_tickets ORDER BY id DESC LIMIT 1')
      .get() as { status: string };
    assert.equal(ticket.status, 'awaiting_user');
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});

test('QualityEngine outage report sends formatted alert to topic_logs_id', async () => {
  const { db, sqlite } = createSqliteD1Adapter();
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body || '{}')) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    await saveTopicRoute(db, 'logs', -100111222, 77);
    sqlite
      .prepare(
        `INSERT INTO donated_outbounds (
           id, tag, protocol, server_address, server_port, config_json,
           fail_count, status, fingerprint_sha256
         ) VALUES (1, 'DE-Node-01', 'vless', '1.2.3.4', 443, '{}', 2, 'active', 'fp-test-1')`
      )
      .run();

    const resp = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/nodes/health-report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Quality-Secret': 'qe-secret-123',
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
              security_passed: true,
              error_msg: 'TCP connect timeout',
            },
          ],
        }),
      }),
      {
        DB: db,
        TELEGRAM_BOT_TOKEN: '123456:TEST_TOKEN',
        QUALITY_ENGINE_SECRET: 'qe-secret-123',
      } as Env,
      {} as ExecutionContext
    );

    assert.equal(resp.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.chat_id, -100111222);
    assert.equal(calls[0].body.message_thread_id, 77);
    assert.match(String(calls[0].body.text), /QualityEngine/);
    assert.match(String(calls[0].body.text), /DE-Node-01/);
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});

test('sendDatabaseBackup exports all D1 tables as JSON FormData document to backup topic and works via /admin & scheduled cron', async () => {
  const { db, sqlite } = createSqliteD1Adapter();
  const originalFetch = globalThis.fetch;
  let capturedForm: FormData | null = null;
  let capturedUrl = '';
  const jsonCalls: Array<{ url: string; body: Record<string, unknown> }> = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/sendDocument') && init?.body instanceof FormData) {
      capturedUrl = url;
      capturedForm = init.body;
    } else if (typeof init?.body === 'string') {
      jsonCalls.push({
        url,
        body: JSON.parse(init.body) as Record<string, unknown>,
      });
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const env = {
    DB: db,
    TELEGRAM_BOT_TOKEN: '123456:TEST_TOKEN',
    ADMIN_TELEGRAM_ID: '777777',
  } as Env;

  try {
    await saveTopicRoute(db, 'backups', -100333444, 55);
    sqlite
      .prepare(
        `INSERT INTO users (user_uuid, telegram_id, username, first_name, role, status)
         VALUES ('uuid-bkp-1', 777777, 'admin_user', 'Admin', 'admin', 'active')`
      )
      .run();

    // 1. Direct sendDatabaseBackup check
    const fixedDate = new Date('2026-11-27T14:30:00.000Z');
    const result = await sendDatabaseBackup(env, fixedDate);
    assert.equal(result.ok, true);
    assert.equal(result.filename, 'sentra-backup-2026-11-27-14-30.json');
    assert.ok((result.tablesCount || 0) >= 10);
    assert.ok(capturedUrl.includes('/sendDocument'));
    assert.ok(capturedForm);
    assert.equal(capturedForm.get('chat_id'), '-100333444');
    assert.equal(capturedForm.get('message_thread_id'), '55');

    const doc = capturedForm.get('document') as File;
    assert.ok(doc);
    const parsedBackup = JSON.parse(await doc.text()) as {
      project: string;
      tables: Record<string, unknown[]>;
    };
    assert.equal(parsedBackup.project, 'SentraVPN');
    assert.equal(parsedBackup.tables.users.length, 1);
    assert.ok(Array.isArray(parsedBackup.tables.system_settings));

    // 2. Manual backup via /admin button (adm_backup_now)
    capturedForm = null;
    await handleTelegramWebhook(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/telegram/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          update_id: 301,
          callback_query: {
            id: 'cb-bkp-1',
            from: { id: 777777, first_name: 'Admin' },
            message: { message_id: 50, chat: { id: 777777, type: 'private' } },
            data: 'adm_backup_now',
          },
        }),
      }),
      env
    );
    assert.ok(capturedForm, 'Expected adm_backup_now to upload backup document');
    assert.ok(
      jsonCalls.some((c) => c.body.chat_id === 777777 && /بکاپ فوری/.test(String(c.body.text)))
    );

    // 3. Scheduled cron trigger handler
    capturedForm = null;
    const waitPromises: Promise<unknown>[] = [];
    await worker.scheduled(
      {} as ScheduledController,
      env,
      { waitUntil: (p: Promise<unknown>) => waitPromises.push(p) } as unknown as ExecutionContext
    );
    await Promise.all(waitPromises);
    assert.ok(capturedForm, 'Expected scheduled handler to upload backup document');
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});

test('sendToTopic never throws on network errors', async () => {
  const { db, sqlite } = createSqliteD1Adapter();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('Simulated Telegram API outage');
  }) as typeof fetch;

  try {
    await saveTopicRoute(db, 'logs', -100123, 9);
    const ok = await sendToTopic(
      { DB: db, TELEGRAM_BOT_TOKEN: '123456:TEST_TOKEN' } as Env,
      'logs',
      'test message'
    );
    assert.equal(ok, false);
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});

test('error-only policy: routine /start and /api/v1/auth/register do NOT send messages to topic_logs_id', async () => {
  const { db, sqlite } = createSqliteD1Adapter();
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body || '{}')) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({ ok: true, result: { message_id: calls.length } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const env = {
    DB: db,
    TELEGRAM_BOT_TOKEN: '123456:TEST_TOKEN',
    ADMIN_TELEGRAM_ID: '777777',
  } as Env;

  try {
    await saveTopicRoute(db, 'logs', -100777888, 101);

    // 1. Routine /start registration in private chat
    await handleTelegramWebhook(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/telegram/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          update_id: 401,
          message: {
            message_id: 1,
            chat: { id: 912345, type: 'private' },
            from: { id: 912345, first_name: 'Sara', username: 'sara_user' },
            text: '/start',
          },
        }),
      }),
      env
    );

    // 2. Routine API user registration
    const regResp = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'sara_client_01',
          password: 'Password123!',
        }),
      }),
      env,
      {} as ExecutionContext
    );
    assert.equal(regResp.status, 201);

    const logTopicPosts = calls.filter(
      (c) => c.body.chat_id === -100777888 && c.body.message_thread_id === 101
    );
    assert.equal(logTopicPosts.length, 0, 'Routine events must never spam topic_logs_id');
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});

test('sendErrorAlert, dispatchErrorAlert (waitUntil), Telegram API ok:false alert without recursion, and singboxCompiler error reporting', async () => {
  const { db, sqlite } = createSqliteD1Adapter();
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  let failUserSendOnce = true;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    calls.push({ url: String(input), body });

    // Simulate Telegram returning ok:false for a user DM, while topic_logs_id succeeds
    if (failUserSendOnce && body.chat_id === 654321) {
      failUserSendOnce = false;
      return new Response(
        JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(JSON.stringify({ ok: true, result: { message_id: calls.length } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const env = {
    DB: db,
    TELEGRAM_BOT_TOKEN: '123456:TEST_TOKEN',
    ADMIN_TELEGRAM_ID: '777777',
  } as Env;

  try {
    await saveTopicRoute(db, 'logs', -100444555, 88);

    // 1. Direct sendErrorAlert formats source, timestamp, and details
    const ok = await sendErrorAlert(env, 'UnitTestSource', new Error('Simulated crash'));
    assert.equal(ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.chat_id, -100444555);
    assert.equal(calls[0].body.message_thread_id, 88);
    assert.match(String(calls[0].body.text), /UnitTestSource/);
    assert.match(String(calls[0].body.text), /Simulated crash/);

    // 2. dispatchErrorAlert schedules via ctx.waitUntil when provided
    calls.length = 0;
    const queued: Promise<unknown>[] = [];
    await dispatchErrorAlert(
      env,
      { waitUntil: (p: Promise<unknown>) => queued.push(p) } as unknown as ExecutionContext,
      'WaitUntilSource',
      'Async failure'
    );
    assert.equal(queued.length, 1);
    await Promise.all(queued);
    assert.equal(calls.length, 1);
    assert.match(String(calls[0].body.text), /WaitUntilSource/);

    // 3. Telegram API ok:false triggers a single sendErrorAlert with no recursion
    calls.length = 0;
    await handleTelegramWebhook(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/telegram/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          update_id: 501,
          message: {
            message_id: 2,
            chat: { id: 654321, type: 'private' },
            from: { id: 654321, first_name: 'BlockedUser' },
            text: '/start',
          },
        }),
      }),
      env
    );
    const tgErrorAlerts = calls.filter(
      (c) => c.body.chat_id === -100444555 && c.body.message_thread_id === 88
    );
    assert.equal(tgErrorAlerts.length, 1);
    assert.match(String(tgErrorAlerts[0].body.text), /Telegram API \(sendMessage\)/);
    assert.match(String(tgErrorAlerts[0].body.text), /403/);

    // 4. Malformed config_json in singboxCompiler triggers sendErrorAlert via /sub/:token?format=singbox
    calls.length = 0;
    const insertedUser = sqlite
      .prepare(
        `INSERT INTO users (user_uuid, telegram_id, first_name, role, status)
         VALUES ('uuid-corrupt-1', 333222, 'CorruptTestUser', 'user', 'active')`
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO subscriptions (user_id, tier, token, status, traffic_limit_bytes, max_concurrent_devices, expires_at)
         VALUES (?, 'Sentra Lite', 'tok_corrupt_check', 'active', 10737418240, 3, '2027-01-01T00:00:00.000Z')`
      )
      .run(Number(insertedUser.lastInsertRowid));
    sqlite
      .prepare(
        `INSERT INTO donated_outbounds (
           tag, protocol, server_address, server_port, config_json,
           health_score, status, fingerprint_sha256
         ) VALUES ('Broken-Node', 'vless', '5.6.7.8', 443, '{invalid-json', 95, 'active', 'fp-broken-1')`
      )
      .run();

    const subQueued: Promise<unknown>[] = [];
    const subResp = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/sub/tok_corrupt_check?format=singbox', {
        method: 'GET',
      }),
      env,
      { waitUntil: (p: Promise<unknown>) => subQueued.push(p) } as unknown as ExecutionContext
    );
    assert.equal(subResp.status, 200);
    await Promise.all(subQueued);

    const compilerAlerts = calls.filter(
      (c) => c.body.chat_id === -100444555 && c.body.message_thread_id === 88
    );
    assert.equal(compilerAlerts.length, 1);
    assert.match(String(compilerAlerts[0].body.text), /singboxCompiler\.ts/);
    assert.match(String(compilerAlerts[0].body.text), /Broken-Node/);
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});

test('two-way support forwards photo attachments to support topic and forwards admin photo reply back to user', async () => {
  const { db, sqlite } = createSqliteD1Adapter();
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body || '{}')) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({ ok: true, result: { message_id: calls.length } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const env = {
    DB: db,
    TELEGRAM_BOT_TOKEN: '123456:TEST_TOKEN',
    ADMIN_TELEGRAM_ID: '777777',
  } as Env;

  try {
    await saveTopicRoute(db, 'support', -100999777, 45);

    // Put user in awaiting_support_ticket state
    await handleTelegramWebhook(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/telegram/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          update_id: 601,
          callback_query: {
            id: 'cb-media-sup',
            from: { id: 889900, first_name: 'Mina', username: 'mina_dev' },
            message: { message_id: 20, chat: { id: 889900, type: 'private' } },
            data: 'user_ticket_new_connection',
          },
        }),
      }),
      env
    );

    calls.length = 0;

    // User sends screenshot photo with caption
    await handleTelegramWebhook(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/telegram/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          update_id: 602,
          message: {
            message_id: 21,
            chat: { id: 889900, type: 'private' },
            from: { id: 889900, first_name: 'Mina', username: 'mina_dev' },
            photo: [
              { file_id: 'photo_small_1', width: 90, height: 90 },
              { file_id: 'photo_large_99', width: 1280, height: 720 },
            ],
            caption: 'این خطا موقع اتصال نمایش داده می‌شود',
          },
        }),
      }),
      env
    );

    const photoToSupport = calls.find(
      (c) =>
        c.url.includes('/sendPhoto') &&
        c.body.chat_id === -100999777 &&
        c.body.message_thread_id === 45
    );
    assert.ok(photoToSupport, 'Expected user photo forwarded via sendPhoto to support topic');
    assert.equal(photoToSupport.body.photo, 'photo_large_99');
    assert.match(String(photoToSupport.body.caption), /#UID_889900/);
    assert.match(String(photoToSupport.body.caption), /@mina_dev/);

    calls.length = 0;

    // Admin replies with a photo + caption to the captioned photo in topic_support_id
    await handleTelegramWebhook(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/telegram/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          update_id: 603,
          message: {
            message_id: 120,
            message_thread_id: 45,
            chat: { id: -100999777, type: 'supergroup' },
            from: { id: 777777, first_name: 'Admin' },
            photo: [{ file_id: 'admin_guide_photo', width: 800, height: 600 }],
            caption: 'این تنظیمات را فعال کنید',
            reply_to_message: {
              message_id: 119,
              caption: String(photoToSupport.body.caption),
            },
          },
        }),
      }),
      env
    );

    const adminPhotoToUser = calls.find(
      (c) => c.url.includes('/sendPhoto') && c.body.chat_id === 889900
    );
    assert.ok(adminPhotoToUser, 'Expected admin photo reply forwarded to user DM');
    assert.equal(adminPhotoToUser.body.photo, 'admin_guide_photo');
    assert.match(String(adminPhotoToUser.body.caption), /این تنظیمات را فعال کنید/);

    const confirmMsg = calls.find(
      (c) =>
        c.url.includes('/sendMessage') &&
        c.body.chat_id === -100999777 &&
        c.body.message_thread_id === 45
    );
    assert.ok(confirmMsg);
    assert.match(String(confirmMsg.body.text), /پاسخ به کاربر ارسال شد/);
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});

test('sendDatabaseBackup reports sendDocument failures to topic_logs_id via sendErrorAlert', async () => {
  const { db, sqlite } = createSqliteD1Adapter();
  const originalFetch = globalThis.fetch;
  const logAlerts: Array<Record<string, unknown>> = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/sendDocument')) {
      return new Response(
        JSON.stringify({ ok: false, error_code: 500, description: 'Internal Telegram Upload Error' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (url.includes('/sendMessage') && typeof init?.body === 'string') {
      logAlerts.push(JSON.parse(init.body) as Record<string, unknown>);
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const env = {
    DB: db,
    TELEGRAM_BOT_TOKEN: '123456:TEST_TOKEN',
  } as Env;

  try {
    await saveTopicRoute(db, 'logs', -100666777, 11);
    await saveTopicRoute(db, 'backups', -100666777, 22);

    const res = await sendDatabaseBackup(env, new Date('2026-11-27T12:00:00.000Z'));
    assert.equal(res.ok, false);
    assert.equal(logAlerts.length, 1);
    assert.equal(logAlerts[0].chat_id, -100666777);
    assert.equal(logAlerts[0].message_thread_id, 11);
    assert.match(String(logAlerts[0].text), /Database Backup/);
    assert.match(String(logAlerts[0].text), /500/);
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});

