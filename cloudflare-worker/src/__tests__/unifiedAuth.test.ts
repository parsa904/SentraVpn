import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  AUTH_PBKDF2_ITERATIONS,
  hashPassword,
  resetAuthRateLimitsForTests,
  verifyPassword,
} from '../auth.ts';
import { routeRequest } from '../routes.ts';
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

test('auth.ts uses 15,000-iteration PBKDF2-SHA256 with random 16-byte salt and verifies securely', async () => {
  const h1 = await hashPassword('SentraPass123');
  const h2 = await hashPassword('SentraPass123');

  assert.notEqual(h1, h2, 'Each hash must use a fresh random salt');
  const parts = h1.split('$');
  assert.equal(parts.length, 4);
  assert.equal(parts[0], 'pbkdf2_sha256');
  assert.equal(Number(parts[1]), AUTH_PBKDF2_ITERATIONS);
  assert.equal(parts[1], '15000');
  assert.equal(parts[2].length, 32, 'Salt must be 16 random bytes (32 hex chars)');
  assert.equal(parts[3].length, 64, 'Derived key must be 256 bits (64 hex chars)');

  assert.equal(await verifyPassword('SentraPass123', h1), true);
  assert.equal(await verifyPassword('SentraPass123', h2), true);
  assert.equal(await verifyPassword('WrongPass123', h1), false);
  assert.equal(await verifyPassword('', h1), false);
  assert.equal(await verifyPassword('SentraPass123', null), false);
});

test('POST /api/v1/auth/register & /login validate confirmPassword, optional email, 8-digit connect_code, usage, and 5/min per-IP rate limit', async () => {
  resetAuthRateLimitsForTests();
  const { db, sqlite } = createSqliteD1Adapter();
  const env = { DB: db } as Env;
  const ctx = {} as ExecutionContext;

  try {
    // 1. Mismatched confirmPassword rejected with 400
    const mismatchResp = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CF-Connecting-IP': '198.51.100.10',
        },
        body: JSON.stringify({
          username: 'Ali_Dev',
          password: 'password123',
          confirmPassword: 'password999',
        }),
      }),
      env,
      ctx
    );
    assert.equal(mismatchResp.status, 400);

    // 2. Successful registration WITHOUT optional email -> creates user + 8-digit connect_code + free plan
    const regResp = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CF-Connecting-IP': '198.51.100.11',
        },
        body: JSON.stringify({
          username: 'Ali_Dev',
          password: 'password123',
          confirmPassword: 'password123',
        }),
      }),
      env,
      ctx
    );
    assert.equal(regResp.status, 201);
    const regData = (await regResp.json()) as {
      success: boolean;
      connect_code: string;
      plan_tier: string;
      user: { username: string; telegram_id: number | null; email: string | null };
      subscription: { connect_code: string; plan_tier: string; web_used_bytes: number };
    };
    assert.equal(regData.success, true);
    assert.equal(regData.user.username, 'ali_dev');
    assert.equal(regData.user.telegram_id, null);
    assert.equal(regData.user.email, null);
    assert.match(regData.connect_code, /^\d{8}$/);
    assert.equal(regData.subscription.connect_code, regData.connect_code);
    assert.equal(regData.plan_tier, 'free');

    // 3. Duplicate username (case-insensitive) rejected with 409
    const dupResp = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CF-Connecting-IP': '198.51.100.12',
        },
        body: JSON.stringify({
          username: 'ALI_DEV',
          password: 'password123',
          confirmPassword: 'password123',
          email: 'ali@example.com',
        }),
      }),
      env,
      ctx
    );
    assert.equal(dupResp.status, 409);

    // 4. Registration WITH optional email succeeds
    const regEmailResp = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CF-Connecting-IP': '198.51.100.13',
        },
        body: JSON.stringify({
          username: 'sara_99',
          password: 'secret99',
          confirmPassword: 'secret99',
          email: 'Sara@Example.COM',
        }),
      }),
      env,
      ctx
    );
    assert.equal(regEmailResp.status, 201);
    const regEmailData = (await regEmailResp.json()) as { user: { email: string } };
    assert.equal(regEmailData.user.email, 'sara@example.com');

    // 5. Login returns connect_code, plan_tier, and usage info
    const loginResp = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CF-Connecting-IP': '198.51.100.14',
        },
        body: JSON.stringify({
          username: 'ali_dev',
          password: 'password123',
        }),
      }),
      env,
      ctx
    );
    assert.equal(loginResp.status, 200);
    const loginData = (await loginResp.json()) as {
      connect_code: string;
      plan_tier: string;
      subscription: {
        connect_code: string;
        plan_tier: string;
        web_used_bytes: number;
        download_used_bytes: number;
        special_used_bytes: number;
        remaining_bytes: number;
      };
    };
    assert.equal(loginData.connect_code, regData.connect_code);
    assert.equal(loginData.plan_tier, 'free');
    assert.equal(loginData.subscription.web_used_bytes, 0);
    assert.equal(loginData.subscription.download_used_bytes, 0);
    assert.ok(loginData.subscription.remaining_bytes > 0);

    // 6. Rate limiting: 5 failed login attempts from same IP -> 6th returns 429 with Retry-After
    for (let i = 0; i < 5; i += 1) {
      const failResp = await routeRequest(
        new Request('https://sentra-core.kziepr.workers.dev/api/v1/auth/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'CF-Connecting-IP': '203.0.113.55',
          },
          body: JSON.stringify({
            username: 'ali_dev',
            password: 'wrong_password',
          }),
        }),
        env,
        ctx
      );
      assert.equal(failResp.status, 401);
    }

    const blockedResp = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CF-Connecting-IP': '203.0.113.55',
        },
        body: JSON.stringify({
          username: 'ali_dev',
          password: 'password123',
        }),
      }),
      env,
      ctx
    );
    assert.equal(blockedResp.status, 429);
    assert.ok(Number(blockedResp.headers.get('Retry-After')) >= 1);
  } finally {
    resetAuthRateLimitsForTests();
    sqlite.close();
  }
});

test('Telegram Bot unified auth: 2-button unlinked Account gate, secure registration FSM (deleteMessage + hashed state), and App account linking', async () => {
  resetAuthRateLimitsForTests();
  const { db, sqlite } = createSqliteD1Adapter();
  const originalFetch = globalThis.fetch;
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = String(input).split('/').pop() || '';
    const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    calls.push({ method, body });
    return new Response(JSON.stringify({ ok: true, result: { message_id: calls.length + 100 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const env = {
    DB: db,
    TELEGRAM_BOT_TOKEN: '123456:TEST_TOKEN',
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
    // --- Flow A: Brand-new Telegram user registers via "📝 ثبت‌نام جدید" ---
    const tgUserA = { id: 700101, first_name: 'Kian' };

    // 1. Tap "👤 حساب کاربری" without any existing account -> ONLY 2 inline buttons
    const acctGate = await sendUpdate({
      update_id: 9001,
      message: {
        message_id: 10,
        chat: { id: 700101, type: 'private' },
        from: tgUserA,
        text: '👤 حساب کاربری',
      },
    });
    const gateMarkup = acctGate[0].body.reply_markup as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
    const gateButtons = gateMarkup.inline_keyboard.flat();
    assert.equal(gateButtons.length, 2);
    assert.equal(gateButtons[0].text, '📝 ثبت‌نام جدید');
    assert.equal(gateButtons[0].callback_data, 'auth_register_new');
    assert.equal(gateButtons[1].text, '🔑 ورود به حساب موجود (اتصال به اپلیکیشن)');
    assert.equal(gateButtons[1].callback_data, 'auth_login_app');

    // 2. Click "📝 ثبت‌نام جدید" -> prompts for username
    await sendUpdate({
      update_id: 9002,
      callback_query: {
        id: 'cb_reg_1',
        from: tgUserA,
        message: { message_id: 101, chat: { id: 700101, type: 'private' } },
        data: 'auth_register_new',
      },
    });

    // 3. Send desired username
    await sendUpdate({
      update_id: 9003,
      message: {
        message_id: 11,
        chat: { id: 700101, type: 'private' },
        from: tgUserA,
        text: 'kian_vpn',
      },
    });

    // 4. Send password -> message MUST be deleted via deleteMessage & NEVER stored in plaintext
    const passStepCalls = await sendUpdate({
      update_id: 9004,
      message: {
        message_id: 12,
        chat: { id: 700101, type: 'private' },
        from: tgUserA,
        text: 'MySecret789',
      },
    });
    assert.ok(
      passStepCalls.some((c) => c.method === 'deleteMessage' && c.body.message_id === 12),
      'Bot must delete password message immediately'
    );
    const stateRow = sqlite
      .prepare('SELECT state_type, payload_json FROM telegram_states WHERE telegram_id = ?')
      .get(700101) as { state_type: string; payload_json: string };
    assert.equal(stateRow.state_type, 'awaiting_register_confirm_password');
    assert.equal(
      stateRow.payload_json.includes('MySecret789'),
      false,
      'Plaintext password must NEVER be stored in telegram_states'
    );
    assert.ok(stateRow.payload_json.includes('pbkdf2_sha256$15000$'));

    // 5. Confirm password -> message deleted, user & 8-digit connect_code created, full Account panel shown
    const confirmCalls = await sendUpdate({
      update_id: 9005,
      message: {
        message_id: 13,
        chat: { id: 700101, type: 'private' },
        from: tgUserA,
        text: 'MySecret789',
      },
    });
    assert.ok(
      confirmCalls.some((c) => c.method === 'deleteMessage' && c.body.message_id === 13),
      'Bot must delete confirm-password message immediately'
    );
    assert.ok(
      confirmCalls.some((c) => c.method === 'sendMessage' && String(c.body.text).includes('کد اتصال ۸ رقمی')),
      'Account panel with 8-digit connect code must be sent after registration'
    );

    const createdUser = sqlite
      .prepare('SELECT id, telegram_id, username, password_hash FROM users WHERE telegram_id = ?')
      .get(700101) as { id: number; telegram_id: number; username: string; password_hash: string };
    assert.equal(createdUser.username, 'kian_vpn');
    assert.equal(await verifyPassword('MySecret789', createdUser.password_hash), true);

    // 6. Now user can log into Sentra Client API with the exact same Telegram-created credentials!
    const apiLoginAfterBotReg = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CF-Connecting-IP': '198.51.100.77',
        },
        body: JSON.stringify({
          username: 'kian_vpn',
          password: 'MySecret789',
        }),
      }),
      env,
      {} as ExecutionContext
    );
    assert.equal(apiLoginAfterBotReg.status, 200);

    // --- Flow B: User registers in Sentra Client App FIRST, then links Telegram via "🔑 ورود به حساب موجود" ---
    const appRegResp = await routeRequest(
      new Request('https://sentra-core.kziepr.workers.dev/api/v1/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CF-Connecting-IP': '198.51.100.88',
        },
        body: JSON.stringify({
          username: 'app_first_user',
          password: 'AppPassword99',
          confirmPassword: 'AppPassword99',
        }),
      }),
      env,
      {} as ExecutionContext
    );
    assert.equal(appRegResp.status, 201);
    const appRegJson = (await appRegResp.json()) as { connect_code: string };

    const tgUserB = { id: 700202, first_name: 'Mina' };
    // Even if Mina previously ran /start (creating a passwordless shell), Account Linking must succeed cleanly!
    await sendUpdate({
      update_id: 9010,
      message: { message_id: 20, chat: { id: 700202, type: 'private' }, from: tgUserB, text: '/start' },
    });
    await sendUpdate({
      update_id: 9011,
      callback_query: {
        id: 'cb_login_app',
        from: tgUserB,
        message: { message_id: 110, chat: { id: 700202, type: 'private' } },
        data: 'auth_login_app',
      },
    });
    await sendUpdate({
      update_id: 9012,
      message: {
        message_id: 21,
        chat: { id: 700202, type: 'private' },
        from: tgUserB,
        text: 'app_first_user',
      },
    });
    const linkCalls = await sendUpdate({
      update_id: 9013,
      message: {
        message_id: 22,
        chat: { id: 700202, type: 'private' },
        from: tgUserB,
        text: 'AppPassword99',
      },
    });

    assert.ok(
      linkCalls.some((c) => c.method === 'deleteMessage' && c.body.message_id === 22),
      'Bot must delete login password message immediately'
    );
    assert.ok(
      linkCalls.some(
        (c) =>
          c.method === 'sendMessage' && String(c.body.text).includes(appRegJson.connect_code)
      ),
      'Bot must display the existing 8-digit connect_code after linking App account'
    );

    const linkedRow = sqlite
      .prepare('SELECT telegram_id FROM users WHERE username = ?')
      .get('app_first_user') as { telegram_id: number };
    assert.equal(linkedRow.telegram_id, 700202);

    // Another Telegram user attempting to link an already-linked account is safely rejected
    const tgAttacker = { id: 700303, first_name: 'Other' };
    await sendUpdate({
      update_id: 9020,
      callback_query: {
        id: 'cb_login_other',
        from: tgAttacker,
        message: { message_id: 120, chat: { id: 700303, type: 'private' } },
        data: 'auth_login_app',
      },
    });
    await sendUpdate({
      update_id: 9021,
      message: {
        message_id: 31,
        chat: { id: 700303, type: 'private' },
        from: tgAttacker,
        text: 'app_first_user',
      },
    });
    const hijackCalls = await sendUpdate({
      update_id: 9022,
      message: {
        message_id: 32,
        chat: { id: 700303, type: 'private' },
        from: tgAttacker,
        text: 'AppPassword99',
      },
    });
    assert.ok(
      hijackCalls.some((c) => String(c.body.text || '').includes('قبلاً به یک حساب تلگرام دیگر متصل شده')),
      'Linking an already-linked account from another Telegram ID must be rejected'
    );
    const unchangedRow = sqlite
      .prepare('SELECT telegram_id FROM users WHERE username = ?')
      .get('app_first_user') as { telegram_id: number };
    assert.equal(unchangedRow.telegram_id, 700202);
  } finally {
    globalThis.fetch = originalFetch;
    resetAuthRateLimitsForTests();
    sqlite.close();
  }
});
