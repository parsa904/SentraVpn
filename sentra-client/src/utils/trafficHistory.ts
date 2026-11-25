export const TRAFFIC_WINDOW_MS = 60_000;
export const MAX_TRAFFIC_POINTS = 120;

export interface TrafficPoint {
  timestamp: number;
  downloadBps: number;
  uploadBps: number;
}

export interface TrafficStats {
  currentDownloadBps: number;
  currentUploadBps: number;
  peakDownloadBps: number;
  peakUploadBps: number;
  peakCombinedBps: number;
  avgDownloadBps: number;
  avgUploadBps: number;
  sampleCount: number;
}

const KB = 1024;
const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;

const CLEAN_CEILINGS_BPS = [
  10 * KB,
  50 * KB,
  100 * KB,
  250 * KB,
  500 * KB,
  1 * MB,
  2 * MB,
  5 * MB,
  10 * MB,
  25 * MB,
  50 * MB,
  100 * MB,
  250 * MB,
  500 * MB,
  1 * GB,
];

function normalizeBps(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.round(value);
}

/**
 * Drops any traffic samples older than the rolling window (default 60s).
 */
export function pruneTrafficHistory(
  history: readonly TrafficPoint[],
  nowMs: number,
  windowMs: number = TRAFFIC_WINDOW_MS
): TrafficPoint[] {
  const cutoff = nowMs - windowMs;
  return history.filter(
    (pt) => Number.isFinite(pt.timestamp) && pt.timestamp >= cutoff && pt.timestamp <= nowMs + 1_000
  );
}

/**
 * Appends a real-time upload/download throughput sample and enforces the 60-second rolling window.
 */
export function appendTrafficSample(
  history: readonly TrafficPoint[],
  downloadBps: number | null | undefined,
  uploadBps: number | null | undefined,
  nowMs: number,
  windowMs: number = TRAFFIC_WINDOW_MS
): TrafficPoint[] {
  const pruned = pruneTrafficHistory(history, nowMs, windowMs);
  const dl = normalizeBps(downloadBps);
  const ul = normalizeBps(uploadBps);

  // Coalesce sub-250ms bursts into the latest sample for smooth D3 paths
  if (pruned.length > 0) {
    const last = pruned[pruned.length - 1];
    if (nowMs - last.timestamp < 250) {
      const updated = pruned.slice(0, -1);
      updated.push({ timestamp: nowMs, downloadBps: dl, uploadBps: ul });
      return updated;
    }
  }

  const next = [...pruned, { timestamp: nowMs, downloadBps: dl, uploadBps: ul }];
  if (next.length > MAX_TRAFFIC_POINTS) {
    return next.slice(next.length - MAX_TRAFFIC_POINTS);
  }
  return next;
}

/**
 * Computes current, peak, and average upload/download statistics across the rolling window.
 */
export function computeTrafficStats(history: readonly TrafficPoint[]): TrafficStats {
  if (history.length === 0) {
    return {
      currentDownloadBps: 0,
      currentUploadBps: 0,
      peakDownloadBps: 0,
      peakUploadBps: 0,
      peakCombinedBps: 0,
      avgDownloadBps: 0,
      avgUploadBps: 0,
      sampleCount: 0,
    };
  }

  let peakDl = 0;
  let peakUl = 0;
  let sumDl = 0;
  let sumUl = 0;

  for (const pt of history) {
    const dl = normalizeBps(pt.downloadBps);
    const ul = normalizeBps(pt.uploadBps);
    if (dl > peakDl) peakDl = dl;
    if (ul > peakUl) peakUl = ul;
    sumDl += dl;
    sumUl += ul;
  }

  const latest = history[history.length - 1];
  return {
    currentDownloadBps: normalizeBps(latest.downloadBps),
    currentUploadBps: normalizeBps(latest.uploadBps),
    peakDownloadBps: peakDl,
    peakUploadBps: peakUl,
    peakCombinedBps: Math.max(peakDl, peakUl),
    avgDownloadBps: Math.round(sumDl / history.length),
    avgUploadBps: Math.round(sumUl / history.length),
    sampleCount: history.length,
  };
}

/**
 * Computes a clean, readable Y-axis ceiling (in bytes/sec) with breathing room above peak speed.
 */
export function computeTrafficDomainMax(history: readonly TrafficPoint[]): number {
  const { peakCombinedBps } = computeTrafficStats(history);
  if (peakCombinedBps <= 0) return 100 * KB;

  const padded = peakCombinedBps * 1.2;
  for (const step of CLEAN_CEILINGS_BPS) {
    if (padded <= step) return step;
  }
  return Math.ceil(padded / (100 * MB)) * (100 * MB);
}

/**
 * Formats a compact Y-axis throughput tick label (e.g. "0", "250 KB", "2.5 MB").
 */
export function formatCompactTrafficTick(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return '0';
  if (bps >= GB) {
    const val = bps / GB;
    return `${val >= 10 || Number.isInteger(val) ? Math.round(val) : val.toFixed(1)} GB`;
  }
  if (bps >= MB) {
    const val = bps / MB;
    return `${val >= 10 || Number.isInteger(val) ? Math.round(val) : val.toFixed(1)} MB`;
  }
  if (bps >= KB) {
    const val = bps / KB;
    return `${val >= 10 || Number.isInteger(val) ? Math.round(val) : val.toFixed(1)} KB`;
  }
  return `${Math.round(bps)} B`;
}
