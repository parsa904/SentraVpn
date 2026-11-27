import type {
  ActiveServerSelection,
  BootstrapResponse,
  DonatedOutboundRecord,
} from '../types/sentra';

const BOOTSTRAP_CACHE_PREFIX = 'sentra_offline_bootstrap_v1_';
const DONATIONS_CACHE_PREFIX = 'sentra_offline_donations_v1_';
const ACTIVE_SERVER_CACHE_PREFIX = 'sentra_offline_active_server_v1_';
const SINGBOX_CONFIG_CACHE_PREFIX = 'sentra_offline_singbox_cfg_v1_';
export const OFFLINE_CONFIG_CACHE_NAME = 'sentra-last-config-v1';
export const SW_RUNTIME_CONFIG_CACHE_NAME = 'sentra-config-cache';

export interface CachedBootstrapEnvelope {
  version: 1;
  cachedAt: string;
  data: BootstrapResponse;
}

interface CachedDonationsEnvelope {
  version: 1;
  cachedAt: string;
  donations: DonatedOutboundRecord[];
}

interface CachedActiveServerEnvelope {
  version: 1;
  cachedAt: string;
  selection: ActiveServerSelection;
}

export interface CachedSingboxConfigEnvelope {
  version: 1;
  cachedAt: string;
  etag: string | null;
  mode: string;
  locationCode: string;
  config: Record<string, unknown>;
}

/**
 * Produces a short, deterministic, non-reversible key fingerprint from a token
 * so raw tokens are never exposed in storage key names and accounts remain isolated.
 */
export function hashCacheScope(token: string): string {
  const input = (token || '').trim();
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b1;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    h1 ^= ch;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= ch + i;
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}

function getStorage(storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'length' | 'key'>): Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem' | 'length' | 'key'
> | null {
  if (storage) return storage;
  if (typeof localStorage === 'undefined') return null;
  return localStorage;
}

function sanitizeBootstrapForCache(data: BootstrapResponse): BootstrapResponse {
  return {
    ...data,
    modes: Array.isArray(data.modes) ? data.modes : [],
    outbounds: Array.isArray(data.outbounds) ? data.outbounds : [],
    devices: Array.isArray(data.devices) ? data.devices : [],
  };
}

async function mirrorToCacheStorage(cacheKeyUrl: string, payload: unknown): Promise<void> {
  if (typeof caches === 'undefined' || typeof Response === 'undefined') return;
  try {
    const cache = await caches.open(OFFLINE_CONFIG_CACHE_NAME);
    const body = JSON.stringify(payload);
    await cache.put(
      cacheKeyUrl,
      new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'X-Sentra-Cached-At': new Date().toISOString(),
        },
      })
    );
  } catch {
    // CacheStorage may be restricted in private browsing or non-secure contexts
  }
}

export function saveCachedBootstrapSnapshot(
  token: string,
  data: BootstrapResponse,
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'length' | 'key'>
): CachedBootstrapEnvelope | null {
  const scope = hashCacheScope(token);
  if (!token.trim()) return null;

  const envelope: CachedBootstrapEnvelope = {
    version: 1,
    cachedAt: new Date().toISOString(),
    data: sanitizeBootstrapForCache(data),
  };

  const store = getStorage(storage);
  if (store) {
    try {
      store.setItem(`${BOOTSTRAP_CACHE_PREFIX}${scope}`, JSON.stringify(envelope));
    } catch {
      // ignore quota errors
    }
  }

  void mirrorToCacheStorage(`/_sentra_offline_cache/bootstrap/${scope}.json`, envelope);
  return envelope;
}

export function loadCachedBootstrapSnapshot(
  token: string,
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'length' | 'key'>
): CachedBootstrapEnvelope | null {
  if (!token.trim()) return null;
  const scope = hashCacheScope(token);
  const store = getStorage(storage);
  if (!store) return null;

  try {
    const raw = store.getItem(`${BOOTSTRAP_CACHE_PREFIX}${scope}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedBootstrapEnvelope>;
    if (
      parsed.version !== 1 ||
      !parsed.data ||
      typeof parsed.data !== 'object' ||
      !parsed.data.subscription
    ) {
      return null;
    }
    return {
      version: 1,
      cachedAt: typeof parsed.cachedAt === 'string' ? parsed.cachedAt : new Date().toISOString(),
      data: sanitizeBootstrapForCache(parsed.data),
    };
  } catch {
    return null;
  }
}

export async function loadCachedBootstrapFromCacheStorage(
  token: string
): Promise<CachedBootstrapEnvelope | null> {
  if (!token.trim() || typeof caches === 'undefined') return null;
  const scope = hashCacheScope(token);
  try {
    const cache = await caches.open(OFFLINE_CONFIG_CACHE_NAME);
    const resp = await cache.match(`/_sentra_offline_cache/bootstrap/${scope}.json`);
    if (!resp) return null;
    const parsed = (await resp.json()) as Partial<CachedBootstrapEnvelope>;
    if (parsed.version !== 1 || !parsed.data || !parsed.data.subscription) return null;
    return {
      version: 1,
      cachedAt: typeof parsed.cachedAt === 'string' ? parsed.cachedAt : new Date().toISOString(),
      data: sanitizeBootstrapForCache(parsed.data),
    };
  } catch {
    return null;
  }
}

export function saveCachedDonationsSnapshot(
  token: string,
  donations: DonatedOutboundRecord[],
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'length' | 'key'>
): void {
  if (!token.trim()) return;
  const scope = hashCacheScope(token);
  const envelope: CachedDonationsEnvelope = {
    version: 1,
    cachedAt: new Date().toISOString(),
    donations: Array.isArray(donations) ? donations : [],
  };
  const store = getStorage(storage);
  if (store) {
    try {
      store.setItem(`${DONATIONS_CACHE_PREFIX}${scope}`, JSON.stringify(envelope));
    } catch {
      // ignore quota errors
    }
  }
  void mirrorToCacheStorage(`/_sentra_offline_cache/donations/${scope}.json`, envelope);
}

export function loadCachedDonationsSnapshot(
  token: string,
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'length' | 'key'>
): DonatedOutboundRecord[] | null {
  if (!token.trim()) return null;
  const scope = hashCacheScope(token);
  const store = getStorage(storage);
  if (!store) return null;
  try {
    const raw = store.getItem(`${DONATIONS_CACHE_PREFIX}${scope}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedDonationsEnvelope>;
    if (parsed.version !== 1 || !Array.isArray(parsed.donations)) return null;
    return parsed.donations;
  } catch {
    return null;
  }
}

export function saveCachedActiveServer(
  token: string,
  selection: ActiveServerSelection | null,
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'length' | 'key'>
): void {
  if (!token.trim()) return;
  const scope = hashCacheScope(token);
  const store = getStorage(storage);
  if (!store) return;

  try {
    if (!selection) {
      store.removeItem(`${ACTIVE_SERVER_CACHE_PREFIX}${scope}`);
      return;
    }
    const envelope: CachedActiveServerEnvelope = {
      version: 1,
      cachedAt: new Date().toISOString(),
      selection,
    };
    store.setItem(`${ACTIVE_SERVER_CACHE_PREFIX}${scope}`, JSON.stringify(envelope));
  } catch {
    // ignore storage errors
  }
}

export function loadCachedActiveServer(
  token: string,
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'length' | 'key'>
): ActiveServerSelection | null {
  if (!token.trim()) return null;
  const scope = hashCacheScope(token);
  const store = getStorage(storage);
  if (!store) return null;
  try {
    const raw = store.getItem(`${ACTIVE_SERVER_CACHE_PREFIX}${scope}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedActiveServerEnvelope>;
    if (parsed.version !== 1 || !parsed.selection || typeof parsed.selection.id !== 'string') {
      return null;
    }
    return parsed.selection;
  } catch {
    return null;
  }
}

function buildSingboxCacheKey(
  token: string,
  mode: string,
  locationCode?: string
): string {
  const scope = hashCacheScope(token);
  const safeMode = (mode || 'web_browsing').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
  const safeLoc = (locationCode || 'auto').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '') || 'AUTO';
  return `${SINGBOX_CONFIG_CACHE_PREFIX}${scope}_${safeMode}_${safeLoc}`;
}

export function saveCachedSingboxConfig(
  token: string,
  mode: string,
  locationCode: string | undefined,
  config: Record<string, unknown>,
  etag: string | null,
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'length' | 'key'>
): CachedSingboxConfigEnvelope | null {
  if (!token.trim() || !config || typeof config !== 'object') return null;
  const key = buildSingboxCacheKey(token, mode, locationCode);
  const envelope: CachedSingboxConfigEnvelope = {
    version: 1,
    cachedAt: new Date().toISOString(),
    etag: etag && etag.trim() ? etag.trim() : null,
    mode: (mode || 'web_browsing').trim().toLowerCase(),
    locationCode: (locationCode || 'auto').trim().toLowerCase() || 'auto',
    config,
  };
  const store = getStorage(storage);
  if (store) {
    try {
      store.setItem(key, JSON.stringify(envelope));
    } catch {
      // ignore storage quota errors
    }
  }
  void mirrorToCacheStorage(`/_sentra_offline_cache/singbox/${key}.json`, envelope);
  return envelope;
}

export function loadCachedSingboxConfig(
  token: string,
  mode: string,
  locationCode: string | undefined,
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'length' | 'key'>
): CachedSingboxConfigEnvelope | null {
  if (!token.trim()) return null;
  const key = buildSingboxCacheKey(token, mode, locationCode);
  const store = getStorage(storage);
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedSingboxConfigEnvelope>;
    if (
      parsed.version !== 1 ||
      !parsed.config ||
      typeof parsed.config !== 'object' ||
      Array.isArray(parsed.config)
    ) {
      return null;
    }
    return {
      version: 1,
      cachedAt: typeof parsed.cachedAt === 'string' ? parsed.cachedAt : new Date().toISOString(),
      etag: typeof parsed.etag === 'string' && parsed.etag.trim() ? parsed.etag.trim() : null,
      mode: typeof parsed.mode === 'string' ? parsed.mode : mode,
      locationCode: typeof parsed.locationCode === 'string' ? parsed.locationCode : locationCode || 'auto',
      config: parsed.config,
    };
  } catch {
    return null;
  }
}

export async function clearOfflineConfigCache(
  token?: string | null,
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'length' | 'key'>
): Promise<void> {
  const store = getStorage(storage);
  if (store) {
    try {
      if (token && token.trim()) {
        const scope = hashCacheScope(token);
        store.removeItem(`${BOOTSTRAP_CACHE_PREFIX}${scope}`);
        store.removeItem(`${DONATIONS_CACHE_PREFIX}${scope}`);
        store.removeItem(`${ACTIVE_SERVER_CACHE_PREFIX}${scope}`);
        const singboxPrefix = `${SINGBOX_CONFIG_CACHE_PREFIX}${scope}_`;
        const singboxKeys: string[] = [];
        for (let i = 0; i < store.length; i += 1) {
          const k = store.key(i);
          if (k && k.startsWith(singboxPrefix)) {
            singboxKeys.push(k);
          }
        }
        for (const k of singboxKeys) {
          store.removeItem(k);
        }
      } else {
        const keysToRemove: string[] = [];
        for (let i = 0; i < store.length; i += 1) {
          const k = store.key(i);
          if (
            k &&
            (k.startsWith(BOOTSTRAP_CACHE_PREFIX) ||
              k.startsWith(DONATIONS_CACHE_PREFIX) ||
              k.startsWith(ACTIVE_SERVER_CACHE_PREFIX) ||
              k.startsWith(SINGBOX_CONFIG_CACHE_PREFIX))
          ) {
            keysToRemove.push(k);
          }
        }
        for (const k of keysToRemove) {
          store.removeItem(k);
        }
      }
    } catch {
      // ignore storage errors
    }
  }

  if (typeof caches !== 'undefined') {
    try {
      await Promise.all([
        caches.delete(OFFLINE_CONFIG_CACHE_NAME),
        caches.delete(SW_RUNTIME_CONFIG_CACHE_NAME),
      ]);
    } catch {
      // ignore cache API errors
    }
  }
}
