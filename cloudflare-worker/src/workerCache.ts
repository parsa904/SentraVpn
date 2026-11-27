import {
  compileClientSingboxConfig,
  compileV2RaySubscriptionBase64,
} from './singboxCompiler.ts';
import {
  computeActiveNodesVersionHash,
  getOrLoadActiveNodesCache,
  invalidateActiveNodesKvCache,
  invalidateSystemSettingsKvCache,
  L1_ACTIVE_NODES_TTL_MS,
  resetKvL1CachesForTests,
  type ActiveNodesPoolSnapshot,
  type CachedLocationSummary,
  type CachedTopicRoutingConfig,
} from './kvCache.ts';
import type {
  ConnectionMode,
  DonatedOutboundRow,
  OutboundRow,
} from './types.ts';

export type {
  ActiveNodesPoolSnapshot,
  CachedLocationSummary,
  CachedTopicRoutingConfig,
};

export const ISOLATE_CACHE_TTL_MS = L1_ACTIVE_NODES_TTL_MS; // 5 minutes per Worker isolate
const MAX_COMPILED_VARIANTS = 64;
const MAX_RATE_LIMIT_IPS = 1000;
const D1_BATCH_CHUNK_SIZE = 50;

interface CompiledSingboxEntry {
  config: Record<string, unknown>;
  json: string;
}

interface IsolateCacheStore {
  lastPoolVersion: string;
  compiledSingbox: Map<string, CompiledSingboxEntry>;
  compiledV2Ray: Map<string, string>;
}

function createEmptyStore(): IsolateCacheStore {
  return {
    lastPoolVersion: '',
    compiledSingbox: new Map(),
    compiledV2Ray: new Map(),
  };
}

// Production Cloudflare Workers D1Database instances share one isolate-wide cache.
// Plain JS mock DB objects in unit tests get isolated WeakMap slots so separate
// test databases never pollute each other while repeated requests on the same DB
// exercise real cache hits and invalidation.
let globalIsolateStore: IsolateCacheStore = createEmptyStore();
const mockDbStores = new WeakMap<object, IsolateCacheStore>();

function getStore(db: D1Database): IsolateCacheStore {
  if (db && typeof db === 'object' && db.constructor === Object) {
    let store = mockDbStores.get(db);
    if (!store) {
      store = createEmptyStore();
      mockDbStores.set(db, store);
    }
    return store;
  }
  return globalIsolateStore;
}

export function resetAllWorkerCachesForTests(): void {
  globalIsolateStore = createEmptyStore();
  ipRateLimitStore.clear();
  resetKvL1CachesForTests();
}

/**
 * Executes an array of prepared D1 statements in chunks via `db.batch()` to
 * minimize network round-trips and Worker CPU time. Falls back sequentially
 * only for minimal unit-test adapters that omit `.batch()`.
 */
export async function executeD1Batch<T = unknown>(
  db: D1Database,
  statements: D1PreparedStatement[],
  chunkSize: number = D1_BATCH_CHUNK_SIZE
): Promise<D1Result<T>[]> {
  if (statements.length === 0) return [];
  const results: D1Result<T>[] = [];
  const hasBatch = typeof db.batch === 'function';

  for (let i = 0; i < statements.length; i += chunkSize) {
    const chunk = statements.slice(i, i + chunkSize);
    if (hasBatch) {
      const batchRes = await db.batch<T>(chunk);
      results.push(...batchRes);
    } else {
      for (const stmt of chunk) {
        const res = await stmt.all<T>();
        results.push(res);
      }
    }
  }
  return results;
}

function deriveHasActiveGaming(
  donated: DonatedOutboundRow[],
  core: OutboundRow[]
): boolean {
  for (const row of donated) {
    if (row.allow_gaming === 1 || row.assigned_tier === 'gaming') {
      return true;
    }
  }
  for (const row of core) {
    if (row.server_address !== '127.0.0.1' && row.mode_category === 'gaming') {
      return true;
    }
  }
  return false;
}

function deriveLocations(donated: DonatedOutboundRow[]): CachedLocationSummary[] {
  const byCountry = new Map<string, CachedLocationSummary>();
  for (const row of donated) {
    const code = (row.country_code || 'XX').toUpperCase();
    const name = row.country_name || 'جهانی 🌍';
    const key = `${code}|${name}`;
    const ping = Number.isFinite(Number(row.latency_ms)) ? Number(row.latency_ms) : 9999;
    const prev = byCountry.get(key);
    if (!prev) {
      byCountry.set(key, {
        country_code: row.country_code || 'XX',
        country_name: name,
        active_nodes: 1,
        best_ping: ping,
      });
    } else {
      prev.active_nodes += 1;
      if (ping < prev.best_ping) {
        prev.best_ping = ping;
      }
    }
  }
  return Array.from(byCountry.values()).sort((a, b) => a.best_ping - b.best_ping);
}

/**
 * Loads the active nodes pool (`donated_outbounds` + `outbounds`) via 3-tier cache:
 *   L1: Isolate RAM (5 minutes, 0 KV reads, 0 D1 reads)
 *   L2: Cloudflare KV `cache:active_nodes_v1` (1 hour, 0 D1 reads, 0 KV writes)
 *   L3: Single batched D1 read with narrow columns -> populates L1 & L2
 */
export async function getCachedActiveNodesPool(
  db: D1Database,
  kv?: KVNamespace,
  nowMs: number = Date.now()
): Promise<ActiveNodesPoolSnapshot> {
  const store = getStore(db);

  const { snapshot } = await getOrLoadActiveNodesCache(
    db,
    kv,
    async () => {
      const donatedStmt = db.prepare(
        `SELECT id, tag, protocol, server_address, server_port, config_json,
                latency_ms, speed_mbps, assigned_tier, health_score, status, fail_count,
                raw_link, fingerprint_sha256, is_official, label, country_code, country_name,
                allow_web, allow_download, allow_gaming, allow_static_ip,
                gemini_ok, trading_safe, speed_score, jitter_ms, allocation_mode
         FROM donated_outbounds
         WHERE status = 'active'
         ORDER BY is_official DESC, health_score DESC, speed_score DESC, latency_ms ASC
         LIMIT 200`
      );

      const coreStmt = db.prepare(
        `SELECT id, tag, protocol, mode_category, server_address, server_port,
                uuid, password, network_transport, tls_enabled, tls_sni,
                reality_public_key, reality_short_id, min_tier, country_code, is_active, weight
         FROM outbounds
         WHERE is_active = 1
         ORDER BY weight DESC, id ASC
         LIMIT 100`
      );

      const [donatedRes, coreRes] = await executeD1Batch<Record<string, unknown>>(db, [
        donatedStmt,
        coreStmt,
      ]);

      const donated = ((donatedRes?.results || []) as unknown) as DonatedOutboundRow[];
      const core = ((coreRes?.results || []) as unknown) as OutboundRow[];

      return {
        version: computeActiveNodesVersionHash(donated, core),
        donated,
        core,
        hasActiveGaming: deriveHasActiveGaming(donated, core),
        locations: deriveLocations(donated),
      };
    },
    nowMs
  );

  if (store.lastPoolVersion !== snapshot.version) {
    store.lastPoolVersion = snapshot.version;
    store.compiledSingbox.clear();
    store.compiledV2Ray.clear();
  }

  return snapshot;
}

export async function invalidateNodesCache(
  db?: D1Database,
  kv?: KVNamespace
): Promise<void> {
  if (db) {
    const store = getStore(db);
    store.lastPoolVersion = '';
    store.compiledSingbox.clear();
    store.compiledV2Ray.clear();
  }
  globalIsolateStore.lastPoolVersion = '';
  globalIsolateStore.compiledSingbox.clear();
  globalIsolateStore.compiledV2Ray.clear();

  await invalidateActiveNodesKvCache(db, kv);
}

export async function getCachedHasActiveGaming(
  db: D1Database,
  kv?: KVNamespace,
  nowMs?: number
): Promise<boolean> {
  const pool = await getCachedActiveNodesPool(db, kv, nowMs);
  return pool.hasActiveGaming;
}

export async function getCachedLocations(
  db: D1Database,
  kv?: KVNamespace,
  nowMs?: number
): Promise<CachedLocationSummary[]> {
  const pool = await getCachedActiveNodesPool(db, kv, nowMs);
  return pool.locations;
}

export function filterPoolForMode(
  pool: ActiveNodesPoolSnapshot,
  mode: ConnectionMode,
  locationCode?: string
): { donated: DonatedOutboundRow[]; core: OutboundRow[] } {
  const loc = (locationCode || '').trim().toUpperCase();

  const matchesMode = (row: DonatedOutboundRow): boolean => {
    if (mode === 'static_ip') {
      return row.allow_static_ip === 1 || row.assigned_tier === 'static_ip';
    }
    if (mode === 'gaming') {
      return row.allow_gaming === 1 || row.assigned_tier === 'gaming';
    }
    if (mode === 'download') {
      return row.allow_download === 1 || row.assigned_tier === 'download';
    }
    return row.allow_web === 1 || row.assigned_tier === 'web_browsing';
  };

  let donated = pool.donated.filter((row) => {
    if (!matchesMode(row)) return false;
    if (loc && loc !== 'AUTO' && (row.country_code || '').toUpperCase() !== loc) {
      return false;
    }
    return true;
  });

  // Sort identically to SQL: is_official DESC, speed_score DESC, latency_ms ASC
  donated.sort((a, b) => {
    if ((b.is_official || 0) !== (a.is_official || 0)) {
      return (b.is_official || 0) - (a.is_official || 0);
    }
    if ((b.speed_score || 0) !== (a.speed_score || 0)) {
      return (b.speed_score || 0) - (a.speed_score || 0);
    }
    return (a.latency_ms ?? 9999) - (b.latency_ms ?? 9999);
  });

  if (donated.length === 0 && (mode === 'web_browsing' || mode === 'download')) {
    donated = [...pool.donated].sort((a, b) => {
      if ((b.is_official || 0) !== (a.is_official || 0)) {
        return (b.is_official || 0) - (a.is_official || 0);
      }
      if ((b.speed_score || 0) !== (a.speed_score || 0)) {
        return (b.speed_score || 0) - (a.speed_score || 0);
      }
      return (a.latency_ms ?? 9999) - (b.latency_ms ?? 9999);
    });
  }

  const core = pool.core.filter(
    (row) => row.mode_category === mode || row.mode_category === 'all'
  );

  return { donated, core };
}

function setBoundedMap<K, V>(map: Map<K, V>, key: K, value: V, maxSize: number): void {
  if (!map.has(key) && map.size >= maxSize) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) {
      map.delete(oldest);
    }
  }
  map.set(key, value);
}

/**
 * Returns a cached compiled sing-box 1.14+ config and its pre-serialized JSON
 * string so repeated user requests skip JSON compilation & serialization (<1ms CPU).
 */
export async function getCachedCompiledSingbox(
  db: D1Database,
  options: {
    mode: ConnectionMode;
    locationCode?: string;
    preferFirstAsDefault?: boolean;
    includeClashApi: boolean;
    onError?: (source: string, errorDetails: unknown) => void;
    kv?: KVNamespace;
    nowMs?: number;
  }
): Promise<{ config: Record<string, unknown>; json: string; poolVersion: string }> {
  const pool = await getCachedActiveNodesPool(db, options.kv, options.nowMs);
  const store = getStore(db);
  const locKey = (options.locationCode || 'AUTO').trim().toUpperCase() || 'AUTO';
  const cacheKey = `${pool.version}:${options.mode}:${locKey}:${
    options.preferFirstAsDefault ? 1 : 0
  }:${options.includeClashApi ? 1 : 0}`;

  const cached = store.compiledSingbox.get(cacheKey);
  if (cached) {
    return {
      config: cached.config,
      json: cached.json,
      poolVersion: pool.version,
    };
  }

  const { donated, core } = filterPoolForMode(pool, options.mode, options.locationCode);
  const config = compileClientSingboxConfig(core, donated, {
    mode: options.mode,
    preferFirstAsDefault: options.preferFirstAsDefault,
    includeClashApi: options.includeClashApi,
    onError: options.onError,
  });
  const json = JSON.stringify(config);

  setBoundedMap(store.compiledSingbox, cacheKey, { config, json }, MAX_COMPILED_VARIANTS);
  return { config, json, poolVersion: pool.version };
}

/**
 * Returns a cached Base64 V2Ray subscription string for the given mode & location.
 */
export async function getCachedV2RayBase64(
  db: D1Database,
  mode: ConnectionMode,
  locationCode?: string,
  kv?: KVNamespace,
  nowMs?: number
): Promise<{ base64: string; poolVersion: string }> {
  const pool = await getCachedActiveNodesPool(db, kv, nowMs);
  const store = getStore(db);
  const locKey = (locationCode || 'AUTO').trim().toUpperCase() || 'AUTO';
  const cacheKey = `${pool.version}:${mode}:${locKey}`;

  const cached = store.compiledV2Ray.get(cacheKey);
  if (cached !== undefined) {
    return { base64: cached, poolVersion: pool.version };
  }

  const { donated, core } = filterPoolForMode(pool, mode, locationCode);
  const base64 = compileV2RaySubscriptionBase64(donated, core);
  setBoundedMap(store.compiledV2Ray, cacheKey, base64, MAX_COMPILED_VARIANTS);
  return { base64, poolVersion: pool.version };
}

export async function invalidateSystemSettingsCache(
  db?: D1Database,
  kv?: KVNamespace
): Promise<void> {
  await invalidateSystemSettingsKvCache(db, kv);
}

/**
 * Fast deterministic weak ETag generator (dual 32-bit FNV-1a, <0.05ms CPU).
 * Never pass raw secrets or subscription tokens as inputs.
 */
export function computeWeakEtag(parts: Array<string | number | boolean | null | undefined>): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b1;
  for (let p = 0; p < parts.length; p += 1) {
    const str = String(parts[p] ?? '');
    for (let i = 0; i < str.length; i += 1) {
      const ch = str.charCodeAt(i);
      h1 ^= ch;
      h1 = Math.imul(h1, 0x01000193);
      h2 ^= ch + ((p + 1) * 31) + i;
      h2 = Math.imul(h2, 0x85ebca6b);
    }
    h1 ^= 0x7c;
    h1 = Math.imul(h1, 0x01000193);
  }
  const hex = `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0)
    .toString(16)
    .padStart(8, '0')}`;
  return `W/"${hex}"`;
}

export function matchesIfNoneMatch(
  headerValue: string | null | undefined,
  currentEtag: string
): boolean {
  if (!headerValue) return false;
  const normalize = (tag: string) => tag.trim().replace(/^W\//i, '');
  const target = normalize(currentEtag);
  const candidates = headerValue.split(',');
  for (const raw of candidates) {
    const trimmed = raw.trim();
    if (trimmed === '*') return true;
    if (normalize(trimmed) === target) return true;
  }
  return false;
}

// ============================================================================
// In-Memory Per-IP Public Endpoint Rate Limiter (Zero D1 Reads / Writes)
// ============================================================================
type RateLimitBucket = 'sub' | 'logs';

interface IpWindowEntry {
  windowStartMs: number;
  count: number;
}

const RATE_LIMIT_CONFIG: Record<RateLimitBucket, { maxRequests: number; windowMs: number }> = {
  sub: { maxRequests: 30, windowMs: 60_000 },
  logs: { maxRequests: 15, windowMs: 60_000 },
};

const ipRateLimitStore = new Map<string, IpWindowEntry>();

export function extractClientIp(request: Request): string {
  const cfIp = request.headers.get('CF-Connecting-IP')?.trim();
  if (cfIp) return cfIp.slice(0, 64);
  const xff = request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim();
  if (xff) return xff.slice(0, 64);
  return 'unknown';
}

export function checkPublicIpRateLimit(
  bucket: RateLimitBucket,
  ip: string,
  nowMs: number = Date.now()
): { allowed: boolean; retryAfterSec: number } {
  const cfg = RATE_LIMIT_CONFIG[bucket];
  const key = `${bucket}:${ip || 'unknown'}`;
  const existing = ipRateLimitStore.get(key);

  if (existing && nowMs - existing.windowStartMs < cfg.windowMs) {
    if (existing.count >= cfg.maxRequests) {
      const remainingMs = Math.max(1000, cfg.windowMs - (nowMs - existing.windowStartMs));
      return { allowed: false, retryAfterSec: Math.ceil(remainingMs / 1000) };
    }
    existing.count += 1;
    return { allowed: true, retryAfterSec: 0 };
  }

  // Prune expired or evict oldest key if map reached capacity (FIFO)
  if (ipRateLimitStore.size >= MAX_RATE_LIMIT_IPS) {
    for (const [k, entry] of ipRateLimitStore.entries()) {
      if (nowMs - entry.windowStartMs >= cfg.windowMs) {
        ipRateLimitStore.delete(k);
      }
      if (ipRateLimitStore.size < MAX_RATE_LIMIT_IPS) break;
    }
    if (ipRateLimitStore.size >= MAX_RATE_LIMIT_IPS) {
      const oldestKey = ipRateLimitStore.keys().next().value;
      if (oldestKey !== undefined) {
        ipRateLimitStore.delete(oldestKey);
      }
    }
  }

  ipRateLimitStore.set(key, { windowStartMs: nowMs, count: 1 });
  return { allowed: true, retryAfterSec: 0 };
}
