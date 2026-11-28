/**
 * Cloudflare Edge Cache API (`caches.default`) wrapper for SentraVPN Worker.
 *
 * Serves high-traffic read-only GET endpoints directly from Cloudflare's Edge
 * POP cache with ZERO Cloudflare D1 reads and ZERO Cloudflare KV reads/writes.
 *
 * Exposes `X-Sentra-Cache: HIT | MISS` diagnostic headers and supports targeted
 * `caches.default.delete(...)` invalidation whenever QualityEngine or an admin
 * updates nodes, subscription sources, or client release versions.
 */

export const EDGE_TTL_NODES_SECONDS = 180; // 3 minutes for active nodes & locations
export const EDGE_TTL_METADATA_SECONDS = 600; // 10 minutes for app version & sing-box rule-sets

export const DEFAULT_EDGE_ORIGIN = 'https://sentra-core.kziepr.workers.dev';

export const EDGE_CACHE_PATHS = {
  NODES_ACTIVE: '/__edge_cache/v1/nodes/active',
  NODES_SNAPSHOT: '/__edge_cache/v1/nodes/snapshot',
  CLIENT_LOCATIONS: '/__edge_cache/v1/client/locations',
  CLIENT_VERSION: '/__edge_cache/v1/client/version',
  RULE_SETS_INDEX: '/__edge_cache/v1/client/rule-sets',
  BOOTSTRAP: '/__edge_cache/v1/bootstrap',
} as const;

/**
 * Builds a lightweight revision-based weak ETag (`W/"<part1>-<part2>..."`)
 * without expensive SHA/MD5 hashing so Worker CPU stays well under 1ms.
 */
export function buildRevisionEtag(
  parts: Array<string | number | null | undefined>
): string {
  const cleaned = parts
    .map((p) =>
      String(p ?? '0')
        .trim()
        .replace(/[^A-Za-z0-9._:]/g, '')
        .slice(0, 48)
    )
    .filter(Boolean);
  return `W/"${cleaned.join('-') || '0'}"`;
}

/**
 * Checks whether an incoming `If-None-Match` header matches the current ETag
 * per RFC 7232 weak comparison semantics.
 */
export function matchesWeakEtag(
  ifNoneMatchHeader: string | null | undefined,
  currentEtag: string
): boolean {
  if (!ifNoneMatchHeader) return false;
  const normalize = (tag: string): string =>
    tag.trim().replace(/^W\//i, '').replace(/^"|"$/g, '');
  const target = normalize(currentEtag);
  if (!target) return false;

  return ifNoneMatchHeader
    .split(',')
    .map((part) => part.trim())
    .some((candidate) => candidate === '*' || normalize(candidate) === target);
}

/**
 * Builds an instant empty-body `304 Not Modified` response with `ETag`,
 * `Cache-Control`, and `X-Sentra-Cache: HIT-304`.
 */
export function buildNotModifiedResponse(
  etag: string,
  cacheControl = `public, max-age=${EDGE_TTL_NODES_SECONDS}`
): Response {
  return new Response(null, {
    status: 304,
    headers: {
      ETag: etag,
      'Cache-Control': cacheControl,
      'X-Sentra-Cache': 'HIT-304',
    },
  });
}

let testEdgeCacheOverride: Cache | null | undefined = undefined;
let lastKnownEdgeOrigin: string = DEFAULT_EDGE_ORIGIN;

/**
 * Allows unit tests running in Node.js (where `caches.default` is undefined)
 * to inject an in-memory `Cache` implementation and verify real HIT/MISS/delete flows.
 */
export function setEdgeCacheOverrideForTests(cache: Cache | null | undefined): void {
  testEdgeCacheOverride = cache;
}

export function resetEdgeOriginForTests(): void {
  lastKnownEdgeOrigin = DEFAULT_EDGE_ORIGIN;
}

export function getDefaultEdgeCache(): Cache | null {
  if (testEdgeCacheOverride !== undefined) {
    return testEdgeCacheOverride;
  }
  const g = globalThis as unknown as { caches?: { default?: Cache } };
  if (g.caches && g.caches.default) {
    return g.caches.default;
  }
  return null;
}

export function resolveEdgeOrigin(source?: string | Request | null): string {
  if (source) {
    try {
      const rawUrl = typeof source === 'string' ? source : source.url;
      const parsed = new URL(rawUrl);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        lastKnownEdgeOrigin = parsed.origin;
        return parsed.origin;
      }
    } catch {
      // Fallback to last known origin
    }
  }
  return lastKnownEdgeOrigin || DEFAULT_EDGE_ORIGIN;
}

export function buildEdgeCacheKeyRequest(path: string, origin?: string | Request | null): Request {
  const baseOrigin = resolveEdgeOrigin(origin);
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return new Request(`${baseOrigin}${normalizedPath}`, { method: 'GET' });
}

/**
 * Wraps a GET response producer with Cloudflare Edge Cache (`caches.default`)
 * and optional revision-based `ETag` / `If-None-Match` (`304 Not Modified`).
 * - On `If-None-Match` match: returns `304 Not Modified` with `X-Sentra-Cache: HIT-304`.
 * - On HIT: returns cached response immediately with `X-Sentra-Cache: HIT`.
 * - On MISS: runs `producer()`, stores HTTP 200 responses with
 *   `Cache-Control: public, max-age=<ttlSeconds>`, and returns with `X-Sentra-Cache: MISS`.
 */
export async function withEdgeCache(params: {
  cachePath: string;
  ttlSeconds: number;
  origin?: string | Request | null;
  request?: Request;
  etag?: string;
  ctx?: ExecutionContext;
  producer: () => Promise<Response>;
}): Promise<Response> {
  const cache = getDefaultEdgeCache();
  const originSource = params.origin ?? params.request ?? null;
  const cacheKey = buildEdgeCacheKeyRequest(params.cachePath, originSource);
  const cacheControl = `public, max-age=${params.ttlSeconds}`;
  const incomingIfNoneMatch =
    params.request?.headers.get('If-None-Match') ??
    (params.origin instanceof Request ? params.origin.headers.get('If-None-Match') : null);

  if (params.etag && matchesWeakEtag(incomingIfNoneMatch, params.etag)) {
    return buildNotModifiedResponse(params.etag, cacheControl);
  }

  if (cache) {
    try {
      const cached = await cache.match(cacheKey);
      if (cached) {
        const cachedEtag = params.etag || cached.headers.get('ETag') || '';
        if (cachedEtag && matchesWeakEtag(incomingIfNoneMatch, cachedEtag)) {
          return buildNotModifiedResponse(cachedEtag, cacheControl);
        }
        const headers = new Headers(cached.headers);
        headers.set('X-Sentra-Cache', 'HIT');
        if (!headers.get('Cache-Control')) {
          headers.set('Cache-Control', cacheControl);
        }
        if (cachedEtag && !headers.get('ETag')) {
          headers.set('ETag', cachedEtag);
        }
        return new Response(cached.body, {
          status: cached.status,
          statusText: cached.statusText,
          headers,
        });
      }
    } catch (err) {
      console.warn('[Sentra EdgeCache Match Error]', params.cachePath, err);
    }
  }

  const fresh = await params.producer();
  if (fresh.status !== 200) {
    return fresh;
  }

  const clientHeaders = new Headers(fresh.headers);
  clientHeaders.set('Cache-Control', cacheControl);
  clientHeaders.set('X-Sentra-Cache', 'MISS');
  const effectiveEtag = params.etag || clientHeaders.get('ETag') || '';
  if (effectiveEtag) {
    clientHeaders.set('ETag', effectiveEtag);
  }

  const bodyBuf = await fresh.arrayBuffer();

  if (cache) {
    const storeHeaders = new Headers(clientHeaders);
    storeHeaders.set('X-Sentra-Cache', 'HIT');
    const toStore = new Response(bodyBuf.slice(0), {
      status: 200,
      headers: storeHeaders,
    });
    const putPromise = Promise.resolve(cache.put(cacheKey, toStore)).catch((err) => {
      console.warn('[Sentra EdgeCache Put Error]', params.cachePath, err);
    });
    if (params.ctx && typeof params.ctx.waitUntil === 'function') {
      params.ctx.waitUntil(putPromise);
    } else {
      await putPromise;
    }
  }

  if (effectiveEtag && matchesWeakEtag(incomingIfNoneMatch, effectiveEtag)) {
    return buildNotModifiedResponse(effectiveEtag, cacheControl);
  }

  return new Response(bodyBuf, {
    status: 200,
    headers: clientHeaders,
  });
}

async function deleteEdgeCachePaths(
  paths: readonly string[],
  origin?: string | Request | null
): Promise<number> {
  const cache = getDefaultEdgeCache();
  if (!cache) return 0;

  let deleted = 0;
  await Promise.allSettled(
    paths.map(async (p) => {
      try {
        const keyReq = buildEdgeCacheKeyRequest(p, origin);
        const ok = await cache.delete(keyReq);
        if (ok) deleted += 1;
      } catch (err) {
        console.warn('[Sentra EdgeCache Delete Error]', p, err);
      }
    })
  );
  return deleted;
}

/**
 * Purges Edge-cached node, snapshot & location responses immediately after QualityEngine
 * health-report updates or admin node/sublink additions/deletions.
 */
export async function invalidateEdgeNodesCache(
  origin?: string | Request | null
): Promise<number> {
  return await deleteEdgeCachePaths(
    [
      EDGE_CACHE_PATHS.NODES_ACTIVE,
      EDGE_CACHE_PATHS.NODES_SNAPSHOT,
      EDGE_CACHE_PATHS.CLIENT_LOCATIONS,
    ],
    origin
  );
}

/**
 * Purges Edge-cached client version & release metadata immediately after a new
 * APK/EXE/ZIP release is synced or uploaded via Telegram.
 */
export async function invalidateEdgeVersionCache(
  origin?: string | Request | null
): Promise<number> {
  return await deleteEdgeCachePaths([EDGE_CACHE_PATHS.CLIENT_VERSION], origin);
}

/**
 * Built-in lightweight sing-box 1.14+ headless rule-sets served from Edge Cache
 * (10-minute TTL, zero D1/KV reads).
 */
export const SINGBOX_RULE_SETS: Record<string, Record<string, unknown>> = {
  'iran-direct': {
    version: 3,
    rules: [
      {
        domain_suffix: ['.ir', '.shaparak.ir', '.bankmellat.ir', '.bmi.ir', '.digikala.com', '.snapp.ir', '.aparat.com'],
        ip_cidr: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8'],
      },
    ],
  },
  'ads-block': {
    version: 3,
    rules: [
      {
        domain_suffix: [
          'doubleclick.net',
          'googlesyndication.com',
          'googleadservices.com',
          'adnxs.com',
          'taboola.com',
          'outbrain.com',
          'yektanet.com',
          'tapsell.ir',
        ],
      },
    ],
  },
};
