import {
  checkAuthFailureRateLimit,
  clearAuthFailures,
  hashPassword,
  normalizeLoginIdentifier,
  recordAuthFailure,
  validateOptionalEmail,
  validateUnifiedPassword,
  validateUnifiedUsername,
  verifyPassword,
} from './auth.ts';
import {
  constantTimeEquals,
  extractAuthToken,
  extractBearerOrHeaderSecret,
  generateNumericCode,
  generateSubscriptionToken,
  generateUniqueConnectCode,
  isValidEightDigitConnectCode,
  validateExternalHttpsUrl,
  validateSentraClientRequest,
} from './security.ts';
import {
  auditOutboundSecurity,
  parseOutboundInput,
  validateSingboxOutboundStrict,
} from './outboundAnalyzer.ts';
import {
  resolvePlanTier,
  subscriptionCanAccessSpecialMode,
} from './singboxCompiler.ts';
import { handleTelegramWebhook } from './telegramWebhook.ts';
import { dispatchErrorAlert, getFreeQuotaSettings } from './telegramTopics.ts';
import {
  checkIngestionRateAndDedup,
  dispatchUnifiedError,
  parseExternalErrorPayload,
  reportWorkerError,
} from './errorReporter.ts';
import { logTelemetryToTurso } from './tursoClient.ts';
import {
  checkPublicIpRateLimit,
  computeWeakEtag,
  executeD1Batch,
  extractClientIp,
  getCachedActiveNodesPool,
  getCachedCompiledSingbox,
  getCachedHasActiveGaming,
  getCachedLocations,
  getCachedPrecompiledPlanConfig,
  invalidateNodesCache,
  matchesIfNoneMatch,
} from './workerCache.ts';
import type {
  ConnectionMode,
  DonatedOutboundRow,
  Env,
  HealthReportPayload,
  SubscriptionRow,
  SubscriptionSourceRow,
  UserRow,
} from './types.ts';

const STATIC_IP_MONTHLY_QUOTA_MB = 30720;
const GIB_BYTES = 1024 * 1024 * 1024;
const MIB_BYTES = 1024 * 1024;

function isMissingSchemaElementError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err || '');
  return /no such column|has no column named|no such table/i.test(msg);
}

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

const SUB_SELECT_COLS =
  'id, user_id, tier, plan_tier, connect_code, token, status, upload_bytes, download_bytes, traffic_limit_bytes, speed_limit_bps, max_concurrent_devices, web_browsing_used_mb, download_used_mb, static_ip_used_mb, web_used_bytes, download_used_bytes, special_quota_bytes, special_used_bytes, has_used_special_trial, expires_at';
const USER_SELECT_COLS =
  'id, user_uuid, telegram_id, username, email, password_hash, first_name, last_name, role, status, outbound_reward_banned';

async function getSubscriptionWithUser(
  db: D1Database,
  token: string
): Promise<{ user: UserRow; sub: SubscriptionRow } | null> {
  const sub = await db
    .prepare(`SELECT ${SUB_SELECT_COLS} FROM subscriptions WHERE token = ? LIMIT 1`)
    .bind(token)
    .first<SubscriptionRow>();
  if (!sub) return null;
  const user = await db
    .prepare(`SELECT ${USER_SELECT_COLS} FROM users WHERE id = ? LIMIT 1`)
    .bind(sub.user_id)
    .first<UserRow>();
  if (!user) return null;
  return { user, sub };
}

async function getSubscriptionWithUserByConnectCode(
  db: D1Database,
  connectCode: string
): Promise<{ user: UserRow; sub: SubscriptionRow } | null> {
  const cleanCode = connectCode.trim();
  if (!isValidEightDigitConnectCode(cleanCode)) return null;
  const sub = await db
    .prepare(`SELECT ${SUB_SELECT_COLS} FROM subscriptions WHERE connect_code = ? LIMIT 1`)
    .bind(cleanCode)
    .first<SubscriptionRow>();
  if (!sub) return null;
  const user = await db
    .prepare(`SELECT ${USER_SELECT_COLS} FROM users WHERE id = ? LIMIT 1`)
    .bind(sub.user_id)
    .first<UserRow>();
  if (!user) return null;
  return { user, sub };
}

function normalizeMode(raw: string | null | undefined): ConnectionMode {
  const m = (raw || 'web_browsing').trim().toLowerCase();
  if (m === 'download' || m === 'gaming' || m === 'static_ip') return m;
  return 'web_browsing';
}

function getEffectiveWebUsedBytes(sub: SubscriptionRow): number {
  return Math.max(Number(sub.web_used_bytes || 0), Number(sub.web_browsing_used_mb || 0) * MIB_BYTES);
}

function getEffectiveDownloadUsedBytes(sub: SubscriptionRow): number {
  return Math.max(Number(sub.download_used_bytes || 0), Number(sub.download_used_mb || 0) * MIB_BYTES);
}

function getEffectiveSpecialUsedBytes(sub: SubscriptionRow): number {
  return Math.max(Number(sub.special_used_bytes || 0), Number(sub.static_ip_used_mb || 0) * MIB_BYTES);
}

export async function routeRequest(
  request: Request,
  env: Env,
  ctx?: ExecutionContext
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
    } catch (err) {
      console.error('[Sentra Health D1 Error]', err);
      await dispatchErrorAlert(env, ctx, 'routes.ts (/health D1)', err);
      return errorResponse(503, 'اتصال به دیتابیس D1 برقرار نشد.');
    }
  }

  // 2. Telegram Webhook (await full processing + Telegram API replies before returning 200 OK)
  if (method === 'POST' && path === '/api/v1/telegram/webhook') {
    return await handleTelegramWebhook(request, env, ctx);
  }

  // 2b. Unified AI-Ready Error Telemetry Ingestion (GitHub Actions, Android, Windows)
  if (
    method === 'POST' &&
    (path === '/api/v1/telemetry/error' ||
      path === '/api/v1/errors/report' ||
      path === '/api/v1/logs/report')
  ) {
    const ipLimit = checkPublicIpRateLimit('logs', extractClientIp(request));
    if (!ipLimit.allowed) {
      return jsonResponse(
        {
          success: false,
          error: 'تعداد درخواست‌های ارسال خطا از این آی‌پی بیش از حد مجاز است.',
          message: 'Rate limit exceeded',
          code: 'RATE_LIMITED',
        },
        429,
        { 'Retry-After': String(ipLimit.retryAfterSec) }
      );
    }

    let rawBody = '';
    try {
      rawBody = await request.text();
    } catch {
      return errorResponse(400, 'خواندن بدنه درخواست ناموفق بود.');
    }

    if (rawBody.length > 16_384) {
      return errorResponse(413, 'حجم گزارش خطا بیش از حد مجاز (۱۶ کیلوبایت) است.');
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawBody);
    } catch {
      return errorResponse(400, 'فرمت JSON گزارش خطا نامعتبر است.');
    }

    const parsed = parseExternalErrorPayload(parsedJson);
    if (!parsed.ok) {
      return errorResponse(400, parsed.error);
    }

    const report = parsed.report;

    // GitHub Actions / QualityEngine reports require QUALITY_ENGINE_SECRET
    if (report.platform === 'github-actions') {
      if (!env.QUALITY_ENGINE_SECRET) {
        return errorResponse(503, 'کلید امنیتی QualityEngine پیکربندی نشده است.');
      }
      const provided = extractBearerOrHeaderSecret(request, 'X-Quality-Secret');
      if (!provided || !(await constantTimeEquals(provided, env.QUALITY_ENGINE_SECRET))) {
        return errorResponse(401, 'دسترسی ارسال گزارش خطای QualityEngine مجاز نیست.', 'UNAUTHORIZED_QUALITY_ENGINE');
      }
    }

    // Optional subscription tier enrichment for Android/Windows (without ever logging the token)
    let authStatus = report.platform === 'github-actions' ? 'quality_secret_verified' : 'anonymous';
    if (report.platform === 'android' || report.platform === 'windows') {
      const subToken = extractAuthToken(request);
      if (subToken) {
        try {
          const found = await getSubscriptionWithUser(env.DB, subToken);
          if (found) {
            authStatus = `authenticated (${found.sub.tier})`;
          }
        } catch {
          // Never fail error ingestion if D1 lookup fails
        }
      }
    }

    const clientIp =
      request.headers.get('CF-Connecting-IP') ||
      request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
      request.headers.get('X-Device-Id') ||
      report.platform;
    const throttleKey = `${report.platform}:${clientIp}`;

    const verdict = checkIngestionRateAndDedup(report, throttleKey);
    if (!verdict.allowed) {
      if (verdict.reason === 'rate_limited') {
        return errorResponse(429, 'تعداد گزارش‌های خطا در دقیقه بیش از حد مجاز است.', 'RATE_LIMITED');
      }
      return jsonResponse(
        {
          success: true,
          accepted: true,
          deduplicated: true,
        },
        202
      );
    }

    const enrichedReport = {
      ...report,
      context: {
        ...(report.context || {}),
        auth_status: authStatus,
      },
    };

    await dispatchUnifiedError(env, ctx, enrichedReport);

    return jsonResponse(
      {
        success: true,
        accepted: true,
        deduplicated: false,
      },
      202
    );
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

    try {
      let nodeRows: DonatedOutboundRow[] = [];
      let subSourceRows: SubscriptionSourceRow[] = [];
      let schemaFallbackUsed = false;

      try {
        const [rowsRes, subSourcesRes] = await executeD1Batch<Record<string, unknown>>(env.DB, [
          env.DB.prepare(
            `SELECT id, tag, protocol, server_address, server_port, config_json,
                    compiled_outbound_json, validation_error,
                    country_code, status, fail_count, is_official, allocation_mode,
                    assigned_tier, allow_web, allow_download, allow_gaming, allow_static_ip,
                    fingerprint_sha256
             FROM donated_outbounds
             WHERE status IN ('active', 'inactive')
             ORDER BY is_official DESC, id ASC
             LIMIT 200`
          ),
          env.DB.prepare(
            `SELECT id, category, sub_url, tag, total_nodes, healthy_nodes, last_sync_at
             FROM subscription_sources
             WHERE status = 'active'
             ORDER BY id ASC
             LIMIT 50`
          ),
        ]);

        nodeRows = ((rowsRes?.results || []) as unknown) as DonatedOutboundRow[];
        subSourceRows = ((subSourcesRes?.results || []) as unknown) as SubscriptionSourceRow[];
      } catch (batchErr) {
        if (!isMissingSchemaElementError(batchErr)) {
          throw batchErr;
        }
        schemaFallbackUsed = true;

        // Report pending D1 migration warning non-blockingly so admin knows migrations need applying
        await reportWorkerError(env, ctx, {
          moduleOrFile: 'cloudflare-worker/src/routes.ts',
          actionOrRoute: 'GET /api/v1/nodes/active (schema-fallback)',
          error: batchErr,
          context: {
            fallback_activated: true,
            hint: 'Run wrangler d1 migrations apply sentra-db --remote (migrations 003/004)',
          },
        });

        // Fallback 1: Query donated_outbounds using pre-004 base columns (with ultra-safe minimal retry)
        try {
          const fallbackNodes = await env.DB.prepare(
            `SELECT id, tag, protocol, server_address, server_port, config_json,
                    country_code, status, fail_count, is_official, allocation_mode,
                    assigned_tier, allow_web, allow_download, allow_gaming, allow_static_ip,
                    fingerprint_sha256
             FROM donated_outbounds
             WHERE status IN ('active', 'inactive')
             ORDER BY is_official DESC, id ASC
             LIMIT 200`
          ).all<Record<string, unknown>>();
          nodeRows = ((fallbackNodes?.results || []) as unknown) as DonatedOutboundRow[];
        } catch (nodesErr) {
          if (!isMissingSchemaElementError(nodesErr)) {
            throw nodesErr;
          }
          const minimalNodes = await env.DB.prepare(
            `SELECT id, tag, protocol, server_address, server_port, config_json, status, fail_count
             FROM donated_outbounds
             WHERE status IN ('active', 'inactive')
             ORDER BY id ASC
             LIMIT 200`
          ).all<Record<string, unknown>>();
          nodeRows = ((minimalNodes?.results || []) as unknown) as DonatedOutboundRow[];
        }

        // Fallback 2: Query subscription_sources without requiring migration-003 `status` column
        try {
          const fallbackSubs = await env.DB.prepare(
            `SELECT id, category, sub_url, tag, total_nodes, healthy_nodes, last_sync_at
             FROM subscription_sources
             ORDER BY id ASC
             LIMIT 50`
          ).all<Record<string, unknown>>();
          subSourceRows = ((fallbackSubs?.results || []) as unknown) as SubscriptionSourceRow[];
        } catch (subsErr) {
          if (!isMissingSchemaElementError(subsErr)) {
            throw subsErr;
          }
          subSourceRows = [];
        }
      }

      return jsonResponse({
        ok: true,
        success: true,
        schema_fallback: schemaFallbackUsed,
        count: nodeRows.length,
        nodes: nodeRows.map((row) => ({
          id: row.id,
          tag: row.tag,
          protocol: row.protocol,
          server_address: row.server_address,
          server_port: row.server_port,
          config_json: row.compiled_outbound_json || row.config_json,
          compiled_outbound_json: row.compiled_outbound_json || null,
          country_code: row.country_code || 'XX',
          status: row.status,
          fail_count: Number(row.fail_count || 0),
          is_official: Number(row.is_official || 0) === 1,
          allocation_mode: row.allocation_mode || 'auto',
          assigned_tier: row.assigned_tier || 'web_browsing',
          allow_web: row.allow_web ?? 1,
          allow_download: row.allow_download ?? 1,
          allow_gaming: row.allow_gaming ?? 0,
          allow_static_ip: row.allow_static_ip ?? 0,
          fingerprint_sha256: row.fingerprint_sha256 || null,
        })),
        subscription_sources: subSourceRows.map((src) => ({
          id: src.id,
          category: src.category,
          sub_url: src.sub_url,
          tag: src.tag,
          total_nodes: Number(src.total_nodes || 0),
          healthy_nodes: Number(src.healthy_nodes || 0),
          last_sync_at: src.last_sync_at || null,
        })),
      });
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err || 'Unknown D1/KV error');
      await reportWorkerError(env, ctx, {
        moduleOrFile: 'cloudflare-worker/src/routes.ts',
        actionOrRoute: 'GET /api/v1/nodes/active',
        error: err,
        context: { endpoint: '/api/v1/nodes/active' },
      });
      return jsonResponse(
        {
          ok: false,
          success: false,
          error: errMessage,
        },
        500
      );
    }
  }

  // 5. QualityEngine — Receive Health Report (POST /api/v1/nodes/health-report)
  // Uses a single batched read + Diff-Only Writes + db.batch() to stay well below D1 write limits.
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

    const nodeResults = Array.isArray(payload.results) ? payload.results.slice(0, 250) : [];
    const subReports = Array.isArray(payload.subscription_reports)
      ? payload.subscription_reports.slice(0, 50)
      : [];

    if (nodeResults.length === 0 && subReports.length === 0) {
      return errorResponse(400, 'آرایه results و subscription_reports خالی است.');
    }

    try {

    const nodeIds = Array.from(
      new Set(
        nodeResults
          .map((item) => Number(item.outbound_id))
          .filter((id) => Number.isInteger(id) && id > 0)
      )
    );
    const sourceIds = Array.from(
      new Set(
        subReports
          .map((src) => Number(src.source_id))
          .filter((id) => Number.isInteger(id) && id > 0)
      )
    );
    const discoveredFps = Array.from(
      new Set(
        subReports.flatMap((src) =>
          (Array.isArray(src.discovered_nodes) ? src.discovered_nodes.slice(0, 50) : [])
            .map((n) => String(n.fingerprint_sha256 || '').trim())
            .filter(Boolean)
        )
      )
    );

    // 1. Single initial batched read using PRIMARY KEY / UNIQUE INDEX lookups
    const readStmts: D1PreparedStatement[] = [];
    let nodeReadIdx = -1;
    let sourceReadIdx = -1;
    let fpReadIdx = -1;

    if (nodeIds.length > 0) {
      nodeReadIdx = readStmts.length;
      const placeholders = nodeIds.map(() => '?').join(', ');
      readStmts.push(
        env.DB.prepare(
          `SELECT id, tag, protocol, status, health_score, fail_count,
                  gemini_ok, trading_safe, allow_static_ip, offline_since, allocation_mode,
                  compiled_outbound_json, validation_error
           FROM donated_outbounds
           WHERE id IN (${placeholders})`
        ).bind(...nodeIds)
      );
    }

    if (sourceIds.length > 0) {
      sourceReadIdx = readStmts.length;
      const placeholders = sourceIds.map(() => '?').join(', ');
      readStmts.push(
        env.DB.prepare(
          `SELECT id, total_nodes, healthy_nodes
           FROM subscription_sources
           WHERE id IN (${placeholders})`
        ).bind(...sourceIds)
      );
    }

    if (discoveredFps.length > 0) {
      fpReadIdx = readStmts.length;
      const placeholders = discoveredFps.map(() => '?').join(', ');
      readStmts.push(
        env.DB.prepare(
          `SELECT id, status, health_score, fail_count, gemini_ok, trading_safe,
                  fingerprint_sha256, compiled_outbound_json
           FROM donated_outbounds
           WHERE fingerprint_sha256 IN (${placeholders})`
        ).bind(...discoveredFps)
      );
    }

    const readResults = await executeD1Batch<Record<string, unknown>>(env.DB, readStmts);

    interface ExistingHealthNode {
      id: number;
      tag: string;
      protocol: string;
      status: string;
      health_score: number;
      fail_count: number;
      gemini_ok: number;
      trading_safe: number;
      allow_static_ip: number;
      offline_since: string | null;
      allocation_mode: string;
      compiled_outbound_json: string | null;
      validation_error: string | null;
    }
    interface ExistingSubSource {
      id: number;
      total_nodes: number;
      healthy_nodes: number;
    }
    interface ExistingFpNode {
      id: number;
      status: string;
      health_score: number;
      fail_count: number;
      gemini_ok: number;
      trading_safe: number;
      fingerprint_sha256: string;
      compiled_outbound_json: string | null;
    }

    const existingNodesById = new Map<number, ExistingHealthNode>();
    if (nodeReadIdx >= 0) {
      for (const row of (readResults[nodeReadIdx]?.results || []) as unknown as ExistingHealthNode[]) {
        existingNodesById.set(Number(row.id), row);
      }
    }

    const existingSourcesById = new Map<number, ExistingSubSource>();
    if (sourceReadIdx >= 0) {
      for (const row of (readResults[sourceReadIdx]?.results || []) as unknown as ExistingSubSource[]) {
        existingSourcesById.set(Number(row.id), row);
      }
    }

    const existingNodesByFp = new Map<string, ExistingFpNode>();
    if (fpReadIdx >= 0) {
      for (const row of (readResults[fpReadIdx]?.results || []) as unknown as ExistingFpNode[]) {
        if (row.fingerprint_sha256) {
          existingNodesByFp.set(String(row.fingerprint_sha256), row);
        }
      }
    }

    const writeStatements: D1PreparedStatement[] = [];
    let updated = 0;
    let writesSkipped = 0;
    let deactivated = 0;
    let quarantinedCount = 0;
    let geminiReady = 0;
    let subscriptionSourcesUpdated = 0;
    let discoveredNodesAdded = 0;
    const quarantinedNodesSummary: Array<{
      id: number;
      tag: string;
      protocol: string;
      reason: string;
    }> = [];
    const deactivatedNodeTags: string[] = [];

    let nodesChanged = false;

    // 2. Diff-Only Writes for evaluated DB nodes
    for (const item of nodeResults) {
      const nodeId = Number(item.outbound_id);
      if (!Number.isInteger(nodeId) || nodeId <= 0) continue;

      const existing = existingNodesById.get(nodeId);
      if (!existing) continue;

      const latencyMs = Math.max(0, Math.min(9999, Math.round(Number(item.latency_ms) || 9999)));
      const jitterMs = Math.max(0, Math.min(9999, Math.round(Number(item.jitter_ms) || 0)));
      const speedMbps = Math.max(0, Number(item.speed_mbps) || 0);
      const speedScore = Math.max(0, Math.min(100, Math.round(Number(item.speed_score) || 0)));
      const healthScore = Math.max(0, Math.min(100, Math.round(Number(item.health_score) || speedScore)));
      const geminiOk = item.gemini_ok ? 1 : 0;
      const tradingSafe = item.trading_safe ? 1 : 0;

      // Stage-1 sing-box check / strict schema failure -> Quarantine (logged to Turso, zero Telegram spam)
      if (item.quarantined) {
        const validationError = String(
          item.validation_error || item.error_msg || 'Failed sing-box 1.14+ schema validation'
        ).slice(0, 500);
        if (
          existing.status !== 'quarantined' ||
          existing.validation_error !== validationError ||
          Number(existing.health_score) !== 0
        ) {
          writeStatements.push(
            env.DB.prepare(
              `UPDATE donated_outbounds
               SET status = 'quarantined', validation_error = ?, rejection_reason = ?,
                   health_score = 0, gemini_ok = 0, trading_safe = 0,
                   last_checked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
               WHERE id = ?`
            ).bind(validationError, validationError, nodeId)
          );
          nodesChanged = true;
          deactivated += 1;
        } else {
          writesSkipped += 1;
        }
        quarantinedCount += 1;
        quarantinedNodesSummary.push({
          id: nodeId,
          tag: existing.tag,
          protocol: existing.protocol,
          reason: validationError,
        });
        updated += 1;
        continue;
      }

      if (!item.security_passed) {
        const rejectReason = String(item.validation_error || item.error_msg || 'Failed security audit').slice(0, 500);
        if (
          existing.status !== 'rejected' ||
          existing.validation_error !== rejectReason ||
          Number(existing.health_score) !== 0
        ) {
          writeStatements.push(
            env.DB.prepare(
              `UPDATE donated_outbounds
               SET status = 'rejected', rejection_reason = ?, validation_error = ?, health_score = 0,
                   last_checked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
               WHERE id = ?`
            ).bind(rejectReason, rejectReason, nodeId)
          );
          nodesChanged = true;
          deactivated += 1;
        } else {
          writesSkipped += 1;
        }
        quarantinedCount += 1;
        quarantinedNodesSummary.push({
          id: nodeId,
          tag: existing.tag,
          protocol: existing.protocol,
          reason: rejectReason,
        });
        updated += 1;
        continue;
      }

      if (item.is_healthy) {
        if (geminiOk === 1) geminiReady += 1;
        const autoStatic =
          existing.allocation_mode === 'auto' && geminiOk === 1 && tradingSafe === 1 ? 1 : null;
        const nextAllowStatic = autoStatic ?? Number(existing.allow_static_ip || 0);
        const compiledJson =
          typeof item.compiled_outbound_json === 'string' &&
          item.compiled_outbound_json.trim().startsWith('{')
            ? item.compiled_outbound_json.trim()
            : null;

        const changed =
          existing.status !== 'active' ||
          Number(existing.health_score) !== healthScore ||
          Number(existing.fail_count || 0) !== 0 ||
          Number(existing.gemini_ok || 0) !== geminiOk ||
          Number(existing.trading_safe || 0) !== tradingSafe ||
          Number(existing.allow_static_ip || 0) !== nextAllowStatic ||
          existing.validation_error !== null ||
          (compiledJson !== null && existing.compiled_outbound_json !== compiledJson);

        if (changed) {
          writeStatements.push(
            env.DB.prepare(
              `UPDATE donated_outbounds
               SET latency_ms = ?, jitter_ms = ?, speed_mbps = ?, speed_score = ?,
                   health_score = ?, gemini_ok = ?, trading_safe = ?,
                   status = 'active', fail_count = 0, offline_since = NULL,
                   validation_error = NULL,
                   compiled_outbound_json = COALESCE(?, compiled_outbound_json),
                   allow_static_ip = COALESCE(?, allow_static_ip),
                   last_online_at = CURRENT_TIMESTAMP, last_checked_at = CURRENT_TIMESTAMP,
                   updated_at = CURRENT_TIMESTAMP
               WHERE id = ?`
            ).bind(
              latencyMs,
              jitterMs,
              speedMbps,
              speedScore,
              healthScore,
              geminiOk,
              tradingSafe,
              compiledJson,
              autoStatic,
              nodeId
            )
          );
          nodesChanged = true;
        } else {
          writesSkipped += 1;
        }
      } else {
        const nextFailCount = Math.min(3, (Number(existing.fail_count) || 0) + 1);
        const nextStatus = nextFailCount >= 3 ? 'inactive' : 'active';
        const nextHealthScore = Math.max(0, 100 - nextFailCount * 35);
        if (nextStatus === 'inactive' && existing.status !== 'inactive') {
          deactivated += 1;
          if (deactivatedNodeTags.length < 8) {
            deactivatedNodeTags.push(
              `${existing.tag} (${String(item.error_msg || 'offline').slice(0, 60)})`
            );
          }
        }

        const changed =
          existing.status !== nextStatus ||
          Number(existing.fail_count || 0) !== nextFailCount ||
          Number(existing.health_score) !== nextHealthScore ||
          Number(existing.gemini_ok || 0) !== 0 ||
          Number(existing.trading_safe || 0) !== 0;

        if (changed) {
          writeStatements.push(
            env.DB.prepare(
              `UPDATE donated_outbounds
               SET latency_ms = ?, jitter_ms = ?, speed_mbps = 0, speed_score = 0,
                   health_score = ?, gemini_ok = 0, trading_safe = 0,
                   status = ?, fail_count = ?,
                   offline_since = COALESCE(offline_since, CURRENT_TIMESTAMP),
                   last_checked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
               WHERE id = ?`
            ).bind(
              latencyMs,
              jitterMs,
              nextHealthScore,
              nextStatus,
              nextFailCount,
              nodeId
            )
          );
          nodesChanged = true;
        } else {
          writesSkipped += 1;
        }
      }

      updated += 1;
    }

    // 3. Diff-Only Writes for subscription_sources & discovered nodes
    const seenNewFps = new Set<string>();
    for (const srcReport of subReports) {
      const sourceId = Number(srcReport.source_id);
      if (!Number.isInteger(sourceId) || sourceId <= 0) continue;

      const totalNodes = Math.max(0, Math.round(Number(srcReport.total_nodes) || 0));
      const healthyNodes = Math.max(0, Math.round(Number(srcReport.healthy_nodes) || 0));

      const existingSrc = existingSourcesById.get(sourceId);
      if (
        !existingSrc ||
        Number(existingSrc.total_nodes) !== totalNodes ||
        Number(existingSrc.healthy_nodes) !== healthyNodes
      ) {
        writeStatements.push(
          env.DB.prepare(
            `UPDATE subscription_sources
             SET total_nodes = ?, healthy_nodes = ?, last_sync_at = CURRENT_TIMESTAMP
             WHERE id = ?`
          ).bind(totalNodes, healthyNodes, sourceId)
        );
      } else {
        writesSkipped += 1;
      }
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

        let compiledJson = String(node.compiled_outbound_json || node.config_json || '{}');
        try {
          const parsedCandidate = JSON.parse(compiledJson) as Record<string, unknown>;
          const checked = validateSingboxOutboundStrict(parsedCandidate);
          if (!checked.ok) {
            quarantinedCount += 1;
            quarantinedNodesSummary.push({
              id: 0,
              tag: String(node.tag || 'SubNode').slice(0, 64),
              protocol: String(node.protocol),
              reason: checked.error,
            });
            continue;
          }
          compiledJson = checked.compiledJson;
        } catch {
          quarantinedCount += 1;
          continue;
        }

        const existingNode = existingNodesByFp.get(fp);
        const lat = Math.max(0, Math.min(9999, Math.round(Number(node.latency_ms) || 120)));
        const jit = Math.max(0, Math.min(9999, Math.round(Number(node.jitter_ms) || 0)));
        const spd = Math.max(0, Number(node.speed_mbps) || 0);
        const spdScore = Math.max(0, Math.min(100, Math.round(Number(node.speed_score) || 60)));
        const hScore = Math.max(0, Math.min(100, Math.round(Number(node.health_score) || spdScore)));
        const gOk = node.gemini_ok ? 1 : 0;
        const tSafe = node.trading_safe ? 1 : 0;
        if (gOk === 1) geminiReady += 1;

        if (existingNode) {
          const changed =
            existingNode.status !== 'active' ||
            Number(existingNode.health_score) !== hScore ||
            Number(existingNode.fail_count || 0) !== 0 ||
            Number(existingNode.gemini_ok || 0) !== gOk ||
            Number(existingNode.trading_safe || 0) !== tSafe ||
            existingNode.compiled_outbound_json !== compiledJson;
          if (changed) {
            writeStatements.push(
              env.DB.prepare(
                `UPDATE donated_outbounds
                 SET latency_ms = ?, jitter_ms = ?, speed_mbps = ?, speed_score = ?,
                     health_score = ?, gemini_ok = ?, trading_safe = ?, status = 'active',
                     fail_count = 0, offline_since = NULL, validation_error = NULL,
                     compiled_outbound_json = ?,
                     last_online_at = CURRENT_TIMESTAMP, last_checked_at = CURRENT_TIMESTAMP,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`
              ).bind(lat, jit, spd, spdScore, hScore, gOk, tSafe, compiledJson, existingNode.id)
            );
            nodesChanged = true;
          } else {
            writesSkipped += 1;
          }
        } else if (!seenNewFps.has(fp)) {
          seenNewFps.add(fp);
          writeStatements.push(
            env.DB.prepare(
              `INSERT INTO donated_outbounds (
                 donor_user_id, tag, protocol, server_address, server_port, config_json,
                 compiled_outbound_json, validation_error,
                 latency_ms, jitter_ms, speed_mbps, speed_score, assigned_tier, health_score,
                 status, fail_count, raw_link, fingerprint_sha256, is_official, label,
                 country_code, country_name, allow_web, allow_download, allow_gaming, allow_static_ip,
                 gemini_ok, trading_safe, allocation_mode, last_online_at, last_checked_at
               ) VALUES (NULL, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
            ).bind(
              String(node.tag || 'SubNode').slice(0, 64),
              String(node.protocol),
              String(node.server_address),
              Math.max(1, Math.min(65535, Math.round(Number(node.server_port) || 443))),
              compiledJson,
              compiledJson,
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
          );
          nodesChanged = true;
          discoveredNodesAdded += 1;
        }
      }
    }

    // 4. Execute all changed writes in chunked db.batch() and invalidate L1+L2 KV cache ONLY if nodes actually changed
    if (writeStatements.length > 0) {
      await executeD1Batch(env.DB, writeStatements);
      if (nodesChanged) {
        await invalidateNodesCache(env.DB, env.SENTRA_KV);
      }
    }

    // 5. Inspect remaining healthy capacity per plan tier (single lightweight aggregate query)
    let activePoolCount = 1;
    let freeTierActive = 1;
    let proTierActive = 1;
    let flowPlusTierActive = 1;
    if (writeStatements.length > 0 || quarantinedCount > 0 || updated > 0 || subscriptionSourcesUpdated > 0) {
      try {
        const capRow = await env.DB.prepare(
          `SELECT
             COUNT(*) AS cnt,
             COALESCE(SUM(CASE WHEN allow_web = 1 OR allow_download = 1 THEN 1 ELSE 0 END), 0) AS free_cnt,
             COALESCE(SUM(CASE WHEN allow_web = 1 OR allow_download = 1 OR allow_static_ip = 1 THEN 1 ELSE 0 END), 0) AS pro_cnt,
             COALESCE(SUM(CASE WHEN allow_web = 1 OR allow_download = 1 OR allow_static_ip = 1 OR allow_gaming = 1 THEN 1 ELSE 0 END), 0) AS flow_cnt
           FROM donated_outbounds
           WHERE status = 'active'`
        ).first<{
          cnt: number;
          free_cnt: number;
          pro_cnt: number;
          flow_cnt: number;
        }>();
        activePoolCount = Number(capRow?.cnt ?? 0);
        freeTierActive = Number(capRow?.free_cnt ?? 0);
        proTierActive = Number(capRow?.pro_cnt ?? 0);
        flowPlusTierActive = Number(capRow?.flow_cnt ?? 0);
      } catch {
        activePoolCount = 1;
      }
    }

    const bundleChecks = Array.isArray(payload.bundle_checks) ? payload.bundle_checks : [];
    const failedBundles = bundleChecks.filter((b) => b && b.passed === false);
    const depletedPlans: string[] = [];
    if (updated > 0 || subscriptionSourcesUpdated > 0) {
      if (freeTierActive === 0) depletedPlans.push('Free');
      if (proTierActive === 0) depletedPlans.push('Pro');
      if (flowPlusTierActive === 0) depletedPlans.push('Flow+');
    }

    // Alert Telegram topic_logs_id ONLY on complete plan capacity depletion or Stage-2 bundle check failure
    // (Individual quarantined nodes are recorded in Turso telemetry_logs without spamming Telegram)
    if (depletedPlans.length > 0 || failedBundles.length > 0) {
      const summaryLines: string[] = [
        `Checked: ${updated} | Writes: ${writeStatements.length} | Skipped: ${writesSkipped} | Quarantined: ${quarantinedCount} | Active Pool: ${activePoolCount}`,
      ];
      if (depletedPlans.length > 0) {
        summaryLines.push(
          `CRITICAL: Plan capacity reached 0 healthy nodes for: ${depletedPlans.join(', ')}`
        );
      }
      if (deactivatedNodeTags.length > 0) {
        summaryLines.push(`Affected Nodes: ${deactivatedNodeTags.slice(0, 5).join(', ')}`);
      }
      if (quarantinedNodesSummary.length > 0) {
        summaryLines.push(
          `Quarantined Nodes: ${quarantinedNodesSummary
            .slice(0, 5)
            .map((q) => `${q.tag} (${q.reason.slice(0, 60)})`)
            .join(', ')}`
        );
      }
      for (const b of failedBundles) {
        summaryLines.push(
          `CRITICAL: Stage-2 sing-box check failed for plan "${b.plan_tier}" (${b.node_count} nodes): ${String(
            b.error || 'unknown error'
          ).slice(0, 180)}`
        );
      }

      await dispatchErrorAlert(env, ctx, 'QualityEngine (plan-capacity-alert)', summaryLines.join('\n'));
    }

    // Offload QualityEngine health + quarantine history to Turso telemetry_logs (zero D1 Row Writes, zero Telegram noise)
    const tursoHealthWrite = logTelemetryToTurso(env, {
      platform: 'github-actions',
      eventType: quarantinedCount > 0 ? 'node_quarantine_and_health_report' : 'node_health_report',
      details: {
        runner: payload.runner || 'quality-engine',
        checked_at: payload.checked_at || new Date().toISOString(),
        checked_nodes: updated,
        d1_writes: writeStatements.length,
        d1_writes_skipped: writesSkipped,
        deactivated,
        quarantined_count: quarantinedCount,
        quarantined_nodes: quarantinedNodesSummary.slice(0, 40),
        bundle_checks: bundleChecks,
        tier_capacity: {
          total_active: activePoolCount,
          free: freeTierActive,
          pro: proTierActive,
          flow_plus: flowPlusTierActive,
        },
        gemini_ready: geminiReady,
        subscription_sources_updated: subscriptionSourcesUpdated,
        discovered_nodes_added: discoveredNodesAdded,
        nodes_sample: nodeResults.slice(0, 30).map((n) => ({
          id: Number(n.outbound_id),
          healthy: Boolean(n.is_healthy),
          quarantined: Boolean(n.quarantined),
          latency_ms: Math.round(Number(n.latency_ms) || 0),
          health_score: Math.round(Number(n.health_score) || 0),
          gemini_ok: Boolean(n.gemini_ok),
        })),
      },
    }).then(() => undefined);

    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(tursoHealthWrite);
    } else {
      await tursoHealthWrite;
    }

    return jsonResponse({
      ok: true,
      success: true,
      updated,
      db_writes: writeStatements.length,
      writes_skipped: writesSkipped,
      deactivated,
      quarantined: quarantinedCount,
      gemini_ready: geminiReady,
      subscription_sources_updated: subscriptionSourcesUpdated,
      discovered_nodes_added: discoveredNodesAdded,
      tier_capacity: {
        total_active: activePoolCount,
        free: freeTierActive,
        pro: proTierActive,
        flow_plus: flowPlusTierActive,
      },
      recorded_at: new Date().toISOString(),
    });
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err || 'Unknown D1/KV error');
      await reportWorkerError(env, ctx, {
        moduleOrFile: 'cloudflare-worker/src/routes.ts',
        actionOrRoute: 'POST /api/v1/nodes/health-report',
        error: err,
        context: {
          endpoint: '/api/v1/nodes/health-report',
          results_count: nodeResults.length,
          sub_reports_count: subReports.length,
        },
      });
      return jsonResponse(
        {
          ok: false,
          success: false,
          error: errMessage,
        },
        500
      );
    }
  }

  // 5b. Automated GitHub Releases Sync Endpoint: POST /api/v1/releases/sync (Protected by QUALITY_ENGINE_SECRET)
  if (method === 'POST' && path === '/api/v1/releases/sync') {
    if (!env.QUALITY_ENGINE_SECRET) {
      return errorResponse(503, 'کلید امنیتی QualityEngine پیکربندی نشده است.');
    }
    const provided = extractBearerOrHeaderSecret(request, 'X-Quality-Secret');
    if (!provided || !(await constantTimeEquals(provided, env.QUALITY_ENGINE_SECRET))) {
      return errorResponse(401, 'دسترسی همگام‌سازی انتشار مجاز نیست.', 'UNAUTHORIZED_RELEASE_SYNC');
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return errorResponse(400, 'بدنه JSON همگام‌سازی نسخه معتبر نیست.');
    }

    const platformRaw = String(body.platform || '').trim().toLowerCase();
    if (platformRaw !== 'android' && platformRaw !== 'windows') {
      return errorResponse(400, 'فیلد platform باید android یا windows باشد.');
    }

    const version = String(body.version || '').trim().slice(0, 48);
    if (!version) {
      return errorResponse(400, 'فیلد version الزامی است.');
    }

    const rawGithubUrl = String(body.github_url || '').trim();
    let parsedUrl: URL;
    try {
      parsedUrl = validateExternalHttpsUrl(rawGithubUrl);
      if (parsedUrl.protocol !== 'https:') {
        return errorResponse(400, 'آدرس github_url باید با https:// شروع شود.');
      }
    } catch {
      return errorResponse(400, 'آدرس github_url نامعتبر است.');
    }

    const telegramFileId =
      typeof body.telegram_file_id === 'string' && body.telegram_file_id.trim().length > 0
        ? body.telegram_file_id.trim().slice(0, 256)
        : null;

    await env.DB.prepare(
      `INSERT INTO app_release_files (platform, version, github_url, telegram_file_id, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(platform) DO UPDATE SET
         version = excluded.version,
         github_url = excluded.github_url,
         telegram_file_id = COALESCE(excluded.telegram_file_id, app_release_files.telegram_file_id),
         updated_at = CURRENT_TIMESTAMP`
    )
      .bind(platformRaw, version, parsedUrl.toString(), telegramFileId)
      .run();

    return jsonResponse({
      success: true,
      platform: platformRaw,
      version,
      github_url: parsedUrl.toString(),
      has_telegram_file_id: Boolean(telegramFileId),
      updated_at: new Date().toISOString(),
    });
  }

  // 6. Public V2Ray/Subscription Routes Permanently Disabled (403 Forbidden)
  const subMatch = /^\/(?:api\/v1\/)?sub(?:\/.*)?$/.exec(path);
  if (subMatch) {
    return errorResponse(
      403,
      'دریافت لینک اشتراک عمومی (V2Ray/Subscription) غیرفعال شده است. لطفاً کد اتصال ۸ رقمی خود را از ربات تلگرام دریافت کرده و فقط در اپلیکیشن رسمی SentraVPN وارد کنید.',
      'PUBLIC_SUB_DISABLED'
    );
  }

  // 7. Official SentraVPN Client Config & Connect Endpoint:
  //    GET/POST /api/v1/client/config & POST /api/v1/client/connect
  //    Strictly requires `X-Sentra-Client` header, blocks V2Ray/Clash/browser UAs,
  //    and authenticates via 8-digit `connect_code` (or authenticated client token).
  if (
    (method === 'POST' || method === 'GET') &&
    (path === '/api/v1/client/config' || path === '/api/v1/client/connect')
  ) {
    const rate = checkPublicIpRateLimit('sub', extractClientIp(request));
    if (!rate.allowed) {
      return new Response(
        JSON.stringify({
          success: false,
          code: 'RATE_LIMITED',
          error: 'تعداد درخواست‌های شما بیش از حد مجاز است. لطفاً کمی بعد تلاش کنید.',
        }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Retry-After': String(rate.retryAfterSec),
          },
        }
      );
    }

    const clientCheck = validateSentraClientRequest(request);
    if (!clientCheck.ok) {
      return errorResponse(403, clientCheck.reason || 'کلاینت مجاز نیست.', 'UNSUPPORTED_CLIENT');
    }

    let body: Record<string, unknown> = {};
    if (method === 'POST') {
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        body = {};
      }
    }

    const rawConnectCode =
      (typeof body.connect_code === 'string' && body.connect_code.trim()) ||
      (typeof body.code === 'string' && body.code.trim()) ||
      (url.searchParams.get('connect_code') || url.searchParams.get('code') || '').trim() ||
      (request.headers.get('X-Connect-Code') || '').trim() ||
      '';

    let found: { user: UserRow; sub: SubscriptionRow } | null = null;
    if (rawConnectCode) {
      if (!isValidEightDigitConnectCode(rawConnectCode)) {
        return errorResponse(400, 'کد اتصال باید دقیقاً ۸ رقم عددی باشد.', 'INVALID_CONNECT_CODE');
      }
      found = await getSubscriptionWithUserByConnectCode(env.DB, rawConnectCode);
      if (!found) {
        return errorResponse(401, 'کد اتصال ۸ رقمی نامعتبر است.', 'INVALID_CONNECT_CODE');
      }
    } else {
      const token = extractAuthToken(request, body.token);
      if (!token) {
        return errorResponse(
          401,
          'کد اتصال ۸ رقمی (connect_code) یا توکن احراز هویت ارسال نشده است.',
          'MISSING_CREDENTIALS'
        );
      }
      found = await getSubscriptionWithUser(env.DB, token);
      if (!found) {
        return errorResponse(401, 'توکن اشتراک معتبر نیست.', 'INVALID_TOKEN');
      }
    }

    if (found.user.status !== 'active' || found.sub.status !== 'active') {
      return errorResponse(403, 'حساب یا اشتراک شما غیرفعال است.', 'ACCOUNT_SUSPENDED');
    }

    const mode = normalizeMode(
      typeof body.mode === 'string' ? body.mode : url.searchParams.get('mode') || 'web_browsing'
    );
    const locationCode =
      typeof body.location_code === 'string'
        ? body.location_code
        : url.searchParams.get('location_code') || url.searchParams.get('location') || undefined;
    const pool = await getCachedActiveNodesPool(env.DB, env.SENTRA_KV);
    const planTier = resolvePlanTier(found.sub);

    if (mode === 'gaming') {
      if (!pool.hasActiveGaming) {
        return errorResponse(
          400,
          'بخش گیمینگ به‌زودی راه‌اندازی می‌شود و پس از افزودن سرور گیمینگ فعال خواهد شد.',
          'GAMING_COMING_SOON'
        );
      }
      const specialCheck = subscriptionCanAccessSpecialMode(found.sub, 'gaming');
      if (!specialCheck.allowed) {
        if (specialCheck.quotaExceeded) {
          return errorResponse(
            402,
            'حجم بخش ویژه (آی‌پی ثابت + گیمینگ) شما به پایان رسیده است.',
            'SPECIAL_QUOTA_EXCEEDED'
          );
        }
        return errorResponse(
          403,
          'دسترسی به حالت گیمینگ نیازمند پلن Sentra Flow+ یا تست رایگان ۱ گیگابایتی است.',
          'TIER_REQUIRED'
        );
      }
    }

    if (mode === 'static_ip') {
      const specialCheck = subscriptionCanAccessSpecialMode(found.sub, 'static_ip');
      if (!specialCheck.allowed) {
        if (specialCheck.quotaExceeded) {
          return errorResponse(
            402,
            'حجم بخش ویژه (آی‌پی ثابت) شما به پایان رسیده است.',
            'STATIC_IP_QUOTA_EXCEEDED'
          );
        }
        return errorResponse(
          403,
          'دسترسی به حالت آی‌پی ثابت نیازمند پلن Sentra Pro، Sentra Flow+ یا تست رایگان ۱ گیگابایتی است.',
          'TIER_REQUIRED'
        );
      }
    }

    if (planTier === 'free' && (mode === 'web_browsing' || mode === 'download')) {
      const freeQuotas = await getFreeQuotaSettings(env.DB, env.SENTRA_KV);
      if (
        mode === 'web_browsing' &&
        getEffectiveWebUsedBytes(found.sub) >= freeQuotas.webQuotaBytes
      ) {
        return errorResponse(
          429,
          `سهمیه وبگردی پلن رایگان (${freeQuotas.webQuotaGb} گیگابایت) به پایان رسیده است.`,
          'QUOTA_EXCEEDED'
        );
      }
      if (
        mode === 'download' &&
        getEffectiveDownloadUsedBytes(found.sub) >= freeQuotas.downloadQuotaBytes
      ) {
        return errorResponse(
          429,
          `سهمیه دانلود پلن رایگان (${freeQuotas.downloadQuotaGb} گیگابایت) به پایان رسیده است.`,
          'QUOTA_EXCEEDED'
        );
      }
    }

    const preferFirst = Boolean(body.selected_outbound_id);
    const normalizedLocation = (locationCode || 'auto').trim().toLowerCase() || 'auto';
    const usePrecompiledPlanCache =
      mode === 'web_browsing' && normalizedLocation === 'auto' && !preferFirst;

    const etag = computeWeakEtag([
      'cfg',
      pool.version,
      mode,
      normalizedLocation.toUpperCase(),
      preferFirst ? 1 : 0,
      planTier,
      found.sub.tier,
      found.sub.status,
      found.sub.expires_at,
    ]);

    if (matchesIfNoneMatch(request.headers.get('If-None-Match'), etag)) {
      return new Response(null, {
        status: 304,
        headers: {
          ETag: etag,
          'Cache-Control': 'private, max-age=1800',
        },
      });
    }

    let precompiledConfigJson: string;
    let cacheSource: string = 'isolate';
    try {
      if (usePrecompiledPlanCache) {
        const ready = await getCachedPrecompiledPlanConfig(env.DB, planTier, {
          kv: env.SENTRA_KV,
          onError: (source, details) => {
            void dispatchErrorAlert(env, ctx, source, details);
          },
        });
        precompiledConfigJson = ready.configJson;
        cacheSource = ready.source;
      } else {
        const compiled = await getCachedCompiledSingbox(env.DB, {
          mode,
          locationCode,
          preferFirstAsDefault: preferFirst,
          includeClashApi: true,
          kv: env.SENTRA_KV,
          onError: (source, details) => {
            void dispatchErrorAlert(env, ctx, source, details);
          },
        });
        precompiledConfigJson = compiled.json;
      }
    } catch (err) {
      await dispatchErrorAlert(env, ctx, 'singboxCompiler.ts (/api/v1/client/config)', err);
      throw err;
    }

    // Zero-parse / zero-re-stringify response assembly (<1ms CPU)
    const responseBody =
      `{"success":true,` +
      `"mode":${JSON.stringify(mode)},` +
      `"plan_tier":${JSON.stringify(planTier)},` +
      `"connect_code":${JSON.stringify(found.sub.connect_code || null)},` +
      `"location_code":${JSON.stringify(locationCode || 'auto')},` +
      `"singbox_schema":"1.14+",` +
      `"config":${precompiledConfigJson},` +
      `"singbox_config":${precompiledConfigJson}}`;

    return new Response(responseBody, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        ETag: etag,
        'Cache-Control': 'private, max-age=1800',
        'X-Sentra-Cache': cacheSource,
      },
    });
  }

  // 8. Client Modes Catalog: GET /api/v1/client/modes (Served from L1 RAM / L2 KV Cache)
  if (method === 'GET' && path === '/api/v1/client/modes') {
    const token = extractAuthToken(request);
    const found = token ? await getSubscriptionWithUser(env.DB, token) : null;
    const planTier = found ? resolvePlanTier(found.sub) : 'free';
    const isFree = planTier === 'free';
    const gamingLive = await getCachedHasActiveGaming(env.DB, env.SENTRA_KV);
    const freeQuotas = await getFreeQuotaSettings(env.DB, env.SENTRA_KV);

    const staticAccess = found
      ? subscriptionCanAccessSpecialMode(found.sub, 'static_ip')
      : { allowed: false, isTrial: false, quotaExceeded: false };
    const gamingAccess = found
      ? subscriptionCanAccessSpecialMode(found.sub, 'gaming')
      : { allowed: false, isTrial: false, quotaExceeded: false };

    const webUsedMb = found ? Math.round(getEffectiveWebUsedBytes(found.sub) / MIB_BYTES) : 0;
    const dlUsedMb = found ? Math.round(getEffectiveDownloadUsedBytes(found.sub) / MIB_BYTES) : 0;
    const specialQuotaMb = found && Number(found.sub.special_quota_bytes || 0) > 0
      ? Math.round(Number(found.sub.special_quota_bytes || 0) / MIB_BYTES)
      : STATIC_IP_MONTHLY_QUOTA_MB;
    const specialUsedMb = found ? Math.round(getEffectiveSpecialUsedBytes(found.sub) / MIB_BYTES) : 0;

    return jsonResponse({
      success: true,
      plan_tier: planTier,
      gaming_enabled: gamingLive,
      modes: [
        {
          id: 'web_browsing',
          title: 'وب‌گردی',
          status: 'available',
          is_locked: false,
          is_coming_soon: false,
          daily_quota_mb: isFree ? Math.round(freeQuotas.webQuotaGb * 1024) : 0,
          daily_used_mb: webUsedMb,
        },
        {
          id: 'download',
          title: 'دانلود',
          status: 'available',
          is_locked: false,
          is_coming_soon: false,
          daily_quota_mb: isFree ? Math.round(freeQuotas.downloadQuotaGb * 1024) : 0,
          daily_used_mb: dlUsedMb,
        },
        {
          id: 'gaming',
          title: 'گیمینگ',
          status: !gamingLive ? 'coming_soon' : gamingAccess.allowed ? 'available' : 'locked',
          is_locked: gamingLive && !gamingAccess.allowed,
          is_coming_soon: !gamingLive,
          daily_quota_mb: specialQuotaMb,
          daily_used_mb: specialUsedMb,
        },
        {
          id: 'static_ip',
          title: 'آی‌پی ثابت',
          status: staticAccess.allowed ? 'available' : 'locked',
          is_locked: !staticAccess.allowed,
          is_coming_soon: false,
          daily_quota_mb: specialQuotaMb,
          daily_used_mb: specialUsedMb,
        },
      ],
    });
  }

  // 9. Client Locations: GET /api/v1/client/locations (Served from L1 RAM / L2 KV Cache)
  if (method === 'GET' && path === '/api/v1/client/locations') {
    const items = await getCachedLocations(env.DB, env.SENTRA_KV);
    const totalNodes = items.reduce((sum, r) => sum + r.active_nodes, 0);
    const minPing = items.length > 0 ? items[0].best_ping : 0;

    return jsonResponse(
      [
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
      ],
      200,
      { 'Cache-Control': 'public, max-age=300' }
    );
  }

  // 10. Auth: Register (POST /api/v1/auth/register)
  if (method === 'POST' && path === '/api/v1/auth/register') {
    const clientIp = extractClientIp(request);
    const rate = checkAuthFailureRateLimit(clientIp);
    if (!rate.allowed) {
      return jsonResponse(
        {
          success: false,
          error: 'تعداد تلاش‌های ناموفق بیش از حد مجاز است. لطفاً یک دقیقه دیگر دوباره تلاش کنید.',
          message: 'تعداد تلاش‌های ناموفق بیش از حد مجاز است. لطفاً یک دقیقه دیگر دوباره تلاش کنید.',
          code: 'RATE_LIMITED',
          retry_after_seconds: rate.retryAfterSec,
        },
        429,
        { 'Retry-After': String(rate.retryAfterSec) }
      );
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      recordAuthFailure(clientIp);
      return errorResponse(400, 'بدنه درخواست معتبر نیست.');
    }

    const usernameCheck = validateUnifiedUsername(body.username);
    if (!usernameCheck.ok) {
      recordAuthFailure(clientIp);
      return errorResponse(400, usernameCheck.error, 'INVALID_USERNAME');
    }

    const passwordCheck = validateUnifiedPassword(body.password);
    if (!passwordCheck.ok) {
      recordAuthFailure(clientIp);
      return errorResponse(400, passwordCheck.error, 'INVALID_PASSWORD');
    }

    const rawConfirm =
      body.confirmPassword !== undefined ? body.confirmPassword : body.confirm_password;
    if (typeof rawConfirm !== 'string' || rawConfirm !== passwordCheck.password) {
      recordAuthFailure(clientIp);
      return errorResponse(400, 'رمز عبور و تکرار رمز عبور مطابقت ندارند.', 'PASSWORD_MISMATCH');
    }

    const emailCheck = validateOptionalEmail(body.email);
    if (!emailCheck.ok) {
      recordAuthFailure(clientIp);
      return errorResponse(400, emailCheck.error, 'INVALID_EMAIL');
    }

    const username = usernameCheck.username;
    const email = emailCheck.email;

    const exists = await env.DB.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1')
      .bind(username)
      .first<{ id: number }>();
    if (exists) {
      recordAuthFailure(clientIp);
      return errorResponse(409, 'این نام کاربری قبلاً ثبت شده است.', 'USERNAME_TAKEN');
    }

    const userUuid = crypto.randomUUID();
    const passwordHash = await hashPassword(passwordCheck.password);
    const token = generateSubscriptionToken();
    const connectCode = await generateUniqueConnectCode(env.DB);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const freeQuotas = await getFreeQuotaSettings(env.DB);
    const initialTrafficLimit = freeQuotas.webQuotaBytes + freeQuotas.downloadQuotaBytes;

    const userRes = await env.DB.prepare(
      `INSERT INTO users (user_uuid, telegram_id, username, email, password_hash, first_name, role, status)
       VALUES (?, NULL, ?, ?, ?, ?, 'user', 'active')`
    )
      .bind(userUuid, username, email, passwordHash, username)
      .run();

    const userId = userRes.meta.last_row_id;
    await env.DB.prepare(
      `INSERT INTO subscriptions (
         user_id, tier, plan_tier, connect_code, token, status,
         traffic_limit_bytes, max_concurrent_devices,
         web_used_bytes, download_used_bytes, special_quota_bytes, special_used_bytes,
         has_used_special_trial, expires_at
       ) VALUES (?, 'Sentra Lite', 'free', ?, ?, 'active', ?, 3, 0, 0, 0, 0, 0, ?)`
    )
      .bind(userId, connectCode, token, initialTrafficLimit, expiresAt)
      .run();

    clearAuthFailures(clientIp);

    return jsonResponse(
      {
        success: true,
        access_token: `jwt_sentra_${token}`,
        token_type: 'Bearer',
        connect_code: connectCode,
        plan_tier: 'free',
        user: {
          id: userId,
          user_uuid: userUuid,
          telegram_id: null,
          username,
          email,
          first_name: username,
          role: 'user',
        },
        subscription: {
          tier: 'Sentra Lite',
          plan_tier: 'free',
          connect_code: connectCode,
          token,
          status: 'active',
          traffic_limit_bytes: initialTrafficLimit,
          remaining_bytes: initialTrafficLimit,
          web_used_bytes: 0,
          download_used_bytes: 0,
          special_quota_bytes: 0,
          special_used_bytes: 0,
          has_used_special_trial: false,
          free_web_quota_gb: freeQuotas.webQuotaGb,
          free_download_quota_gb: freeQuotas.downloadQuotaGb,
          max_concurrent_devices: 3,
          expires_at: expiresAt,
        },
      },
      201
    );
  }

  // 11. Auth: Login (POST /api/v1/auth/login)
  if (method === 'POST' && path === '/api/v1/auth/login') {
    const clientIp = extractClientIp(request);
    const rate = checkAuthFailureRateLimit(clientIp);
    if (!rate.allowed) {
      return jsonResponse(
        {
          success: false,
          error: 'تعداد تلاش‌های ناموفق بیش از حد مجاز است. لطفاً یک دقیقه دیگر دوباره تلاش کنید.',
          message: 'تعداد تلاش‌های ناموفق بیش از حد مجاز است. لطفاً یک دقیقه دیگر دوباره تلاش کنید.',
          code: 'RATE_LIMITED',
          retry_after_seconds: rate.retryAfterSec,
        },
        429,
        { 'Retry-After': String(rate.retryAfterSec) }
      );
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      recordAuthFailure(clientIp);
      return errorResponse(400, 'بدنه درخواست معتبر نیست.');
    }

    const identifier = normalizeLoginIdentifier(body.username);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!identifier || !password) {
      recordAuthFailure(clientIp);
      return errorResponse(400, 'نام کاربری و رمز عبور الزامی است.');
    }

    const user = await env.DB.prepare(
      `SELECT ${USER_SELECT_COLS} FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?) LIMIT 1`
    )
      .bind(identifier, identifier)
      .first<UserRow>();

    if (!user || !(await verifyPassword(password, user.password_hash))) {
      recordAuthFailure(clientIp);
      return errorResponse(401, 'نام کاربری یا رمز عبور اشتباه است.', 'INVALID_CREDENTIALS');
    }
    if (user.status !== 'active') {
      return errorResponse(403, 'حساب کاربری شما تعلیق شده است.', 'ACCOUNT_SUSPENDED');
    }

    clearAuthFailures(clientIp);

    let sub = await env.DB.prepare(
      `SELECT ${SUB_SELECT_COLS} FROM subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 1`
    )
      .bind(user.id)
      .first<SubscriptionRow>();

    const freeQuotas = await getFreeQuotaSettings(env.DB);
    if (!sub) {
      const token = generateSubscriptionToken();
      const connectCode = await generateUniqueConnectCode(env.DB);
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const initialLimit = freeQuotas.webQuotaBytes + freeQuotas.downloadQuotaBytes;
      await env.DB.prepare(
        `INSERT INTO subscriptions (
           user_id, tier, plan_tier, connect_code, token, status,
           traffic_limit_bytes, max_concurrent_devices,
           web_used_bytes, download_used_bytes, special_quota_bytes, special_used_bytes,
           has_used_special_trial, expires_at
         ) VALUES (?, 'Sentra Lite', 'free', ?, ?, 'active', ?, 3, 0, 0, 0, 0, 0, ?)`
      )
        .bind(user.id, connectCode, token, initialLimit, expiresAt)
        .run();
      sub = await env.DB.prepare(
        `SELECT ${SUB_SELECT_COLS} FROM subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 1`
      )
        .bind(user.id)
        .first<SubscriptionRow>();
    }

    if (!sub) {
      return errorResponse(500, 'خطا در بازیابی اشتراک کاربر.');
    }

    if (!sub.connect_code) {
      const generatedCode = await generateUniqueConnectCode(env.DB);
      await env.DB.prepare(
        'UPDATE subscriptions SET connect_code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      )
        .bind(generatedCode, sub.id)
        .run();
      sub = { ...sub, connect_code: generatedCode };
    }

    const planTier = resolvePlanTier(sub);
    const webUsedBytes = Number(sub.web_used_bytes ?? (sub.web_browsing_used_mb || 0) * MIB_BYTES);
    const downloadUsedBytes = Number(
      sub.download_used_bytes ?? (sub.download_used_mb || 0) * MIB_BYTES
    );
    const specialQuotaBytes = Number(sub.special_quota_bytes ?? 0);
    const specialUsedBytes = Number(sub.special_used_bytes ?? 0);
    const remainingBytes = Math.max(
      0,
      sub.traffic_limit_bytes - (sub.upload_bytes + sub.download_bytes)
    );

    return jsonResponse({
      success: true,
      access_token: `jwt_sentra_${sub.token}`,
      token_type: 'Bearer',
      connect_code: sub.connect_code,
      plan_tier: planTier,
      user: {
        id: user.id,
        user_uuid: user.user_uuid,
        telegram_id: user.telegram_id,
        username: user.username,
        email: user.email,
        first_name: user.first_name,
        role: user.role,
      },
      subscription: {
        tier: sub.tier,
        plan_tier: planTier,
        connect_code: sub.connect_code,
        token: sub.token,
        status: sub.status,
        traffic_limit_bytes: sub.traffic_limit_bytes,
        used_bytes: sub.upload_bytes + sub.download_bytes,
        remaining_bytes: remainingBytes,
        web_used_bytes: webUsedBytes,
        download_used_bytes: downloadUsedBytes,
        special_quota_bytes: specialQuotaBytes,
        special_used_bytes: specialUsedBytes,
        has_used_special_trial: Boolean(sub.has_used_special_trial),
        free_web_quota_gb: freeQuotas.webQuotaGb,
        free_download_quota_gb: freeQuotas.downloadQuotaGb,
        max_concurrent_devices: sub.max_concurrent_devices,
        expires_at: sub.expires_at,
      },
    });
  }

  // 12. Auth: Login with Permanent 8-Digit Connect Code (or legacy OTP code)
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

    const code = String(body.connect_code || body.code || '').trim();
    if (!/^\d{6,8}$/.test(code)) {
      return errorResponse(400, 'کد اتصال ۸ رقمی معتبر نیست.');
    }

    // 12a. First check permanent 8-digit subscriptions.connect_code (zero D1 writes!)
    if (isValidEightDigitConnectCode(code)) {
      const byCode = await getSubscriptionWithUserByConnectCode(env.DB, code);
      if (byCode) {
        if (byCode.user.status !== 'active' || byCode.sub.status !== 'active') {
          return errorResponse(403, 'حساب کاربری یا اشتراک شما غیرفعال است.');
        }
        return jsonResponse({
          success: true,
          access_token: `jwt_sentra_${byCode.sub.token}`,
          token_type: 'Bearer',
          user: {
            id: byCode.user.id,
            user_uuid: byCode.user.user_uuid,
            telegram_id: byCode.user.telegram_id,
            username: byCode.user.username,
            first_name: byCode.user.first_name,
            role: byCode.user.role,
          },
          subscription: {
            tier: byCode.sub.tier,
            plan_tier: resolvePlanTier(byCode.sub),
            connect_code: byCode.sub.connect_code,
            token: byCode.sub.token,
            status: byCode.sub.status,
            remaining_bytes: Math.max(
              0,
              byCode.sub.traffic_limit_bytes - (byCode.sub.upload_bytes + byCode.sub.download_bytes)
            ),
            max_concurrent_devices: byCode.sub.max_concurrent_devices,
            expires_at: byCode.sub.expires_at,
          },
        });
      }
    }

    // 12b. Fallback: legacy ephemeral auth_code
    const user = await env.DB.prepare(
      `SELECT ${USER_SELECT_COLS} FROM users
       WHERE auth_code = ? AND auth_code_expires_at > datetime('now')
       LIMIT 1`
    )
      .bind(code)
      .first<UserRow>();

    if (!user) {
      return errorResponse(401, 'کد اتصال ۸ رقمی نامعتبر یا منقضی شده است.');
    }

    const [, subBatchRes] = await executeD1Batch<Record<string, unknown>>(env.DB, [
      env.DB.prepare(
        'UPDATE users SET auth_code = NULL, auth_code_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      ).bind(user.id),
      env.DB.prepare(
        `SELECT ${SUB_SELECT_COLS} FROM subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 1`
      ).bind(user.id),
    ]);

    const sub = ((subBatchRes?.results || [])[0] as unknown as SubscriptionRow | undefined) ?? null;
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
        plan_tier: resolvePlanTier(sub),
        connect_code: sub.connect_code || null,
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
    const deltaBytes = deltaUp + deltaDown;
    const deltaMb = Math.floor(deltaBytes / MIB_BYTES);
    const mode = normalizeMode(typeof body.mode === 'string' ? body.mode : 'web_browsing');
    const planTier = resolvePlanTier(found.sub);

    const webAddMb = mode === 'web_browsing' ? deltaMb : 0;
    const dlAddMb = mode === 'download' ? deltaMb : 0;
    const staticAddMb = mode === 'static_ip' || mode === 'gaming' ? deltaMb : 0;
    const webAddBytes = mode === 'web_browsing' ? deltaBytes : 0;
    const dlAddBytes = mode === 'download' ? deltaBytes : 0;
    const specialAddBytes = mode === 'static_ip' || mode === 'gaming' ? deltaBytes : 0;

    await env.DB.prepare(
      `UPDATE subscriptions
       SET upload_bytes = upload_bytes + ?,
           download_bytes = download_bytes + ?,
           web_browsing_used_mb = web_browsing_used_mb + ?,
           download_used_mb = download_used_mb + ?,
           static_ip_used_mb = static_ip_used_mb + ?,
           web_used_bytes = web_used_bytes + ?,
           download_used_bytes = download_used_bytes + ?,
           special_used_bytes = special_used_bytes + ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
      .bind(
        deltaUp,
        deltaDown,
        webAddMb,
        dlAddMb,
        staticAddMb,
        webAddBytes,
        dlAddBytes,
        specialAddBytes,
        found.sub.id
      )
      .run();

    const nextWebBytes = getEffectiveWebUsedBytes(found.sub) + webAddBytes;
    const nextDlBytes = getEffectiveDownloadUsedBytes(found.sub) + dlAddBytes;
    const nextSpecialBytes = getEffectiveSpecialUsedBytes(found.sub) + specialAddBytes;
    const specialQuotaBytes = Number(found.sub.special_quota_bytes || 0);

    if (planTier === 'free') {
      const freeQuotas = await getFreeQuotaSettings(env.DB, env.SENTRA_KV);
      if (mode === 'web_browsing' && nextWebBytes >= freeQuotas.webQuotaBytes) {
        return jsonResponse({
          action: 'disconnect',
          code: 'QUOTA_EXCEEDED',
          message: `سهمیه وبگردی پلن رایگان (${freeQuotas.webQuotaGb} گیگابایت) به پایان رسیده است.`,
        });
      }
      if (mode === 'download' && nextDlBytes >= freeQuotas.downloadQuotaBytes) {
        return jsonResponse({
          action: 'disconnect',
          code: 'QUOTA_EXCEEDED',
          message: `سهمیه دانلود پلن رایگان (${freeQuotas.downloadQuotaGb} گیگابایت) به پایان رسیده است.`,
        });
      }
    }

    if (
      (mode === 'static_ip' || mode === 'gaming') &&
      specialQuotaBytes > 0 &&
      nextSpecialBytes >= specialQuotaBytes
    ) {
      return jsonResponse({
        action: 'disconnect',
        code: 'SPECIAL_QUOTA_EXCEEDED',
        message: 'حجم بخش ویژه (آی‌پی ثابت / گیمینگ) شما به پایان رسیده است.',
      });
    }

    const totalUsed = found.sub.upload_bytes + found.sub.download_bytes + deltaBytes;
    const remaining =
      planTier === 'free'
        ? Math.max(0, found.sub.traffic_limit_bytes - totalUsed)
        : Math.max(0, specialQuotaBytes - nextSpecialBytes);

    return jsonResponse({
      action: 'continue',
      plan_tier: planTier,
      remaining_bytes: remaining,
      web_used_bytes: nextWebBytes,
      download_used_bytes: nextDlBytes,
      special_quota_bytes: specialQuotaBytes,
      special_used_bytes: nextSpecialBytes,
      web_browsing_used_mb: found.sub.web_browsing_used_mb + webAddMb,
      download_used_mb: found.sub.download_used_mb + dlAddMb,
      static_ip_used_mb: found.sub.static_ip_used_mb + staticAddMb,
      static_ip_remaining_mb: Math.max(
        0,
        (specialQuotaBytes > 0 ? Math.round(specialQuotaBytes / MIB_BYTES) : STATIC_IP_MONTHLY_QUOTA_MB) -
          Math.round(nextSpecialBytes / MIB_BYTES)
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

    const deviceId = (request.headers.get('X-Device-Id') || '').trim().slice(0, 128);

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

    let rawDevices = [...(devicesRes.results || [])];

    // Avoid unnecessary D1 writes: only upsert device_sessions if device is new or unseen for > 6 hours
    if (deviceId.length >= 4) {
      const existingDevice = rawDevices.find((d) => d.device_identifier === deviceId);
      const lastSeenMs = existingDevice ? Date.parse(existingDevice.last_seen_at) : 0;
      const needsDeviceWrite =
        !existingDevice ||
        !Number.isFinite(lastSeenMs) ||
        Date.now() - lastSeenMs > 6 * 60 * 60 * 1000;

      if (needsDeviceWrite) {
        const ua = (request.headers.get('User-Agent') || '').toLowerCase();
        const osName = ua.includes('android') ? 'android' : ua.includes('windows') ? 'windows' : 'client';
        const deviceName = osName === 'android' ? 'Android Device' : osName === 'windows' ? 'Windows PC' : 'Sentra Client';
        const nowIso = new Date().toISOString();
        try {
          await env.DB.prepare(
            `INSERT INTO device_sessions (subscription_id, device_identifier, device_name, os, is_active, last_seen_at)
             VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
             ON CONFLICT(subscription_id, device_identifier)
             DO UPDATE SET is_active = 1, last_seen_at = CURRENT_TIMESTAMP`
          )
            .bind(found.sub.id, deviceId, deviceName, osName)
            .run();

          if (!existingDevice) {
            rawDevices = [
              {
                id: rawDevices.length + 1,
                device_identifier: deviceId,
                device_name: deviceName,
                os: osName,
                last_seen_at: nowIso,
                created_at: nowIso,
              },
              ...rawDevices.filter((d) => d.device_identifier !== deviceId),
            ];
          } else {
            existingDevice.last_seen_at = nowIso;
          }
        } catch {
          // Non-fatal if concurrent upsert occurs
        }
      }
    }

    const activeDevices = rawDevices.map((d) => ({
      id: d.id,
      device_id: d.device_identifier,
      device_name: d.device_name,
      platform: d.os,
      last_active_at: d.last_seen_at,
      created_at: d.created_at,
    }));

    // Serve active outbounds + gaming status from L1 RAM / L2 KV cache (zero extra D1 reads)
    const pool = await getCachedActiveNodesPool(env.DB, env.SENTRA_KV);
    const outbounds = pool.donated.slice(0, 100).map((row) => ({
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
    const planTier = resolvePlanTier(found.sub);
    const isFree = planTier === 'free';
    const gamingLive = pool.hasActiveGaming;
    const freeQuotas = await getFreeQuotaSettings(env.DB, env.SENTRA_KV);
    const webUsedBytes = getEffectiveWebUsedBytes(found.sub);
    const dlUsedBytes = getEffectiveDownloadUsedBytes(found.sub);
    const specialQuotaBytes = Number(found.sub.special_quota_bytes || 0);
    const specialUsedBytes = getEffectiveSpecialUsedBytes(found.sub);
    const staticAccess = subscriptionCanAccessSpecialMode(found.sub, 'static_ip');
    const gamingAccess = subscriptionCanAccessSpecialMode(found.sub, 'gaming');

    const freeWebMb = Math.round(freeQuotas.webQuotaGb * 1024);
    const freeDlMb = Math.round(freeQuotas.downloadQuotaGb * 1024);
    const webUsedMb = Math.round(webUsedBytes / MIB_BYTES);
    const dlUsedMb = Math.round(dlUsedBytes / MIB_BYTES);
    const specialQuotaMb =
      specialQuotaBytes > 0 ? Math.round(specialQuotaBytes / MIB_BYTES) : STATIC_IP_MONTHLY_QUOTA_MB;
    const specialUsedMb = Math.round(specialUsedBytes / MIB_BYTES);

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
        plan_tier: planTier,
        connect_code: found.sub.connect_code || null,
        token: found.sub.token,
        status: found.sub.status,
        upload_bytes: found.sub.upload_bytes,
        download_bytes: found.sub.download_bytes,
        used_bytes: usedBytes,
        traffic_limit_bytes: found.sub.traffic_limit_bytes,
        remaining_bytes: remainingBytes,
        web_used_bytes: webUsedBytes,
        download_used_bytes: dlUsedBytes,
        special_quota_bytes: specialQuotaBytes,
        special_used_bytes: specialUsedBytes,
        has_used_special_trial: Number(found.sub.has_used_special_trial || 0) === 1,
        web_browsing_used_mb: webUsedMb,
        download_used_mb: dlUsedMb,
        static_ip_used_mb: specialUsedMb,
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
          status: isFree && webUsedBytes >= freeQuotas.webQuotaBytes ? 'depleted' : 'active',
          daily_limit_mb: isFree ? freeWebMb : 0,
          used_today_mb: webUsedMb,
          remaining_today_mb: isFree ? Math.max(0, freeWebMb - webUsedMb) : 0,
          description: 'مناسب وب‌گردی، تلگرام، اینستاگرام و شبکه‌های اجتماعی',
        },
        {
          id: 'download',
          name: 'دانلود و استریم',
          status: isFree && dlUsedBytes >= freeQuotas.downloadQuotaBytes ? 'depleted' : 'active',
          daily_limit_mb: isFree ? freeDlMb : 0,
          used_today_mb: dlUsedMb,
          remaining_today_mb: isFree ? Math.max(0, freeDlMb - dlUsedMb) : 0,
          description: 'پهنای باند بهینه برای دانلود فایل و تماشای ویدیو',
        },
        {
          id: 'gaming',
          name: 'گیمینگ',
          status: !gamingLive ? 'locked' : gamingAccess.allowed ? 'active' : 'locked',
          daily_limit_mb: specialQuotaMb,
          used_today_mb: specialUsedMb,
          remaining_today_mb: Math.max(0, specialQuotaMb - specialUsedMb),
          description: 'پینگ پایدار و بهینه برای بازی‌های آنلاین',
        },
        {
          id: 'static_ip',
          name: 'آی‌پی ثابت',
          status: staticAccess.allowed ? 'active' : 'locked',
          daily_limit_mb: specialQuotaMb,
          used_today_mb: specialUsedMb,
          remaining_today_mb: Math.max(0, specialQuotaMb - specialUsedMb),
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
         compiled_outbound_json, validation_error,
         latency_ms, assigned_tier, health_score, status, raw_link, fingerprint_sha256,
         is_official, label, country_code, country_name, allow_web, allow_download
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, 'web_browsing', 100, ?, ?, ?, ?, ?, ?, ?, 1, 1)`
    )
      .bind(
        found.user.id,
        label,
        parsed.protocol,
        parsed.server_address,
        parsed.server_port,
        parsed.compiled_outbound_json,
        parsed.compiled_outbound_json,
        status,
        parsed.raw_link,
        parsed.fingerprint_sha256,
        isOfficial,
        label,
        parsed.country_code,
        parsed.country_name
      )
      .run();

    if (status === 'active') {
      await invalidateNodesCache(env.DB, env.SENTRA_KV);
    }

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
