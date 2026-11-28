import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import workerDefault, { resolveAllowedOrigin } from '../index.ts';
import { routeRequest } from '../routes.ts';
import { signTelegramInitDataForTests, verifyTelegramInitData } from '../miniAppAuth.ts';
import { resetAllWorkerCachesForTests } from '../workerCache.ts';
import type { Env } from '../types.ts';

function toSqlParams(values: unknown[]): SQLInputValue[] {
  return values.map((v) => (v === undefined ? null : (v as SQLInputValue)));
}

function createSqliteD1(sqlite: DatabaseSync): D1Database {
  const makeStmt = (sql: string, bound: unknown[] = []) => ({
    bind(...values: unknown[]) {
      return makeStmt(sql, values);
    },
    async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
      const row = sqlite.prepare(sql).get(...toSqlParams(bound)) as
        | Record<string, unknown>
        | undefined;
      if (!row) return null;
      if (colName) return (row[colName] as T) ?? null;
      return row as T;
    },
    async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
      const results = sqlite.prepare(sql).all(...toSqlParams(bound)) as T[];
      return {
        results,
        success: true,
        meta: {
          duration: 1,
          size_after: 0,
          rows_read: results.length,
          rows_written: 0,
          last_row_id: 0,
          changed_db: false,
          changes: 0,
        },
      };
    },
    async run(): Promise<D1Result> {
      const info = sqlite.prepare(sql).run(...toSqlParams(bound));
      const changes = Number(info.changes || 0);
      return {
        results: [],
        success: true,
        meta: {
          duration: 1,
          size_after: 0,
          rows_read: 0,
          rows_written: changes,
          last_row_id: Number(info.lastInsertRowid || 0),
          changed_db: changes > 0,
          changes,
        },
      };
    },
    async raw<T = unknown[]>(): Promise<T[]> {
      const rows = sqlite.prepare(sql).all(...toSqlParams(bound)) as Record<string, unknown>[];
      return rows.map((r) => Object.values(r)) as T[];
    },
    _sql: sql,
    _bound: bound,
  });

  return {
    prepare(sql: string) {
      return makeStmt(sql);
    },
    async batch(statements: Array<{ _sql: string; _bound: unknown[] }>) {
      const results: D1Result[] = [];
      for (const s of statements) {
        const trimmed = s._sql.trim().toUpperCase();
        if (trimmed.startsWith('SELECT') || trimmed.startsWith('PRAGMA')) {
          const rows = sqlite.prepare(s._sql).all(...toSqlParams(s._bound));
          results.push({
            results: rows,
            success: true,
            meta: {
              duration: 1,
              size_after: 0,
              rows_read: rows.length,
              rows_written: 0,
              last_row_id: 0,
              changed_db: false,
              changes: 0,
            },
          });
        } else {
          const info = sqlite.prepare(s._sql).run(...toSqlParams(s._bound));
          const changes = Number(info.changes || 0);
          results.push({
            results: [],
            success: true,
            meta: {
              duration: 1,
              size_after: 0,
              rows_read: 0,
              rows_written: changes,
              last_row_id: Number(info.lastInsertRowid || 0),
              changed_db: changes > 0,
              changes,
            },
          });
        }
      }
      return results;
    },
    async exec(sql: string) {
      sqlite.exec(sql);
      return { count: 1, duration: 1 };
    },
    async dump() {
      return new ArrayBuffer(0);
    },
  } as unknown as D1Database;
}

function setupDb(): DatabaseSync {
  const sqlite = new DatabaseSync(':memory:');
  const schemaPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../schema.sql');
  sqlite.exec(fs.readFileSync(schemaPath, 'utf-8'));
  return sqlite;
}

test('verifyTelegramInitData validates authentic HMAC-SHA256 signatures and rejects tampered or expired initData', async () => {
  const botToken = '123456:ABC-DEF-telegram-test-token';
  const nowSec = Math.floor(Date.now() / 1000);
  const userJson = JSON.stringify({
    id: 7771234,
    first_name: 'Parsa',
    last_name: 'Dev',
    username: 'parsadev',
  });

  const validInitData = await signTelegramInitDataForTests(
    {
      auth_date: String(nowSec - 10),
      query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
      user: userJson,
    },
    botToken
  );

  const okRes = await verifyTelegramInitData(validInitData, botToken, nowSec);
  assert.equal(okRes.ok, true);
  if (okRes.ok) {
    assert.equal(okRes.data.user.id, 7771234);
    assert.equal(okRes.data.user.first_name, 'Parsa');
  }

  // Tampered user id must fail HMAC check
  const tampered = validInitData.replace('7771234', '7779999');
  const tamperedRes = await verifyTelegramInitData(tampered, botToken, nowSec);
  assert.equal(tamperedRes.ok, false);

  // Wrong bot token must fail
  const wrongTokenRes = await verifyTelegramInitData(validInitData, '999999:wrong-token', nowSec);
  assert.equal(wrongTokenRes.ok, false);

  // Expired auth_date (>24h old) must fail
  const expiredInitData = await signTelegramInitDataForTests(
    {
      auth_date: String(nowSec - 90_000),
      user: userJson,
    },
    botToken
  );
  const expiredRes = await verifyTelegramInitData(expiredInitData, botToken, nowSec);
  assert.equal(expiredRes.ok, false);
});

test('POST /api/v1/miniapp/me auto-provisions new user + 8-digit connect_code, returns live nodes + CORS for *.pages.dev, and POST /api/v1/miniapp/credentials updates unified login', async () => {
  const sqlite = setupDb();
  const db = createSqliteD1(sqlite);
  resetAllWorkerCachesForTests();

  const botToken = '555666:miniapp-secret-token';
  const env: Env = {
    DB: db,
    TELEGRAM_BOT_TOKEN: botToken,
    BOT_USERNAME: 'SentraVPNBot',
    MINIAPP_URL: 'https://sentravpn.pages.dev',
  };

  try {
    // Seed 2 healthy active nodes
    sqlite
      .prepare(
        `INSERT INTO donated_outbounds
           (tag, protocol, server_address, server_port, config_json, country_code, country_name, status, latency_ms, health_score, is_official, allow_web, allow_download, fingerprint_sha256)
         VALUES
           ('DE-1', 'vless', '1.1.1.1', 443, '{"type":"vless","tag":"DE-1","server":"1.1.1.1","server_port":443}', 'DE', 'آلمان 🇩🇪', 'active', 50, 96, 1, 1, 1, 'fp-m1'),
           ('NL-1', 'vless', '2.2.2.2', 443, '{"type":"vless","tag":"NL-1","server":"2.2.2.2","server_port":443}', 'NL', 'هلند 🇳🇱', 'active', 60, 94, 1, 1, 1, 'fp-m2')`
      )
      .run();

    // 1. Strict CORS check for *.pages.dev & spoof rejection
    const allowedReq = new Request('https://sentra-core.kziepr.workers.dev/api/v1/miniapp/me', {
      method: 'OPTIONS',
      headers: { Origin: 'https://preview-123.sentravpn.pages.dev' },
    });
    assert.equal(resolveAllowedOrigin(allowedReq, env), 'https://preview-123.sentravpn.pages.dev');

    const spoofReq = new Request('https://sentra-core.kziepr.workers.dev/api/v1/miniapp/me', {
      method: 'OPTIONS',
      headers: { Origin: 'https://evilpages.dev' },
    });
    assert.equal(resolveAllowedOrigin(spoofReq, env), null);

    const optResp = await workerDefault.fetch(
      allowedReq,
      env,
      {} as ExecutionContext
    );
    assert.equal(optResp.status, 204);
    assert.equal(
      optResp.headers.get('Access-Control-Allow-Origin'),
      'https://preview-123.sentravpn.pages.dev'
    );
    assert.ok(
      (optResp.headers.get('Access-Control-Allow-Headers') || '').includes('X-Telegram-Init-Data')
    );

    // 2. Reject invalid initData with 401
    const unauthResp = await workerDefault.fetch(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/miniapp/me', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://sentravpn.pages.dev',
        },
        body: JSON.stringify({ initData: 'user=%7B%22id%22%3A1%7D&hash=deadbeef' }),
      }),
      env,
      {} as ExecutionContext
    );
    assert.equal(unauthResp.status, 401);
    assert.equal(unauthResp.headers.get('Access-Control-Allow-Origin'), 'https://sentravpn.pages.dev');

    // 3. Valid initData auto-creates user & 8-digit connect_code
    const initData = await signTelegramInitDataForTests(
      {
        auth_date: String(Math.floor(Date.now() / 1000)),
        user: JSON.stringify({
          id: 424242,
          first_name: 'Nima',
          last_name: 'K',
          username: 'nima_tg',
        }),
      },
      botToken
    );

    const meResp = await workerDefault.fetch(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/miniapp/me', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://sentravpn.pages.dev',
          'X-Telegram-Init-Data': initData,
        },
        body: JSON.stringify({}),
      }),
      env,
      {} as ExecutionContext
    );
    assert.equal(meResp.status, 200);
    assert.equal(meResp.headers.get('Access-Control-Allow-Origin'), 'https://sentravpn.pages.dev');

    const meBody = (await meResp.json()) as Record<string, any>;
    assert.equal(meBody.success, true);
    assert.equal(meBody.is_new_user, true);
    assert.equal(meBody.user.telegram_id, 424242);
    assert.match(String(meBody.subscription.connect_code), /^\d{8}$/);
    assert.equal(meBody.subscription.plan_label, 'Free');
    assert.equal(meBody.servers.online_nodes, 2);
    assert.equal(meBody.servers.countries_count, 2);
    assert.ok(meBody.downloads.android_apk.includes('SentraVPN-Android-Universal.apk'));
    assert.ok(meBody.referral.invite_link.includes('ref_424242'));

    // 4. Update unified credentials via POST /api/v1/miniapp/credentials
    const credsResp = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/miniapp/credentials', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Init-Data': initData,
        },
        body: JSON.stringify({
          username: 'nima_app',
          password: 'SuperSecretPassword123',
          confirm_password: 'SuperSecretPassword123',
        }),
      }),
      env
    );
    assert.equal(credsResp.status, 200);
    const credsBody = (await credsResp.json()) as Record<string, any>;
    assert.equal(credsBody.success, true);
    assert.equal(credsBody.username, 'nima_app');

    // Verify password is stored hashed (never plaintext) and reflected in /miniapp/me
    const dbUser = sqlite
      .prepare('SELECT username, password_hash FROM users WHERE telegram_id = ?')
      .get(424242) as { username: string; password_hash: string };
    assert.equal(dbUser.username, 'nima_app');
    assert.ok(dbUser.password_hash.startsWith('pbkdf2_sha256$'));
    assert.ok(!dbUser.password_hash.includes('SuperSecretPassword123'));
  } finally {
    sqlite.close();
  }
});

test('Telegram Bot renders web_app Mini App button with configured MINIAPP_URL on main menu and account view', async () => {
  const sqlite = setupDb();
  const db = createSqliteD1(sqlite);

  const env: Env = {
    DB: db,
    TELEGRAM_BOT_TOKEN: '123:tg-miniapp-btn-token',
    MINIAPP_URL: 'https://custom-sentra.pages.dev',
  };

  const sentCalls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (urlStr.startsWith('https://api.telegram.org/')) {
      const method = urlStr.split('/').pop() || '';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      sentCalls.push({ method, body });
      return new Response(JSON.stringify({ ok: true, result: { message_id: sentCalls.length } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  try {
    // 1. /start returns ReplyKeyboard with web_app Mini App button
    const startRes = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/telegram/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          update_id: 901,
          message: {
            message_id: 1,
            chat: { id: 600123, type: 'private' },
            from: { id: 600123, first_name: 'Mina' },
            text: '/start',
          },
        }),
      }),
      env
    );
    assert.equal(startRes.status, 200);
    const startKeyboard = (
      sentCalls[0].body.reply_markup as {
        keyboard: Array<Array<{ text: string; web_app?: { url: string } }>>;
      }
    ).keyboard.flat();
    const miniAppMainBtn = startKeyboard.find((b) => b.web_app?.url);
    assert.ok(miniAppMainBtn, 'Main keyboard must contain web_app Mini App button');
    assert.equal(miniAppMainBtn?.text, '📱 ورود به پنل گرافیکی (Mini App)');
    assert.equal(miniAppMainBtn?.web_app?.url, 'https://custom-sentra.pages.dev');

    // Give user unified credentials so "👤 حساب کاربری" opens buildUserAccountView
    sqlite
      .prepare("UPDATE users SET username = 'mina_u', password_hash = 'pbkdf2_sha256$15000$a$b' WHERE telegram_id = 600123")
      .run();

    sentCalls.length = 0;
    const acctRes = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/telegram/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          update_id: 902,
          message: {
            message_id: 2,
            chat: { id: 600123, type: 'private' },
            from: { id: 600123, first_name: 'Mina' },
            text: '👤 حساب کاربری',
          },
        }),
      }),
      env
    );
    assert.equal(acctRes.status, 200);
    const acctInline = (
      sentCalls[0].body.reply_markup as {
        inline_keyboard: Array<Array<{ text: string; web_app?: { url: string } }>>;
      }
    ).inline_keyboard;
    assert.equal(acctInline[0][0].text, '📱 ورود به پنل گرافیکی (Mini App)');
    assert.equal(acctInline[0][0].web_app?.url, 'https://custom-sentra.pages.dev');

    // 3. Static miniapp/index.html exists and contains Telegram WebApp SDK + Tailwind CDN + Vazirmatn + RTL
    const miniappHtml = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../miniapp/index.html'),
      'utf-8'
    );
    assert.ok(miniappHtml.includes('dir="rtl"'));
    assert.ok(miniappHtml.includes('https://telegram.org/js/telegram-web-app.js'));
    assert.ok(miniappHtml.includes('https://cdn.tailwindcss.com'));
    assert.ok(miniappHtml.includes('Vazirmatn'));
    assert.ok(miniappHtml.includes('https://sentra-core.kziepr.workers.dev'));
    assert.ok(miniappHtml.includes('HapticFeedback'));
    assert.ok(!miniappHtml.includes('innerHTML'), 'Mini App must avoid innerHTML for XSS safety');
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});
