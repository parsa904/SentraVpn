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
