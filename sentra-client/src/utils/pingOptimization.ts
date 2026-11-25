import type { LiveOutboundNode } from '../types/sentra';

export const PING_OPT_ENABLED_STORAGE_KEY = 'sentra_ping_opt_enabled_v1';
export const PING_OPT_INTERVAL_MS = 30_000;

export type ResolvedLatencyState = 'measured' | 'cached' | 'untested' | 'timeout';

export interface ResolvedOutboundLatency {
  latencyMs: number | null;
  state: ResolvedLatencyState;
}

export interface PeriodicOptimizationContext {
  enabled: boolean;
  outboundsCount: number;
  isTestingAll: boolean;
  isAutoResolving: boolean;
  isOptimizing: boolean;
  isDocumentVisible: boolean;
  lastRunAtMs: number | null;
  nowMs: number;
  intervalMs?: number;
}

export function getInitialPingOptimizationEnabled(): boolean {
  try {
    const saved = localStorage.getItem(PING_OPT_ENABLED_STORAGE_KEY);
    if (saved === 'false') return false;
    if (saved === 'true') return true;
  } catch {
    // ignore storage errors
  }
  return true;
}

export function persistPingOptimizationEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(PING_OPT_ENABLED_STORAGE_KEY, enabled ? 'true' : 'false');
  } catch {
    // ignore storage errors
  }
}

/**
 * Resolves the latest latency reading for an outbound node by preferring live
 * measured pings over cached bootstrap latency values.
 */
export function resolveOutboundLatency(
  node: Pick<LiveOutboundNode, 'id' | 'latency_ms'>,
  livePings: Record<string, number | null>
): ResolvedOutboundLatency {
  if (Object.prototype.hasOwnProperty.call(livePings, node.id)) {
    const live = livePings[node.id];
    if (typeof live === 'number' && Number.isFinite(live) && live > 0) {
      return { latencyMs: Math.round(live), state: 'measured' };
    }
    return { latencyMs: null, state: 'timeout' };
  }

  if (
    typeof node.latency_ms === 'number' &&
    Number.isFinite(node.latency_ms) &&
    node.latency_ms > 0
  ) {
    return { latencyMs: Math.round(node.latency_ms), state: 'cached' };
  }

  return { latencyMs: null, state: 'untested' };
}

function rankBucket(node: LiveOutboundNode, resolved: ResolvedOutboundLatency): number {
  if (node.is_online === false) return 3;
  if (resolved.latencyMs !== null) return 0;
  if (resolved.state === 'untested') return 1;
  return 2; // timeout / unreachable online node
}

/**
 * Deterministically sorts outbounds so the lowest-latency reachable nodes are
 * always placed at the top, followed by untested nodes, timed-out nodes, and
 * offline nodes. Never mutates the input array.
 */
export function sortOutboundsByLatency(
  outbounds: readonly LiveOutboundNode[],
  livePings: Record<string, number | null>
): LiveOutboundNode[] {
  if (outbounds.length <= 1) return [...outbounds];

  const indexed = outbounds.map((node, index) => {
    const resolved = resolveOutboundLatency(node, livePings);
    return {
      node,
      index,
      resolved,
      bucket: rankBucket(node, resolved),
    };
  });

  indexed.sort((a, b) => {
    if (a.bucket !== b.bucket) return a.bucket - b.bucket;

    // Both have valid latency: lowest ms always first
    if (a.bucket === 0 && a.resolved.latencyMs !== null && b.resolved.latencyMs !== null) {
      if (a.resolved.latencyMs !== b.resolved.latencyMs) {
        return a.resolved.latencyMs - b.resolved.latencyMs;
      }
      // Prefer live measured ping over stale cached latency on exact tie
      if (a.resolved.state !== b.resolved.state) {
        return a.resolved.state === 'measured' ? -1 : 1;
      }
    }

    // Secondary tie-breakers: higher health score, official nodes first, original order
    const healthDiff = (b.node.health_score || 0) - (a.node.health_score || 0);
    if (healthDiff !== 0) return healthDiff;

    if (a.node.is_official !== b.node.is_official) {
      return a.node.is_official ? -1 : 1;
    }

    return a.index - b.index;
  });

  return indexed.map((entry) => entry.node);
}

/**
 * Returns true when an automated periodic ping-optimization sweep is eligible to run.
 */
export function shouldRunPeriodicPingOptimization(ctx: PeriodicOptimizationContext): boolean {
  if (!ctx.enabled) return false;
  if (ctx.outboundsCount <= 0) return false;
  if (ctx.isTestingAll || ctx.isAutoResolving || ctx.isOptimizing) return false;
  if (!ctx.isDocumentVisible) return false;
  if (ctx.lastRunAtMs === null) return true;
  const interval = ctx.intervalMs ?? PING_OPT_INTERVAL_MS;
  return ctx.nowMs - ctx.lastRunAtMs >= interval;
}

/**
 * Checks whether the ordered sequence of outbound IDs changed between two lists.
 */
export function didOutboundOrderChange(
  previous: readonly Pick<LiveOutboundNode, 'id'>[],
  next: readonly Pick<LiveOutboundNode, 'id'>[]
): boolean {
  if (previous.length !== next.length) return true;
  for (let i = 0; i < previous.length; i += 1) {
    if (previous[i].id !== next[i].id) return true;
  }
  return false;
}

/**
 * Returns elapsed whole seconds since the last optimization timestamp, or null
 * when no pass has completed yet.
 */
export function getElapsedSecondsSinceOptimization(
  lastOptimizedAtMs: number | null,
  nowMs: number
): number | null {
  if (lastOptimizedAtMs === null || !Number.isFinite(lastOptimizedAtMs)) return null;
  return Math.max(0, Math.floor((nowMs - lastOptimizedAtMs) / 1000));
}
