export const LATENCY_WINDOW_MS = 60_000;
export const MAX_LATENCY_POINTS = 120;

export interface LatencyPoint {
  timestamp: number;
  latencyMs: number | null;
}

export interface LatencyStats {
  currentMs: number | null;
  avgMs: number | null;
  minMs: number | null;
  maxMs: number | null;
  validCount: number;
}

function normalizeLatencyValue(latencyMs: number | null | undefined): number | null {
  if (typeof latencyMs !== 'number' || !Number.isFinite(latencyMs) || latencyMs <= 0) {
    return null;
  }
  return Math.max(1, Math.round(latencyMs));
}

/**
 * Drops any latency samples older than the rolling window (default 60s).
 */
export function pruneLatencyHistory(
  history: LatencyPoint[],
  nowMs: number,
  windowMs: number = LATENCY_WINDOW_MS
): LatencyPoint[] {
  const cutoff = nowMs - windowMs;
  return history.filter(
    (pt) => Number.isFinite(pt.timestamp) && pt.timestamp >= cutoff && pt.timestamp <= nowMs + 1_000
  );
}

/**
 * Appends a new real-time latency measurement and enforces the 60-second rolling window.
 */
export function appendLatencySample(
  history: LatencyPoint[],
  latencyMs: number | null,
  nowMs: number,
  windowMs: number = LATENCY_WINDOW_MS
): LatencyPoint[] {
  const pruned = pruneLatencyHistory(history, nowMs, windowMs);
  const normalized = normalizeLatencyValue(latencyMs);

  // Coalesce duplicate sub-250ms ticks into the latest reading to keep curve smooth
  if (pruned.length > 0) {
    const last = pruned[pruned.length - 1];
    if (nowMs - last.timestamp < 250) {
      const updated = pruned.slice(0, -1);
      updated.push({ timestamp: nowMs, latencyMs: normalized });
      return updated;
    }
  }

  const next = [...pruned, { timestamp: nowMs, latencyMs: normalized }];
  if (next.length > MAX_LATENCY_POINTS) {
    return next.slice(next.length - MAX_LATENCY_POINTS);
  }
  return next;
}

/**
 * Computes live summary metrics (current, average, min, max) over valid positive samples.
 */
export function computeLatencyStats(history: LatencyPoint[]): LatencyStats {
  const validValues: number[] = [];
  for (const pt of history) {
    if (typeof pt.latencyMs === 'number' && Number.isFinite(pt.latencyMs) && pt.latencyMs > 0) {
      validValues.push(pt.latencyMs);
    }
  }

  if (validValues.length === 0) {
    return {
      currentMs: null,
      avgMs: null,
      minMs: null,
      maxMs: null,
      validCount: 0,
    };
  }

  let min = validValues[0];
  let max = validValues[0];
  let sum = 0;
  for (const v of validValues) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }

  return {
    currentMs: validValues[validValues.length - 1],
    avgMs: Math.round(sum / validValues.length),
    minMs: min,
    maxMs: max,
    validCount: validValues.length,
  };
}

/**
 * Computes a clean, readable Y-axis ceiling (in ms) with breathing room above peak latency.
 */
export function computeLatencyDomainMax(history: LatencyPoint[]): number {
  const { maxMs } = computeLatencyStats(history);
  if (maxMs === null) return 200;
  const padded = maxMs * 1.25;
  if (padded <= 100) return 100;
  if (padded <= 200) return 200;
  if (padded <= 300) return 300;
  if (padded <= 500) return 500;
  return Math.ceil(padded / 100) * 100;
}
