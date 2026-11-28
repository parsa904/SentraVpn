import {
  buildEdgeCacheKeyRequest,
  EDGE_CACHE_PATHS,
  EDGE_TTL_NODES_SECONDS,
  getDefaultEdgeCache,
  invalidateEdgeNodesCache,
} from './edgeCache.ts';
import type { CachedLocationSummary } from './kvCache.ts';
import { compilePlanTierSingboxConfig } from './singboxCompiler.ts';
import { executeD1Batch } from './workerCache.ts';
import type { DonatedOutboundRow, Env, OutboundRow, PlanTier } from './types.ts';

/**
 * Unified Nodes Snapshot Module (`SENTRA_NODES_SNAPSHOT`)
 *
 * Single source of truth for healthy active nodes & precompiled sing-box 1.14+
 * configs across Worker endpoints, Telegram Mini App, and SentraVPN Clients.
 *
 * Read hierarchy (sub-5ms CPU, near-zero D1/KV consumption):
 *   1. L0 Isolate RAM (3 min)
 *   2. L1 Cloudflare Edge Cache (`caches.default`, 3 min)
 *   3. L2 Cloudflare KV (`SENTRA_NODES_SNAPSHOT`, 1 hour)
 *   4. L3 Cold-Start D1 Fallback (builds once, writes KV + Edge + RAM)
 */

export const KV_KEY_NODES_SNAPSHOT = 'SENTRA_NODES_SNAPSHOT' as const;
export const SNAPSHOT_RAM_TTL_MS = 3 * 60_000;
export const SNAPSHOT_KV_TTL_SEC = 3600;

export interface SnapshotNodeSummary {
  id: string;
  db_id: number;
  tag: string;
  name: string;
  protocol: string;
  category: string;
  country_code: string;
  country_name: string;
  flag: string;
  latency_ms: number;
  health_score: number;
  is_official: boolean;
  allow_web: boolean;
  allow_download: boolean;
  allow_gaming: boolean;
  allow_static_ip: boolean;
}

export interface SnapshotTierBundle {
  node_count: number;
  nodes: SnapshotNodeSummary[];
  singbox_config: Record<string, unknown>;
}

export interface NodesSnapshot {
  nodes_rev: string;
  updated_at: string;
  healthy_count: number;
  countries_count: number;
  has_active_gaming: boolean;
  locations: CachedLocationSummary[];
  tiers: {
    free: SnapshotTierBundle;
    pro: SnapshotTierBundle;
    special: SnapshotTierBundle;
  };
}

export type SnapshotCacheSource = 'ram' | 'edge' | 'kv' | 'd1-cold' | 'rebuilt';

interface RamSnapshotEntry {
  fetchedAtMs: number;
  snapshot: NodesSnapshot;
}

let globalRamSnapshot: RamSnapshotEntry | null = null;
const mockDbRamSnapshots = new WeakMap<object, RamSnapshotEntry>();

function getRamSnapshot(db: D1Database, nowMs: number): NodesSnapshot | null {
  const entry =
    db && typeof db === 'object' && db.constructor === Object
      ? mockDbRamSnapshots.get(db) || null
      : globalRamSnapshot;
  if (entry && nowMs - entry.fetchedAtMs < SNAPSHOT_RAM_TTL_MS) {
    return entry.snapshot;
  }
  return null;
}

function setRamSnapshot(db: D1Database, snapshot: NodesSnapshot, nowMs: number): void {
  const entry: RamSnapshotEntry = { fetchedAtMs: nowMs, snapshot };
  if (db && typeof db === 'object' && db.constructor === Object) {
    mockDbRamSnapshots.set(db, entry);
  } else {
    globalRamSnapshot = entry;
  }
}

export function clearSnapshotRamCacheForTests(db?: D1Database): void {
  globalRamSnapshot = null;
  if (db && typeof db === 'object') {
    mockDbRamSnapshots.delete(db);
  }
}

function fnv1aHex(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function summarizeNode(row: DonatedOutboundRow): SnapshotNodeSummary {
  const countryName = row.country_name || 'Global 🌐';
  return {
    id: `donated_${row.id}`,
    db_id: row.id,
    tag: row.tag,
    name: row.label || row.tag,
    protocol: row.protocol,
    category: row.assigned_tier || 'web_browsing',
    country_code: (row.country_code || 'XX').toUpperCase(),
    country_name: countryName,
    flag: countryName.split(' ').pop() || '🌍',
    latency_ms: Math.max(0, Number(row.latency_ms) || 0),
    health_score: Math.max(0, Number(row.health_score) || 0),
    is_official: Number(row.is_official || 0) === 1,
    allow_web: Number(row.allow_web ?? 1) === 1,
    allow_download: Number(row.allow_download ?? 1) === 1,
    allow_gaming: Number(row.allow_gaming ?? 0) === 1,
    allow_static_ip: Number(row.allow_static_ip ?? 0) === 1,
  };
}

function computeLocations(donated: DonatedOutboundRow[]): CachedLocationSummary[] {
  const map = new Map<string, CachedLocationSummary>();
  for (const row of donated) {
    const code = (row.country_code || 'XX').toUpperCase();
    const name = row.country_name || 'Global 🌐';
    const ping = Math.max(0, Number(row.latency_ms) || 0);
    const existing = map.get(code);
    if (!existing) {
      map.set(code, {
        country_code: code,
        country_name: name,
        active_nodes: 1,
        best_ping: ping,
      });
    } else {
      existing.active_nodes += 1;
      if (ping > 0 && (existing.best_ping === 0 || ping < existing.best_ping)) {
        existing.best_ping = ping;
      }
    }
  }
  return Array.from(map.values()).sort((a, b) => {
    if (a.best_ping === 0 && b.best_ping > 0) return 1;
    if (b.best_ping === 0 && a.best_ping > 0) return -1;
    return a.best_ping - b.best_ping;
  });
}

function safeCompileTierConfig(
  tier: PlanTier,
  donated: DonatedOutboundRow[],
  core: OutboundRow[]
): Record<string, unknown> {
  try {
    const compiled = compilePlanTierSingboxConfig(core, donated, tier, {
      includeClashApi: true,
    });
    return compiled.config;
  } catch {
    return {
      log: { level: 'warn', timestamp: true },
      outbounds: [{ type: 'direct', tag: 'direct' }],
    };
  }
}

async function queryActiveNodesFromDb(
  db: D1Database
): Promise<{ donated: DonatedOutboundRow[]; core: OutboundRow[] }> {
  let donated: DonatedOutboundRow[] = [];
  let core: OutboundRow[] = [];

  try {
    const [donatedRes, coreRes] = await executeD1Batch<Record<string, unknown>>(db, [
      db.prepare(
        `SELECT id, tag, protocol, server_address, server_port, config_json,
                compiled_outbound_json, latency_ms, health_score, status,
                is_official, label, country_code, country_name, assigned_tier,
                allow_web, allow_download, allow_gaming, allow_static_ip,
                gemini_ok, trading_safe, speed_score, jitter_ms, updated_at
         FROM donated_outbounds
         WHERE status = 'active'
         ORDER BY is_official DESC, health_score DESC, latency_ms ASC
         LIMIT 200`
      ),
      db.prepare(
        `SELECT id, tag, protocol, mode_category, server_address, server_port,
                uuid, password, network_transport, tls_enabled, tls_sni,
                reality_public_key, reality_short_id, min_tier, country_code,
                is_active, weight
         FROM outbounds
         WHERE is_active = 1
         ORDER BY weight DESC, id ASC
         LIMIT 50`
      ),
    ]);
    donated = ((donatedRes?.results || []) as unknown) as DonatedOutboundRow[];
    core = ((coreRes?.results || []) as unknown) as OutboundRow[];
  } catch {
    // Fallback for schemas without migration 004 `compiled_outbound_json` or `outbounds`
    try {
      const res = await db
        .prepare(
          `SELECT id, tag, protocol, server_address, server_port, config_json,
                  latency_ms, health_score, status, is_official, label,
                  country_code, country_name, assigned_tier,
                  allow_web, allow_download, allow_gaming, allow_static_ip
           FROM donated_outbounds
           WHERE status = 'active'
           ORDER BY is_official DESC, health_score DESC, latency_ms ASC
           LIMIT 200`
        )
        .all<DonatedOutboundRow>();
      donated = res.results || [];
    } catch {
      donated = [];
    }
    core = [];
  }

  return { donated, core };
}

function buildSnapshotPayload(
  donated: DonatedOutboundRow[],
  core: OutboundRow[],
  nowMs: number,
  forceUniqueNonce = false
): NodesSnapshot {
  const summaries = donated.map(summarizeNode);
  const freeNodes = summaries.filter(
    (n) => n.allow_web || n.allow_download || n.category === 'web_browsing' || n.category === 'download'
  );
  const proNodes = summaries.filter(
    (n) => n.allow_web || n.allow_download || n.allow_static_ip
  );
  const specialNodes = summaries.filter(
    (n) => n.allow_static_ip || n.allow_gaming || n.category === 'static_ip' || n.category === 'gaming'
  );

  const locations = computeLocations(donated);
  const hasActiveGaming = donated.some(
    (n) => Number(n.allow_gaming || 0) === 1 || n.assigned_tier === 'gaming'
  );

  const fingerprintSeed = [
    donated.map((d) => `${d.id}:${d.health_score}:${d.latency_ms}:${d.updated_at || ''}`).join(','),
    core.map((c) => `${c.id}:${c.weight}`).join(','),
    forceUniqueNonce ? String(nowMs) : '',
  ].join('|');

  const shortHash = fnv1aHex(fingerprintSeed);
  const tsBase36 = Math.floor(nowMs / 1000).toString(36);
  const nodesRev = `${tsBase36}_${shortHash}`;

  return {
    nodes_rev: nodesRev,
    updated_at: new Date(nowMs).toISOString(),
    healthy_count: donated.length + core.length,
    countries_count: locations.length,
    has_active_gaming: hasActiveGaming,
    locations,
    tiers: {
      free: {
        node_count: freeNodes.length,
        nodes: freeNodes,
        singbox_config: safeCompileTierConfig('free', donated, core),
      },
      pro: {
        node_count: proNodes.length,
        nodes: proNodes,
        singbox_config: safeCompileTierConfig('pro', donated, core),
      },
      special: {
        node_count: specialNodes.length,
        nodes: specialNodes,
        singbox_config: safeCompileTierConfig('flow_plus', donated, core),
      },
    },
  };
}

async function readSnapshotFromEdgeCache(
  origin?: string | Request | null
): Promise<NodesSnapshot | null> {
  const cache = getDefaultEdgeCache();
  if (!cache) return null;
  try {
    const keyReq = buildEdgeCacheKeyRequest(EDGE_CACHE_PATHS.NODES_SNAPSHOT, origin);
    const cached = await cache.match(keyReq);
    if (!cached) return null;
    const parsed = (await cached.json()) as NodesSnapshot;
    if (parsed && typeof parsed.nodes_rev === 'string' && parsed.tiers) {
      return parsed;
    }
  } catch (err) {
    console.warn('[Sentra Snapshot Edge Read Error]', err);
  }
  return null;
}

async function writeSnapshotToEdgeCache(
  snapshot: NodesSnapshot,
  origin?: string | Request | null,
  ctx?: ExecutionContext
): Promise<void> {
  const cache = getDefaultEdgeCache();
  if (!cache) return;
  try {
    const keyReq = buildEdgeCacheKeyRequest(EDGE_CACHE_PATHS.NODES_SNAPSHOT, origin);
    const resp = new Response(JSON.stringify(snapshot), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': `public, max-age=${EDGE_TTL_NODES_SECONDS}`,
        ETag: `W/"${snapshot.nodes_rev}"`,
      },
    });
    const putPromise = Promise.resolve(cache.put(keyReq, resp)).catch((err) => {
      console.warn('[Sentra Snapshot Edge Put Error]', err);
    });
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(putPromise);
    } else {
      await putPromise;
    }
  } catch (err) {
    console.warn('[Sentra Snapshot Edge Write Error]', err);
  }
}

async function readSnapshotFromKv(kv?: KVNamespace): Promise<NodesSnapshot | null> {
  if (!kv) return null;
  try {
    const raw = await kv.get(KV_KEY_NODES_SNAPSHOT, 'json');
    if (raw && typeof raw === 'object') {
      const candidate = raw as NodesSnapshot;
      if (typeof candidate.nodes_rev === 'string' && candidate.tiers) {
        return candidate;
      }
    }
  } catch (err) {
    console.warn('[Sentra Snapshot KV Read Error]', err);
  }
  return null;
}

async function writeSnapshotToKv(
  kv: KVNamespace | undefined,
  snapshot: NodesSnapshot
): Promise<void> {
  if (!kv) return;
  try {
    await kv.put(KV_KEY_NODES_SNAPSHOT, JSON.stringify(snapshot), {
      expirationTtl: SNAPSHOT_KV_TTL_SEC,
    });
  } catch (err) {
    console.warn('[Sentra Snapshot KV Write Error]', err);
  }
}

/**
 * Resolves the unified `NodesSnapshot` with multi-layer caching:
 *   RAM -> Cloudflare Edge Cache -> Cloudflare KV (`SENTRA_NODES_SNAPSHOT`) -> D1 Cold-Start Build.
 */
export async function getOrBuildNodesSnapshot(
  env: Env,
  origin?: string | Request | null,
  ctx?: ExecutionContext,
  nowMs = Date.now()
): Promise<{ snapshot: NodesSnapshot; source: SnapshotCacheSource }> {
  // 1. L0 Isolate RAM
  const fromRam = getRamSnapshot(env.DB, nowMs);
  if (fromRam) {
    return { snapshot: fromRam, source: 'ram' };
  }

  // 2. L1 Cloudflare Edge Cache (`caches.default`)
  const fromEdge = await readSnapshotFromEdgeCache(origin);
  if (fromEdge) {
    setRamSnapshot(env.DB, fromEdge, nowMs);
    return { snapshot: fromEdge, source: 'edge' };
  }

  // 3. L2 Cloudflare KV (`SENTRA_NODES_SNAPSHOT`)
  const fromKv = await readSnapshotFromKv(env.SENTRA_KV);
  if (fromKv) {
    setRamSnapshot(env.DB, fromKv, nowMs);
    await writeSnapshotToEdgeCache(fromKv, origin, ctx);
    return { snapshot: fromKv, source: 'kv' };
  }

  // 4. L3 Cold-Start Fallback: Build once from D1, persist into KV + Edge Cache + RAM
  const { donated, core } = await queryActiveNodesFromDb(env.DB);
  const fresh = buildSnapshotPayload(donated, core, nowMs, false);
  setRamSnapshot(env.DB, fresh, nowMs);
  await writeSnapshotToKv(env.SENTRA_KV, fresh);
  await writeSnapshotToEdgeCache(fresh, origin, ctx);
  return { snapshot: fresh, source: 'd1-cold' };
}

/**
 * Rebuilds `SENTRA_NODES_SNAPSHOT` immediately from D1, writes the new snapshot to
 * `SENTRA_KV`, refreshes Isolate RAM, and invalidates `caches.default` Edge Cache.
 * Called whenever QualityEngine writes health updates or an Admin mutates nodes/sublinks.
 */
export async function rebuildNodesSnapshot(
  env: Env,
  origin?: string | Request | null,
  nowMs = Date.now()
): Promise<NodesSnapshot> {
  const { donated, core } = await queryActiveNodesFromDb(env.DB);
  const snapshot = buildSnapshotPayload(donated, core, nowMs, true);
  setRamSnapshot(env.DB, snapshot, nowMs);
  await writeSnapshotToKv(env.SENTRA_KV, snapshot);
  await invalidateEdgeNodesCache(origin);
  return snapshot;
}

/**
 * Selects the entitled tier bundle from a `NodesSnapshot` for a user's `PlanTier`.
 */
export function selectSnapshotTierForPlan(
  snapshot: NodesSnapshot,
  planTier: PlanTier
): { tierKey: 'free' | 'pro' | 'special'; bundle: SnapshotTierBundle } {
  if (planTier === 'flow_plus') {
    return { tierKey: 'special', bundle: snapshot.tiers.special };
  }
  if (planTier === 'pro') {
    return { tierKey: 'pro', bundle: snapshot.tiers.pro };
  }
  return { tierKey: 'free', bundle: snapshot.tiers.free };
}
