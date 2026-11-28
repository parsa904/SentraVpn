#!/usr/bin/env node
/**
 * Idempotent Cloudflare D1 migration runner for CI/CD (`deploy-cloudflare.yml`).
 *
 * 1. Runs official `npx wrangler d1 migrations apply sentra-db --remote`.
 * 2. If Wrangler reports `duplicate column name` (for example, when an existing
 *    database was previously bootstrapped with `schema.sql` or manual `ALTER TABLE`
 *    commands), reconciles missing columns/tables/indexes safely via
 *    `pragma_table_info`, records applied migrations in `d1_migrations`, and
 *    re-verifies `wrangler d1 migrations apply sentra-db --remote`.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER_DIR = path.resolve(__dirname, '../../cloudflare-worker');
const MIGRATIONS_DIR = path.join(WORKER_DIR, 'migrations');
const DB_NAME = process.env.D1_DATABASE_NAME || 'sentra-db';

function runWrangler(args) {
  return execFileSync('npx', ['wrangler', ...args], {
    cwd: WORKER_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function execD1Sql(sql) {
  runWrangler(['d1', 'execute', DB_NAME, '--remote', '--yes', '--command', sql]);
}

function queryD1Json(sql) {
  const out = runWrangler([
    'd1',
    'execute',
    DB_NAME,
    '--remote',
    '--yes',
    '--json',
    '--command',
    sql,
  ]);
  const parsed = JSON.parse(out);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return Array.isArray(first?.results) ? first.results : [];
}

function getTableColumns(tableName) {
  try {
    const rows = queryD1Json(`SELECT name FROM pragma_table_info('${tableName}');`);
    return new Set(rows.map((r) => String(r.name)));
  } catch {
    return new Set();
  }
}

function ensureColumn(table, existingCols, colName, colDef) {
  if (existingCols.has(colName)) {
    return false;
  }
  console.log(`[D1 Reconcile] Adding missing column ${table}.${colName}...`);
  execD1Sql(`ALTER TABLE ${table} ADD COLUMN ${colName} ${colDef};`);
  existingCols.add(colName);
  return true;
}

function recordMigrationApplied(filename) {
  execD1Sql(
    `CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);`
  );
  execD1Sql(
    `INSERT OR IGNORE INTO d1_migrations (name) VALUES ('${filename.replace(/'/g, "''")}');`
  );
}

function reconcileIdempotently() {
  console.log('[D1 Reconcile] Ensuring base schema tables/indexes exist...');
  runWrangler(['d1', 'execute', DB_NAME, '--remote', '--yes', '--file=./schema.sql']);

  // Reconcile Migration 003 columns on `subscriptions`
  const subCols = getTableColumns('subscriptions');
  if (subCols.size > 0) {
    ensureColumn('subscriptions', subCols, 'connect_code', 'TEXT');
    ensureColumn('subscriptions', subCols, 'plan_tier', "TEXT NOT NULL DEFAULT 'free'");
    ensureColumn('subscriptions', subCols, 'web_used_bytes', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn('subscriptions', subCols, 'download_used_bytes', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn('subscriptions', subCols, 'special_quota_bytes', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn('subscriptions', subCols, 'special_used_bytes', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn('subscriptions', subCols, 'has_used_special_trial', 'INTEGER NOT NULL DEFAULT 0');
    execD1Sql(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_connect_code ON subscriptions(connect_code);`
    );
    execD1Sql(
      `CREATE INDEX IF NOT EXISTS idx_subscriptions_plan_tier ON subscriptions(plan_tier);`
    );
    execD1Sql(
      `UPDATE subscriptions SET plan_tier = CASE WHEN tier = 'Sentra Flow+' THEN 'flow_plus' WHEN tier IN ('Sentra Pro', 'Sentra Static IP', 'Sentra Gaming') THEN 'pro' ELSE 'free' END WHERE plan_tier = 'free' AND tier != 'Sentra Lite';`
    );
  }

  // Reconcile Migration 003 columns on `subscription_sources`
  const srcCols = getTableColumns('subscription_sources');
  if (srcCols.size > 0) {
    ensureColumn('subscription_sources', srcCols, 'submitted_by_user_id', 'INTEGER');
    ensureColumn('subscription_sources', srcCols, 'status', "TEXT NOT NULL DEFAULT 'pending'");
    execD1Sql(
      `UPDATE subscription_sources SET status = 'active' WHERE submitted_by_user_id IS NULL AND (status IS NULL OR status = '' OR status = 'pending');`
    );
    execD1Sql(
      `CREATE INDEX IF NOT EXISTS idx_sub_sources_status ON subscription_sources(status);`
    );
    execD1Sql(
      `CREATE INDEX IF NOT EXISTS idx_sub_sources_user_created ON subscription_sources(submitted_by_user_id, created_at);`
    );
  }

  // Reconcile Migration 004 columns & 'quarantined' status CHECK on `donated_outbounds`
  const donatedCols = getTableColumns('donated_outbounds');
  if (donatedCols.size > 0) {
    const needsRebuildFor004 =
      !donatedCols.has('compiled_outbound_json') || !donatedCols.has('validation_error');
    if (needsRebuildFor004) {
      console.log('[D1 Reconcile] Applying 004_precompiled_outbounds.sql table rebuild...');
      runWrangler([
        'd1',
        'execute',
        DB_NAME,
        '--remote',
        '--yes',
        '--file=./migrations/004_precompiled_outbounds.sql',
      ]);
    }
  }

  // Reconcile Migration 005 columns & case-insensitive indexes on `users`
  const userCols = getTableColumns('users');
  if (userCols.size > 0) {
    ensureColumn('users', userCols, 'username', 'TEXT');
    ensureColumn('users', userCols, 'password_hash', 'TEXT');
    ensureColumn('users', userCols, 'email', 'TEXT');
    execD1Sql(`DROP INDEX IF EXISTS idx_users_username;`);
    execD1Sql(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(LOWER(username));`
    );
    execD1Sql(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(LOWER(email));`);
  }

  // Reconcile Migration 006 `support_sessions` table & indexes
  const supportSessionCols = getTableColumns('support_sessions');
  if (supportSessionCols.size > 0) {
    ensureColumn('support_sessions', supportSessionCols, 'topic_thread_id', 'INTEGER');
    ensureColumn('support_sessions', supportSessionCols, 'message_count', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn('support_sessions', supportSessionCols, 'last_user_message_id', 'INTEGER');
    ensureColumn('support_sessions', supportSessionCols, 'status', "TEXT NOT NULL DEFAULT 'open'");
    execD1Sql(
      `CREATE INDEX IF NOT EXISTS idx_support_sessions_user_status ON support_sessions(user_id, status);`
    );
    execD1Sql(
      `CREATE INDEX IF NOT EXISTS idx_support_sessions_topic_status ON support_sessions(topic_thread_id, status);`
    );
  }

  // Mark migrations 0001..006 as applied in d1_migrations so future wrangler runs stay clean
  const migrationFiles = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of migrationFiles) {
    if (/^(0001|002|003|004|005|006)_/.test(file)) {
      recordMigrationApplied(file);
    }
  }
}

function main() {
  console.log(`[D1 Migrations] Running: npx wrangler d1 migrations apply ${DB_NAME} --remote`);
  try {
    const out = runWrangler(['d1', 'migrations', 'apply', DB_NAME, '--remote']);
    if (out) console.log(out);
    console.log('[D1 Migrations] All remote D1 migrations applied cleanly.');
    return;
  } catch (err) {
    const stderr = String(err?.stderr || '');
    const stdout = String(err?.stdout || '');
    const combined = `${stdout}\n${stderr}\n${err?.message || ''}`;

    if (/duplicate column name|already exists/i.test(combined)) {
      console.warn(
        '[D1 Migrations] Detected pre-existing columns/tables on remote D1; running idempotent column reconciliation...'
      );
      reconcileIdempotently();
      const verifyOut = runWrangler(['d1', 'migrations', 'apply', DB_NAME, '--remote']);
      if (verifyOut) console.log(verifyOut);
      console.log('[D1 Migrations] Reconciled and verified remote D1 migrations successfully.');
      return;
    }

    console.error('[D1 Migrations] Migration failed:\n', combined);
    process.exit(1);
  }
}

main();
