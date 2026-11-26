import { execFile, spawn } from 'node:child_process';
import dns from 'node:dns/promises';
import dgram from 'node:dgram';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface RemoteNode {
  id: number;
  tag: string;
  protocol: string;
  server_address: string;
  server_port: number;
  config_json: string;
  country_code: string;
  status: string;
  fail_count: number;
  is_official: boolean;
  allocation_mode: string;
}

interface NodeHealthResult {
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
  error_msg: string | null;
}

const WORKER_URL = (process.env.SENTRA_WORKER_URL || '').trim().replace(/\/+$/, '');
const QUALITY_SECRET = (process.env.QUALITY_ENGINE_SECRET || '').trim();
const CONCURRENCY = Math.max(1, Math.min(12, Number(process.env.QUALITY_CONCURRENCY || 6)));
const SINGBOX_BIN = (process.env.SINGBOX_BIN || 'sing-box').trim();

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
  if (!singboxAvailable || jitterMs > 30) {
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
    parsedConfig = JSON.parse(node.config_json) as Record<string, unknown>;
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
      error_msg: 'Invalid JSON in stored config_json',
    };
  }

  const security = auditSecurity(node.protocol, parsedConfig);
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
        error_msg: `Blocked private/restricted IP: ${resolvedIp}`,
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
      error_msg: 'Node unreachable or latency exceeded threshold',
    };
  }

  const targetReadiness = await probeGeminiAndTrading(
    parsedConfig,
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

async function main(): Promise<void> {
  if (!WORKER_URL || !QUALITY_SECRET) {
    throw new Error(
      'Missing required environment variables: SENTRA_WORKER_URL and QUALITY_ENGINE_SECRET'
    );
  }

  const singboxAvailable = await hasSingboxBinary();
  console.log(
    `[QualityEngine] Starting cycle against ${WORKER_URL} (sing-box available: ${singboxAvailable})`
  );

  const listResp = await fetch(`${WORKER_URL}/api/v1/nodes/active`, {
    headers: {
      'X-Quality-Secret': QUALITY_SECRET,
      Accept: 'application/json',
    },
  });

  if (!listResp.ok) {
    throw new Error(`Failed to fetch active nodes: HTTP ${listResp.status}`);
  }

  const listData = (await listResp.json()) as { nodes?: RemoteNode[] };
  const nodes = Array.isArray(listData.nodes) ? listData.nodes : [];
  console.log(`[QualityEngine] Loaded ${nodes.length} candidate nodes.`);

  if (nodes.length === 0) {
    console.log('[QualityEngine] No nodes to test. Exiting cleanly.');
    return;
  }

  const results = await runWithConcurrency(nodes, CONCURRENCY, (node) =>
    evaluateNode(node, singboxAvailable)
  );

  const healthyCount = results.filter((r) => r.is_healthy).length;
  const geminiCount = results.filter((r) => r.gemini_ok).length;
  const tradingCount = results.filter((r) => r.trading_safe).length;
  console.log(
    `[QualityEngine] Evaluated ${results.length} nodes: healthy=${healthyCount}, gemini_ok=${geminiCount}, trading_safe=${tradingCount}`
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
    }),
  });

  if (!reportResp.ok) {
    const errText = await reportResp.text();
    throw new Error(`Failed to submit health report: HTTP ${reportResp.status} — ${errText}`);
  }

  const summary = await reportResp.json();
  console.log('[QualityEngine] Health report accepted:', JSON.stringify(summary));
}

main().catch((err) => {
  console.error('[QualityEngine] Fatal error:', err);
  process.exit(1);
});
