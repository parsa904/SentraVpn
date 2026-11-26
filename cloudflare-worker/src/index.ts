import { routeRequest } from './routes.ts';
import type { Env } from './types.ts';

function resolveAllowedOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get('Origin');
  if (!origin) return null;

  const configured = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  // Allow Tauri native desktop/Android WebView origins + explicitly configured web origins
  const defaultOrigins = new Set([
    'tauri://localhost',
    'http://tauri.localhost',
    'https://tauri.localhost',
    ...configured,
  ]);

  return defaultOrigins.has(origin) ? origin : null;
}

function applySecurityAndCorsHeaders(
  response: Response,
  allowedOrigin: string | null
): Response {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  if (allowedOrigin) {
    headers.set('Access-Control-Allow-Origin', allowedOrigin);
    headers.set('Vary', 'Origin');
    headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    headers.set(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-Subscription-Token, X-Device-Id, X-Bridge-Secret, X-Quality-Secret'
    );
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const allowedOrigin = resolveAllowedOrigin(request, env);

    if (request.method.toUpperCase() === 'OPTIONS') {
      return applySecurityAndCorsHeaders(new Response(null, { status: 204 }), allowedOrigin);
    }

    try {
      const response = await routeRequest(request, env);
      return applySecurityAndCorsHeaders(response, allowedOrigin);
    } catch (err) {
      console.error('[Sentra Worker Unhandled Error]', err);
      const errResp = new Response(
        JSON.stringify({
          success: false,
          error: 'خطای داخلی سرور رخ داد.',
          message: 'Internal Worker Error',
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        }
      );
      return applySecurityAndCorsHeaders(errResp, allowedOrigin);
    }
  },
} satisfies ExportedHandler<Env>;
