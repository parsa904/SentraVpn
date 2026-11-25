import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TRAFFIC_WINDOW_MS,
  appendTrafficSample,
  computeTrafficDomainMax,
  computeTrafficStats,
  formatCompactTrafficTick,
  pruneTrafficHistory,
  type TrafficPoint,
} from './trafficHistory';

describe('trafficHistory rolling 60s window', () => {
  it('prunes samples older than 60 seconds and preserves active window points', () => {
    const now = 100_000;
    const history: TrafficPoint[] = [
      { timestamp: now - TRAFFIC_WINDOW_MS - 1, downloadBps: 500_000, uploadBps: 100_000 },
      { timestamp: now - TRAFFIC_WINDOW_MS, downloadBps: 1_000_000, uploadBps: 250_000 },
      { timestamp: now - 5_000, downloadBps: 2_000_000, uploadBps: 500_000 },
    ];

    const pruned = pruneTrafficHistory(history, now);
    assert.equal(pruned.length, 2);
    assert.equal(pruned[0].downloadBps, 1_000_000);
    assert.equal(pruned[1].uploadBps, 500_000);
  });

  it('appends samples, sanitizes invalid speeds, and coalesces sub-250ms ticks', () => {
    let history: TrafficPoint[] = [];
    history = appendTrafficSample(history, 1_200_000, 300_000, 10_000);
    history = appendTrafficSample(history, 1_500_000, -40, 10_100); // coalesces into previous
    history = appendTrafficSample(history, Number.NaN, 450_000, 11_000);

    assert.equal(history.length, 2);
    assert.deepEqual(history[0], { timestamp: 10_100, downloadBps: 1_500_000, uploadBps: 0 });
    assert.deepEqual(history[1], { timestamp: 11_000, downloadBps: 0, uploadBps: 450_000 });
  });

  it('computes accurate current, peak, and average traffic metrics', () => {
    const history: TrafficPoint[] = [
      { timestamp: 1_000, downloadBps: 1_000_000, uploadBps: 200_000 },
      { timestamp: 2_000, downloadBps: 4_000_000, uploadBps: 800_000 },
      { timestamp: 3_000, downloadBps: 2_500_000, uploadBps: 500_000 },
    ];

    const stats = computeTrafficStats(history);
    assert.deepEqual(stats, {
      currentDownloadBps: 2_500_000,
      currentUploadBps: 500_000,
      peakDownloadBps: 4_000_000,
      peakUploadBps: 800_000,
      peakCombinedBps: 4_000_000,
      avgDownloadBps: 2_500_000,
      avgUploadBps: 500_000,
      sampleCount: 3,
    });
  });

  it('selects clean Y-axis ceilings and formats compact ticks accurately', () => {
    assert.equal(computeTrafficDomainMax([]), 100 * 1024);
    assert.equal(
      computeTrafficDomainMax([{ timestamp: 1_000, downloadBps: 3_800_000, uploadBps: 900_000 }]),
      5 * 1024 * 1024
    );
    assert.equal(formatCompactTrafficTick(0), '0');
    assert.equal(formatCompactTrafficTick(512 * 1024), '512 KB');
    assert.equal(formatCompactTrafficTick(2.5 * 1024 * 1024), '2.5 MB');
    assert.equal(formatCompactTrafficTick(10 * 1024 * 1024), '10 MB');
  });
});
