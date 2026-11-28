#!/usr/bin/env node
/**
 * SentraVPN CI Build Failure Reporter (AI-Ready)
 *
 * Executed on `if: failure()` in `.github/workflows/release-clients.yml` for
 * `android-build`, `windows-build`, `health-checks`, and `release-publish`.
 *
 * Delivery priority:
 *  1. Sentra Worker `/api/v1/errors/report` (with `X-Quality-Secret`) -> routes
 *     automatically to the D1-configured Telegram Logs Topic + Sentry + Turso.
 *  2. Direct Telegram Bot API fallback (`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`,
 *     with optional `TELEGRAM_LOG_TOPIC_ID`) if Worker reporting is unavailable or
 *     `QUALITY_ENGINE_SECRET` is not configured.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';

const BUILD_PLATFORM = (process.env.BUILD_PLATFORM || 'github-actions').trim();
const STEP_TRACKER_FILE = (process.env.STEP_TRACKER_FILE || '').trim();
const BUILD_LOG_FILE = (process.env.BUILD_LOG_FILE || '').trim();
const RELEASE_TAG = (process.env.RELEASE_TAG || process.env.APP_VERSION || 'unknown').trim();
const GITHUB_SHA = (process.env.GITHUB_SHA || '').trim();
const GITHUB_REF_NAME = (process.env.GITHUB_REF_NAME || '').trim();
const GITHUB_REPOSITORY = (process.env.GITHUB_REPOSITORY || '').trim();
const GITHUB_RUN_ID = (process.env.GITHUB_RUN_ID || '').trim();
const GITHUB_SERVER_URL = (process.env.GITHUB_SERVER_URL || 'https://github.com').trim();

const SENTRA_WORKER_URL = (
  process.env.SENTRA_WORKER_URL || 'https://sentra-core.kziepr.workers.dev'
)
  .trim()
  .replace(/\/+$/, '');
const QUALITY_ENGINE_SECRET = (process.env.QUALITY_ENGINE_SECRET || '').trim();
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TELEGRAM_CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim();
const TELEGRAM_LOG_TOPIC_ID = (process.env.TELEGRAM_LOG_TOPIC_ID || '').trim();

function escapeHtml(input) {
  return String(input || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function scrubSecrets(text) {
  let out = String(text || '');
  const runtimeSecrets = [
    QUALITY_ENGINE_SECRET,
    TELEGRAM_BOT_TOKEN,
    process.env.GH_TOKEN || '',
    process.env.GITHUB_TOKEN || '',
    process.env.ANDROID_KEYSTORE_PASSWORD || '',
    process.env.ANDROID_KEY_PASSWORD || '',
    process.env.SENTRY_DSN_CLIENT || '',
  ].filter((s) => typeof s === 'string' && s.trim().length >= 6);

  for (const secret of runtimeSecrets.sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join('[REDACTED]');
  }

  out = out.replace(/\bbot\d{6,14}:[A-Za-z0-9_-]{20,}\b/g, 'bot[REDACTED]');
  out = out.replace(/\b\d{6,14}:[A-Za-z0-9_-]{20,}\b/g, '[REDACTED]');
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]');
  out = out.replace(/(storePassword|keyPassword)\s*=\s*\S+/gi, '$1=[REDACTED]');
  return out;
}

function getLastCommitSummary() {
  const shortSha = GITHUB_SHA ? GITHUB_SHA.slice(0, 8) : 'unknown';
  try {
    const subject = execSync('git log -1 --pretty=%s', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
      .replace(/[\r\n]+/g, ' ')
      .slice(0, 140);
    return subject ? `${shortSha} - ${subject}` : shortSha;
  } catch {
    return shortSha;
  }
}

function readFailedStep() {
  if (STEP_TRACKER_FILE && fs.existsSync(STEP_TRACKER_FILE)) {
    try {
      const content = fs.readFileSync(STEP_TRACKER_FILE, 'utf8').trim();
      if (content) return content.slice(0, 160);
    } catch {
      // ignore read errors
    }
  }
  return process.env.FAILED_STEP || `${BUILD_PLATFORM} step`;
}

function readBuildLogTail() {
  if (!BUILD_LOG_FILE || !fs.existsSync(BUILD_LOG_FILE)) {
    return 'No captured build log file found; inspect GitHub Actions run logs via run_url.';
  }
  try {
    const raw = fs.readFileSync(BUILD_LOG_FILE, 'utf8');
    const lines = raw
      .split(/\r?\n/)
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0);
    const tail = lines.slice(-45).join('\n');
    const cleaned = scrubSecrets(tail);
    return cleaned.length > 1700 ? `...\n${cleaned.slice(-1700)}` : cleaned;
  } catch (err) {
    return `Failed to read build log file: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function buildAiReadyBlock({ failedStep, commitSummary, runUrl, logTail, timestamp }) {
  return [
    '=== SENTRAVPN ERROR REPORT (AI-READY) ===',
    `platform: ${BUILD_PLATFORM}`,
    `appVersion: ${RELEASE_TAG}`,
    `timestamp: ${timestamp}`,
    `moduleOrFile: .github/workflows/release-clients.yml (${BUILD_PLATFORM})`,
    `actionOrRoute: ${failedStep}`,
    'errorName: ClientBuildFailure',
    `errorMessage: Build job "${BUILD_PLATFORM}" failed at step "${failedStep}"`,
    'context:',
    `  build_platform: ${BUILD_PLATFORM}`,
    `  failed_step: ${failedStep}`,
    `  commit: ${commitSummary}`,
    `  ref: ${GITHUB_REF_NAME || 'unknown'}`,
    `  run_url: ${runUrl}`,
    'stackTrace:',
    logTail,
  ].join('\n');
}

async function sendViaWorker({ failedStep, commitSummary, runUrl, logTail, timestamp }) {
  if (!QUALITY_ENGINE_SECRET || !SENTRA_WORKER_URL) {
    return false;
  }

  const primaryPlatform =
    BUILD_PLATFORM === 'android-build' || BUILD_PLATFORM === 'windows-build'
      ? BUILD_PLATFORM
      : 'github-actions';
  const candidatePlatforms =
    primaryPlatform === 'github-actions'
      ? ['github-actions']
      : [primaryPlatform, 'github-actions'];

  for (const platform of candidatePlatforms) {
    const payload = {
      platform,
      appVersion: RELEASE_TAG,
      timestamp,
      moduleOrFile: `.github/workflows/release-clients.yml (${BUILD_PLATFORM})`,
      actionOrRoute: `${BUILD_PLATFORM} :: ${failedStep}`,
      errorName: `${BUILD_PLATFORM}_FAILURE`,
      errorMessage: `Build failed on ${BUILD_PLATFORM} during step "${failedStep}"`,
      stackTrace: logTail,
      context: {
        build_platform: BUILD_PLATFORM,
        failed_step: failedStep,
        commit: commitSummary,
        ref: GITHUB_REF_NAME || 'unknown',
        run_url: runUrl,
      },
    };

    try {
      const resp = await fetch(`${SENTRA_WORKER_URL}/api/v1/errors/report`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Quality-Secret': QUALITY_ENGINE_SECRET,
        },
        body: JSON.stringify(payload),
      });
      if (resp.ok) {
        console.log(
          `[BuildErrorReporter] Reported ${BUILD_PLATFORM} failure to Sentra Worker logs topic (platform=${platform}).`
        );
        return true;
      }
      if (resp.status === 400 && platform !== 'github-actions') {
        console.warn(
          `[BuildErrorReporter] Worker rejected platform="${platform}" with HTTP 400; retrying with "github-actions".`
        );
        continue;
      }
      console.warn(
        `[BuildErrorReporter] Worker error endpoint returned HTTP ${resp.status}; trying Telegram fallback.`
      );
      return false;
    } catch (err) {
      console.warn(
        `[BuildErrorReporter] Worker request failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    }
  }

  return false;
}

async function sendDirectTelegram({ failedStep, aiBlock }) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn(
      '[BuildErrorReporter] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not configured; skipping direct Telegram alert.'
    );
    return false;
  }

  const header =
    `🚨 <b>گزارش خطای بیلد SentraVPN</b> | ⚙️ <code>${escapeHtml(BUILD_PLATFORM)}</code>\n` +
    `📌 <b>مرحله ناموفق:</b> <code>${escapeHtml(failedStep)}</code>\n` +
    `📋 <i>برای دیباگ مستقیم در AI Studio روی کادر زیر ضربه بزنید تا کپی شود:</i>\n\n`;

  const maxCodeLen = Math.max(400, 3900 - header.length - '<pre><code></code></pre>'.length);
  let escapedBody = escapeHtml(aiBlock);
  if (escapedBody.length > maxCodeLen) {
    escapedBody = `${escapeHtml(aiBlock.slice(0, Math.floor(maxCodeLen * 0.8)))}\n...[truncated]`;
  }

  const body = {
    chat_id: TELEGRAM_CHAT_ID,
    text: `${header}<pre><code>${escapedBody}</code></pre>`,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (TELEGRAM_LOG_TOPIC_ID && /^\d+$/.test(TELEGRAM_LOG_TOPIC_ID)) {
    body.message_thread_id = Number(TELEGRAM_LOG_TOPIC_ID);
  }

  try {
    const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (resp.ok) {
      console.log(`[BuildErrorReporter] Sent AI-ready ${BUILD_PLATFORM} failure report directly to Telegram.`);
      return true;
    }
    console.warn(`[BuildErrorReporter] Telegram sendMessage returned HTTP ${resp.status}.`);
    return false;
  } catch (err) {
    console.warn(
      `[BuildErrorReporter] Telegram fallback failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
}

async function main() {
  const timestamp = new Date().toISOString();
  const failedStep = readFailedStep();
  const commitSummary = getLastCommitSummary();
  const runUrl =
    GITHUB_REPOSITORY && GITHUB_RUN_ID
      ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
      : 'unavailable';
  const logTail = readBuildLogTail();
  const aiBlock = buildAiReadyBlock({ failedStep, commitSummary, runUrl, logTail, timestamp });

  console.log('\n' + aiBlock + '\n');

  const deliveredByWorker = await sendViaWorker({
    failedStep,
    commitSummary,
    runUrl,
    logTail,
    timestamp,
  });

  if (!deliveredByWorker) {
    await sendDirectTelegram({ failedStep, aiBlock });
  }
}

main().catch((err) => {
  console.warn('[BuildErrorReporter] Non-fatal reporter error:', err);
});
