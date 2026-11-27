import type { DonatedOutboundRow, OutboundRow, PlanTier } from './types.ts';

/**
 * Strict Cloudflare KV L2 Cache Module (L1 Isolate RAM -> L2 Cloudflare KV -> L3 D1)
 *
 * Free-tier KV protection rules:
 * 1. ONLY five shared, high-read keys may ever be stored in SENTRA_KV:
 *    - `cache:active_nodes_v1`          (L1: 5 min RAM,  L2: 1 hour KV)
 *    - `cache:system_settings_v1`       (L1: 10 min RAM, L2: 24 hours KV)
 *    - `cache:compiled_cfg_free_v1`     (L1: 5 min RAM,  L2: 1 hour KV)
 *    - `cache:compiled_cfg_pro_v1`      (L1: 5 min RAM,  L2: 1 hour KV)
 *    - `cache:compiled_cfg_flow_plus_v1`(L1: 5 min RAM,  L2: 1 hour KV)
 * 2. User-specific or high-churn data (users, subscriptions, telegram_states,
 *    counters, rate limits) MUST NEVER be written to KV.
 * 3. Every KV operation (get / put / delete) is wrapped in try/catch so missing
 *    bindings, transient KV outages, or daily KV quota exhaustion gracefully
 *    fall back to D1 without ever disrupting user traffic.
 */

export const KV_KEY_ACTIVE_NODES = 'cache:active_nodes_v1' as const;
export const KV_KEY_SYSTEM_SETTINGS = 'cache:system_settings_v1' as const;
export const KV_KEY_COMPILED_CFG_FREE = 'cache:compiled_cfg_free_v1' as const;
export const KV_KEY_COMPILED_CFG_PRO = 'cache:compiled_cfg_pro_v1' as const;
export const KV_KEY_COMPILED_CFG_FLOW_PLUS = 'cache:compiled_cfg_flow_plus_v1' as const;

export type AllowedKvKey =
  | typeof KV_KEY_ACTIVE_NODES
  | typeof KV_KEY_SYSTEM_SETTINGS
  | typeof KV_KEY_COMPILED_CFG_FREE
  | typeof KV_KEY_COMPILED_CFG_PRO
  | typeof KV_KEY_COMPILED_CFG_FLOW_PLUS;

export const ALL_COMPILED_PLAN_KV_KEYS = [
  KV_KEY_COMPILED_CFG_FREE,
  KV_KEY_COMPILED_CFG_PRO,
  KV_KEY_COMPILED_CFG_FLOW_PLUS,
] as const;

export function getCompiledPlanKvKey(planTier: PlanTier):
  | typeof KV_KEY_COMPILED_CFG_FREE
  | typeof KV_KEY_COMPILED_CFG_PRO
  | typeof KV_KEY_COMPILED_CFG_FLOW_PLUS {
  if (planTier === 'flow_plus') return KV_KEY_COMPILED_CFG_FLOW_PLUS;
  if (planTier === 'pro') return KV_KEY_COMPILED_CFG_PRO;
  return KV_KEY_COMPILED_CFG_FREE;
}

export const L1_ACTIVE_NODES_TTL_MS = 5 * 60_000; // 5 minutes in Worker isolate RAM
export const L2_ACTIVE_NODES_TTL_SEC = 3600; // 1 hour in Cloudflare KV

export const L1_SYSTEM_SETTINGS_TTL_MS = 10 * 60_000; // 10 minutes in Worker isolate RAM
export const L2_SYSTEM_SETTINGS_TTL_SEC = 86400; // 24 hours in Cloudflare KV

export const L1_COMPILED_CFG_TTL_MS = 5 * 60_000; // 5 minutes in Worker isolate RAM
export const L2_COMPILED_CFG_TTL_SEC = 3600; // 1 hour in Cloudflare KV

export interface CachedLocationSummary {
  country_code: string;
  country_name: string;
  active_nodes: number;
  best_ping: number;
}

export interface ActiveNodesPoolSnapshot {
  version: string;
  fetchedAtMs: number;
  donated: DonatedOutboundRow[];
  core: OutboundRow[];
  hasActiveGaming: boolean;
  locations: CachedLocationSummary[];
}

export interface CompiledPlanConfigSnapshot {
  planTier: PlanTier;
  poolVersion: string;
  configJson: string;
  nodeCount: number;
  fetchedAtMs: number;
}

export const DEFAULT_FREE_WEB_QUOTA_GB = 2;
export const DEFAULT_FREE_DOWNLOAD_QUOTA_GB = 3;

export interface CachedTopicRoutingConfig {
  logGroupId: string | null;
  topicLogsId: string | null;
  topicBackupsId: string | null;
  topicSupportId: string | null;
  freeWebQuotaGb?: number;
  freeDownloadQuotaGb?: number;
}

interface ActiveNodesKvPayload {
  v: 1;
  version: string;
  cachedAt: number;
  donated: DonatedOutboundRow[];
  core: OutboundRow[];
  hasActiveGaming: boolean;
  locations: CachedLocationSummary[];
}

interface CompiledPlanConfigKvPayload {
  v: 1;
  planTier: PlanTier;
  poolVersion: string;
  cachedAt: number;
  nodeCount: number;
  configJson: string;
}

interface SystemSettingsKvPayload {
  v: 1;
  cachedAt: number;
  logGroupId: string | null;
  topicLogsId: string | null;
  topicBackupsId: string | null;
  topicSupportId: string | null;
  freeWebQuotaGb?: number;
  freeDownloadQuotaGb?: number;
}

interface L1KvStore {
  activeNodes: ActiveNodesPoolSnapshot | null;
  systemSettings: { fetchedAtMs: number; config: CachedTopicRoutingConfig } | null;
  compiledPlanConfigs: Record<PlanTier, CompiledPlanConfigSnapshot | null>;
}

function createEmptyL1Store(): L1KvStore {
  return {
    activeNodes: null,
    systemSettings: null,
    compiledPlanConfigs: {
      free: null,
      pro: null,
      flow_plus: null,
    },
  };
}

let globalL1Store: L1KvStore = createEmptyL1Store();
const mockDbL1Stores = new WeakMap<object, L1KvStore>();

function getL1Store(db: D1Database): L1KvStore {
  if (db && typeof db === 'object' && db.constructor === Object) {
    let store = mockDbL1Stores.get(db);
    if (!store) {
      store = createEmptyL1Store();
      mockDbL1Stores.set(db, store);
    }
    return store;
  }
  return globalL1Store;
}

export function resetKvL1CachesForTests(): void {
  globalL1Store = createEmptyL1Store();
}

/**
 * Deterministic 64-bit FNV-1a fingerprint of the active nodes pool so every
 * Worker edge isolate computes the exact same version string & ETag.
 */
export function computeActiveNodesVersionHash(
  donated: DonatedOutboundRow[],
  core: OutboundRow[]
): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b1;

  const mix = (str: string) => {
    for (let i = 0; i < str.length; i += 1) {
      const ch = str.charCodeAt(i);
      h1 ^= ch;
      h1 = Math.imul(h1, 0x01000193);
      h2 ^= ch + i;
      h2 = Math.imul(h2, 0x85ebca6b);
    }
    h1 ^= 0x1f;
    h1 = Math.imul(h1, 0x01000193);
  };

  mix(`d:${donated.length}|c:${core.length}`);
  for (const row of donated) {
    mix(
      `${row.id}:${row.status}:${row.health_score}:${row.speed_score}:${row.latency_ms}:${row.is_official}:${row.allow_web}${row.allow_download}${row.allow_gaming}${row.allow_static_ip}:${row.country_code}:${row.fingerprint_sha256 || ''}:${row.compiled_outbound_json || ''}:${row.tag}`
    );
  }
  for (const row of core) {
    mix(
      `${row.id}:${row.is_active}:${row.mode_category}:${row.weight}:${row.server_address}:${row.server_port}:${row.tag}`
    );
  }

  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0)
    .toString(16)
    .padStart(8, '0')}`;
}

async function safeKvGetJson<T>(
  kv: KVNamespace | undefined,
  key: AllowedKvKey
): Promise<T | null> {
  if (!kv || typeof kv.get !== 'function') return null;
  try {
    const raw = await kv.get(key, 'json');
    if (raw && typeof raw === 'object') {
      return raw as T;
    }
    return null;
  } catch (err) {
    console.warn(`[Sentra KV Read Fallback] key=${key}`, err instanceof Error ? err.message : err);
    return null;
  }
}

async function safeKvPutJson(
  kv: KVNamespace | undefined,
  key: AllowedKvKey,
  value: unknown,
  expirationTtl: number
): Promise<boolean> {
  if (!kv || typeof kv.put !== 'function') return false;
  try {
    await kv.put(key, JSON.stringify(value), { expirationTtl });
    return true;
  } catch (err) {
    console.warn(`[Sentra KV Write Fallback] key=${key}`, err instanceof Error ? err.message : err);
    return false;
  }
}

async function safeKvDelete(
  kv: KVNamespace | undefined,
  key: AllowedKvKey
): Promise<boolean> {
  if (!kv || typeof kv.delete !== 'function') return false;
  try {
    await kv.delete(key);
    return true;
  } catch (err) {
    console.warn(
      `[Sentra KV Delete Fallback] key=${key}`,
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

function isValidActiveNodesKvPayload(val: unknown): val is ActiveNodesKvPayload {
  if (!val || typeof val !== 'object') return false;
  const obj = val as Record<string, unknown>;
  return (
    obj.v === 1 &&
    typeof obj.version === 'string' &&
    obj.version.length > 0 &&
    Array.isArray(obj.donated) &&
    Array.isArray(obj.core) &&
    typeof obj.hasActiveGaming === 'boolean' &&
    Array.isArray(obj.locations)
  );
}

function isValidCompiledPlanConfigKvPayload(
  val: unknown,
  expectedPlanTier: PlanTier
): val is CompiledPlanConfigKvPayload {
  if (!val || typeof val !== 'object') return false;
  const obj = val as Record<string, unknown>;
  return (
    obj.v === 1 &&
    obj.planTier === expectedPlanTier &&
    typeof obj.poolVersion === 'string' &&
    obj.poolVersion.length > 0 &&
    typeof obj.configJson === 'string' &&
    obj.configJson.startsWith('{') &&
    typeof obj.nodeCount === 'number'
  );
}

function isValidSystemSettingsKvPayload(val: unknown): val is SystemSettingsKvPayload {
  if (!val || typeof val !== 'object') return false;
  const obj = val as Record<string, unknown>;
  const isNullableString = (v: unknown) => v === null || typeof v === 'string';
  return (
    obj.v === 1 &&
    isNullableString(obj.logGroupId) &&
    isNullableString(obj.topicLogsId) &&
    isNullableString(obj.topicBackupsId) &&
    isNullableString(obj.topicSupportId)
  );
}

/**
 * Two-tier cache lookup for `cache:active_nodes_v1`:
 *   L1 (Isolate RAM, 5 min) -> L2 (Cloudflare KV, 1 hour) -> L3 (D1 loader)
 *
 * Writes to KV ONLY on a genuine L2 cache miss so KV daily write quota (1,000/day)
 * is strictly protected.
 */
export async function getOrLoadActiveNodesCache(
  db: D1Database,
  kv: KVNamespace | undefined,
  loader: () => Promise<Omit<ActiveNodesPoolSnapshot, 'fetchedAtMs'>>,
  nowMs: number = Date.now()
): Promise<{ snapshot: ActiveNodesPoolSnapshot; source: 'l1' | 'l2' | 'l3' }> {
  const l1 = getL1Store(db);

  // 1. L1 Isolate RAM check (0 KV reads, 0 D1 reads)
  if (l1.activeNodes && nowMs - l1.activeNodes.fetchedAtMs < L1_ACTIVE_NODES_TTL_MS) {
    return { snapshot: l1.activeNodes, source: 'l1' };
  }

  // 2. L2 Cloudflare KV check (0 D1 reads, 0 KV writes)
  const kvPayload = await safeKvGetJson<ActiveNodesKvPayload>(kv, KV_KEY_ACTIVE_NODES);
  if (isValidActiveNodesKvPayload(kvPayload)) {
    const snapshot: ActiveNodesPoolSnapshot = {
      version: kvPayload.version,
      fetchedAtMs: nowMs,
      donated: kvPayload.donated,
      core: kvPayload.core,
      hasActiveGaming: kvPayload.hasActiveGaming,
      locations: kvPayload.locations,
    };
    l1.activeNodes = snapshot;
    return { snapshot, source: 'l2' };
  }

  // 3. L3 D1 fallback -> populate L1 RAM + L2 KV (TTL 1 hour)
  const loaded = await loader();
  const snapshot: ActiveNodesPoolSnapshot = {
    ...loaded,
    fetchedAtMs: nowMs,
  };
  l1.activeNodes = snapshot;

  const toStore: ActiveNodesKvPayload = {
    v: 1,
    version: snapshot.version,
    cachedAt: nowMs,
    donated: snapshot.donated,
    core: snapshot.core,
    hasActiveGaming: snapshot.hasActiveGaming,
    locations: snapshot.locations,
  };
  await safeKvPutJson(kv, KV_KEY_ACTIVE_NODES, toStore, L2_ACTIVE_NODES_TTL_SEC);

  return { snapshot, source: 'l3' };
}

/**
 * Two-tier cache lookup for per-plan ready-to-serve precompiled sing-box 1.14+ JSON:
 *   - `cache:compiled_cfg_free_v1`
 *   - `cache:compiled_cfg_pro_v1`
 *   - `cache:compiled_cfg_flow_plus_v1`
 *
 * Delivers pre-serialized JSON string in <1ms CPU on L1/L2 hits with zero raw-link parsing.
 */
export async function getOrLoadCompiledPlanConfigCache(
  db: D1Database,
  kv: KVNamespace | undefined,
  planTier: PlanTier,
  loader: () => Promise<{ poolVersion: string; configJson: string; nodeCount: number }>,
  nowMs: number = Date.now()
): Promise<{ snapshot: CompiledPlanConfigSnapshot; source: 'l1' | 'l2' | 'l3' }> {
  const l1 = getL1Store(db);
  const existingL1 = l1.compiledPlanConfigs[planTier];

  // 1. L1 Isolate RAM hit (0 KV reads, 0 D1 reads, <0.1ms CPU)
  if (existingL1 && nowMs - existingL1.fetchedAtMs < L1_COMPILED_CFG_TTL_MS) {
    return { snapshot: existingL1, source: 'l1' };
  }

  // 2. L2 Cloudflare KV hit (0 D1 reads, 0 KV writes, <1ms CPU)
  const kvKey = getCompiledPlanKvKey(planTier);
  const kvPayload = await safeKvGetJson<CompiledPlanConfigKvPayload>(kv, kvKey);
  if (isValidCompiledPlanConfigKvPayload(kvPayload, planTier)) {
    const snapshot: CompiledPlanConfigSnapshot = {
      planTier,
      poolVersion: kvPayload.poolVersion,
      configJson: kvPayload.configJson,
      nodeCount: kvPayload.nodeCount,
      fetchedAtMs: nowMs,
    };
    l1.compiledPlanConfigs[planTier] = snapshot;
    return { snapshot, source: 'l2' };
  }

  // 3. L3 builder fallback -> populate L1 RAM + L2 KV
  const built = await loader();
  const snapshot: CompiledPlanConfigSnapshot = {
    planTier,
    poolVersion: built.poolVersion,
    configJson: built.configJson,
    nodeCount: built.nodeCount,
    fetchedAtMs: nowMs,
  };
  l1.compiledPlanConfigs[planTier] = snapshot;

  const toStore: CompiledPlanConfigKvPayload = {
    v: 1,
    planTier,
    poolVersion: snapshot.poolVersion,
    cachedAt: nowMs,
    nodeCount: snapshot.nodeCount,
    configJson: snapshot.configJson,
  };
  await safeKvPutJson(kv, kvKey, toStore, L2_COMPILED_CFG_TTL_SEC);

  return { snapshot, source: 'l3' };
}

/**
 * Invalidates `cache:active_nodes_v1` AND all three per-plan compiled config keys
 * (`cache:compiled_cfg_free_v1`, `cache:compiled_cfg_pro_v1`, `cache:compiled_cfg_flow_plus_v1`)
 * in both L1 RAM and L2 KV.
 * MUST be called ONLY when active nodes genuinely changed (QualityEngine diff-writes
 * or Admin node/subscription add/approve/delete) to protect free-tier KV write limits.
 */
export async function invalidateActiveNodesKvCache(
  db?: D1Database,
  kv?: KVNamespace
): Promise<void> {
  if (db) {
    const l1 = getL1Store(db);
    l1.activeNodes = null;
    l1.compiledPlanConfigs = { free: null, pro: null, flow_plus: null };
  }
  globalL1Store.activeNodes = null;
  globalL1Store.compiledPlanConfigs = { free: null, pro: null, flow_plus: null };

  if (kv) {
    await Promise.all([
      safeKvDelete(kv, KV_KEY_ACTIVE_NODES),
      safeKvDelete(kv, KV_KEY_COMPILED_CFG_FREE),
      safeKvDelete(kv, KV_KEY_COMPILED_CFG_PRO),
      safeKvDelete(kv, KV_KEY_COMPILED_CFG_FLOW_PLUS),
    ]);
  }
}

/**
 * Two-tier cache lookup for `cache:system_settings_v1`:
 *   L1 (Isolate RAM, 10 min) -> L2 (Cloudflare KV, 24 hours) -> L3 (D1 loader)
 */
export async function getOrLoadSystemSettingsCache(
  db: D1Database,
  kv: KVNamespace | undefined,
  loader: () => Promise<CachedTopicRoutingConfig>,
  nowMs: number = Date.now()
): Promise<{ config: CachedTopicRoutingConfig; source: 'l1' | 'l2' | 'l3' }> {
  const l1 = getL1Store(db);

  // 1. L1 Isolate RAM check (10-minute TTL)
  if (l1.systemSettings && nowMs - l1.systemSettings.fetchedAtMs < L1_SYSTEM_SETTINGS_TTL_MS) {
    return { config: l1.systemSettings.config, source: 'l1' };
  }

  // 2. L2 Cloudflare KV check (24-hour TTL)
  const kvPayload = await safeKvGetJson<SystemSettingsKvPayload>(kv, KV_KEY_SYSTEM_SETTINGS);
  if (isValidSystemSettingsKvPayload(kvPayload)) {
    const config: CachedTopicRoutingConfig = {
      logGroupId: kvPayload.logGroupId,
      topicLogsId: kvPayload.topicLogsId,
      topicBackupsId: kvPayload.topicBackupsId,
      topicSupportId: kvPayload.topicSupportId,
      freeWebQuotaGb:
        typeof kvPayload.freeWebQuotaGb === 'number' && Number.isFinite(kvPayload.freeWebQuotaGb)
          ? kvPayload.freeWebQuotaGb
          : DEFAULT_FREE_WEB_QUOTA_GB,
      freeDownloadQuotaGb:
        typeof kvPayload.freeDownloadQuotaGb === 'number' &&
        Number.isFinite(kvPayload.freeDownloadQuotaGb)
          ? kvPayload.freeDownloadQuotaGb
          : DEFAULT_FREE_DOWNLOAD_QUOTA_GB,
    };
    l1.systemSettings = { fetchedAtMs: nowMs, config };
    return { config, source: 'l2' };
  }

  // 3. L3 D1 fallback -> populate L1 RAM + L2 KV (TTL 24 hours)
  const config = await loader();
  const normalizedConfig: CachedTopicRoutingConfig = {
    ...config,
    freeWebQuotaGb:
      typeof config.freeWebQuotaGb === 'number' && Number.isFinite(config.freeWebQuotaGb)
        ? config.freeWebQuotaGb
        : DEFAULT_FREE_WEB_QUOTA_GB,
    freeDownloadQuotaGb:
      typeof config.freeDownloadQuotaGb === 'number' && Number.isFinite(config.freeDownloadQuotaGb)
        ? config.freeDownloadQuotaGb
        : DEFAULT_FREE_DOWNLOAD_QUOTA_GB,
  };
  l1.systemSettings = { fetchedAtMs: nowMs, config: normalizedConfig };

  const toStore: SystemSettingsKvPayload = {
    v: 1,
    cachedAt: nowMs,
    logGroupId: normalizedConfig.logGroupId,
    topicLogsId: normalizedConfig.topicLogsId,
    topicBackupsId: normalizedConfig.topicBackupsId,
    topicSupportId: normalizedConfig.topicSupportId,
    freeWebQuotaGb: normalizedConfig.freeWebQuotaGb,
    freeDownloadQuotaGb: normalizedConfig.freeDownloadQuotaGb,
  };
  await safeKvPutJson(kv, KV_KEY_SYSTEM_SETTINGS, toStore, L2_SYSTEM_SETTINGS_TTL_SEC);

  return { config: normalizedConfig, source: 'l3' };
}

/**
 * Write-through update for `cache:system_settings_v1` (1 single KV write instead of delete+put).
 * MUST be called ONLY when an admin updates Telegram group/topic bindings or dynamic settings.
 */
export async function updateSystemSettingsKvCache(
  db: D1Database,
  kv: KVNamespace | undefined,
  config: CachedTopicRoutingConfig,
  nowMs: number = Date.now()
): Promise<void> {
  const normalizedConfig: CachedTopicRoutingConfig = {
    ...config,
    freeWebQuotaGb:
      typeof config.freeWebQuotaGb === 'number' && Number.isFinite(config.freeWebQuotaGb)
        ? config.freeWebQuotaGb
        : DEFAULT_FREE_WEB_QUOTA_GB,
    freeDownloadQuotaGb:
      typeof config.freeDownloadQuotaGb === 'number' && Number.isFinite(config.freeDownloadQuotaGb)
        ? config.freeDownloadQuotaGb
        : DEFAULT_FREE_DOWNLOAD_QUOTA_GB,
  };
  const l1 = getL1Store(db);
  l1.systemSettings = { fetchedAtMs: nowMs, config: normalizedConfig };

  const toStore: SystemSettingsKvPayload = {
    v: 1,
    cachedAt: nowMs,
    logGroupId: normalizedConfig.logGroupId,
    topicLogsId: normalizedConfig.topicLogsId,
    topicBackupsId: normalizedConfig.topicBackupsId,
    topicSupportId: normalizedConfig.topicSupportId,
    freeWebQuotaGb: normalizedConfig.freeWebQuotaGb,
    freeDownloadQuotaGb: normalizedConfig.freeDownloadQuotaGb,
  };
  await safeKvPutJson(kv, KV_KEY_SYSTEM_SETTINGS, toStore, L2_SYSTEM_SETTINGS_TTL_SEC);
}

/**
 * Clears L1 (and optionally L2 KV) system_settings cache.
 */
export async function invalidateSystemSettingsKvCache(
  db?: D1Database,
  kv?: KVNamespace
): Promise<void> {
  if (db) {
    getL1Store(db).systemSettings = null;
  }
  globalL1Store.systemSettings = null;

  if (kv) {
    await safeKvDelete(kv, KV_KEY_SYSTEM_SETTINGS);
  }
}
