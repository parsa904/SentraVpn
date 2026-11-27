import type { Env } from './types.ts';

/**
 * Dependency-free Turso (libSQL) HTTP Pipeline Client for Cloudflare Workers.
 *
 * Uses Turso's native Hrana v2 HTTP Pipeline API (`POST <https_url>/v2/pipeline`)
 * with zero npm dependencies and zero Node.js polyfills to keep Worker bundle size
 * well under 1 MB and CPU usage minimal.
 *
 * All operations use parameterized SQL `args` and are strictly wrapped in `try/catch`
 * with graceful fallback so any Turso outage never disrupts primary Cloudflare D1/KV traffic.
 */

export const TURSO_MAX_BACKUPS_RETAINED = 14;
const TURSO_REQUEST_TIMEOUT_MS = 5000;

export interface TursoStatement {
  sql: string;
  args?: unknown[];
}

export interface TursoTelemetryInput {
  platform: string;
  eventType: string;
  details: string | Record<string, unknown>;
}

type HranaArg =
  | { type: 'null' }
  | { type: 'integer'; value: string }
  | { type: 'float'; value: number }
  | { type: 'text'; value: string };

let telemetryTableEnsured = false;
let backupsTableEnsured = false;

export function resetTursoSchemaFlagsForTests(): void {
  telemetryTableEnsured = false;
  backupsTableEnsured = false;
}

/**
 * Converts a `libsql://` or `https://` Turso database URL into the Hrana v2
 * HTTP Pipeline endpoint (`https://<host>/v2/pipeline`). Returns `null` if invalid.
 */
export function normalizeTursoPipelineUrl(rawUrl?: string): string | null {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return null;

  const normalized = trimmed.replace(/^libsql:\/\//i, 'https://');
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:' || !parsed.hostname) {
    return null;
  }

  const basePath = parsed.pathname.replace(/\/+$/, '').replace(/\/v2\/pipeline$/i, '');
  return `${parsed.origin}${basePath}/v2/pipeline`;
}

/**
 * Encodes a JS primitive into a strictly typed Turso Hrana v2 SQL parameter.
 */
export function toTursoArg(value: unknown): HranaArg {
  if (value === null || value === undefined) {
    return { type: 'null' };
  }
  if (typeof value === 'boolean') {
    return { type: 'integer', value: value ? '1' : '0' };
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { type: 'null' };
    if (Number.isInteger(value)) {
      return { type: 'integer', value: String(value) };
    }
    return { type: 'float', value };
  }
  if (typeof value === 'string') {
    return { type: 'text', value };
  }
  try {
    return { type: 'text', value: JSON.stringify(value) };
  } catch {
    return { type: 'text', value: String(value) };
  }
}

/**
 * Executes one or more parameterized SQL statements against Turso in a single
 * HTTP pipeline round-trip. Always catches errors and returns `false` on failure.
 */
export async function executeTursoPipeline(
  env: Env,
  statements: TursoStatement[]
): Promise<boolean> {
  try {
    const pipelineUrl = normalizeTursoPipelineUrl(env.TURSO_DATABASE_URL);
    const authToken = (env.TURSO_AUTH_TOKEN || '').trim();
    if (!pipelineUrl || !authToken || statements.length === 0) {
      return false;
    }

    const requests: Array<Record<string, unknown>> = statements.map((s) => ({
      type: 'execute',
      stmt: {
        sql: s.sql,
        ...(s.args && s.args.length > 0 ? { args: s.args.map(toTursoArg) } : {}),
      },
    }));
    requests.push({ type: 'close' });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TURSO_REQUEST_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(pipelineUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ requests }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.warn('[Sentra Turso Pipeline HTTP Error]', resp.status, errText.slice(0, 200));
      return false;
    }

    const data = (await resp.json().catch(() => null)) as {
      results?: Array<{ type?: string; error?: { message?: string } }>;
    } | null;

    if (data?.results?.some((r) => r.type === 'error')) {
      const firstErr = data.results.find((r) => r.type === 'error')?.error?.message || 'SQL error';
      console.warn('[Sentra Turso Pipeline SQL Error]', firstErr.slice(0, 200));
      return false;
    }

    return true;
  } catch (err) {
    console.warn(
      '[Sentra Turso Fallback]',
      err instanceof Error ? err.message : String(err)
    );
    return false;
  }
}

/**
 * Use Case 1: Offloads high-volume telemetry & QualityEngine health history writes
 * to Turso `telemetry_logs` without consuming Cloudflare D1 daily Row Write quota.
 */
export async function logTelemetryToTurso(
  env: Env,
  input: TursoTelemetryInput
): Promise<boolean> {
  try {
    if (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN) {
      return false;
    }

    const platform = String(input.platform || 'worker').trim().slice(0, 48);
    const eventType = String(input.eventType || 'event').trim().slice(0, 64);
    const serializedDetails =
      typeof input.details === 'string'
        ? input.details.slice(0, 8000)
        : JSON.stringify(input.details).slice(0, 8000);

    const statements: TursoStatement[] = [];
    if (!telemetryTableEnsured) {
      statements.push({
        sql: `CREATE TABLE IF NOT EXISTS telemetry_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          platform TEXT,
          event_type TEXT,
          details TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
      });
    }

    statements.push({
      sql: `INSERT INTO telemetry_logs (platform, event_type, details) VALUES (?, ?, ?)`,
      args: [platform, eventType, serializedDetails],
    });

    const ok = await executeTursoPipeline(env, statements);
    if (ok) {
      telemetryTableEnsured = true;
    }
    return ok;
  } catch (err) {
    console.warn(
      '[Sentra Turso Telemetry Fallback]',
      err instanceof Error ? err.message : String(err)
    );
    return false;
  }
}

/**
 * Use Case 2: 12-hour Cloud Mirror of critical Cloudflare D1 tables inside Turso
 * `d1_backups`, automatically pruning older snapshots to retain only the latest 14.
 */
export async function saveD1BackupMirrorToTurso(
  env: Env,
  payloadJson: string
): Promise<boolean> {
  try {
    if (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN || !payloadJson) {
      return false;
    }

    const statements: TursoStatement[] = [];
    if (!backupsTableEnsured) {
      statements.push({
        sql: `CREATE TABLE IF NOT EXISTS d1_backups (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          payload_json TEXT
        )`,
      });
    }

    statements.push({
      sql: `INSERT INTO d1_backups (payload_json) VALUES (?)`,
      args: [payloadJson],
    });

    statements.push({
      sql: `DELETE FROM d1_backups WHERE id NOT IN (SELECT id FROM d1_backups ORDER BY id DESC LIMIT ?)`,
      args: [TURSO_MAX_BACKUPS_RETAINED],
    });

    const ok = await executeTursoPipeline(env, statements);
    if (ok) {
      backupsTableEnsured = true;
    }
    return ok;
  } catch (err) {
    console.warn(
      '[Sentra Turso Backup Mirror Fallback]',
      err instanceof Error ? err.message : String(err)
    );
    return false;
  }
}
