import {
  constantTimeEquals,
  extractAuthToken,
  extractBearerOrHeaderSecret,
  generateNumericCode,
  generateSubscriptionToken,
  hashPassword,
  verifyPassword,
} from './security.ts';
import { auditOutboundSecurity, parseOutboundInput } from './outboundAnalyzer.ts';
import {
  buildSubscriptionUserInfoHeader,
  compileClientSingboxConfig,
  compileV2RaySubscriptionBase64,
  tierHasGaming,
  tierHasStaticIp,
} from './singboxCompiler.ts';
import { handleTelegramWebhook } from './telegramWebhook.ts';
import type {
  ConnectionMode,
  DonatedOutboundRow,
  Env,
  HealthReportPayload,
  OutboundRow,
  SubscriptionRow,
  SubscriptionSourceRow,
  UserRow,
} from './types.ts';

const LITE_WEB_QUOTA_MB = 2048;
const LITE_DL_QUOTA_MB = 3072;
const STATIC_IP_MONTHLY_QUOTA_MB = 30720;

function jsonResponse(
  data: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      ...extraHeaders,
    },
  });
}

function errorResponse(status: number, message: string, code?: string): Response {
  return jsonResponse(
    {
      success: false,
      error: message,
      message,
      ...(code ? { code } : {}),
    },
    status
  );
}

async function getSubscriptionWithUser(
  db: D1Database,
  token: string
): Promise<{ user: UserRow; sub: SubscriptionRow } | null> {
  const sub = await db
    .prepare('SELECT * FROM subscriptions WHERE token = ? LIMIT 1')
    .bind(token)
    .first<SubscriptionRow>();
  if (!sub) return null;
  const user = await db
    .prepare('SELECT * FROM users WHERE id = ? LIMIT 1')
    .bind(sub.user_id)
    .first<UserRow>();
  if (!user) return null;
  return { user, sub };
}

async function hasActiveGamingOutbounds(db: D1Database): Promise<boolean> {
  const donated = await db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM donated_outbounds
       WHERE status = 'active' AND (allow_gaming = 1 OR assigned_tier = 'gaming')`
    )
    .first<{ cnt: number }>();
  if ((donated?.cnt || 0) > 0) return true;

  const core = await db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM outbounds
       WHERE is_active = 1 AND server_address != '127.0.0.1' AND mode_category = 'gaming'`
    )
    .first<{ cnt: number }>();
  return (core?.cnt || 0) > 0;
}

async function queryOutboundsForMode(
  db: D1Database,
  mode: ConnectionMode,
  locationCode?: string
): Promise<{ donated: DonatedOutboundRow[]; core: OutboundRow[] }> {
  const modeClause =
    mode === 'static_ip'
      ? `(allow_static_ip = 1 OR assigned_tier = 'static_ip')`
      : mode === 'gaming'
      ? `(allow_gaming = 1 OR assigned_tier = 'gaming')`
      : mode === 'download'
      ? `(allow_download = 1 OR assigned_tier = 'download')`
      : `(allow_web = 1 OR assigned_tier = 'web_browsing')`;

  const loc = (locationCode || '').trim().toUpperCase();
  let donatedRows: DonatedOutboundRow[];

  if (loc && loc !== 'AUTO') {
    const res = await db
      .prepare(
        `SELECT * FROM donated_outbounds
         WHERE status = 'active' AND ${modeClause} AND upper(country_code) = ?
         ORDER BY is_official DESC, speed_score DESC, latency_ms ASC`
      )
      .bind(loc)
      .all<DonatedOutboundRow>();
    donatedRows = res.results || [];
  } else {
    const res = await db
      .prepare(
        `SELECT * FROM donated_outbounds
         WHERE status = 'active' AND ${modeClause}
         ORDER BY is_official DESC, speed_score DESC, latency_ms ASC`
      )
      .all<DonatedOutboundRow>();
    donatedRows = res.results || [];
  }

  // Fallback to all active ecosystem outbounds for web/download if mode-specific pool is empty
  if (donatedRows.length === 0 && (mode === 'web_browsing' || mode === 'download')) {
    const fallback = await db
      .prepare(
        `SELECT * FROM donated_outbounds
         WHERE status = 'active'
         ORDER BY is_official DESC, speed_score DESC, latency_ms ASC`
      )
      .all<DonatedOutboundRow>();
    donatedRows = fallback.results || [];
  }

  const coreRes = await db
    .prepare(
      `SELECT * FROM outbounds
       WHERE is_active = 1 AND (mode_category = ? OR mode_category = 'all')
       ORDER BY weight DESC, id ASC`
    )
    .bind(mode)
    .all<OutboundRow>();

  return {
    donated: donatedRows,
    core: coreRes.results || [],
  };
}

function normalizeMode(raw: string | null | undefined): ConnectionMode {
  const m = (raw || 'web_browsing').trim().toLowerCase();
  if (m === 'download' || m === 'gaming' || m === 'static_ip') return m;
  return 'web_browsing';
}

export async function routeRequest(
  request: Request,
  env: Env,
  _ctx?: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method.toUpperCase();

  // 1. Health Check
  if (method === 'GET' && path === '/health') {
    try {
      await env.DB.prepare('SELECT 1 AS ok').first();
      return jsonResponse({
        status: 'ok',
        service: 'sentra-cloudflare-worker',
        runtime: 'cloudflare-workers-d1',
        singbox_schema: '1.14+',
        timestamp: new Date().toISOString(),
      });
    } catch {
      return errorResponse(503, 'اتصال به دیتابیس D1 برقرار نشد.');
    }
  }

  // 2. Telegram Webhook (await full processing + Telegram API replies before returning 200 OK)
  if (method === 'POST' && path === '/api/v1/telegram/webhook') {
    return await handleTelegramWebhook(request, env);
  }

  // 3. QualityEngine — Fetch Active/Candidate Nodes (Protected by QUALITY_ENGINE_SECRET)
  if (method === 'GET' && path === '/api/v1/nodes/active') {
    if (!env.QUALITY_ENGINE_SECRET) {
      return errorResponse(503, 'کلید امنیتی QualityEngine پیکربندی نشده است.');
    }
    const provided = extractBearerOrHeaderSecret(request, 'X-Quality-Secret');
    if (!provided || !(await constantTimeEquals(provided, env.QUALITY_ENGINE_SECRET))) {
      return errorResponse(401, 'دسترسی QualityEngine مجاز نیست.', 'UNAUTHORIZED_QUALITY_ENGINE');
    }

    const rows = await env.DB.prepare(
      `SELECT id, tag, protocol, server_address, server_port, config_json,
              country_code, status, fail_count, is_official, allocation_mode, fingerprint_sha256
       FROM donated_outbounds
       WHERE status IN ('active', 'inactive')
       ORDER BY is_official DESC, id ASC
       LIMIT 200`
    ).all<DonatedOutboundRow>();

    const subSources = await env.DB.prepare(
      `SELECT id, category, sub_url, tag, total_nodes, healthy_nodes, last_sync_at
       FROM subscription_sources
       ORDER BY id ASC
       LIMIT 50`
    ).all<SubscriptionSourceRow>();

    return jsonResponse({
      success: true,
      count: (rows.results || []).length,
      nodes: (rows.results || []).map((row) => ({
        id: row.id,
        tag: row.tag,
        protocol: row.protocol,
        server_address: row.server_address,
        server_port: row.server_port,
        config_json: row.config_json,
        country_code: row.country_code,
        status: row.status,
        fail_count: row.fail_count,
        is_official: row.is_official === 1,
        allocation_mode: row.allocation_mode,
        fingerprint_sha256: row.fingerprint_sha256,
      })),
      subscription_sources: (subSources.results || []).map((src) => ({
        id: src.id,
        category: src.category,
        sub_url: src.sub_url,
        tag: src.tag,
        total_nodes: src.total_nodes,
        healthy_nodes: src.healthy_nodes,
        last_sync_at: src.last_sync_at,
      })),
    });
  }

  // 5. QualityEngine — Receive Health Report (POST /api/v1/nodes/health-report)
  if (method === 'POST' && path === '/api/v1/nodes/health-report') {
    if (!env.QUALITY_ENGINE_SECRET) {
      return errorResponse(503, 'کلید امنیتی QualityEngine پیکربندی نشده است.');
    }
    const provided = extractBearerOrHeaderSecret(request, 'X-Quality-Secret');
    if (!provided || !(await constantTimeEquals(provided, env.QUALITY_ENGINE_SECRET))) {
      return errorResponse(401, 'دسترسی QualityEngine مجاز نیست.', 'UNAUTHORIZED_QUALITY_ENGINE');
    }

    let payload: HealthReportPayload;
    try {
      payload = (await request.json()) as HealthReportPayload;
    } catch {
      return errorResponse(400, 'بدنه JSON گزارش سلامت معتبر نیست.');
    }

    const nodeResults = Array.isArray(payload.results) ? payload.results : [];
    const subReports = Array.isArray(payload.subscription_reports)
      ? payload.subscription_reports
      : [];

    if (nodeResults.length === 0 && subReports.length === 0) {
      return errorResponse(400, 'آرایه results و subscription_reports خالی است.');
    }

    let updated = 0;
    let deactivated = 0;
    let geminiReady = 0;
    let subscriptionSourcesUpdated = 0;
    let discoveredNodesAdded = 0;

    for (const item of nodeResults.slice(0, 250)) {
      const nodeId = Number(item.outbound_id);
      if (!Number.isInteger(nodeId) || nodeId <= 0) continue;

      const existing = await env.DB.prepare(
        'SELECT id, fail_count, offline_since, allocation_mode FROM donated_outbounds WHERE id = ? LIMIT 1'
      )
        .bind(nodeId)
        .first<{ id: number; fail_count: number; offline_since: string | null; allocation_mode: string }>();
      if (!existing) continue;

      const latencyMs = Math.max(0, Math.min(9999, Math.round(Number(item.latency_ms) || 9999)));
      const jitterMs = Math.max(0, Math.min(9999, Math.round(Number(item.jitter_ms) || 0)));
      const speedMbps = Math.max(0, Number(item.speed_mbps) || 0);
      const speedScore = Math.max(0, Math.min(100, Math.round(Number(item.speed_score) || 0)));
      const healthScore = Math.max(0, Math.min(100, Math.round(Number(item.health_score) || speedScore)));
      const geminiOk = item.gemini_ok ? 1 : 0;
      const tradingSafe = item.trading_safe ? 1 : 0;

      if (!item.security_passed) {
        await env.DB.prepare(
          `UPDATE donated_outbounds
           SET status = 'rejected', rejection_reason = ?, health_score = 0,
               last_checked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        )
          .bind(String(item.error_msg || 'Failed security audit'), nodeId)
          .run();
        deactivated += 1;
        updated += 1;
        continue;
      }

      if (item.is_healthy) {
        if (geminiOk === 1) geminiReady += 1;
        // Auto-promote to static_ip only when allocation_mode === 'auto' and both Gemini & Trading pass
        const autoStatic =
          existing.allocation_mode === 'auto' && geminiOk === 1 && tradingSafe === 1 ? 1 : null;

        await env.DB.prepare(
          `UPDATE donated_outbounds
           SET latency_ms = ?, jitter_ms = ?, speed_mbps = ?, speed_score = ?,
               health_score = ?, gemini_ok = ?, trading_safe = ?,
               status = 'active', fail_count = 0, offline_since = NULL,
               allow_static_ip = COALESCE(?, allow_static_ip),
               last_online_at = CURRENT_TIMESTAMP, last_checked_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        )
          .bind(
            latencyMs,
            jitterMs,
            speedMbps,
            speedScore,
            healthScore,
            geminiOk,
            tradingSafe,
            autoStatic,
            nodeId
          )
          .run();
      } else {
        const nextFailCount = (existing.fail_count || 0) + 1;
        const nextStatus = nextFailCount >= 3 ? 'inactive' : 'active';
        if (nextStatus === 'inactive') deactivated += 1;

        await env.DB.prepare(
          `UPDATE donated_outbounds
           SET latency_ms = ?, jitter_ms = ?, speed_mbps = 0, speed_score = 0,
               health_score = ?, gemini_ok = 0, trading_safe = 0,
               status = ?, fail_count = ?,
               offline_since = COALESCE(offline_since, CURRENT_TIMESTAMP),
               last_checked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        )
          .bind(
            latencyMs,
            jitterMs,
            Math.max(0, 100 - nextFailCount * 35),
            nextStatus,
            nextFailCount,
            nodeId
          )
          .run();
      }

      updated += 1;
    }

    for (const srcReport of subReports.slice(0, 50)) {
      const sourceId = Number(srcReport.source_id);
      if (!Number.isInteger(sourceId) || sourceId <= 0) continue;

      const totalNodes = Math.max(0, Math.round(Number(srcReport.total_nodes) || 0));
      const healthyNodes = Math.max(0, Math.round(Number(srcReport.healthy_nodes) || 0));

      await env.DB.prepare(
        `UPDATE subscription_sources
         SET total_nodes = ?, healthy_nodes = ?, last_sync_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
        .bind(totalNodes, healthyNodes, sourceId)
        .run();
      subscriptionSourcesUpdated += 1;

      const category = String(srcReport.category || 'web_browsing').trim().toLowerCase();
      const allowWeb = category === 'web_browsing' || category === 'download' ? 1 : 0;
      const allowDownload = category === 'download' || category === 'web_browsing' ? 1 : 0;
      const allowGaming = category === 'gaming' ? 1 : 0;
      const allowStaticIp = category === 'static_ip' ? 1 : 0;
      const assignedTier =
        category === 'gaming'
          ? 'gaming'
          : category === 'static_ip'
          ? 'static_ip'
          : category === 'download'
          ? 'download'
          : 'web_browsing';

      const discovered = Array.isArray(srcReport.discovered_nodes)
        ? srcReport.discovered_nodes.slice(0, 50)
        : [];
      for (const node of discovered) {
        const fp = String(node.fingerprint_sha256 || '').trim();
        if (!fp || !node.server_address || !node.protocol) continue;

        const existingNode = await env.DB.prepare(
          'SELECT id FROM donated_outbounds WHERE fingerprint_sha256 = ? LIMIT 1'
        )
          .bind(fp)
          .first<{ id: number }>();

        const lat = Math.max(0, Math.min(9999, Math.round(Number(node.latency_ms) || 120)));
        const jit = Math.max(0, Math.min(9999, Math.round(Number(node.jitter_ms) || 0)));
        const spd = Math.max(0, Number(node.speed_mbps) || 0);
        const spdScore = Math.max(0, Math.min(100, Math.round(Number(node.speed_score) || 60)));
        const hScore = Math.max(0, Math.min(100, Math.round(Number(node.health_score) || spdScore)));
        const gOk = node.gemini_ok ? 1 : 0;
        const tSafe = node.trading_safe ? 1 : 0;
        if (gOk === 1) geminiReady += 1;

        if (existingNode) {
          await env.DB.prepare(
            `UPDATE donated_outbounds
             SET latency_ms = ?, jitter_ms = ?, speed_mbps = ?, speed_score = ?,
                 health_score = ?, gemini_ok = ?, trading_safe = ?, status = 'active',
                 fail_count = 0, offline_since = NULL,
                 last_online_at = CURRENT_TIMESTAMP, last_checked_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`
          )
            .bind(lat, jit, spd, spdScore, hScore, gOk, tSafe, existingNode.id)
            .run();
        } else {
          await env.DB.prepare(
            `INSERT INTO donated_outbounds (
               donor_user_id, tag, protocol, server_address, server_port, config_json,
               latency_ms, jitter_ms, speed_mbps, speed_score, assigned_tier, health_score,
               status, fail_count, raw_link, fingerprint_sha256, is_official, label,
               country_code, country_name, allow_web, allow_download, allow_gaming, allow_static_ip,
               gemini_ok, trading_safe, allocation_mode, last_online_at, last_checked_at
             ) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
          )
            .bind(
              String(node.tag || 'SubNode').slice(0, 64),
              String(node.protocol),
              String(node.server_address),
              Math.max(1, Math.min(65535, Math.round(Number(node.server_port) || 443))),
              String(node.config_json || '{}'),
              lat,
              jit,
              spd,
              spdScore,
              assignedTier,
              hScore,
              String(node.raw_link || ''),
              fp,
              String(node.tag || 'SubNode').slice(0, 64),
              String(node.country_code || 'XX').slice(0, 4),
              String(node.country_name || 'Global 🌐').slice(0, 40),
              allowWeb,
              allowDownload,
              allowGaming,
              allowStaticIp,
              gOk,
              tSafe,
              category
            )
            .run();
          discoveredNodesAdded += 1;
        }
      }
    }

    return jsonResponse({
      success: true,
      updated,
      deactivated,
      gemini_ready: geminiReady,
      subscription_sources_updated: subscriptionSourcesUpdated,
      discovered_nodes_added: discoveredNodesAdded,
      recorded_at: new Date().toISOString(),
    });
  }

  // 6. Subscription Endpoint: GET /sub/:token & GET /api/v1/sub/:token
  const subMatch = /^\/(?:api\/v1\/)?sub\/([^/]+)$/.exec(path);
  if (method === 'GET' && subMatch) {
    const token = decodeURIComponent(subMatch[1]).trim();
    const found = await getSubscriptionWithUser(env.DB, token);
    if (!found) {
      return errorResponse(404, 'توکن اشتراک یافت نشد.', 'SUBSCRIPTION_NOT_FOUND');
    }
    if (found.user.status !== 'active' || found.sub.status !== 'active') {
      return errorResponse(403, 'اشتراک شما غیرفعال یا منقضی شده است.', 'SUBSCRIPTION_INACTIVE');
    }

    const mode = normalizeMode(url.searchParams.get('mode'));
    if (mode === 'gaming') {
      const gamingLive = await hasActiveGamingOutbounds(env.DB);
      if (!gamingLive) {
        return errorResponse(400, 'بخش گیمینگ به‌زودی راه‌اندازی می‌شود.', 'GAMING_COMING_SOON');
      }
      if (!tierHasGaming(found.sub.tier)) {
        return errorResponse(403, 'حالت گیمینگ نیازمند اشتراک گیمینگ یا ویژه است.', 'TIER_REQUIRED');
      }
    }
    if (mode === 'static_ip' && !tierHasStaticIp(found.sub.tier)) {
      return errorResponse(403, 'حالت آی‌پی ثابت نیازمند پلن ویژه است.', 'TIER_REQUIRED');
    }

    const { donated, core } = await queryOutboundsForMode(
      env.DB,
      mode,
      url.searchParams.get('location') || undefined
    );

    const userAgent = (request.headers.get('User-Agent') || '').toLowerCase();
    const formatParam = (url.searchParams.get('format') || '').toLowerCase();
    const wantsSingbox =
      formatParam === 'singbox' ||
      formatParam === 'sing-box' ||
      formatParam === 'json' ||
      userAgent.includes('sing-box') ||
      userAgent.includes('sentra') ||
      userAgent.includes('sfa') ||
      userAgent.includes('sfi') ||
      userAgent.includes('hiddify');

    const subUserInfo = buildSubscriptionUserInfoHeader(found.sub);

    if (wantsSingbox) {
      const config = compileClientSingboxConfig(core, donated, {
        mode,
        includeClashApi: false,
      });
      return new Response(JSON.stringify(config, null, 2), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Subscription-Userinfo': subUserInfo,
          'Profile-Title': 'Sentra Connect',
          'Profile-Update-Interval': '6',
          'Cache-Control': 'no-store',
        },
      });
    }

    const base64Body = compileV2RaySubscriptionBase64(donated, core);
    return new Response(base64Body, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Subscription-Userinfo': subUserInfo,
        'Content-Disposition': 'attachment; filename="sentra-sub.txt"',
        'Cache-Control': 'no-store',
      },
    });
  }

  // 7. Client Sing-box 1.14+ Config Endpoint: POST /api/v1/client/config & /connect
  if (method === 'POST' && (path === '/api/v1/client/config' || path === '/api/v1/client/connect')) {
    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }

    const token = extractAuthToken(request, body.token);
    if (!token) {
      return errorResponse(401, 'توکن احراز هویت ارسال نشده است.', 'MISSING_TOKEN');
    }

    const found = await getSubscriptionWithUser(env.DB, token);
    if (!found) {
      return errorResponse(401, 'توکن اشتراک معتبر نیست.', 'INVALID_TOKEN');
    }
    if (found.user.status !== 'active' || found.sub.status !== 'active') {
      return errorResponse(403, 'حساب یا اشتراک شما غیرفعال است.', 'ACCOUNT_SUSPENDED');
    }

    const mode = normalizeMode(typeof body.mode === 'string' ? body.mode : 'web_browsing');
    const locationCode = typeof body.location_code === 'string' ? body.location_code : undefined;

    if (mode === 'gaming') {
      const gamingLive = await hasActiveGamingOutbounds(env.DB);
      if (!gamingLive) {
        return errorResponse(
          400,
          'بخش گیمینگ به‌زودی راه‌اندازی می‌شود و پس از افزودن سرور گیمینگ فعال خواهد شد.',
          'GAMING_COMING_SOON'
        );
      }
      if (!tierHasGaming(found.sub.tier)) {
        return errorResponse(403, 'دسترسی به حالت گیمینگ نیازمند اشتراک ویژه است.', 'TIER_REQUIRED');
      }
    }

    if (mode === 'static_ip') {
      if (!tierHasStaticIp(found.sub.tier)) {
        return errorResponse(403, 'دسترسی به حالت آی‌پی ثابت نیازمند پلن Pro یا Flow+ است.', 'TIER_REQUIRED');
      }
      if (found.sub.static_ip_used_mb >= STATIC_IP_MONTHLY_QUOTA_MB) {
        return errorResponse(402, 'سقف ماهانه ۳۰ گیگابایت آی‌پی ثابت به پایان رسیده است.', 'STATIC_IP_QUOTA_EXCEEDED');
      }
    }

    const isLite = found.sub.tier.toLowerCase() === 'sentra lite';
    if (isLite && mode === 'web_browsing' && found.sub.web_browsing_used_mb >= LITE_WEB_QUOTA_MB) {
      return errorResponse(429, 'سهمیه روزانه ۲ گیگابایت وب‌گردی پلن رایگان به پایان رسیده است.', 'QUOTA_EXCEEDED');
    }
    if (isLite && mode === 'download' && found.sub.download_used_mb >= LITE_DL_QUOTA_MB) {
      return errorResponse(429, 'سهمیه روزانه ۳ گیگابایت دانلود پلن رایگان به پایان رسیده است.', 'QUOTA_EXCEEDED');
    }

    const { donated, core } = await queryOutboundsForMode(env.DB, mode, locationCode);
    const singboxConfig = compileClientSingboxConfig(core, donated, {
      mode,
      preferFirstAsDefault: Boolean(body.selected_outbound_id),
      includeClashApi: true,
    });

    return jsonResponse({
      success: true,
      mode,
      location_code: locationCode || 'auto',
      singbox_schema: '1.14+',
      config: singboxConfig,
      singbox_config: singboxConfig,
    });
  }

  // 8. Client Modes Catalog: GET /api/v1/client/modes
  if (method === 'GET' && path === '/api/v1/client/modes') {
    const token = extractAuthToken(request);
    const found = token ? await getSubscriptionWithUser(env.DB, token) : null;
    const tier = found?.sub.tier || 'Sentra Lite';
    const gamingLive = await hasActiveGamingOutbounds(env.DB);
    const isLite = tier.toLowerCase() === 'sentra lite';

    return jsonResponse({
      success: true,
      gaming_enabled: gamingLive,
      modes: [
        {
          id: 'web_browsing',
          title: 'وب‌گردی',
          status: 'available',
          is_locked: false,
          is_coming_soon: false,
          daily_quota_mb: isLite ? LITE_WEB_QUOTA_MB : 0,
          daily_used_mb: found?.sub.web_browsing_used_mb || 0,
        },
        {
          id: 'download',
          title: 'دانلود',
          status: 'available',
          is_locked: false,
          is_coming_soon: false,
          daily_quota_mb: isLite ? LITE_DL_QUOTA_MB : 0,
          daily_used_mb: found?.sub.download_used_mb || 0,
        },
        {
          id: 'gaming',
          title: 'گیمینگ',
          status: !gamingLive ? 'coming_soon' : tierHasGaming(tier) ? 'available' : 'locked',
          is_locked: gamingLive && !tierHasGaming(tier),
          is_coming_soon: !gamingLive,
          daily_quota_mb: 0,
          daily_used_mb: 0,
        },
        {
          id: 'static_ip',
          title: 'آی‌پی ثابت',
          status: tierHasStaticIp(tier) ? 'available' : 'locked',
          is_locked: !tierHasStaticIp(tier),
          is_coming_soon: false,
          daily_quota_mb: STATIC_IP_MONTHLY_QUOTA_MB,
          daily_used_mb: found?.sub.static_ip_used_mb || 0,
        },
      ],
    });
  }

  // 9. Client Locations: GET /api/v1/client/locations
  if (method === 'GET' && path === '/api/v1/client/locations') {
    const rows = await env.DB.prepare(
      `SELECT country_code, country_name, COUNT(*) AS active_nodes, MIN(latency_ms) AS best_ping
       FROM donated_outbounds
       WHERE status = 'active'
       GROUP BY country_code, country_name
       ORDER BY best_ping ASC`
    ).all<{ country_code: string; country_name: string; active_nodes: number; best_ping: number }>();

    const items = rows.results || [];
    const totalNodes = items.reduce((sum, r) => sum + r.active_nodes, 0);
    const minPing = items.length > 0 ? items[0].best_ping : 0;

    return jsonResponse([
      {
        code: 'auto',
        name: '⚡️ انتخاب خودکار (سریع‌ترین لوکیشن)',
        flag: '⚡️',
        ping_ms: minPing,
        active_nodes: totalNodes,
        is_auto: true,
      },
      ...items.map((r) => ({
        code: r.country_code,
        name: r.country_name,
        flag: r.country_name.split(' ').pop() || '🌍',
        ping_ms: r.best_ping,
        active_nodes: r.active_nodes,
        is_auto: false,
      })),
    ]);
  }

  // 10. Auth: Register (POST /api/v1/auth/register)
  if (method === 'POST' && path === '/api/v1/auth/register') {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return errorResponse(400, 'بدنه درخواست معتبر نیست.');
    }

    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (username.length < 3 || username.length > 40 || !/^[a-zA-Z0-9._-]+$/.test(username)) {
      return errorResponse(400, 'نام کاربری باید بین ۳ تا ۴۰ کاراکتر انگلیسی، عدد یا _ باشد.');
    }
    if (password.length < 6) {
      return errorResponse(400, 'رمز عبور باید حداقل ۶ کاراکتر باشد.');
    }

    const exists = await env.DB.prepare('SELECT id FROM users WHERE lower(username) = lower(?) LIMIT 1')
      .bind(username)
      .first<{ id: number }>();
    if (exists) {
      return errorResponse(409, 'این نام کاربری قبلاً ثبت شده است.');
    }

    const userUuid = crypto.randomUUID();
    const passwordHash = await hashPassword(password);
    const token = generateSubscriptionToken();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const userRes = await env.DB.prepare(
      `INSERT INTO users (user_uuid, username, password_hash, first_name, role, status)
       VALUES (?, ?, ?, ?, 'user', 'active')`
    )
      .bind(userUuid, username, passwordHash, username)
      .run();

    const userId = userRes.meta.last_row_id;
    await env.DB.prepare(
      `INSERT INTO subscriptions (user_id, tier, token, status, traffic_limit_bytes, max_concurrent_devices, expires_at)
       VALUES (?, 'Sentra Lite', ?, 'active', ?, 3, ?)`
    )
      .bind(userId, token, 10 * 1024 * 1024 * 1024, expiresAt)
      .run();

    return jsonResponse(
      {
        success: true,
        access_token: `jwt_sentra_${token}`,
        token_type: 'Bearer',
        user: {
          id: userId,
          user_uuid: userUuid,
          telegram_id: null,
          username,
          first_name: username,
          role: 'user',
        },
        subscription: {
          tier: 'Sentra Lite',
          token,
          status: 'active',
          remaining_bytes: 10 * 1024 * 1024 * 1024,
          max_concurrent_devices: 3,
          expires_at: expiresAt,
        },
      },
      201
    );
  }

  // 11. Auth: Login (POST /api/v1/auth/login)
  if (method === 'POST' && path === '/api/v1/auth/login') {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return errorResponse(400, 'بدنه درخواست معتبر نیست.');
    }

    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const user = await env.DB.prepare(
      'SELECT * FROM users WHERE lower(username) = lower(?) OR lower(email) = lower(?) LIMIT 1'
    )
      .bind(username, username)
      .first<UserRow>();

    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return errorResponse(401, 'نام کاربری یا رمز عبور اشتباه است.');
    }
    if (user.status !== 'active') {
      return errorResponse(403, 'حساب کاربری شما تعلیق شده است.');
    }

    const sub = await env.DB.prepare(
      'SELECT * FROM subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 1'
    )
      .bind(user.id)
      .first<SubscriptionRow>();
    if (!sub) {
      return errorResponse(404, 'اشتراک فعالی برای این کاربر یافت نشد.');
    }

    return jsonResponse({
      success: true,
      access_token: `jwt_sentra_${sub.token}`,
      token_type: 'Bearer',
      user: {
        id: user.id,
        user_uuid: user.user_uuid,
        telegram_id: user.telegram_id,
        username: user.username,
        first_name: user.first_name,
        role: user.role,
      },
      subscription: {
        tier: sub.tier,
        token: sub.token,
        status: sub.status,
        remaining_bytes: Math.max(0, sub.traffic_limit_bytes - (sub.upload_bytes + sub.download_bytes)),
        max_concurrent_devices: sub.max_concurrent_devices,
        expires_at: sub.expires_at,
      },
    });
  }

  // 12. Auth: Exchange 8-digit Telegram OTP code
  if (
    method === 'POST' &&
    (path === '/api/v1/auth/exchange-code' || path === '/api/v1/auth/code-login')
  ) {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return errorResponse(400, 'بدنه درخواست معتبر نیست.');
    }

    const code = String(body.code || '').trim();
    if (!/^\d{6,8}$/.test(code)) {
      return errorResponse(400, 'کد ورود معتبر نیست.');
    }

    const user = await env.DB.prepare(
      `SELECT * FROM users
       WHERE auth_code = ? AND auth_code_expires_at > datetime('now')
       LIMIT 1`
    )
      .bind(code)
      .first<UserRow>();

    if (!user) {
      return errorResponse(401, 'کد ورود نامعتبر یا منقضی شده است.');
    }

    await env.DB.prepare(
      'UPDATE users SET auth_code = NULL, auth_code_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    )
      .bind(user.id)
      .run();

    const sub = await env.DB.prepare(
      'SELECT * FROM subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 1'
    )
      .bind(user.id)
      .first<SubscriptionRow>();
    if (!sub) {
      return errorResponse(404, 'اشتراک فعالی یافت نشد.');
    }

    return jsonResponse({
      success: true,
      access_token: `jwt_sentra_${sub.token}`,
      token_type: 'Bearer',
      user: {
        id: user.id,
        user_uuid: user.user_uuid,
        telegram_id: user.telegram_id,
        username: user.username,
        first_name: user.first_name,
        role: user.role,
      },
      subscription: {
        tier: sub.tier,
        token: sub.token,
        status: sub.status,
        remaining_bytes: Math.max(0, sub.traffic_limit_bytes - (sub.upload_bytes + sub.download_bytes)),
        max_concurrent_devices: sub.max_concurrent_devices,
        expires_at: sub.expires_at,
      },
    });
  }

  // 13. Auth: Generate 6-digit Telegram Link Code
  if (method === 'POST' && path === '/api/v1/auth/link-token') {
    const token = extractAuthToken(request);
    if (!token) return errorResponse(401, 'توکن احراز هویت ارسال نشده است.');
    const found = await getSubscriptionWithUser(env.DB, token);
    if (!found) return errorResponse(401, 'توکن معتبر نیست.');

    const linkCode = generateNumericCode(6);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    await env.DB.prepare(
      'UPDATE users SET link_code = ?, link_code_expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    )
      .bind(linkCode, expiresAt, found.user.id)
      .run();

    return jsonResponse({
      success: true,
      link_code: linkCode,
      expires_in_seconds: 300,
    });
  }

  // 14. Client Heartbeat & Usage Sync: POST /api/v1/client/heartbeat
  if (method === 'POST' && path === '/api/v1/client/heartbeat') {
    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }

    const token = extractAuthToken(request, body.token);
    if (!token) return errorResponse(401, 'توکن ارسال نشده است.');
    const found = await getSubscriptionWithUser(env.DB, token);
    if (!found) return errorResponse(401, 'توکن معتبر نیست.');

    if (found.user.status !== 'active' || found.sub.status !== 'active') {
      return jsonResponse({
        action: 'disconnect',
        code: 'ACCOUNT_SUSPENDED',
        message: 'حساب کاربری یا اشتراک شما غیرفعال شده است.',
      });
    }

    const deltaUp = Math.max(0, Math.round(Number(body.delta_upload_bytes) || 0));
    const deltaDown = Math.max(0, Math.round(Number(body.delta_download_bytes) || 0));
    const deltaMb = Math.floor((deltaUp + deltaDown) / (1024 * 1024));
    const mode = normalizeMode(typeof body.mode === 'string' ? body.mode : 'web_browsing');

    const webAdd = mode === 'web_browsing' ? deltaMb : 0;
    const dlAdd = mode === 'download' ? deltaMb : 0;
    const staticAdd = mode === 'static_ip' ? deltaMb : 0;

    await env.DB.prepare(
      `UPDATE subscriptions
       SET upload_bytes = upload_bytes + ?,
           download_bytes = download_bytes + ?,
           web_browsing_used_mb = web_browsing_used_mb + ?,
           download_used_mb = download_used_mb + ?,
           static_ip_used_mb = static_ip_used_mb + ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
      .bind(deltaUp, deltaDown, webAdd, dlAdd, staticAdd, found.sub.id)
      .run();

    const totalUsed = found.sub.upload_bytes + found.sub.download_bytes + deltaUp + deltaDown;
    const remaining = Math.max(0, found.sub.traffic_limit_bytes - totalUsed);

    if (remaining <= 0) {
      return jsonResponse({
        action: 'disconnect',
        code: 'QUOTA_EXCEEDED',
        message: 'حجم کل اشتراک شما به پایان رسیده است.',
      });
    }

    return jsonResponse({
      action: 'continue',
      remaining_bytes: remaining,
      web_browsing_used_mb: found.sub.web_browsing_used_mb + webAdd,
      download_used_mb: found.sub.download_used_mb + dlAdd,
      static_ip_used_mb: found.sub.static_ip_used_mb + staticAdd,
      static_ip_remaining_mb: Math.max(
        0,
        STATIC_IP_MONTHLY_QUOTA_MB - (found.sub.static_ip_used_mb + staticAdd)
      ),
    });
  }

  // 15. Client Bootstrap (GET /api/v1/client/bootstrap) — Full account, devices, modes, outbounds & synced state
  if (method === 'GET' && path === '/api/v1/client/bootstrap') {
    const token = extractAuthToken(request);
    if (!token) return errorResponse(401, 'توکن احراز هویت ارسال نشده است.', 'MISSING_TOKEN');
    const found = await getSubscriptionWithUser(env.DB, token);
    if (!found) return errorResponse(401, 'توکن اشتراک معتبر نیست.', 'INVALID_TOKEN');
    if (found.user.status !== 'active' || found.sub.status !== 'active') {
      return errorResponse(403, 'حساب کاربری یا اشتراک شما غیرفعال شده است.', 'ACCOUNT_SUSPENDED');
    }

    const deviceId = (request.headers.get('X-Device-Id') || '').trim();
    if (deviceId.length >= 4) {
      const ua = (request.headers.get('User-Agent') || '').toLowerCase();
      const osName = ua.includes('android') ? 'android' : ua.includes('windows') ? 'windows' : 'client';
      const deviceName = osName === 'android' ? 'Android Device' : osName === 'windows' ? 'Windows PC' : 'Sentra Client';
      try {
        await env.DB.prepare(
          `INSERT INTO device_sessions (subscription_id, device_identifier, device_name, os, is_active, last_seen_at)
           VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
           ON CONFLICT(subscription_id, device_identifier)
           DO UPDATE SET is_active = 1, last_seen_at = CURRENT_TIMESTAMP`
        )
          .bind(found.sub.id, deviceId.slice(0, 128), deviceName, osName)
          .run();
      } catch {
        // Non-fatal if concurrent upsert occurs
      }
    }

    const devicesRes = await env.DB.prepare(
      `SELECT id, device_identifier, device_name, os, last_seen_at, created_at
       FROM device_sessions
       WHERE subscription_id = ? AND is_active = 1
       ORDER BY last_seen_at DESC
       LIMIT 20`
    )
      .bind(found.sub.id)
      .all<{
        id: number;
        device_identifier: string;
        device_name: string;
        os: string;
        last_seen_at: string;
        created_at: string;
      }>();

    const activeDevices = (devicesRes.results || []).map((d) => ({
      id: d.id,
      device_id: d.device_identifier,
      device_name: d.device_name,
      platform: d.os,
      last_active_at: d.last_seen_at,
      created_at: d.created_at,
    }));

    const outboundsRes = await env.DB.prepare(
      `SELECT id, tag, label, protocol, server_address, server_port, assigned_tier,
              country_code, country_name, latency_ms, health_score, is_official, status, raw_link
       FROM donated_outbounds
       WHERE status = 'active'
       ORDER BY is_official DESC, health_score DESC, latency_ms ASC
       LIMIT 100`
    ).all<DonatedOutboundRow>();

    const outbounds = (outboundsRes.results || []).map((row) => ({
      id: `donated_${row.id}`,
      db_id: row.id,
      name: row.label || row.tag,
      tag: row.tag,
      protocol: row.protocol,
      category: row.assigned_tier || 'web_browsing',
      country_code: row.country_code || 'XX',
      country_name: row.country_name || 'Global 🌐',
      flag: (row.country_name || '🌍').split(' ').pop() || '🌍',
      latency_ms: row.latency_ms,
      health_score: row.health_score,
      is_official: row.is_official === 1,
      is_online: row.status === 'active',
      server_address: row.server_address,
      server_port: row.server_port,
      uri: row.raw_link || null,
    }));

    const clientStateRow = await env.DB.prepare(
      'SELECT personal_configs_json, preferences_json, updated_at FROM client_states WHERE user_id = ? LIMIT 1'
    )
      .bind(found.user.id)
      .first<{ personal_configs_json: string; preferences_json: string; updated_at: string }>();

    let personalConfigs: unknown[] = [];
    let preferences: Record<string, unknown> = {};
    if (clientStateRow) {
      try {
        const parsedCfg = JSON.parse(clientStateRow.personal_configs_json || '[]');
        if (Array.isArray(parsedCfg)) personalConfigs = parsedCfg;
      } catch {
        personalConfigs = [];
      }
      try {
        const parsedPref = JSON.parse(clientStateRow.preferences_json || '{}');
        if (parsedPref && typeof parsedPref === 'object') preferences = parsedPref as Record<string, unknown>;
      } catch {
        preferences = {};
      }
    }

    const usedBytes = found.sub.upload_bytes + found.sub.download_bytes;
    const remainingBytes = Math.max(0, found.sub.traffic_limit_bytes - usedBytes);
    const expiresMs = Date.parse(found.sub.expires_at);
    const remainingDays = Number.isFinite(expiresMs)
      ? Math.max(0, Math.ceil((expiresMs - Date.now()) / (24 * 60 * 60 * 1000)))
      : 30;
    const isLite = found.sub.tier.toLowerCase() === 'sentra lite';
    const gamingLive = await hasActiveGamingOutbounds(env.DB);

    return jsonResponse({
      success: true,
      server_time: new Date().toISOString(),
      bot_username: (env.BOT_USERNAME || 'sentraconnect_bot').replace(/^@/, ''),
      user: {
        id: found.user.id,
        user_uuid: found.user.user_uuid,
        username: found.user.username,
        first_name: found.user.first_name,
        telegram_id: found.user.telegram_id,
        role: found.user.role,
        status: found.user.status,
      },
      subscription: {
        tier: found.sub.tier,
        token: found.sub.token,
        status: found.sub.status,
        upload_bytes: found.sub.upload_bytes,
        download_bytes: found.sub.download_bytes,
        used_bytes: usedBytes,
        traffic_limit_bytes: found.sub.traffic_limit_bytes,
        remaining_bytes: remainingBytes,
        web_browsing_used_mb: found.sub.web_browsing_used_mb,
        download_used_mb: found.sub.download_used_mb,
        static_ip_used_mb: found.sub.static_ip_used_mb,
        active_devices_count: activeDevices.length,
        max_concurrent_devices: found.sub.max_concurrent_devices,
        remaining_days: remainingDays,
        expires_at: found.sub.expires_at,
      },
      devices: activeDevices,
      modes: [
        {
          id: 'web_browsing',
          name: 'وب‌گردی',
          status: isLite && found.sub.web_browsing_used_mb >= LITE_WEB_QUOTA_MB ? 'depleted' : 'active',
          daily_limit_mb: isLite ? LITE_WEB_QUOTA_MB : 0,
          used_today_mb: found.sub.web_browsing_used_mb,
          remaining_today_mb: isLite ? Math.max(0, LITE_WEB_QUOTA_MB - found.sub.web_browsing_used_mb) : 0,
          description: 'مناسب وب‌گردی، تلگرام، اینستاگرام و شبکه‌های اجتماعی',
        },
        {
          id: 'download',
          name: 'دانلود و استریم',
          status: isLite && found.sub.download_used_mb >= LITE_DL_QUOTA_MB ? 'depleted' : 'active',
          daily_limit_mb: isLite ? LITE_DL_QUOTA_MB : 0,
          used_today_mb: found.sub.download_used_mb,
          remaining_today_mb: isLite ? Math.max(0, LITE_DL_QUOTA_MB - found.sub.download_used_mb) : 0,
          description: 'پهنای باند بهینه برای دانلود فایل و تماشای ویدیو',
        },
        {
          id: 'gaming',
          name: 'گیمینگ',
          status: !gamingLive ? 'locked' : tierHasGaming(found.sub.tier) ? 'active' : 'locked',
          daily_limit_mb: 0,
          used_today_mb: 0,
          remaining_today_mb: 0,
          description: 'پینگ پایدار و بهینه برای بازی‌های آنلاین',
        },
        {
          id: 'static_ip',
          name: 'آی‌پی ثابت',
          status: tierHasStaticIp(found.sub.tier) ? 'active' : 'locked',
          daily_limit_mb: STATIC_IP_MONTHLY_QUOTA_MB,
          used_today_mb: found.sub.static_ip_used_mb,
          remaining_today_mb: Math.max(0, STATIC_IP_MONTHLY_QUOTA_MB - found.sub.static_ip_used_mb),
          description: 'آی‌پی ثابت و ایمن مناسب ترید و حساب‌های بین‌المللی',
        },
      ],
      outbounds,
      client_state: {
        personal_configs: personalConfigs,
        preferences,
        updated_at: clientStateRow?.updated_at ?? null,
      },
    });
  }

  // 16. Client Sync State (GET / PUT /api/v1/client/sync-state)
  if ((method === 'GET' || method === 'PUT') && path === '/api/v1/client/sync-state') {
    const token = extractAuthToken(request);
    if (!token) return errorResponse(401, 'توکن احراز هویت ارسال نشده است.', 'MISSING_TOKEN');
    const found = await getSubscriptionWithUser(env.DB, token);
    if (!found) return errorResponse(401, 'توکن اشتراک معتبر نیست.', 'INVALID_TOKEN');

    if (method === 'PUT') {
      let body: Record<string, unknown> = {};
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return errorResponse(400, 'بدنه JSON معتبر نیست.');
      }

      const existing = await env.DB.prepare(
        'SELECT personal_configs_json, preferences_json FROM client_states WHERE user_id = ? LIMIT 1'
      )
        .bind(found.user.id)
        .first<{ personal_configs_json: string; preferences_json: string }>();

      const nextConfigsJson = Array.isArray(body.personal_configs)
        ? JSON.stringify(body.personal_configs.slice(0, 100))
        : existing?.personal_configs_json || '[]';

      const nextPrefsJson =
        body.preferences && typeof body.preferences === 'object' && !Array.isArray(body.preferences)
          ? JSON.stringify(body.preferences)
          : existing?.preferences_json || '{}';

      await env.DB.prepare(
        `INSERT INTO client_states (user_id, personal_configs_json, preferences_json, updated_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id) DO UPDATE SET
           personal_configs_json = excluded.personal_configs_json,
           preferences_json = excluded.preferences_json,
           updated_at = CURRENT_TIMESTAMP`
      )
        .bind(found.user.id, nextConfigsJson, nextPrefsJson)
        .run();
    }

    const row = await env.DB.prepare(
      'SELECT personal_configs_json, preferences_json, updated_at FROM client_states WHERE user_id = ? LIMIT 1'
    )
      .bind(found.user.id)
      .first<{ personal_configs_json: string; preferences_json: string; updated_at: string }>();

    let personalConfigs: unknown[] = [];
    let preferences: Record<string, unknown> = {};
    try {
      const p = JSON.parse(row?.personal_configs_json || '[]');
      if (Array.isArray(p)) personalConfigs = p;
    } catch {
      personalConfigs = [];
    }
    try {
      const p = JSON.parse(row?.preferences_json || '{}');
      if (p && typeof p === 'object') preferences = p as Record<string, unknown>;
    } catch {
      preferences = {};
    }

    return jsonResponse({
      success: true,
      personal_configs: personalConfigs,
      preferences,
      updated_at: row?.updated_at ?? null,
    });
  }

  // 17. Client Devices Management (GET /api/v1/client/devices & POST /api/v1/client/devices/remove)
  if (method === 'GET' && path === '/api/v1/client/devices') {
    const token = extractAuthToken(request);
    if (!token) return errorResponse(401, 'توکن ارسال نشده است.');
    const found = await getSubscriptionWithUser(env.DB, token);
    if (!found) return errorResponse(401, 'توکن معتبر نیست.');

    const rows = await env.DB.prepare(
      `SELECT id, device_identifier, device_name, os, last_seen_at, created_at
       FROM device_sessions
       WHERE subscription_id = ? AND is_active = 1
       ORDER BY last_seen_at DESC`
    )
      .bind(found.sub.id)
      .all<{
        id: number;
        device_identifier: string;
        device_name: string;
        os: string;
        last_seen_at: string;
        created_at: string;
      }>();

    return jsonResponse({
      success: true,
      max_concurrent_devices: found.sub.max_concurrent_devices,
      devices: (rows.results || []).map((d) => ({
        id: d.id,
        device_id: d.device_identifier,
        device_name: d.device_name,
        platform: d.os,
        last_active_at: d.last_seen_at,
        created_at: d.created_at,
      })),
    });
  }

  if (method === 'POST' && path === '/api/v1/client/devices/remove') {
    const token = extractAuthToken(request);
    if (!token) return errorResponse(401, 'توکن ارسال نشده است.');
    const found = await getSubscriptionWithUser(env.DB, token);
    if (!found) return errorResponse(401, 'توکن معتبر نیست.');

    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return errorResponse(400, 'بدنه درخواست معتبر نیست.');
    }

    const deviceId = String(body.device_id || '').trim();
    if (!deviceId) return errorResponse(400, 'شناسه دستگاه ارسال نشده است.');

    await env.DB.prepare(
      'DELETE FROM device_sessions WHERE subscription_id = ? AND device_identifier = ?'
    )
      .bind(found.sub.id, deviceId)
      .run();

    return jsonResponse({ success: true, removed_device_id: deviceId });
  }

  // 18. Client Outbound Donation & Listing
  if (
    method === 'POST' &&
    (path === '/api/v1/client/outbounds/donate' || path === '/api/v1/client/outbounds/add')
  ) {
    const token = extractAuthToken(request);
    if (!token) return errorResponse(401, 'توکن احراز هویت ارسال نشده است.');
    const found = await getSubscriptionWithUser(env.DB, token);
    if (!found) return errorResponse(401, 'توکن معتبر نیست.');

    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return errorResponse(400, 'بدنه JSON معتبر نیست.');
    }

    const rawUri = String(body.uri || '').trim();
    if (!rawUri) return errorResponse(400, 'لینک کانفیگ خالی است.');

    let parsed;
    try {
      parsed = await parseOutboundInput(rawUri);
    } catch (err) {
      return errorResponse(400, err instanceof Error ? err.message : 'فرمت لینک کانفیگ پشتیبانی نمی‌شود.');
    }

    const audit = auditOutboundSecurity(parsed.protocol, parsed.config_json);
    if (!audit.passed) {
      return errorResponse(400, audit.reason || 'کانفیگ از نظر امنیتی رد شد.');
    }

    const existing = await env.DB.prepare(
      'SELECT id FROM donated_outbounds WHERE fingerprint_sha256 = ? LIMIT 1'
    )
      .bind(parsed.fingerprint_sha256)
      .first<{ id: number }>();
    if (existing) {
      return errorResponse(409, 'این کانفیگ قبلاً در شبکه سنترا ثبت شده است.');
    }

    const isAdmin = found.user.role === 'admin';
    const status = isAdmin && path.endsWith('/add') ? 'active' : 'pending';
    const isOfficial = isAdmin && path.endsWith('/add') ? 1 : 0;
    const label = String(body.name || parsed.tag || 'Community Node').trim().slice(0, 64);

    const insertRes = await env.DB.prepare(
      `INSERT INTO donated_outbounds (
         donor_user_id, tag, protocol, server_address, server_port, config_json,
         latency_ms, assigned_tier, health_score, status, raw_link, fingerprint_sha256,
         is_official, label, country_code, country_name, allow_web, allow_download
       ) VALUES (?, ?, ?, ?, ?, ?, 0, 'web_browsing', 100, ?, ?, ?, ?, ?, ?, ?, 1, 1)`
    )
      .bind(
        found.user.id,
        label,
        parsed.protocol,
        parsed.server_address,
        parsed.server_port,
        JSON.stringify(parsed.config_json),
        status,
        parsed.raw_link,
        parsed.fingerprint_sha256,
        isOfficial,
        label,
        parsed.country_code,
        parsed.country_name
      )
      .run();

    return jsonResponse(
      {
        success: true,
        id: insertRes.meta.last_row_id,
        is_official: isOfficial === 1,
        status,
        message:
          status === 'active'
            ? 'نود با موفقیت به شبکه رسمی سنترا اضافه شد.'
            : 'کانفیگ شما ثبت شد و پس از تایید ادمین به شبکه اضافه می‌شود.',
      },
      201
    );
  }

  if (method === 'GET' && path === '/api/v1/client/outbounds/my-donations') {
    const token = extractAuthToken(request);
    if (!token) return errorResponse(401, 'توکن ارسال نشده است.');
    const found = await getSubscriptionWithUser(env.DB, token);
    if (!found) return errorResponse(401, 'توکن معتبر نیست.');

    const rows = await env.DB.prepare(
      `SELECT id, tag, label, protocol, server_address, server_port, country_code, country_name,
              latency_ms, status, reward_granted, rejection_reason, created_at, updated_at
       FROM donated_outbounds
       WHERE donor_user_id = ?
       ORDER BY id DESC
       LIMIT 50`
    )
      .bind(found.user.id)
      .all<DonatedOutboundRow>();

    return jsonResponse({
      success: true,
      donations: (rows.results || []).map((r) => ({
        id: r.id,
        name: r.label || r.tag,
        protocol: r.protocol,
        server_address: r.server_address,
        server_port: r.server_port,
        country_code: r.country_code || 'XX',
        flag: (r.country_name || '🌍').split(' ').pop() || '🌍',
        latency_ms: r.latency_ms,
        status: r.status === 'active' ? 'approved' : r.status,
        reward_days: r.reward_granted ? 7 : 0,
        rejection_reason: r.rejection_reason || null,
        created_at: r.created_at,
        approved_at: r.status === 'active' ? r.updated_at : null,
      })),
    });
  }

  // 19. Client Version Metadata (GET /api/v1/client/version)
  if (method === 'GET' && path === '/api/v1/client/version') {
    return jsonResponse({
      success: true,
      latest_version: '1.0.0',
      min_supported_version: '1.0.0',
      release_url: 'https://github.com/parsa904/sentravpn/releases/latest',
      downloads: {
        android_universal: 'https://github.com/parsa904/sentravpn/releases/latest/download/SentraVPN-Android-Universal.apk',
        android_armv8: 'https://github.com/parsa904/sentravpn/releases/latest/download/SentraVPN-Android-ARMv8.apk',
        android_armv7: 'https://github.com/parsa904/sentravpn/releases/latest/download/SentraVPN-Android-ARMv7.apk',
        android_x64: 'https://github.com/parsa904/sentravpn/releases/latest/download/SentraVPN-Android-x64.apk',
        windows_setup_x64: 'https://github.com/parsa904/sentravpn/releases/latest/download/SentraVPN-Windows-Setup-x64.exe',
        windows_portable_x64: 'https://github.com/parsa904/sentravpn/releases/latest/download/SentraVPN-Windows-Portable-x64.zip',
      },
    });
  }

  return errorResponse(404, 'مسیر درخواستی یافت نشد.', 'NOT_FOUND');
}
