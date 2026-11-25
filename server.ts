import path from 'node:path';
import express from 'express';
import type { Request, Response } from 'express';
import { SentraStore, StoreError } from './server/store.ts';

const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';
const UPSTREAM_BASE_URL = (process.env.SENTRA_API_BASE_URL || '').trim().replace(/\/+$/, '');

interface RateWindow {
  failures: number;
  windowStartMs: number;
  blockedUntilMs: number;
}

class AuthRateLimiter {
  private windows = new Map<string, RateWindow>();
  private readonly maxFailures = 20;
  private readonly windowMs = 10 * 60 * 1000;
  private readonly blockMs = 5 * 60 * 1000;

  check(ip: string): void {
    const now = Date.now();
    const record = this.windows.get(ip);
    if (!record) return;
    if (record.blockedUntilMs > now) {
      const waitSecs = Math.max(1, Math.ceil((record.blockedUntilMs - now) / 1000));
      throw new StoreError(
        429,
        `تعداد تلاش‌های ناموفق بیش از حد مجاز است. لطفاً ${waitSecs} ثانیه دیگر دوباره تلاش کنید.`
      );
    }
    if (now - record.windowStartMs > this.windowMs) {
      this.windows.delete(ip);
    }
  }

  recordFailure(ip: string): void {
    const now = Date.now();
    const existing = this.windows.get(ip);
    if (!existing || now - existing.windowStartMs > this.windowMs) {
      this.windows.set(ip, { failures: 1, windowStartMs: now, blockedUntilMs: 0 });
      return;
    }
    existing.failures += 1;
    if (existing.failures >= this.maxFailures) {
      existing.blockedUntilMs = now + this.blockMs;
    }
  }

  recordSuccess(ip: string): void {
    this.windows.delete(ip);
  }
}

function getClientIp(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress || req.ip || 'unknown';
}

function extractRequestToken(req: Request): string | undefined {
  const headerToken = req.header('X-Subscription-Token');
  if (headerToken && headerToken.trim()) return headerToken.trim();
  const authHeader = req.header('Authorization');
  if (authHeader && authHeader.trim()) return authHeader.trim();
  const queryToken = req.query.token;
  if (typeof queryToken === 'string' && queryToken.trim()) return queryToken.trim();
  const body = req.body as Record<string, unknown> | undefined;
  if (body && typeof body.token === 'string' && body.token.trim()) return body.token.trim();
  return undefined;
}

async function tryProxyToUpstream(req: Request, res: Response): Promise<boolean> {
  if (!UPSTREAM_BASE_URL) return false;

  const targetUrl = `${UPSTREAM_BASE_URL}${req.originalUrl}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const subToken = req.header('X-Subscription-Token');
    if (subToken) headers['X-Subscription-Token'] = subToken;
    const authHeader = req.header('Authorization');
    if (authHeader) headers['Authorization'] = authHeader;
    const deviceId = req.header('X-Device-Id');
    if (deviceId) headers['X-Device-Id'] = deviceId;

    const method = req.method.toUpperCase();
    const hasBody = method !== 'GET' && method !== 'HEAD';
    const upstreamResp = await fetch(targetUrl, {
      method,
      headers,
      body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (upstreamResp.status >= 500) {
      return false;
    }

    const bodyText = await upstreamResp.text();
    res
      .status(upstreamResp.status)
      .type(upstreamResp.headers.get('content-type') || 'application/json')
      .send(bodyText);
    return true;
  } catch {
    clearTimeout(timer);
    return false;
  }
}

function handleError(res: Response, err: unknown): void {
  if (err instanceof StoreError) {
    res.status(err.status).json({
      success: false,
      error: err.message,
      message: err.message,
      ...(err.code ? { code: err.code } : {}),
    });
    return;
  }
  console.error('[Sentra Server Error]', err);
  res.status(500).json({
    success: false,
    error: 'خطای داخلی سرور رخ داد. لطفاً دوباره تلاش کنید.',
    message: 'خطای داخلی سرور رخ داد. لطفاً دوباره تلاش کنید.',
  });
}

export function createApiApp(store: SentraStore): express.Express {
  const app = express();
  const rateLimiter = new AuthRateLimiter();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '512kb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'sentra-web-backend' });
  });

  app.post('/api/v1/auth/register', async (req, res) => {
    const ip = getClientIp(req);
    try {
      rateLimiter.check(ip);
      if (await tryProxyToUpstream(req, res)) return;
      const body = (req.body || {}) as Record<string, unknown>;
      const result = store.registerUser({
        username: String(body.username ?? ''),
        password: String(body.password ?? ''),
        device_identifier:
          typeof body.device_identifier === 'string' ? body.device_identifier : undefined,
        device_name: typeof body.device_name === 'string' ? body.device_name : undefined,
        os: typeof body.os === 'string' ? body.os : 'web',
      });
      rateLimiter.recordSuccess(ip);
      res.status(201).json(result);
    } catch (err) {
      if (err instanceof StoreError && err.status !== 429) {
        rateLimiter.recordFailure(ip);
      }
      handleError(res, err);
    }
  });

  app.post('/api/v1/auth/login', async (req, res) => {
    const ip = getClientIp(req);
    try {
      rateLimiter.check(ip);
      if (await tryProxyToUpstream(req, res)) return;
      const body = (req.body || {}) as Record<string, unknown>;
      const result = store.loginUser({
        username: String(body.username ?? ''),
        password: String(body.password ?? ''),
        device_identifier:
          typeof body.device_identifier === 'string' ? body.device_identifier : undefined,
        device_name: typeof body.device_name === 'string' ? body.device_name : undefined,
        os: typeof body.os === 'string' ? body.os : 'web',
      });
      rateLimiter.recordSuccess(ip);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof StoreError && err.status !== 429) {
        rateLimiter.recordFailure(ip);
      }
      handleError(res, err);
    }
  });

  const handleCodeLogin = async (req: Request, res: Response) => {
    const ip = getClientIp(req);
    try {
      rateLimiter.check(ip);
      if (await tryProxyToUpstream(req, res)) return;
      const body = (req.body || {}) as Record<string, unknown>;
      const result = store.loginWithCode({
        code: String(body.code ?? ''),
        device_identifier:
          typeof body.device_identifier === 'string' ? body.device_identifier : undefined,
        device_name: typeof body.device_name === 'string' ? body.device_name : undefined,
        os: typeof body.os === 'string' ? body.os : 'web',
      });
      rateLimiter.recordSuccess(ip);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof StoreError && err.status !== 429) {
        rateLimiter.recordFailure(ip);
      }
      handleError(res, err);
    }
  };

  app.post('/api/v1/auth/code-login', handleCodeLogin);
  app.post('/api/v1/auth/exchange-code', handleCodeLogin);

  app.post('/api/v1/auth/link-token', async (req, res) => {
    try {
      if (await tryProxyToUpstream(req, res)) return;
      const result = store.generateLinkCode(extractRequestToken(req));
      res.status(200).json(result);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get('/api/v1/client/bootstrap', async (req, res) => {
    try {
      if (await tryProxyToUpstream(req, res)) return;
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      const result = store.getBootstrap(extractRequestToken(req), req.header('X-Device-Id'));
      res.status(200).json(result);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get('/api/v1/client/modes', async (req, res) => {
    try {
      if (await tryProxyToUpstream(req, res)) return;
      const result = store.getClientModes(extractRequestToken(req));
      res.status(200).json(result);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get('/api/v1/client/devices', async (req, res) => {
    try {
      if (await tryProxyToUpstream(req, res)) return;
      const result = store.getClientDevices(extractRequestToken(req));
      res.status(200).json(result);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.post('/api/v1/client/devices/remove', async (req, res) => {
    try {
      if (await tryProxyToUpstream(req, res)) return;
      const body = (req.body || {}) as Record<string, unknown>;
      const result = store.removeDevice(extractRequestToken(req), String(body.device_id ?? ''));
      res.status(200).json(result);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.delete('/api/v1/client/devices/:deviceId', async (req, res) => {
    try {
      if (await tryProxyToUpstream(req, res)) return;
      const result = store.removeDevice(extractRequestToken(req), req.params.deviceId || '');
      res.status(200).json(result);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.post('/api/v1/client/heartbeat', async (req, res) => {
    try {
      if (await tryProxyToUpstream(req, res)) return;
      const body = (req.body || {}) as Record<string, unknown>;
      const result = store.processHeartbeat(extractRequestToken(req), {
        device_id: String(body.device_id ?? req.header('X-Device-Id') ?? ''),
        mode: typeof body.mode === 'string' ? body.mode : 'web_browsing',
        delta_upload_bytes: Number(body.delta_upload_bytes ?? 0),
        delta_download_bytes: Number(body.delta_download_bytes ?? 0),
      });
      res.status(200).json(result);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.post('/api/v1/client/telemetry', async (req, res) => {
    try {
      if (await tryProxyToUpstream(req, res)) return;
      const body = (req.body || {}) as Record<string, unknown>;
      const result = store.recordTelemetry(extractRequestToken(req), {
        bytes_delta: Number(body.bytes_delta ?? 0),
        device_id: typeof body.device_id === 'string' ? body.device_id : undefined,
      });
      res.status(200).json(result);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get('/api/v1/client/sync-state', async (req, res) => {
    try {
      if (await tryProxyToUpstream(req, res)) return;
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      const result = store.getClientSyncState(extractRequestToken(req));
      res.status(200).json(result);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.put('/api/v1/client/sync-state', async (req, res) => {
    try {
      if (await tryProxyToUpstream(req, res)) return;
      const body = (req.body || {}) as Record<string, unknown>;
      const result = store.updateClientSyncState(extractRequestToken(req), {
        personal_configs: body.personal_configs,
        preferences: body.preferences,
      });
      res.status(200).json(result);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.post('/api/v1/client/outbounds/donate', async (req, res) => {
    try {
      if (await tryProxyToUpstream(req, res)) return;
      const body = (req.body || {}) as Record<string, unknown>;
      const result = store.donateOutbound(extractRequestToken(req), {
        uri: String(body.uri ?? ''),
        name: typeof body.name === 'string' ? body.name : undefined,
        note: typeof body.note === 'string' ? body.note : undefined,
      });
      res.status(201).json(result);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get('/api/v1/client/outbounds/my-donations', async (req, res) => {
    try {
      if (await tryProxyToUpstream(req, res)) return;
      const result = store.getMyDonations(extractRequestToken(req));
      res.status(200).json(result);
    } catch (err) {
      handleError(res, err);
    }
  });

  return app;
}

async function startServer(): Promise<void> {
  const store = new SentraStore();
  const app = createApiApp(store);
  const clientRoot = path.resolve(process.cwd(), 'sentra-client');

  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      root: clientRoot,
      configFile: path.join(clientRoot, 'vite.config.ts'),
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.join(clientRoot, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(
      `Sentra server listening on http://0.0.0.0:${PORT} (${IS_PROD ? 'production' : 'development'}) [DB: ${store.dbPath}]`
    );
  });
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (isDirectRun) {
  startServer().catch((err) => {
    console.error('Failed to start Sentra server:', err);
    process.exit(1);
  });
}
