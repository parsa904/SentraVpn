import fs from 'node:fs';
import path from 'node:path';

interface EnvCheckSpec {
  name: string;
  required: boolean;
  description: string;
  validate?: (value: string) => string | null;
}

const PLACEHOLDER_PATTERNS = [
  /^replace_with_/i,
  /^your_/i,
  /^changeme$/i,
  /^todo$/i,
  /^example/i,
  /^dummy/i,
  /^<.*>$/,
];

const MANDATORY_AND_RECOMMENDED_VARS: EnvCheckSpec[] = [
  {
    name: 'CLOUDFLARE_API_TOKEN',
    required: true,
    description: 'Cloudflare API token for D1 execution, Worker deploy, and secret sync',
  },
  {
    name: 'CLOUDFLARE_ACCOUNT_ID',
    required: true,
    description: 'Cloudflare Account ID owning sentra-core and sentra-db',
  },
  {
    name: 'TELEGRAM_BOT_TOKEN',
    required: true,
    description: 'Telegram Bot API token from BotFather',
    validate: (val) =>
      /^\d+:[A-Za-z0-9_-]{20,}$/.test(val)
        ? null
        : 'does not match expected Telegram Bot token format (<numeric_id>:<token>)',
  },
  {
    name: 'QUALITY_ENGINE_SECRET',
    required: true,
    description: 'Shared secret authenticating GitHub Actions QualityEngine endpoints',
    validate: (val) =>
      val.length >= 12 ? null : 'is too short (minimum 12 characters recommended)',
  },
  {
    name: 'TELEGRAM_WEBHOOK_SECRET',
    required: false,
    description: 'Secret token verified via X-Telegram-Bot-Api-Secret-Token header',
  },
];

const FORBIDDEN_PLAIN_VARS = new Set([
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_WEBHOOK_SECRET',
  'QUALITY_ENGINE_SECRET',
  'CLOUDFLARE_API_TOKEN',
]);

const REQUIRED_WRANGLER_VARS = ['BOT_USERNAME', 'PRO_SUBSCRIPTION_PRICE', 'PUBLIC_BASE_URL'];

const isGithubActions = process.env.GITHUB_ACTIONS === 'true';

function logError(message: string): void {
  if (isGithubActions) {
    console.error(`::error::${message}`);
  } else {
    console.error(`[ERROR] ${message}`);
  }
}

function logWarning(message: string): void {
  if (isGithubActions) {
    console.warn(`::warning::${message}`);
  } else {
    console.warn(`[WARN] ${message}`);
  }
}

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value.trim()));
}

function validateWranglerToml(wranglerPath: string): string[] {
  const errors: string[] = [];

  if (!fs.existsSync(wranglerPath)) {
    errors.push(`wrangler.toml not found at ${wranglerPath}`);
    return errors;
  }

  const content = fs.readFileSync(wranglerPath, 'utf8');
  const lines = content.split(/\r?\n/);

  let currentSection = '';
  const varsFound = new Map<string, string>();
  let databaseId = '';

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const sectionMatch = /^\[+([^\]]+)\]+$/.exec(line);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      continue;
    }

    const kvMatch = /^([A-Za-z0-9_]+)\s*=\s*"([^"]*)"/.exec(line);
    if (!kvMatch) continue;
    const [, key, value] = kvMatch;

    if (currentSection === 'vars') {
      varsFound.set(key, value);
    } else if (currentSection === 'd1_databases' && key === 'database_id') {
      databaseId = value.trim();
    }
  }

  if (!databaseId || isPlaceholder(databaseId)) {
    errors.push('cloudflare-worker/wrangler.toml has a missing or placeholder d1_databases.database_id');
  }

  for (const requiredVar of REQUIRED_WRANGLER_VARS) {
    const val = (varsFound.get(requiredVar) || '').trim();
    if (!val || isPlaceholder(val)) {
      errors.push(`cloudflare-worker/wrangler.toml [vars] is missing or has placeholder value for ${requiredVar}`);
    }
  }

  for (const forbidden of FORBIDDEN_PLAIN_VARS) {
    if (varsFound.has(forbidden)) {
      errors.push(
        `cloudflare-worker/wrangler.toml [vars] must NOT contain secret key ${forbidden}; configure it as a Worker Secret instead`
      );
    }
  }

  return errors;
}

function main(): void {
  const errors: string[] = [];
  const warnings: string[] = [];

  console.log('[verify-env] Validating Cloudflare Worker deployment environment...');

  for (const spec of MANDATORY_AND_RECOMMENDED_VARS) {
    const raw = process.env[spec.name];
    const value = (raw || '').trim();

    if (!value) {
      const msg = `Missing ${spec.required ? 'mandatory' : 'recommended'} variable ${spec.name} (${spec.description}).`;
      if (spec.required) {
        errors.push(msg);
      } else {
        warnings.push(msg);
      }
      continue;
    }

    if (isPlaceholder(value)) {
      const msg = `Variable ${spec.name} appears to contain a placeholder value.`;
      if (spec.required) {
        errors.push(msg);
      } else {
        warnings.push(msg);
      }
      continue;
    }

    if (spec.validate) {
      const validationIssue = spec.validate(value);
      if (validationIssue) {
        errors.push(`Invalid ${spec.name}: ${validationIssue}.`);
        continue;
      }
    }

    console.log(`  [OK] ${spec.name} is set`);
  }

  const wranglerPath = path.resolve(process.cwd(), 'cloudflare-worker', 'wrangler.toml');
  const wranglerErrors = validateWranglerToml(wranglerPath);
  if (wranglerErrors.length === 0) {
    console.log('  [OK] cloudflare-worker/wrangler.toml [vars] and D1 binding verified');
  } else {
    errors.push(...wranglerErrors);
  }

  for (const warn of warnings) {
    logWarning(warn);
  }

  if (errors.length > 0) {
    for (const err of errors) {
      logError(err);
    }
    console.error(
      `[verify-env] Environment verification failed with ${errors.length} error(s). Aborting deployment.`
    );
    process.exit(1);
  }

  console.log('[verify-env] All mandatory Worker environment variables and config checks passed.');
}

main();
