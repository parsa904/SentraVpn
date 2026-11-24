import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BYTES_PER_MB,
  DOWNLOAD_PROBE_SIZES,
  TOTAL_SPEED_TEST_PROBES,
  UPLOAD_PROBE_SIZES,
  type SpeedTestProgress,
  type SpeedTestTransport,
  aggregateThroughputSamples,
  computeProbeThroughputMBps,
  createIncompressiblePayload,
  formatThroughputMBps,
  isAbortError,
  runNetworkSpeedTest,
} from './speedTest';

test('computeProbeThroughputMBps calculates accurate MB/s and guards invalid inputs', () => {
  // 2 MiB in 500ms = 4.00 MB/s
  assert.equal(computeProbeThroughputMBps(2 * BYTES_PER_MB, 500), 4);
  // 512 KiB in 250ms = 2.00 MB/s
  assert.equal(computeProbeThroughputMBps(512 * 1024, 250), 2);
  assert.equal(computeProbeThroughputMBps(0, 100), 0);
  assert.equal(computeProbeThroughputMBps(1024, 0), 0);
  assert.equal(computeProbeThroughputMBps(-100, 100), 0);
  assert.equal(computeProbeThroughputMBps(Number.NaN, 100), 0);
});

test('aggregateThroughputSamples drops cold-start outlier for 3+ samples and rounds cleanly', () => {
  // Cold start 3.0 MB/s dropped; average of 12.0 and 14.0 = 13.00 MB/s
  assert.equal(aggregateThroughputSamples([3.0, 12.0, 14.0]), 13);
  // Two samples average directly
  assert.equal(aggregateThroughputSamples([8.5, 10.5]), 9.5);
  // Ignores invalid or zero values
  assert.equal(aggregateThroughputSamples([0, -2, Number.NaN, 6.25]), 6.25);
  assert.equal(aggregateThroughputSamples([]), 0);
});

test('formatThroughputMBps formats standard and high speeds consistently', () => {
  assert.equal(formatThroughputMBps(12.345), '12.35 MB/s');
  assert.equal(formatThroughputMBps(0.75), '0.75 MB/s');
  assert.equal(formatThroughputMBps(142.68), '142.7 MB/s');
  assert.equal(formatThroughputMBps(null), '—');
});

test('createIncompressiblePayload generates deterministic non-zero payload of requested length', () => {
  const payload = createIncompressiblePayload(4096);
  assert.equal(payload.byteLength, 4096);
  const uniqueBytes = new Set(payload);
  assert.ok(uniqueBytes.size > 100, 'Expected high byte diversity to prevent HTTP compression distortion');
});

test('runNetworkSpeedTest executes full latency, download, and upload probe sequence in order', async () => {
  const callLog: string[] = [];
  const progressEvents: SpeedTestProgress[] = [];

  const transport: SpeedTestTransport = {
    async measureLatency() {
      callLog.push('latency');
      return callLog.length === 1 ? 52 : 44;
    },
    async measureDownload(byteSize) {
      callLog.push(`down:${byteSize}`);
      // Simulate 10 MB/s sustained download (durationMs = bytes / (10 MiB/s) * 1000)
      const durationMs = (byteSize / (10 * BYTES_PER_MB)) * 1000;
      return { bytes: byteSize, durationMs };
    },
    async measureUpload(payload) {
      callLog.push(`up:${payload.byteLength}`);
      // Simulate 4 MB/s sustained upload
      const durationMs = (payload.byteLength / (4 * BYTES_PER_MB)) * 1000;
      return { bytes: payload.byteLength, durationMs };
    },
  };

  const result = await runNetworkSpeedTest({
    transport,
    onProgress: (p) => progressEvents.push(p),
  });

  assert.equal(callLog.length, TOTAL_SPEED_TEST_PROBES);
  assert.deepEqual(callLog, [
    'latency',
    'latency',
    ...DOWNLOAD_PROBE_SIZES.map((s) => `down:${s}`),
    ...UPLOAD_PROBE_SIZES.map((s) => `up:${s}`),
  ]);
  assert.equal(result.latencyMs, 44);
  assert.equal(result.downloadMBps, 10);
  assert.equal(result.uploadMBps, 4);
  assert.equal(
    result.totalBytesDownloaded,
    DOWNLOAD_PROBE_SIZES.reduce((a, b) => a + b, 0)
  );
  assert.equal(
    result.totalBytesUploaded,
    UPLOAD_PROBE_SIZES.reduce((a, b) => a + b, 0)
  );
  assert.equal(progressEvents[progressEvents.length - 1]?.phase, 'completed');
  assert.equal(progressEvents[progressEvents.length - 1]?.completedProbes, TOTAL_SPEED_TEST_PROBES);
});

test('runNetworkSpeedTest stops immediately when AbortSignal is triggered', async () => {
  const controller = new AbortController();
  let calls = 0;

  const transport: SpeedTestTransport = {
    async measureLatency() {
      calls += 1;
      controller.abort();
      return 35;
    },
    async measureDownload(byteSize) {
      calls += 1;
      return { bytes: byteSize, durationMs: 100 };
    },
    async measureUpload(payload) {
      calls += 1;
      return { bytes: payload.byteLength, durationMs: 100 };
    },
  };

  await assert.rejects(
    () => runNetworkSpeedTest({ signal: controller.signal, transport }),
    (err) => isAbortError(err)
  );
  assert.equal(calls, 1);
});

test('runNetworkSpeedTest throws a clean error when all download probes fail', async () => {
  const transport: SpeedTestTransport = {
    async measureLatency() {
      return 40;
    },
    async measureDownload() {
      throw new Error('Network unreachable');
    },
    async measureUpload(payload) {
      return { bytes: payload.byteLength, durationMs: 100 };
    },
  };

  await assert.rejects(
    () => runNetworkSpeedTest({ transport }),
    /Download probes failed/i
  );
});
