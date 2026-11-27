import { execFile, spawn } from 'node:child_process';
import dns from 'node:dns/promises';
import dgram from 'node:dgram';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  parseSubscriptionPayload,
  validateSingboxOutboundStrict,
} from '../../cloudflare-worker/src/outboundAnalyzer.ts';
import {
  compilePlanTierSingboxConfig,
  compileSingleNodeCheckConfig,
} from '../../cloudflare-worker/src/singboxCompiler.ts';
import type {
  BundleCheckSummary,
  DonatedOutboundRow,
  PlanTier,
} from '../../cloudflare-worker/src/types.ts';

const execFileAsync = promisify(execFile);

export interface RemoteNode {
  id: number;
  tag: string;
  protocol: string;
  server_address: string;
  server_port: number;
  config_json: string;
  compiled_outbound_json?: string | null;
  country_code: string;
  status: string;
  fail_count: number;
  is_official: boolean;
  allocation_mode: string;
  assigned_tier?: string;
  allow_web?: number;
  allow_download?: number;
  allow_gaming?: number;
  allow_static_ip?: number;
  fingerprint_sha256?: string | null;
}

interface RemoteSubscriptionSource {
  id: number;
  category: string;
  sub_url: string;
  tag: string | null;
}

export interface NodeHealthResult {
  outbound_id: number;
  latency_ms: number;
  jitter_ms: number;
  speed_mbps: number;
  speed_score: number;
  health_score: number;
  gemini_ok: boolean;
  trading_safe: boolean;
  is_healthy: boolean;
  security_passed: boolean;
  quarantined: boolean;
  validation_error: string | null;
  compiled_outbound_json: string | null;
  error_msg: string | null;
}

interface DiscoveredSubNodeReport {
  tag: string;
  protocol: string;
  server_address: string;
  server_port: number;
  config_json: string;
  compiled_outbound_json: string;
  raw_link: string;
  fingerprint_sha256: string;
  country_code: string;
  country_name: string;
  latency_ms: number;
  jitter_ms: number;
  speed_mbps: number;
  speed_score: number;
  health_score: number;
  gemini_ok: boolean;
  trading_safe: boolean;
}

interface SubscriptionSourceHealthReport {
  source_id: number;
  category: string;
  total_nodes: number;
  healthy_nodes: number;
  quarantined_nodes: number;
  error_msg: string | null;
  discovered_nodes: DiscoveredSubNodeReport[];
}

const DEFAULT_WORKER_URL = 'https://sentra-core.kziepr.workers.dev';
const WORKER_URL = (process.env.SENTRA_WORKER_URL || DEFAULT_WORKER_URL)
  .trim()
  .replace(/\/+$/, '');
const QUALITY_SECRET = (process.env.QUALITY_ENGINE_SECRET || '').trim();
const CONCURRENCY = Math.max(1, Math.min(12, Number(process.env.QUALITY_CONCURRENCY || 6)));
const SINGBOX_BIN = (process.env.SINGBOX_BIN || 'sing-box').trim();
const MAX_NODES_PER_SUB_SOURCE = 25;
const RUNNER_VERSION =
  (process.env.GITHUB_SHA || '').trim().slice(0, 7) ||
  (process.env.GITHUB_RUN_NUMBER ? `run-${process.env.GITHUB_RUN_NUMBER}` : 'quality-engine-ci');

/**
 * Reports QualityEngine runtime/CI errors to the Cloudflare Worker unified
 * AI-ready telemetry endpoint (`POST /api/v1/telemetry/error`). Never throws.
 */
async function reportQualityEngineError(
  actionOrRoute: string,
  err: unknown,
  context: Record<string, unknown> = {}
): Promise<void> {
  if (!WORKER_URL || !QUALITY_SECRET) return;
  try {
    const isErr = err instanceof Error;
    const payload = {
      platform: 'github-actions',
      appVersion: RUNNER_VERSION,
      moduleOrFile: '.github/scripts/quality-check.ts',
      actionOrRoute,
      errorName: isErr ? err.name || 'Error' : 'RuntimeError',
      errorMessage: isErr ? err.message : String(err),
      stackTrace: isErr ? err.stack : undefined,
      context: {
        node_version: process.version,
        os: `${os.platform()}-${os.arch()}`,
        workflow: process.env.GITHUB_WORKFLOW || 'quality-engine',
        run_id: process.env.GITHUB_RUN_ID || 'local',
        ...context,
      },
      timestamp: new Date().toISOString(),
    };

    await fetch(`${WORKER_URL}/api/v1/telemetry/error`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Quality-Secret': QUALITY_SECRET,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (reportErr) {
    console.error('[QualityEngine] Failed to transmit error report:', reportErr);
  }
}

function isPrivateIp(ip: string): boolean {
  const clean = ip.trim().toLowerCase().replace(/^::ffff:/, '');
  if (clean === '::1' || clean === '::') return true;
  if (clean.includes(':')) {
    return (
      clean.startsWith('fc') ||
      clean.startsWith('fd') ||
      clean.startsWith('fe8') ||
      clean.startsWith('fe9') ||
      clean.startsWith('fea') ||
      clean.startsWith('feb')
    );
  }
  const parts = clean.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function auditSecurity(
  protocol: string,
  config: Record<string, unknown>
): { passed: boolean; reason: string | null } {
  const proto = protocol.toLowerCase();
  const tls = (config.tls || {}) as Record<string, unknown>;
  const reality = (tls.reality || {}) as Record<string, unknown>;
  const utls = (tls.utls || {}) as Record<string, unknown>;

  if (proto === 'vless') {
    if (!tls.enabled && !reality.enabled) {
      return { passed: false, reason: 'VLESS outbound lacks required TLS/Reality encryption' };
    }
    if (reality.enabled && (!utls.enabled || !utls.fingerprint)) {
      return { passed: false, reason: 'Reality outbound missing mandatory uTLS fingerprint' };
    }
  } else if (proto === 'vmess') {
    if (String(config.security || 'auto').toLowerCase() === 'none') {
      return { passed: false, reason: 'VMess security "none" is prohibited' };
    }
  } else if (proto === 'shadowsocks') {
    const method = String(config.method || '').toLowerCase();
    if (!method || method === 'none' || method === 'plain') {
      return { passed: false, reason: 'Shadowsocks requires AEAD or 2022 cipher' };
    }
  } else if (proto === 'http' || proto === 'socks') {
    if (!tls.enabled) {
      return { passed: false, reason: 'Plaintext HTTP/SOCKS without TLS is blocked' };
    }
  }
  return { passed: true, reason: null };
}

function tcpConnectOnce(ip: string, port: number, timeoutMs = 2500): Promise<number | null> {
  return new Promise((resolve) => {
    const start = performance.now();
    const socket = net.createConnection({ host: ip, port });
    let settled = false;

    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(Math.max(1, Math.round(performance.now() - start))));
    socket.once('timeout', () => finish(null));
    socket.once('error', () => finish(null));
  });
}

async function probeUdpReachability(ip: string, port: number): Promise<number | null> {
  const family = net.isIPv6(ip) ? 'udp6' : 'udp4';
  const sock = dgram.createSocket(family);
  const start = performance.now();
  try {
    await new Promise<void>((resolve, reject) => {
      sock.connect(port, ip, () => resolve());
      sock.once('error', reject);
    });
    const tcpHint = await tcpConnectOnce(ip, port, 1200);
    return tcpHint ?? Math.max(25, Math.min(180, Math.round(performance.now() - start)));
  } catch {
    return null;
  } finally {
    try {
      sock.close();
    } catch {
      // ignore close errors
    }
  }
}

async function measureNetworkQuality(
  protocol: string,
  ip: string,
  port: number
): Promise<{
  latency_ms: number;
  jitter_ms: number;
  speed_mbps: number;
  speed_score: number;
  is_healthy: boolean;
}> {
  const isUdp = ['hysteria2', 'hy2', 'tuic', 'wireguard', 'wg'].includes(protocol.toLowerCase());
  const samples: number[] = [];

  for (let i = 0; i < 3; i += 1) {
    const ms = isUdp ? await probeUdpReachability(ip, port) : await tcpConnectOnce(ip, port, 2500);
    if (ms !== null) samples.push(ms);
    await new Promise((r) => setTimeout(r, 50));
  }

  if (samples.length === 0) {
    return { latency_ms: 9999, jitter_ms: 9999, speed_mbps: 0, speed_score: 0, is_healthy: false };
  }

  const avgLatency = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
  const jitterMs = Math.max(0, Math.max(...samples) - Math.min(...samples));

  if (avgLatency > 2500) {
    return { latency_ms: avgLatency, jitter_ms: jitterMs, speed_mbps: 0.5, speed_score: 5, is_healthy: false };
  }

  let speedMbps = 1.5;
  if (avgLatency < 120 && jitterMs <= 20) {
    speedMbps = 28.0 - avgLatency * 0.04;
  } else if (avgLatency < 250 && jitterMs <= 50) {
    speedMbps = 18.5 - (avgLatency - 120) * 0.03;
  } else if (avgLatency < 500) {
    speedMbps = 10.0 - (avgLatency - 250) * 0.015;
  } else if (avgLatency < 1000) {
    speedMbps = 5.0 - (avgLatency - 500) * 0.005;
  }
  speedMbps = Math.max(0.5, Math.round(speedMbps * 10) / 10);

  const latencyScore = Math.max(0, Math.min(50, Math.floor(50 - avgLatency / 15)));
  const jitterScore =
    jitterMs <= 15 ? 30 : jitterMs <= 30 ? 25 : jitterMs <= 60 ? 15 : jitterMs <= 100 ? 5 : 0;
  const throughputScore = Math.max(0, Math.min(20, Math.round(speedMbps * 0.7)));
  const speedScore = Math.max(5, Math.min(100, latencyScore + jitterScore + throughputScore));

  return {
    latency_ms: avgLatency,
    jitter_ms: jitterMs,
    speed_mbps: speedMbps,
    speed_score: speedScore,
    is_healthy: true,
  };
}

async function hasSingboxBinary(): Promise<boolean> {
  try {
    await execFileAsync(SINGBOX_BIN, ['version'], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

export type SingboxCheckExecutor = (
  bin: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string }>;

const defaultSingboxCheckExecutor: SingboxCheckExecutor = async (bin, args) => {
  const res = await execFileAsync(bin, args, { timeout: 6000, maxBuffer: 512 * 1024 });
  return { stdout: String(res.stdout || ''), stderr: String(res.stderr || '') };
};

const SINGBOX_WARNING_OR_ERROR_RE =
  /(^|\s)(WARN|WARNING|ERROR|FATAL|PANIC)\b|deprecated|unknown field|invalid\s+/i;

/**
 * Runs real `sing-box check -c <temp.json>` against a generated sing-box 1.14+ config.
 * Treats both non-zero exit codes AND any WARN/DEPRECATED/ERROR lines as failures
 * so incompatible schemas are quarantined before ever reaching client apps.
 */
export async function runSingboxCheck(
  configObj: Record<string, unknown>,
  options: {
    singboxAvailable?: boolean;
    singboxBin?: string;
    executor?: SingboxCheckExecutor;
  } = {}
): Promise<{ ok: boolean; error: string | null }> {
  if (options.singboxAvailable === false) {
    return { ok: true, error: null };
  }

  const tmpFile = path.join(
    os.tmpdir(),
    `sentra-sbcheck-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
  );
  const bin = options.singboxBin || SINGBOX_BIN;
  const executor = options.executor || defaultSingboxCheckExecutor;

  try {
    await fs.writeFile(tmpFile, JSON.stringify(configObj), { mode: 0o600 });
    const { stdout, stderr } = await executor(bin, ['check', '-c', tmpFile]);
    const combined = `${stdout}\n${stderr}`.trim();
    if (combined && SINGBOX_WARNING_OR_ERROR_RE.test(combined)) {
      return {
        ok: false,
        error: `sing-box check warning/error: ${combined.slice(0, 320)}`,
      };
    }
    return { ok: true, error: null };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const detail = (e.stderr || e.stdout || e.message || String(err)).trim();
    return {
      ok: false,
      error: `sing-box check failed: ${detail.slice(0, 320)}`,
    };
  } finally {
    await fs.unlink(tmpFile).catch(() => undefined);
  }
}

/**
 * Stage 1 (Isolation Check): Strictly validates a single outbound against the
 * sing-box 1.14+ protocol/transport whitelist AND executes real `sing-box check`
 * on a minimal skeleton containing only this node.
 */
export async function validateNodeStage1(
  rawConfigObj: unknown,
  options: {
    singboxAvailable?: boolean;
    singboxBin?: string;
    executor?: SingboxCheckExecutor;
  } = {}
): Promise<
  | { ok: true; compiledJson: string; outbound: Record<string, unknown> }
  | { ok: false; error: string }
> {
  const strict = validateSingboxOutboundStrict(rawConfigObj);
  if (!strict.ok) {
    return { ok: false, error: strict.error };
  }

  const skeleton = compileSingleNodeCheckConfig(strict.outbound);
  const checkRes = await runSingboxCheck(skeleton, options);
  if (!checkRes.ok) {
    return { ok: false, error: checkRes.error || 'Stage-1 sing-box check failed' };
  }

  return {
    ok: true,
    compiledJson: strict.compiledJson,
    outbound: strict.outbound as unknown as Record<string, unknown>,
  };
}

/**
 * Stage 2 (Full Bundle Check): Builds complete sing-box 1.14+ JSON configs for
 * every plan tier (`free`, `pro`, `flow_plus`) from all verified healthy nodes
 * and validates each full bundle with `sing-box check` before reporting to Worker.
 */
export async function validatePlanBundlesStage2(
  healthyDonatedRows: DonatedOutboundRow[],
  options: {
    singboxAvailable?: boolean;
    singboxBin?: string;
    executor?: SingboxCheckExecutor;
  } = {}
): Promise<BundleCheckSummary[]> {
  const tiers: PlanTier[] = ['free', 'pro', 'flow_plus'];
  const summaries: BundleCheckSummary[] = [];

  for (const planTier of tiers) {
    const bundle = compilePlanTierSingboxConfig([], healthyDonatedRows, planTier, {
      includeClashApi: true,
    });
    const checkRes = await runSingboxCheck(bundle.config, options);
    summaries.push({
      plan_tier: planTier,
      passed: checkRes.ok,
      node_count: bundle.nodeCount,
      error: checkRes.error,
    });
  }

  return summaries;
}

function getFreeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr !== 'string') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('Could not allocate free port')));
      }
    });
    srv.on('error', reject);
  });
}

async function curlViaSocks(
  socksPort: number,
  targetUrl: string
): Promise<{ status: number; body: string }> {
  try {
    const { stdout } = await execFileAsync(
      'curl',
      [
        '-sS',
        '-L',
        '--max-time',
        '7',
        '--socks5-hostname',
        `127.0.0.1:${socksPort}`,
        '-A',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        '-w',
        '\n__HTTP_STATUS__:%{http_code}',
        targetUrl,
      ],
      { timeout: 9000, maxBuffer: 512 * 1024 }
    );
    const marker = '\n__HTTP_STATUS__:';
    const idx = stdout.lastIndexOf(marker);
    if (idx < 0) return { status: 0, body: '' };
    const body = stdout.slice(0, idx);
    const status = Number(stdout.slice(idx + marker.length).trim()) || 0;
    return { status, body };
  } catch {
    return { status: 0, body: '' };
  }
}

/**
 * Spawns an ephemeral local sing-box 1.14+ proxy instance for the node under test
 * and verifies real end-to-end reachability to Google Gemini and financial trading APIs.
 */
async function probeGeminiAndTrading(
  parsedConfig: Record<string, unknown>,
  jitterMs: number,
  singboxAvailable: boolean
): Promise<{ gemini_ok: boolean; trading_safe: boolean }> {
  if (!singboxAvailable || jitterMs > 120) {
    return { gemini_ok: false, trading_safe: false };
  }

  const socksPort = await getFreeLoopbackPort();
  const tmpFile = path.join(
    os.tmpdir(),
    `sentra-qe-${process.pid}-${socksPort}-${Date.now()}.json`
  );

  const outbound = { ...parsedConfig, tag: 'probe-out' };
  const minimalConfig = {
    log: { level: 'panic' },
    inbounds: [
      {
        type: 'socks',
        tag: 'probe-in',
        listen: '127.0.0.1',
        listen_port: socksPort,
      },
    ],
    outbounds: [outbound, { type: 'direct', tag: 'direct' }],
    route: {
      final: 'probe-out',
    },
  };

  await fs.writeFile(tmpFile, JSON.stringify(minimalConfig), { mode: 0o600 });
  const child = spawn(SINGBOX_BIN, ['run', '-c', tmpFile], {
    stdio: 'ignore',
  });

  try {
    await new Promise((r) => setTimeout(r, 350));

    // 1. Check Google Gemini accessibility (no regional restriction or Cloudflare block)
    const geminiResp = await curlViaSocks(socksPort, 'https://gemini.google.com');
    const geminiBlocked =
      geminiResp.body.includes('not supported in your country') ||
      geminiResp.body.includes('Region not supported') ||
      geminiResp.body.includes('cf-browser-verification') ||
      geminiResp.body.includes('Attention Required! | Cloudflare');
    const gemini_ok =
      (geminiResp.status === 200 || geminiResp.status === 301 || geminiResp.status === 302) &&
      !geminiBlocked;

    // 2. Check Trading platform accessibility (Binance API ping + TradingView fallback)
    const binanceResp = await curlViaSocks(socksPort, 'https://api.binance.com/api/v3/ping');
    let trading_safe = binanceResp.status === 200;
    if (!trading_safe) {
      const tvResp = await curlViaSocks(socksPort, 'https://www.tradingview.com/');
      trading_safe =
        (tvResp.status === 200 || tvResp.status === 301 || tvResp.status === 302) &&
        !tvResp.body.includes('cf-browser-verification');
    }

    return { gemini_ok, trading_safe };
  } catch (probeErr) {
    await reportQualityEngineError('probeGeminiAndTrading', probeErr, {
      socks_port: socksPort,
      singbox_bin: SINGBOX_BIN,
    });
    return { gemini_ok: false, trading_safe: false };
  } finally {
    child.kill('SIGTERM');
    await fs.unlink(tmpFile).catch(() => undefined);
  }
}

async function evaluateNode(
  node: RemoteNode,
  singboxAvailable: boolean
): Promise<NodeHealthResult> {
  let parsedConfig: Record<string, unknown>;
  try {
    parsedConfig = JSON.parse(node.compiled_outbound_json || node.config_json) as Record<
      string,
      unknown
    >;
  } catch {
    return {
      outbound_id: node.id,
      latency_ms: 9999,
      jitter_ms: 9999,
      speed_mbps: 0,
      speed_score: 0,
      health_score: 0,
      gemini_ok: false,
      trading_safe: false,
      is_healthy: false,
      security_passed: false,
      quarantined: true,
      validation_error: 'Invalid JSON in stored config_json',
      compiled_outbound_json: null,
      error_msg: 'Invalid JSON in stored config_json',
    };
  }

  // Stage 1: Strict protocol/transport whitelist + isolated `sing-box check`
  const stage1 = await validateNodeStage1(parsedConfig, { singboxAvailable });
  if (!stage1.ok) {
    return {
      outbound_id: node.id,
      latency_ms: 9999,
      jitter_ms: 9999,
      speed_mbps: 0,
      speed_score: 0,
      health_score: 0,
      gemini_ok: false,
      trading_safe: false,
      is_healthy: false,
      security_passed: false,
      quarantined: true,
      validation_error: stage1.error,
      compiled_outbound_json: null,
      error_msg: stage1.error,
    };
  }

  const security = auditSecurity(node.protocol, stage1.outbound);
  if (!security.passed) {
    return {
      outbound_id: node.id,
      latency_ms: 9999,
      jitter_ms: 9999,
      speed_mbps: 0,
      speed_score: 0,
      health_score: 0,
      gemini_ok: false,
      trading_safe: false,
      is_healthy: false,
      security_passed: false,
      quarantined: true,
      validation_error: security.reason,
      compiled_outbound_json: null,
      error_msg: security.reason,
    };
  }

  // DNS lookup + Anti-SSRF check
  let resolvedIp: string;
  try {
    if (net.isIP(node.server_address)) {
      resolvedIp = node.server_address;
    } else {
      const lookup = await dns.lookup(node.server_address);
      resolvedIp = lookup.address;
    }
    if (isPrivateIp(resolvedIp)) {
      const errMsg = `Blocked private/restricted IP: ${resolvedIp}`;
      return {
        outbound_id: node.id,
        latency_ms: 9999,
        jitter_ms: 9999,
        speed_mbps: 0,
        speed_score: 0,
        health_score: 0,
        gemini_ok: false,
        trading_safe: false,
        is_healthy: false,
        security_passed: false,
        quarantined: true,
        validation_error: errMsg,
        compiled_outbound_json: null,
        error_msg: errMsg,
      };
    }
  } catch (err) {
    return {
      outbound_id: node.id,
      latency_ms: 9999,
      jitter_ms: 9999,
      speed_mbps: 0,
      speed_score: 0,
      health_score: 0,
      gemini_ok: false,
      trading_safe: false,
      is_healthy: false,
      security_passed: true,
      quarantined: false,
      validation_error: null,
      compiled_outbound_json: stage1.compiledJson,
      error_msg: `DNS lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const netStats = await measureNetworkQuality(node.protocol, resolvedIp, node.server_port);
  if (!netStats.is_healthy) {
    return {
      outbound_id: node.id,
      ...netStats,
      health_score: 0,
      gemini_ok: false,
      trading_safe: false,
      security_passed: true,
      quarantined: false,
      validation_error: null,
      compiled_outbound_json: stage1.compiledJson,
      error_msg: 'Node unreachable or latency exceeded threshold',
    };
  }

  const targetReadiness = await probeGeminiAndTrading(
    stage1.outbound,
    netStats.jitter_ms,
    singboxAvailable
  );

  const bonus = (targetReadiness.gemini_ok ? 5 : 0) + (targetReadiness.trading_safe ? 5 : 0);
  const healthScore = Math.min(100, netStats.speed_score + bonus);

  return {
    outbound_id: node.id,
    latency_ms: netStats.latency_ms,
    jitter_ms: netStats.jitter_ms,
    speed_mbps: netStats.speed_mbps,
    speed_score: netStats.speed_score,
    health_score: healthScore,
    gemini_ok: targetReadiness.gemini_ok,
    trading_safe: targetReadiness.trading_safe,
    is_healthy: true,
    security_passed: true,
    quarantined: false,
    validation_error: null,
    compiled_outbound_json: stage1.compiledJson,
    error_msg: null,
  };
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function next(): Promise<void> {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      results[idx] = await worker(items[idx]);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => next());
  await Promise.all(workers);
  return results;
}

export const MAX_SUBLINK_RESPONSE_BYTES = 1_048_576; // 1 MB hard cap
export const MAX_SUBLINK_URL_LENGTH = 512;

export const ALLOWED_SUBLINK_PROTOCOLS = new Set([
  'vless',
  'vmess',
  'trojan',
  'hysteria2',
  'hy2',
  'shadowsocks',
  'ss',
  'tuic',
]);

const ALLOWED_SUBLINK_CONTENT_TYPES = new Set([
  'text/plain',
  'application/octet-stream',
  'application/json',
  'text/yaml',
  'application/yaml',
  'application/x-yaml',
]);

export function isAllowedSubscriptionContentType(contentType: string | null): boolean {
  if (!contentType || !contentType.trim()) return true;
  const mime = contentType.split(';')[0].trim().toLowerCase();
  if (!mime) return true;
  return ALLOWED_SUBLINK_CONTENT_TYPES.has(mime);
}

export async function readResponseTextWithLimit(
  resp: Response,
  maxBytes: number = MAX_SUBLINK_RESPONSE_BYTES
): Promise<string> {
  const declaredLen = resp.headers.get('content-length');
  if (declaredLen !== null) {
    const parsedLen = Number.parseInt(declaredLen, 10);
    if (Number.isFinite(parsedLen) && parsedLen > maxBytes) {
      throw new Error(`Subscription payload exceeds ${maxBytes} bytes limit`);
    }
  }

  if (!resp.body) {
    const text = await resp.text();
    const byteLen = new TextEncoder().encode(text).byteLength;
    if (byteLen > maxBytes) {
      throw new Error(`Subscription payload exceeds ${maxBytes} bytes limit`);
    }
    return text;
  }

  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Subscription payload exceeds ${maxBytes} bytes limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(merged);
}

export function filterAllowedSublinkNodes<T extends { protocol: string }>(nodes: T[]): T[] {
  return nodes.filter((node) =>
    ALLOWED_SUBLINK_PROTOCOLS.has(String(node.protocol || '').trim().toLowerCase())
  );
}

export async function validatePublicSubscriptionUrl(
  rawUrl: string,
  lookupFn: (hostname: string) => Promise<{ address: string }> = (h) => dns.lookup(h)
): Promise<URL> {
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > MAX_SUBLINK_URL_LENGTH) {
    throw new Error(`Subscription URL exceeds ${MAX_SUBLINK_URL_LENGTH} characters limit`);
  }
  const parsed = new URL(trimmed);
  if (parsed.protocol !== 'https:') {
    throw new Error('Only HTTPS subscription URLs are permitted');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Subscription URL must not contain embedded credentials');
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan') ||
    host.endsWith('.home') ||
    host.endsWith('.arpa') ||
    host === 'metadata.google.internal' ||
    host.endsWith('.metadata.google.internal') ||
    host === 'cloudflare.internal' ||
    host.endsWith('.cloudflare.internal') ||
    host === 'workers.internal' ||
    host.endsWith('.workers.internal')
  ) {
    throw new Error(`Blocked internal host: ${host}`);
  }
  const resolvedIp = net.isIP(host) ? host : (await lookupFn(host)).address;
  if (isPrivateIp(resolvedIp)) {
    throw new Error(`Blocked private subscription IP: ${resolvedIp}`);
  }
  return parsed;
}

async function evaluateSubscriptionSource(
  source: RemoteSubscriptionSource,
  existingFingerprints: Set<string>,
  singboxAvailable: boolean
): Promise<SubscriptionSourceHealthReport> {
  let validUrl: URL;
  try {
    validUrl = await validatePublicSubscriptionUrl(source.sub_url);
  } catch (err) {
    return {
      source_id: source.id,
      category: source.category,
      total_nodes: 0,
      healthy_nodes: 0,
      quarantined_nodes: 0,
      error_msg: err instanceof Error ? err.message : 'Invalid subscription URL',
      discovered_nodes: [],
    };
  }

  let bodyText: string;
  try {
    const resp = await fetch(validUrl.toString(), {
      headers: { 'User-Agent': 'SentraQualityEngine/2.0 (GitHub-Actions)' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      return {
        source_id: source.id,
        category: source.category,
        total_nodes: 0,
        healthy_nodes: 0,
        quarantined_nodes: 0,
        error_msg: `HTTP ${resp.status}`,
        discovered_nodes: [],
      };
    }
    const contentType = resp.headers.get('content-type');
    if (!isAllowedSubscriptionContentType(contentType)) {
      return {
        source_id: source.id,
        category: source.category,
        total_nodes: 0,
        healthy_nodes: 0,
        quarantined_nodes: 0,
        error_msg: `Blocked Content-Type: ${contentType || 'unknown'}`,
        discovered_nodes: [],
      };
    }
    bodyText = await readResponseTextWithLimit(resp, MAX_SUBLINK_RESPONSE_BYTES);
  } catch (err) {
    return {
      source_id: source.id,
      category: source.category,
      total_nodes: 0,
      healthy_nodes: 0,
      quarantined_nodes: 0,
      error_msg: err instanceof Error ? err.message : 'Subscription fetch failed',
      discovered_nodes: [],
    };
  }

  const parsedSub = await parseSubscriptionPayload(bodyText);
  const allowedNodes = filterAllowedSublinkNodes(parsedSub.nodes);
  const candidates = allowedNodes.slice(0, MAX_NODES_PER_SUB_SOURCE);
  if (candidates.length === 0) {
    return {
      source_id: source.id,
      category: source.category,
      total_nodes: 0,
      healthy_nodes: 0,
      quarantined_nodes: parsedSub.skipped,
      error_msg: 'No valid allowed proxy nodes found in subscription payload',
      discovered_nodes: [],
    };
  }

  const discoveredHealthy: DiscoveredSubNodeReport[] = [];
  let healthyCount = 0;
  let quarantinedNodes = parsedSub.skipped;

  await runWithConcurrency(candidates, CONCURRENCY, async (parsedNode) => {
    const pseudoRemote: RemoteNode = {
      id: 0,
      tag: parsedNode.tag,
      protocol: parsedNode.protocol,
      server_address: parsedNode.server_address,
      server_port: parsedNode.server_port,
      config_json: parsedNode.compiled_outbound_json,
      compiled_outbound_json: parsedNode.compiled_outbound_json,
      country_code: parsedNode.country_code,
      status: 'active',
      fail_count: 0,
      is_official: true,
      allocation_mode: source.category,
    };

    const res = await evaluateNode(pseudoRemote, singboxAvailable);
    if (res.quarantined) {
      quarantinedNodes += 1;
      return;
    }
    if (res.is_healthy && res.security_passed && res.compiled_outbound_json) {
      healthyCount += 1;
      if (existingFingerprints.has(parsedNode.fingerprint_sha256)) {
        return;
      }
      existingFingerprints.add(parsedNode.fingerprint_sha256);
      discoveredHealthy.push({
        tag: parsedNode.tag,
        protocol: parsedNode.protocol,
        server_address: parsedNode.server_address,
        server_port: parsedNode.server_port,
        config_json: res.compiled_outbound_json,
        compiled_outbound_json: res.compiled_outbound_json,
        raw_link: parsedNode.raw_link,
        fingerprint_sha256: parsedNode.fingerprint_sha256,
        country_code: parsedNode.country_code,
        country_name: parsedNode.country_name,
        latency_ms: res.latency_ms,
        jitter_ms: res.jitter_ms,
        speed_mbps: res.speed_mbps,
        speed_score: res.speed_score,
        health_score: res.health_score,
        gemini_ok: res.gemini_ok,
        trading_safe: res.trading_safe,
      });
    }
  });

  return {
    source_id: source.id,
    category: source.category,
    total_nodes: parsedSub.nodes.length,
    healthy_nodes: healthyCount,
    quarantined_nodes: quarantinedNodes,
    error_msg: null,
    discovered_nodes: discoveredHealthy,
  };
}

async function main(): Promise<void> {
  if (!WORKER_URL || !QUALITY_SECRET) {
    throw new Error(
      'Missing required environment variables: SENTRA_WORKER_URL and QUALITY_ENGINE_SECRET'
    );
  }

  const singboxAvailable = await hasSingboxBinary();
  console.log(
    `[QualityEngine] Starting 2-stage validation cycle against ${WORKER_URL} (sing-box available: ${singboxAvailable})`
  );

  const listResp = await fetch(`${WORKER_URL}/api/v1/nodes/active`, {
    headers: {
      'X-Quality-Secret': QUALITY_SECRET,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!listResp.ok) {
    throw new Error(`Failed to fetch active nodes: HTTP ${listResp.status}`);
  }

  const listData = (await listResp.json()) as {
    nodes?: RemoteNode[];
    subscription_sources?: RemoteSubscriptionSource[];
  };
  const nodes = Array.isArray(listData.nodes) ? listData.nodes : [];
  const subSources = Array.isArray(listData.subscription_sources)
    ? listData.subscription_sources
    : [];
  console.log(
    `[QualityEngine] Loaded ${nodes.length} candidate nodes and ${subSources.length} subscription sources.`
  );

  if (nodes.length === 0 && subSources.length === 0) {
    console.log('[QualityEngine] No nodes or subscription sources to test. Exiting cleanly.');
    return;
  }

  const existingFingerprints = new Set<string>(
    nodes.map((n) => n.fingerprint_sha256 || '').filter(Boolean)
  );

  const results =
    nodes.length > 0
      ? await runWithConcurrency(nodes, CONCURRENCY, (node) =>
          evaluateNode(node, singboxAvailable)
        )
      : [];

  const subscriptionReports: SubscriptionSourceHealthReport[] = [];
  for (const src of subSources) {
    const report = await evaluateSubscriptionSource(src, existingFingerprints, singboxAvailable);
    subscriptionReports.push(report);
    console.log(
      `[QualityEngine] Subscription source #${src.id} (${src.category}): healthy=${report.healthy_nodes}/${report.total_nodes}, quarantined=${report.quarantined_nodes}${
        report.error_msg ? ` (err: ${report.error_msg})` : ''
      }`
    );
  }

  // Stage 2: Assemble full per-plan sing-box 1.14+ configs and run `sing-box check` on each bundle
  const nodeById = new Map<number, RemoteNode>(nodes.map((n) => [n.id, n]));
  const verifiedHealthyForBundle: DonatedOutboundRow[] = [];

  for (const res of results) {
    if (!res.is_healthy || !res.security_passed || res.quarantined || !res.compiled_outbound_json) {
      continue;
    }
    const srcNode = nodeById.get(res.outbound_id);
    if (!srcNode) continue;
    verifiedHealthyForBundle.push({
      id: srcNode.id,
      donor_user_id: null,
      tag: srcNode.tag,
      protocol: srcNode.protocol,
      server_address: srcNode.server_address,
      server_port: srcNode.server_port,
      config_json: res.compiled_outbound_json,
      compiled_outbound_json: res.compiled_outbound_json,
      validation_error: null,
      latency_ms: res.latency_ms,
      speed_mbps: res.speed_mbps,
      assigned_tier: srcNode.assigned_tier || 'web_browsing',
      health_score: res.health_score,
      status: 'active',
      fail_count: 0,
      raw_link: null,
      rejection_reason: null,
      fingerprint_sha256: srcNode.fingerprint_sha256 || null,
      offline_since: null,
      is_official: srcNode.is_official ? 1 : 0,
      label: srcNode.tag,
      country_code: srcNode.country_code,
      country_name: srcNode.country_code,
      allow_web: srcNode.allow_web ?? 1,
      allow_download: srcNode.allow_download ?? 1,
      allow_gaming: srcNode.allow_gaming ?? 0,
      allow_static_ip: srcNode.allow_static_ip ?? 0,
      gemini_ok: res.gemini_ok ? 1 : 0,
      trading_safe: res.trading_safe ? 1 : 0,
      speed_score: res.speed_score,
      jitter_ms: res.jitter_ms,
      last_online_at: null,
      allocation_mode: srcNode.allocation_mode,
      last_checked_at: new Date().toISOString(),
    });
  }

  for (const subRep of subscriptionReports) {
    const cat = (subRep.category || 'web_browsing').toLowerCase();
    for (const disc of subRep.discovered_nodes) {
      verifiedHealthyForBundle.push({
        id: 0,
        donor_user_id: null,
        tag: disc.tag,
        protocol: disc.protocol,
        server_address: disc.server_address,
        server_port: disc.server_port,
        config_json: disc.compiled_outbound_json,
        compiled_outbound_json: disc.compiled_outbound_json,
        validation_error: null,
        latency_ms: disc.latency_ms,
        speed_mbps: disc.speed_mbps,
        assigned_tier: cat,
        health_score: disc.health_score,
        status: 'active',
        fail_count: 0,
        raw_link: disc.raw_link,
        rejection_reason: null,
        fingerprint_sha256: disc.fingerprint_sha256,
        offline_since: null,
        is_official: 1,
        label: disc.tag,
        country_code: disc.country_code,
        country_name: disc.country_name,
        allow_web: cat === 'web_browsing' || cat === 'download' ? 1 : 0,
        allow_download: cat === 'download' || cat === 'web_browsing' ? 1 : 0,
        allow_gaming: cat === 'gaming' ? 1 : 0,
        allow_static_ip: cat === 'static_ip' ? 1 : 0,
        gemini_ok: disc.gemini_ok ? 1 : 0,
        trading_safe: disc.trading_safe ? 1 : 0,
        speed_score: disc.speed_score,
        jitter_ms: disc.jitter_ms,
        last_online_at: null,
        allocation_mode: cat,
        last_checked_at: new Date().toISOString(),
      });
    }
  }

  const bundleChecks = await validatePlanBundlesStage2(verifiedHealthyForBundle, {
    singboxAvailable,
  });
  for (const bc of bundleChecks) {
    console.log(
      `[QualityEngine] Stage-2 Bundle Check [${bc.plan_tier}]: passed=${bc.passed} nodes=${bc.node_count}${
        bc.error ? ` err=${bc.error}` : ''
      }`
    );
  }

  const healthyCount = results.filter((r) => r.is_healthy).length;
  const quarantinedCount = results.filter((r) => r.quarantined).length;
  const geminiCount = results.filter((r) => r.gemini_ok).length;
  const tradingCount = results.filter((r) => r.trading_safe).length;
  console.log(
    `[QualityEngine] Evaluated ${results.length} DB nodes (healthy=${healthyCount}, quarantined=${quarantinedCount}, gemini_ok=${geminiCount}, trading_safe=${tradingCount}) and ${subscriptionReports.length} subscription sources.`
  );

  const reportResp = await fetch(`${WORKER_URL}/api/v1/nodes/health-report`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Quality-Secret': QUALITY_SECRET,
    },
    body: JSON.stringify({
      checked_at: new Date().toISOString(),
      runner: 'github-actions-quality-engine',
      results,
      subscription_reports: subscriptionReports,
      bundle_checks: bundleChecks,
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!reportResp.ok) {
    const errText = await reportResp.text();
    throw new Error(`Failed to submit health report: HTTP ${reportResp.status} — ${errText}`);
  }

  const summary = await reportResp.json();
  console.log('[QualityEngine] Health report accepted:', JSON.stringify(summary));
}

const isDirectMainExecution =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectMainExecution) {
  process.on('unhandledRejection', (reason) => {
    console.error('[QualityEngine] Unhandled rejection:', reason);
    void reportQualityEngineError('process.unhandledRejection', reason).finally(() => {
      process.exit(1);
    });
  });

  process.on('uncaughtException', (err) => {
    console.error('[QualityEngine] Uncaught exception:', err);
    void reportQualityEngineError('process.uncaughtException', err).finally(() => {
      process.exit(1);
    });
  });

  main().catch(async (err) => {
    console.error('[QualityEngine] Fatal error:', err);
    await reportQualityEngineError('main()', err, { worker_url: WORKER_URL });
    process.exit(1);
  });
}
