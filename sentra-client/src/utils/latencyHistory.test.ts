import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LATENCY_WINDOW_MS,
  appendLatencySample,
  computeLatencyDomainMax,
  computeLatencyStats,
  pruneLatencyHistory,
} from './latencyHistory';

test('appendLatencySample maintains a 60-second rolling window and sanitizes values', () => {
  const t0 = 1_700_000_000_000;
  let history = appendLatencySample([], 74.6, t0);
  history = appendLatencySample(history, 88.2, t0 + 20_000);
  history = appendLatencySample(history, -5, t0 + 40_000); // invalid -> null timeout marker
  history = appendLatencySample(history, 62, t0 + LATENCY_WINDOW_MS + 5_000); // prunes t0

  assert.equal(history.length, 3);
  assert.equal(history[0].latencyMs, 88);
  assert.equal(history[1].latencyMs, null);
  assert.equal(history[2].latencyMs, 62);
});

test('pruneLatencyHistory removes points strictly older than the 60s cutoff', () => {
  const now = 1_700_000_100_000;
  const pruned = pruneLatencyHistory(
    [
      { timestamp: now - 61_000, latencyMs: 50 },
      { timestamp: now - 60_000, latencyMs: 60 },
      { timestamp: now - 15_000, latencyMs: 70 },
    ],
    now
  );

  assert.equal(pruned.length, 2);
  assert.equal(pruned[0].latencyMs, 60);
  assert.equal(pruned[1].latencyMs, 70);
});

test('computeLatencyStats calculates current, average, min, max over valid samples', () => {
  const stats = computeLatencyStats([
    { timestamp: 1000, latencyMs: 60 },
    { timestamp: 2000, latencyMs: null },
    { timestamp: 3000, latencyMs: 120 },
    { timestamp: 4000, latencyMs: 90 },
  ]);

  assert.deepEqual(stats, {
    currentMs: 90,
    avgMs: 90,
    minMs: 60,
    maxMs: 120,
    validCount: 3,
  });

  assert.deepEqual(computeLatencyStats([{ timestamp: 1000, latencyMs: null }]), {
    currentMs: null,
    avgMs: null,
    minMs: null,
    maxMs: null,
    validCount: 0,
  });
});

test('computeLatencyDomainMax returns readable stepped ceilings', () => {
  assert.equal(computeLatencyDomainMax([]), 200);
  assert.equal(computeLatencyDomainMax([{ timestamp: 1000, latencyMs: 45 }]), 100);
  assert.equal(computeLatencyDomainMax([{ timestamp: 1000, latencyMs: 130 }]), 200);
  assert.equal(computeLatencyDomainMax([{ timestamp: 1000, latencyMs: 220 }]), 300);
  assert.equal(computeLatencyDomainMax([{ timestamp: 1000, latencyMs: 360 }]), 500);
  assert.equal(computeLatencyDomainMax([{ timestamp: 1000, latencyMs: 620 }]), 800);
});
