export const BYTES_PER_MB = 1024 * 1024;

export const LATENCY_PROBE_COUNT = 2;
export const DOWNLOAD_PROBE_SIZES = [131_072, 524_288, 1_572_864] as const;
export const UPLOAD_PROBE_SIZES = [131_072, 393_216, 786_432] as const;
export const TOTAL_SPEED_TEST_PROBES =
  LATENCY_PROBE_COUNT + DOWNLOAD_PROBE_SIZES.length + UPLOAD_PROBE_SIZES.length;

export type SpeedTestPhase =
  | 'idle'
  | 'latency'
  | 'download'
  | 'upload'
  | 'completed'
  | 'cancelled'
  | 'error';

export interface SpeedTestProgress {
  phase: SpeedTestPhase;
  completedProbes: number;
  totalProbes: number;
  phaseStep: number;
  phaseTotal: number;
  currentMBps: number | null;
  downloadMBps: number | null;
  uploadMBps: number | null;
  latencyMs: number | null;
}

export interface SpeedTestResult {
  downloadMBps: number;
  uploadMBps: number;
  latencyMs: number | null;
  totalBytesDownloaded: number;
  totalBytesUploaded: number;
  durationMs: number;
  completedAtIso: string;
  probesCount: number;
}

export interface ProbeMeasurement {
  bytes: number;
  durationMs: number;
}

export interface SpeedTestTransport {
  measureLatency: (signal: AbortSignal) => Promise<number>;
  measureDownload: (byteSize: number, signal: AbortSignal) => Promise<ProbeMeasurement>;
  measureUpload: (payload: Uint8Array, signal: AbortSignal) => Promise<ProbeMeasurement>;
}

/**
 * Converts a byte transfer count and wall-clock duration in ms into MB/s (MiB/s, matching app speed display).
 */
export function computeProbeThroughputMBps(bytesTransferred: number, durationMs: number): number {
  if (
    !Number.isFinite(bytesTransferred) ||
    !Number.isFinite(durationMs) ||
    bytesTransferred <= 0 ||
    durationMs <= 0
  ) {
    return 0;
  }
  const bytesPerSec = bytesTransferred / (durationMs / 1000);
  const mbps = bytesPerSec / BYTES_PER_MB;
  return Number.isFinite(mbps) && mbps > 0 ? mbps : 0;
}

/**
 * Aggregates sequential throughput probe samples into a representative sustained MB/s figure.
 * For 3+ progressive samples, drops the lowest sample (typically TCP slow-start warm-up) and averages the rest.
 */
export function aggregateThroughputSamples(samplesMBps: number[]): number {
  const valid = samplesMBps.filter((v) => Number.isFinite(v) && v > 0);
  if (valid.length === 0) return 0;
  if (valid.length <= 2) {
    const sum = valid.reduce((acc, v) => acc + v, 0);
    return Number((sum / valid.length).toFixed(2));
  }
  const sorted = [...valid].sort((a, b) => a - b);
  const sustained = sorted.slice(1);
  const sum = sustained.reduce((acc, v) => acc + v, 0);
  return Number((sum / sustained.length).toFixed(2));
}

export function formatThroughputMBps(mbps: number | null | undefined): string {
  if (mbps === null || mbps === undefined || !Number.isFinite(mbps) || mbps < 0) {
    return '—';
  }
  if (mbps >= 100) return `${mbps.toFixed(1)} MB/s`;
  return `${mbps.toFixed(2)} MB/s`;
}

/**
 * Generates deterministic pseudo-random incompressible bytes for upload probes
 * without triggering Web Crypto's 64 KB getRandomValues limit.
 */
export function createIncompressiblePayload(byteLength: number): Uint8Array {
  const safeLength = Math.max(0, Math.floor(byteLength));
  const buffer = new Uint8Array(safeLength);
  let state = 0x9e3779b9;
  for (let i = 0; i < safeLength; i += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    buffer[i] = state & 0xff;
  }
  return buffer;
}

function createAbortError(): Error {
  const err = new Error('Speed test cancelled');
  err.name = 'AbortError';
  return err;
}

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  return (err as { name?: string }).name === 'AbortError';
}

function nowPerf(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  outerSignal: AbortSignal,
  timeoutMs: number
): Promise<Response> {
  if (outerSignal.aborted) {
    throw createAbortError();
  }
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  outerSignal.addEventListener('abort', onOuterAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (err) {
    if (outerSignal.aborted) {
      throw createAbortError();
    }
    throw err;
  } finally {
    clearTimeout(timer);
    outerSignal.removeEventListener('abort', onOuterAbort);
  }
}

async function readResponseByteLength(response: Response, signal: AbortSignal): Promise<number> {
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    let total = 0;
    try {
      while (true) {
        if (signal.aborted) {
          await reader.cancel().catch(() => {});
          throw createAbortError();
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (value) total += value.byteLength;
      }
      return total;
    } finally {
      reader.releaseLock();
    }
  }
  const buf = await response.arrayBuffer();
  return buf.byteLength;
}

/**
 * Default real-world browser/Tauri HTTP throughput transport using public CORS-enabled speed probe endpoints
 * (Cloudflare Speed Test primary, httpbin secondary fallback). Never fabricates numbers.
 */
export function createBrowserSpeedTestTransport(): SpeedTestTransport {
  return {
    async measureLatency(signal: AbortSignal): Promise<number> {
      const endpoints = [
        `https://speed.cloudflare.com/__down?bytes=0&_t=${Date.now()}`,
        `https://httpbin.org/get?_t=${Date.now()}`,
      ];
      let lastErr: unknown = null;
      for (const url of endpoints) {
        try {
          const start = nowPerf();
          const resp = await fetchWithTimeout(url, { method: 'GET' }, signal, 6000);
          await resp.arrayBuffer();
          const elapsed = Math.max(1, Math.round(nowPerf() - start));
          if (resp.ok) return elapsed;
        } catch (err) {
          if (isAbortError(err)) throw err;
          lastErr = err;
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error('Latency probe failed');
    },

    async measureDownload(byteSize: number, signal: AbortSignal): Promise<ProbeMeasurement> {
      const endpoints = [
        `https://speed.cloudflare.com/__down?bytes=${byteSize}&_t=${Date.now()}`,
        `https://httpbin.org/bytes/${Math.min(byteSize, 102_400)}?_t=${Date.now()}`,
      ];
      let lastErr: unknown = null;
      for (const url of endpoints) {
        try {
          const start = nowPerf();
          const resp = await fetchWithTimeout(url, { method: 'GET' }, signal, 15000);
          if (!resp.ok) {
            throw new Error(`HTTP ${resp.status}`);
          }
          const bytes = await readResponseByteLength(resp, signal);
          const durationMs = Math.max(1, nowPerf() - start);
          if (bytes > 0) {
            return { bytes, durationMs };
          }
        } catch (err) {
          if (isAbortError(err)) throw err;
          lastErr = err;
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error('Download probe failed');
    },

    async measureUpload(payload: Uint8Array, signal: AbortSignal): Promise<ProbeMeasurement> {
      const endpoints = [
        `https://speed.cloudflare.com/__up?_t=${Date.now()}`,
        `https://httpbin.org/post?_t=${Date.now()}`,
      ];
      const body = new Blob([payload.buffer as ArrayBuffer], {
        type: 'application/octet-stream',
      });
      let lastErr: unknown = null;
      for (const url of endpoints) {
        try {
          const start = nowPerf();
          const resp = await fetchWithTimeout(
            url,
            {
              method: 'POST',
              body,
            },
            signal,
            15000
          );
          if (!resp.ok) {
            throw new Error(`HTTP ${resp.status}`);
          }
          await resp.arrayBuffer().catch(() => {});
          const durationMs = Math.max(1, nowPerf() - start);
          return { bytes: payload.byteLength, durationMs };
        } catch (err) {
          if (isAbortError(err)) throw err;
          lastErr = err;
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error('Upload probe failed');
    },
  };
}

export interface RunNetworkSpeedTestOptions {
  signal?: AbortSignal;
  onProgress?: (progress: SpeedTestProgress) => void;
  transport?: SpeedTestTransport;
}

/**
 * Executes a sequential real-world speed test:
 * 1) 2x latency warm-up probes
 * 2) 3x progressive download throughput probes (128 KB -> 512 KB -> 1.5 MB)
 * 3) 3x progressive upload throughput probes (128 KB -> 384 KB -> 768 KB)
 */
export async function runNetworkSpeedTest(
  options: RunNetworkSpeedTestOptions = {}
): Promise<SpeedTestResult> {
  const controller = new AbortController();
  const signal = options.signal ?? controller.signal;
  const transport = options.transport ?? createBrowserSpeedTestTransport();
  const onProgress = options.onProgress;

  const overallStart = nowPerf();
  let completedProbes = 0;

  const latencySamples: number[] = [];
  const downloadSamples: number[] = [];
  const uploadSamples: number[] = [];
  let totalBytesDownloaded = 0;
  let totalBytesUploaded = 0;

  let currentLatencyMs: number | null = null;
  let currentDownloadMBps: number | null = null;
  let currentUploadMBps: number | null = null;

  const emitProgress = (
    phase: SpeedTestPhase,
    phaseStep: number,
    phaseTotal: number,
    currentMBps: number | null
  ) => {
    onProgress?.({
      phase,
      completedProbes,
      totalProbes: TOTAL_SPEED_TEST_PROBES,
      phaseStep,
      phaseTotal,
      currentMBps,
      downloadMBps: currentDownloadMBps,
      uploadMBps: currentUploadMBps,
      latencyMs: currentLatencyMs,
    });
  };

  // Phase 1: Latency warm-up probes
  emitProgress('latency', 0, LATENCY_PROBE_COUNT, null);
  for (let i = 0; i < LATENCY_PROBE_COUNT; i += 1) {
    if (signal.aborted) throw createAbortError();
    try {
      const rtt = await transport.measureLatency(signal);
      if (Number.isFinite(rtt) && rtt > 0) {
        latencySamples.push(rtt);
        currentLatencyMs = Math.round(Math.min(...latencySamples));
      }
    } catch (err) {
      if (isAbortError(err)) throw err;
    }
    completedProbes += 1;
    emitProgress('latency', i + 1, LATENCY_PROBE_COUNT, null);
  }

  // Phase 2: Sequential progressive download probes
  emitProgress('download', 0, DOWNLOAD_PROBE_SIZES.length, null);
  for (let i = 0; i < DOWNLOAD_PROBE_SIZES.length; i += 1) {
    if (signal.aborted) throw createAbortError();
    const targetBytes = DOWNLOAD_PROBE_SIZES[i];
    try {
      const measurement = await transport.measureDownload(targetBytes, signal);
      totalBytesDownloaded += measurement.bytes;
      const mbps = computeProbeThroughputMBps(measurement.bytes, measurement.durationMs);
      if (mbps > 0) {
        downloadSamples.push(mbps);
        currentDownloadMBps = aggregateThroughputSamples(downloadSamples);
      }
      completedProbes += 1;
      emitProgress('download', i + 1, DOWNLOAD_PROBE_SIZES.length, mbps > 0 ? mbps : null);
    } catch (err) {
      if (isAbortError(err)) throw err;
      completedProbes += 1;
      emitProgress('download', i + 1, DOWNLOAD_PROBE_SIZES.length, null);
    }
  }

  if (downloadSamples.length === 0) {
    throw new Error('Download probes failed. Check your network connection and try again.');
  }

  // Phase 3: Sequential progressive upload probes
  emitProgress('upload', 0, UPLOAD_PROBE_SIZES.length, null);
  for (let i = 0; i < UPLOAD_PROBE_SIZES.length; i += 1) {
    if (signal.aborted) throw createAbortError();
    const payload = createIncompressiblePayload(UPLOAD_PROBE_SIZES[i]);
    try {
      const measurement = await transport.measureUpload(payload, signal);
      totalBytesUploaded += measurement.bytes;
      const mbps = computeProbeThroughputMBps(measurement.bytes, measurement.durationMs);
      if (mbps > 0) {
        uploadSamples.push(mbps);
        currentUploadMBps = aggregateThroughputSamples(uploadSamples);
      }
      completedProbes += 1;
      emitProgress('upload', i + 1, UPLOAD_PROBE_SIZES.length, mbps > 0 ? mbps : null);
    } catch (err) {
      if (isAbortError(err)) throw err;
      completedProbes += 1;
      emitProgress('upload', i + 1, UPLOAD_PROBE_SIZES.length, null);
    }
  }

  if (uploadSamples.length === 0) {
    throw new Error('Upload probes failed. Check your network connection and try again.');
  }

  const finalDownload = aggregateThroughputSamples(downloadSamples);
  const finalUpload = aggregateThroughputSamples(uploadSamples);
  currentDownloadMBps = finalDownload;
  currentUploadMBps = finalUpload;

  emitProgress('completed', TOTAL_SPEED_TEST_PROBES, TOTAL_SPEED_TEST_PROBES, null);

  return {
    downloadMBps: finalDownload,
    uploadMBps: finalUpload,
    latencyMs: currentLatencyMs,
    totalBytesDownloaded,
    totalBytesUploaded,
    durationMs: Math.max(1, Math.round(nowPerf() - overallStart)),
    completedAtIso: new Date().toISOString(),
    probesCount: downloadSamples.length + uploadSamples.length,
  };
}
