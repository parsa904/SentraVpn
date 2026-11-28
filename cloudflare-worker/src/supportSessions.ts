/**
 * Support Sessions persistence & auto-escalation helpers for Cloudflare D1.
 *
 * Tracks active user support conversations (`support_sessions`) and supports
 * one-time isolate-cached schema self-healing (`ensureSchemaColumns`) so
 * support workflows never crash even before migration 006 is manually applied,
 * while incurring zero DDL overhead on hot VPN config/node routes.
 */

export const SUPPORT_TOPIC_ESCALATION_THRESHOLD = 3; // Escalate after > 2 messages/exchanges

export interface SupportSessionRow {
  id: number;
  user_id: number;
  topic_thread_id: number | null;
  message_count: number;
  last_user_message_id: number | null;
  status: 'open' | 'closed';
  created_at: string;
  updated_at: string;
}

const ensuredDbs = new WeakSet<D1Database>();

export function resetSupportSessionsSchemaCacheForTests(): void {
  // WeakSet cannot be cleared globally; tests pass a fresh D1 adapter instance per test.
  // Keeping this exported hook for symmetry with other Worker cache reset helpers.
}

/**
 * Ensures the `support_sessions` table, required columns, and indexes exist in D1.
 * Cached per D1Database instance in isolate RAM so it runs at most once per isolate
 * and ONLY when a support session operation is invoked.
 */
export async function ensureSchemaColumns(db: D1Database): Promise<void> {
  if (ensuredDbs.has(db)) return;

  try {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS support_sessions (
          id                      INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id                 INTEGER NOT NULL,
          topic_thread_id         INTEGER,
          message_count           INTEGER NOT NULL DEFAULT 0,
          last_user_message_id    INTEGER,
          status                  TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'closed')),
          created_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`
      )
      .run();

    // Reconcile optional columns if an older partial table already existed
    try {
      const info = await db
        .prepare(`SELECT name FROM pragma_table_info('support_sessions')`)
        .all<{ name: string }>();
      const cols = new Set((info.results || []).map((r) => String(r.name)));
      if (cols.size > 0) {
        if (!cols.has('topic_thread_id')) {
          await db.prepare(`ALTER TABLE support_sessions ADD COLUMN topic_thread_id INTEGER`).run();
        }
        if (!cols.has('message_count')) {
          await db
            .prepare(`ALTER TABLE support_sessions ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0`)
            .run();
        }
        if (!cols.has('last_user_message_id')) {
          await db
            .prepare(`ALTER TABLE support_sessions ADD COLUMN last_user_message_id INTEGER`)
            .run();
        }
        if (!cols.has('status')) {
          await db
            .prepare(`ALTER TABLE support_sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'open'`)
            .run();
        }
      }
    } catch {
      // pragma_table_info or column reconciliation is best-effort
    }

    await db
      .prepare(
        `CREATE INDEX IF NOT EXISTS idx_support_sessions_user_status ON support_sessions(user_id, status)`
      )
      .run();
    await db
      .prepare(
        `CREATE INDEX IF NOT EXISTS idx_support_sessions_topic_status ON support_sessions(topic_thread_id, status)`
      )
      .run();

    // Also ensure `app_release_files` table & required columns exist for instant Telegram file_id downloads
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS app_release_files (
          platform                TEXT PRIMARY KEY CHECK(platform IN ('android', 'windows')),
          version                 TEXT NOT NULL,
          github_url              TEXT NOT NULL,
          telegram_file_id        TEXT,
          updated_at              DATETIME DEFAULT CURRENT_TIMESTAMP
        )`
      )
      .run();

    try {
      const relInfo = await db
        .prepare(`SELECT name FROM pragma_table_info('app_release_files')`)
        .all<{ name: string }>();
      const relCols = new Set((relInfo.results || []).map((r) => String(r.name)));
      if (relCols.size > 0) {
        if (!relCols.has('version')) {
          await db.prepare(`ALTER TABLE app_release_files ADD COLUMN version TEXT NOT NULL DEFAULT 'latest'`).run();
        }
        if (!relCols.has('github_url')) {
          await db.prepare(`ALTER TABLE app_release_files ADD COLUMN github_url TEXT NOT NULL DEFAULT ''`).run();
        }
        if (!relCols.has('telegram_file_id')) {
          await db.prepare(`ALTER TABLE app_release_files ADD COLUMN telegram_file_id TEXT`).run();
        }
        if (!relCols.has('updated_at')) {
          await db.prepare(`ALTER TABLE app_release_files ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP`).run();
        }
      }
    } catch {
      // Best-effort column reconciliation
    }

    // Also ensure `subscriptions.account_rev` exists for O(1) ETag / 304 Not Modified sync
    try {
      const subInfo = await db
        .prepare(`SELECT name FROM pragma_table_info('subscriptions')`)
        .all<{ name: string }>();
      const subCols = new Set((subInfo.results || []).map((r) => String(r.name)));
      if (subCols.size > 0 && !subCols.has('account_rev')) {
        await db
          .prepare(`ALTER TABLE subscriptions ADD COLUMN account_rev INTEGER NOT NULL DEFAULT 1`)
          .run();
      }
    } catch {
      // Best-effort column reconciliation
    }

    ensuredDbs.add(db);
  } catch (err) {
    console.warn('[Sentra ensureSchemaColumns warning]', err);
  }
}

/**
 * Increments `subscriptions.account_rev` after any subscription/account change
 * so clients & Telegram Mini App immediately invalidate their cached ETag.
 */
export async function bumpSubscriptionAccountRev(
  db: D1Database,
  subscriptionId: number
): Promise<number> {
  try {
    await ensureSchemaColumns(db);
    await db
      .prepare(
        `UPDATE subscriptions
         SET account_rev = COALESCE(account_rev, 1) + 1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
      .bind(subscriptionId)
      .run();
    const row = await db
      .prepare('SELECT account_rev FROM subscriptions WHERE id = ? LIMIT 1')
      .bind(subscriptionId)
      .first<{ account_rev?: number }>();
    return Number(row?.account_rev ?? 1);
  } catch {
    // Non-fatal if running on a minimal mock DB without account_rev
    return 1;
  }
}

export async function getOpenSupportSessionByUser(
  db: D1Database,
  userTelegramId: number
): Promise<SupportSessionRow | null> {
  await ensureSchemaColumns(db);
  const row = await db
    .prepare(
      `SELECT id, user_id, topic_thread_id, message_count, last_user_message_id, status, created_at, updated_at
       FROM support_sessions
       WHERE user_id = ? AND status = 'open'
       ORDER BY id DESC
       LIMIT 1`
    )
    .bind(userTelegramId)
    .first<SupportSessionRow>();
  return row ?? null;
}

export async function getOpenSupportSessionByTopic(
  db: D1Database,
  topicThreadId: number
): Promise<SupportSessionRow | null> {
  if (!Number.isSafeInteger(topicThreadId) || topicThreadId <= 0) return null;
  await ensureSchemaColumns(db);
  const row = await db
    .prepare(
      `SELECT id, user_id, topic_thread_id, message_count, last_user_message_id, status, created_at, updated_at
       FROM support_sessions
       WHERE topic_thread_id = ? AND status = 'open'
       ORDER BY id DESC
       LIMIT 1`
    )
    .bind(topicThreadId)
    .first<SupportSessionRow>();
  return row ?? null;
}

/**
 * Increments the message counter on the user's open support session (or creates a
 * fresh open session starting at `message_count = 1`), optionally recording the
 * user's latest Telegram `message_id` for direct private-chat replies.
 */
export async function recordSupportSessionActivity(
  db: D1Database,
  params: {
    userId: number;
    lastUserMessageId?: number | null;
  }
): Promise<SupportSessionRow> {
  await ensureSchemaColumns(db);
  const existing = await getOpenSupportSessionByUser(db, params.userId);
  const nextMsgId =
    typeof params.lastUserMessageId === 'number' && params.lastUserMessageId > 0
      ? params.lastUserMessageId
      : existing?.last_user_message_id ?? null;

  if (existing) {
    const nextCount = Number(existing.message_count || 0) + 1;
    await db
      .prepare(
        `UPDATE support_sessions
         SET message_count = ?,
             last_user_message_id = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
      .bind(nextCount, nextMsgId, existing.id)
      .run();

    return {
      ...existing,
      message_count: nextCount,
      last_user_message_id: nextMsgId,
      updated_at: new Date().toISOString(),
    };
  }

  const inserted = await db
    .prepare(
      `INSERT INTO support_sessions (user_id, topic_thread_id, message_count, last_user_message_id, status, created_at, updated_at)
       VALUES (?, NULL, 1, ?, 'open', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    )
    .bind(params.userId, nextMsgId)
    .run();

  const fresh = await getOpenSupportSessionByUser(db, params.userId);
  if (fresh) return fresh;

  return {
    id: Number(inserted.meta?.last_row_id ?? 0),
    user_id: params.userId,
    topic_thread_id: null,
    message_count: 1,
    last_user_message_id: nextMsgId,
    status: 'open',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

export async function attachTopicToSupportSession(
  db: D1Database,
  sessionId: number,
  topicThreadId: number
): Promise<void> {
  await ensureSchemaColumns(db);
  await db
    .prepare(
      `UPDATE support_sessions
       SET topic_thread_id = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .bind(topicThreadId, sessionId)
    .run();
}

export async function closeSupportSession(
  db: D1Database,
  params: { userId: number; topicThreadId?: number | null }
): Promise<void> {
  await ensureSchemaColumns(db);
  if (params.topicThreadId && params.topicThreadId > 0) {
    await db
      .prepare(
        `UPDATE support_sessions
         SET status = 'closed',
             updated_at = CURRENT_TIMESTAMP
         WHERE status = 'open' AND (user_id = ? OR topic_thread_id = ?)`
      )
      .bind(params.userId, params.topicThreadId)
      .run();
    return;
  }

  await db
    .prepare(
      `UPDATE support_sessions
       SET status = 'closed',
           updated_at = CURRENT_TIMESTAMP
       WHERE status = 'open' AND user_id = ?`
    )
    .bind(params.userId)
    .run();
}

/**
 * Builds the Telegram Forum Topic title for an escalated user support chat,
 * safely constrained to Telegram's 128-character limit.
 */
export function buildSupportTopicTitle(params: {
  fullName?: string | null;
  username?: string | null;
  userId: number;
}): string {
  const cleanName = (params.fullName || '').replace(/[\r\n]+/g, ' ').trim();
  const cleanUser = (params.username || '').replace(/^@+/, '').trim();
  const display = cleanName || (cleanUser ? `@${cleanUser}` : 'کاربر');
  const suffix = ` (${params.userId})`;
  const prefix = '🎫 پشتیبانی: ';
  const maxNameLen = Math.max(8, 128 - prefix.length - suffix.length);
  const clipped = display.length > maxNameLen ? `${display.slice(0, maxNameLen - 1)}…` : display;
  return `${prefix}${clipped}${suffix}`;
}
