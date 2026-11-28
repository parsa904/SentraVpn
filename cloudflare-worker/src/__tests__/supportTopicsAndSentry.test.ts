import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  formatAiReadyErrorMessage,
  parseSentryWebhookPayload,
  reportErrorToTelegram,
  resetErrorReporterThrottleForTests,
} from '../errorReporter.ts';
import { routeRequest } from '../routes.ts';
import { ensureSchemaColumns, getOpenSupportSessionByUser } from '../supportSessions.ts';
import { saveTopicRoute } from '../telegramTopics.ts';
import { handleTelegramWebhook } from '../telegramWebhook.ts';
import { resetAllWorkerCachesForTests } from '../workerCache.ts';
import type { Env } from '../types.ts';

function createSqliteD1(options: { dropSupportSessions?: boolean } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  const schemaPath = path.resolve(import.meta.dirname, '../../schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  for (const stmt of sql.split(';').map((s) => s.trim()).filter(Boolean)) {
    sqlite.exec(stmt);
  }
  if (options.dropSupportSessions) {
    sqlite.exec('DROP TABLE IF EXISTS support_sessions;');
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
          if (/^\s*SELECT/i.test(query)) {
            const rows = sqlite.prepare(query).all(...(params as never[])) as T[];
            return { success: true, results: rows, meta: { changes: 0 } };
          }
          const info = sqlite.prepare(query).run(...(params as never[]));
          return {
            success: true,
            results: [] as T[],
            meta: { last_row_id: Number(info.lastInsertRowid), changes: Number(info.changes) },
          };
        },
        async run() {
          const info = sqlite.prepare(query).run(...(params as never[]));
          return {
            success: true,
            meta: { last_row_id: Number(info.lastInsertRowid), changes: Number(info.changes) },
          };
        },
      };
      return stmtObj;
    },
    async batch<T = Record<string, unknown>>(stmts: Array<{ all: () => Promise<unknown> }>) {
      const out = [];
      for (const s of stmts) out.push(await s.all());
      return out as Array<D1Result<T>>;
    },
  } as unknown as D1Database;

  return { sqlite, db };
}

async function computeHmacHex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function postUpdate(env: Env, update: Record<string, unknown>): Promise<Response> {
  return await handleTelegramWebhook(
    new Request('https://sentra-core.kziepr.workers.dev/api/v1/telegram/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(update),
    }),
    env
  );
}

test('ensureSchemaColumns auto-creates missing support_sessions table cleanly on legacy D1', async () => {
  const { sqlite, db } = createSqliteD1({ dropSupportSessions: true });
  try {
    const before = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='support_sessions'")
      .get();
    assert.equal(before, undefined);

    await ensureSchemaColumns(db);

    const after = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='support_sessions'")
      .get() as { name: string } | undefined;
    assert.equal(after?.name, 'support_sessions');

    const sess = await getOpenSupportSessionByUser(db, 12345);
    assert.equal(sess, null);
  } finally {
    sqlite.close();
  }
});

test('Feature 1 & 2: one-click support_reply button, auto-escalated dedicated Forum Topic, direct admin chat, and close/delete topic', async () => {
  resetAllWorkerCachesForTests();
  const { sqlite, db } = createSqliteD1();
  const originalFetch = globalThis.fetch;

  const tgCalls: Array<{ method: string; body: Record<string, unknown> }> = [];
  let nextMsgId = 500;
  let createdTopicCount = 0;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const methodMatch = /\/bot[^/]+\/([A-Za-z0-9_]+)/.exec(url);
    const method = methodMatch ? methodMatch[1] : 'unknown';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    tgCalls.push({ method, body });

    if (method === 'createForumTopic') {
      createdTopicCount += 1;
      return new Response(
        JSON.stringify({
          ok: true,
          result: { message_thread_id: 900 + createdTopicCount, name: body.name },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    nextMsgId += 1;
    return new Response(
      JSON.stringify({ ok: true, result: { message_id: nextMsgId } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as typeof fetch;

  const GROUP_ID = -100777888999;
  const SUPPORT_TOPIC_ID = 33;
  const ADMIN_ID = 111111;
  const USER_ID = 555666;

  const env: Env = {
    DB: db,
    TELEGRAM_BOT_TOKEN: '123456789:TEST_SUPPORT_TOPIC_BOT_TOKEN_ABC123',
    ADMIN_TELEGRAM_ID: String(ADMIN_ID),
  };

  try {
    await saveTopicRoute(db, 'support', GROUP_ID, SUPPORT_TOPIC_ID);

    // 1. User starts support ticket flow and sends message #1 (msg_id = 401)
    await postUpdate(env, {
      update_id: 1,
      callback_query: {
        id: 'cb-ticket-1',
        from: { id: USER_ID, first_name: 'Sara', username: 'sara_vpn' },
        message: { message_id: 400, chat: { id: USER_ID, type: 'private' } },
        data: 'user_ticket_new_connection',
      },
    });

    tgCalls.length = 0;
    await postUpdate(env, {
      update_id: 2,
      message: {
        message_id: 401,
        from: { id: USER_ID, first_name: 'Sara', username: 'sara_vpn' },
        chat: { id: USER_ID, type: 'private' },
        text: 'سلام، اتصال من روی ایرانسل برقرار نمیشه.',
      },
    });

    // Verify forwarded message in general Support Topic has inline button `💬 پاسخ به کاربر` with `support_reply:555666:401`
    const forwarded1 = tgCalls.find(
      (c) => c.method === 'sendMessage' && c.body.chat_id === GROUP_ID && c.body.message_thread_id === SUPPORT_TOPIC_ID
    );
    assert.ok(forwarded1, 'Expected user support message to be forwarded to Support Topic');
    const markup1 = forwarded1.body.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
    assert.equal(markup1.inline_keyboard[0][0].text, '💬 پاسخ به کاربر');
    assert.equal(markup1.inline_keyboard[0][0].callback_data, `support_reply:${USER_ID}:401`);

    // 2. Admin clicks `💬 پاسخ به کاربر` in the support group
    tgCalls.length = 0;
    await postUpdate(env, {
      update_id: 3,
      callback_query: {
        id: 'cb-reply-1',
        from: { id: ADMIN_ID, first_name: 'Admin' },
        message: {
          message_id: 502,
          message_thread_id: SUPPORT_TOPIC_ID,
          chat: { id: GROUP_ID, type: 'supergroup' },
        },
        data: `support_reply:${USER_ID}:401`,
      },
    });

    const stateRow = sqlite
      .prepare('SELECT state_type, payload_json FROM telegram_states WHERE telegram_id = ?')
      .get(ADMIN_ID) as { state_type: string; payload_json: string } | undefined;
    assert.equal(stateRow?.state_type, 'admin_awaiting_support_reply');
    assert.equal(JSON.parse(stateRow!.payload_json).targetUserId, USER_ID);
    assert.equal(JSON.parse(stateRow!.payload_json).userMessageId, 401);

    // 3. Admin sends reply directly in group -> delivered to user replying to msg 401, confirmed in group
    tgCalls.length = 0;
    await postUpdate(env, {
      update_id: 4,
      message: {
        message_id: 510,
        message_thread_id: SUPPORT_TOPIC_ID,
        from: { id: ADMIN_ID, first_name: 'Admin' },
        chat: { id: GROUP_ID, type: 'supergroup' },
        text: 'لطفاً روی حالت وب‌گردی تست کنید و نتیجه را بفرستید.',
      },
    });

    const deliveredToUser = tgCalls.find(
      (c) => c.method === 'sendMessage' && c.body.chat_id === USER_ID
    );
    assert.ok(deliveredToUser, 'Admin reply must be delivered directly to user private chat');
    assert.equal(deliveredToUser.body.reply_to_message_id, 401);
    assert.ok(String(deliveredToUser.body.text).includes('پاسخ تیم پشتیبانی SentraVPN'));

    const groupConfirm = tgCalls.find(
      (c) =>
        c.method === 'sendMessage' &&
        c.body.chat_id === GROUP_ID &&
        String(c.body.text).includes('✅ پاسخ برای کاربر ارسال شد')
    );
    assert.ok(groupConfirm, 'Expected confirmation message in support group');

    // Still at message_count = 2 -> no dedicated topic created yet
    const sessAfter2 = await getOpenSupportSessionByUser(db, USER_ID);
    assert.equal(sessAfter2?.message_count, 2);
    assert.equal(sessAfter2?.topic_thread_id, null);

    // 4. User replies to admin's support message in private chat (message #3 -> triggers createForumTopic!)
    tgCalls.length = 0;
    await postUpdate(env, {
      update_id: 5,
      message: {
        message_id: 405,
        from: { id: USER_ID, first_name: 'Sara', username: 'sara_vpn' },
        chat: { id: USER_ID, type: 'private' },
        text: 'تست کردم ولی هنوز پینگ بالا میده، اسکرین‌شات بفرستم؟',
        reply_to_message: {
          message_id: 505,
          text: '💬 پاسخ تیم پشتیبانی SentraVPN:\n\nلطفاً روی حالت وب‌گردی تست کنید',
        },
      },
    });

    const createTopicCall = tgCalls.find((c) => c.method === 'createForumTopic');
    assert.ok(createTopicCall, 'Ongoing conversation (3rd message) must call createForumTopic');
    assert.equal(createTopicCall.body.chat_id, GROUP_ID);
    assert.equal(createTopicCall.body.name, `🎫 پشتیبانی: Sara (${USER_ID})`);

    const sessAfter3 = await getOpenSupportSessionByUser(db, USER_ID);
    assert.equal(sessAfter3?.message_count, 3);
    assert.equal(sessAfter3?.topic_thread_id, 901);

    // Control panel with `🗑 پایان گفتگو و حذف تاپیک` button sent inside topic 901 and pinned
    const ctrlMsg = tgCalls.find(
      (c) =>
        c.method === 'sendMessage' &&
        c.body.chat_id === GROUP_ID &&
        c.body.message_thread_id === 901 &&
        Boolean(c.body.reply_markup)
    );
    assert.ok(ctrlMsg, 'Expected control panel message inside dedicated topic 901');
    const ctrlMarkup = ctrlMsg.body.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
    assert.equal(ctrlMarkup.inline_keyboard[0][0].text, '🗑 پایان گفتگو و حذف تاپیک');
    assert.equal(ctrlMarkup.inline_keyboard[0][0].callback_data, `close_support_topic:${USER_ID}:901`);

    const pinCall = tgCalls.find((c) => c.method === 'pinChatMessage');
    assert.ok(pinCall, 'Expected control panel message to be pinned');

    // User's 3rd message itself was also routed directly into dedicated topic 901
    const routedToDedicated = tgCalls.find(
      (c) =>
        c.method === 'sendMessage' &&
        c.body.chat_id === GROUP_ID &&
        c.body.message_thread_id === 901 &&
        String(c.body.text).includes('پینگ بالا میده')
    );
    assert.ok(routedToDedicated, 'User message must route directly into dedicated topic 901');

    // 5. Admin sends a plain message inside topic 901 (NO button, NO reply) -> auto-forwarded to user!
    tgCalls.length = 0;
    await postUpdate(env, {
      update_id: 6,
      message: {
        message_id: 610,
        message_thread_id: 901,
        from: { id: ADMIN_ID, first_name: 'Admin' },
        chat: { id: GROUP_ID, type: 'supergroup' },
        text: 'بله لطفاً اسکرین‌شات بفرستید تا نود اختصاصی براتون چک کنم.',
      },
    });

    const autoForwarded = tgCalls.find(
      (c) => c.method === 'sendMessage' && c.body.chat_id === USER_ID
    );
    assert.ok(autoForwarded, 'Plain admin message in dedicated topic must auto-forward to user');
    assert.ok(String(autoForwarded.body.text).includes('اسکرین‌شات بفرستید'));

    // 6. Admin clicks `🗑 پایان گفتگو و حذف تاپیک` -> calls deleteForumTopic, closes D1 session, notifies user
    tgCalls.length = 0;
    await postUpdate(env, {
      update_id: 7,
      callback_query: {
        id: 'cb-close-topic',
        from: { id: ADMIN_ID, first_name: 'Admin' },
        message: {
          message_id: 520,
          message_thread_id: 901,
          chat: { id: GROUP_ID, type: 'supergroup' },
        },
        data: `close_support_topic:${USER_ID}:901`,
      },
    });

    const deleteCall = tgCalls.find((c) => c.method === 'deleteForumTopic');
    assert.ok(deleteCall, 'Expected deleteForumTopic to be called');
    assert.equal(deleteCall.body.chat_id, GROUP_ID);
    assert.equal(deleteCall.body.message_thread_id, 901);

    const closedNotify = tgCalls.find(
      (c) =>
        c.method === 'sendMessage' &&
        c.body.chat_id === USER_ID &&
        String(c.body.text).includes('🔒 گفتگوی پشتیبانی توسط پشتیبانی بسته شد')
    );
    assert.ok(closedNotify, 'Expected user notification when support topic is closed');

    const openAfterClose = await getOpenSupportSessionByUser(db, USER_ID);
    assert.equal(openAfterClose, null, 'Closed session must no longer be returned as open');
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});

test('Feature 3: Sentry Webhook & Sentry-sourced errors include #Sentry_Error | [SENTRY], project, level, issue link, AI-READY block, and skip Sentry loopback', async () => {
  resetAllWorkerCachesForTests();
  resetErrorReporterThrottleForTests();
  const { sqlite, db } = createSqliteD1();
  const originalFetch = globalThis.fetch;

  const sentRequests: Array<{ url: string; body: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sentRequests.push({
      url: String(input),
      body: typeof init?.body === 'string' ? init.body : '',
    });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const env: Env = {
    DB: db,
    TELEGRAM_BOT_TOKEN: '123456789:TEST_SENTRY_WEBHOOK_BOT_TOKEN_XYZ',
    SENTRY_DSN_WORKER: 'https://abcdef1234567890abcdef12345678@o99.ingest.sentry.io/12345',
    SENTRY_WEBHOOK_SECRET: 'sentry-hook-secret-2026',
  };

  try {
    await saveTopicRoute(db, 'logs', -100999111, 55);

    const webhookPayload = {
      action: 'created',
      data: {
        issue: {
          shortId: 'SENTRA-WORKER-42',
          title: 'D1_ERROR: no such column: foo',
          culprit: 'cloudflare-worker/src/routes.ts',
          level: 'fatal',
          permalink: 'https://sentry.io/organizations/sentra/issues/42001/',
          project: { slug: 'sentra-worker' },
          metadata: {
            type: 'D1QueryError',
            value: 'no such column: foo',
          },
        },
        event: {
          release: 'sentra-worker@1.4.0',
          environment: 'production',
          exception: {
            values: [
              {
                type: 'D1QueryError',
                value: 'no such column: foo',
                stacktrace: {
                  frames: [
                    { filename: 'src/routes.ts', function: 'routeRequest', lineno: 312, colno: 14 },
                  ],
                },
              },
            ],
          },
        },
      },
    };

    const parsed = parseSentryWebhookPayload(webhookPayload);
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.report.platform, 'sentry');
      assert.equal(parsed.report.sentryProject, 'sentra-worker');
      assert.equal(parsed.report.sentryLevel, 'fatal');
      assert.equal(parsed.report.sentryIssueUrl, 'https://sentry.io/organizations/sentra/issues/42001/');
    }

    const rawBody = JSON.stringify(webhookPayload);

    // 1. Invalid HMAC signature -> 401
    const badResp = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/webhooks/sentry', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Sentry-Hook-Signature': '0'.repeat(64),
        },
        body: rawBody,
      }),
      env
    );
    assert.equal(badResp.status, 401);

    // 2. Valid HMAC signature -> 200 and Telegram receives #Sentry_Error | [SENTRY]
    sentRequests.length = 0;
    const validSig = await computeHmacHex('sentry-hook-secret-2026', rawBody);
    const okResp = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/webhooks/sentry', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Sentry-Hook-Signature': validSig,
        },
        body: rawBody,
      }),
      env
    );
    assert.equal(okResp.status, 200);

    const tgReq = sentRequests.find((r) => r.url.includes('api.telegram.org'));
    assert.ok(tgReq, 'Expected Sentry webhook to dispatch alert to Telegram logs topic');
    const tgBody = JSON.parse(tgReq.body) as { text: string; message_thread_id: number };
    assert.equal(tgBody.message_thread_id, 55);
    assert.ok(tgBody.text.includes('#Sentry_Error'));
    assert.ok(tgBody.text.includes('[SENTRY]'));
    assert.ok(tgBody.text.includes('sentra-worker'));
    assert.ok(tgBody.text.includes('fatal'));
    assert.ok(tgBody.text.includes('https://sentry.io/organizations/sentra/issues/42001/'));
    assert.ok(tgBody.text.includes('=== SENTRAVPN ERROR REPORT (AI-READY) ==='));

    // Must NOT loop back to Sentry Envelope API!
    const sentryEnvelopeLoop = sentRequests.find((r) => r.url.includes('/envelope/'));
    assert.equal(sentryEnvelopeLoop, undefined, 'Sentry webhook alert must NOT re-send to Sentry Envelope API');

    // 3. Direct SDK-tagged client report (`source: 'sentry'`) also carries #Sentry_Error | [SENTRY]
    sentRequests.length = 0;
    await reportErrorToTelegram(env, {
      platform: 'android',
      source: 'sentry',
      sentryProject: 'sentra-client',
      sentryLevel: 'error',
      appVersion: '1.0.5',
      moduleOrFile: 'vpn_manager.rs',
      actionOrRoute: 'start_tunnel',
      errorName: 'TunStartError',
      errorMessage: 'Sing-box failed to bind TUN',
    });

    const clientTgReq = sentRequests.find((r) => r.url.includes('api.telegram.org'));
    assert.ok(clientTgReq);
    const clientTgText = (JSON.parse(clientTgReq.body) as { text: string }).text;
    assert.ok(clientTgText.includes('#Sentry_Error'));
    assert.ok(clientTgText.includes('[SENTRY]'));
    assert.ok(clientTgText.includes('sentra-client'));
    assert.ok(clientTgText.includes('=== SENTRAVPN ERROR REPORT (AI-READY) ==='));
    assert.equal(
      sentRequests.find((r) => r.url.includes('/envelope/')),
      undefined,
      'SDK-sourced Sentry error must not double-send to Sentry Envelope API'
    );

    // Non-Sentry normal Worker report does NOT get #Sentry_Error tag
    const regularHtml = formatAiReadyErrorMessage({
      platform: 'worker',
      moduleOrFile: 'routes.ts',
      actionOrRoute: 'GET /health',
      errorName: 'Error',
      errorMessage: 'Normal worker error',
    });
    assert.equal(regularHtml.includes('#Sentry_Error'), false);
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});
