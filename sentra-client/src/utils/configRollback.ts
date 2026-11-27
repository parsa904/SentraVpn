import { detectClientPlatform, reportClientRollbackError, sanitizeClientSecrets } from './errorReporter';
import { APP_VERSION } from './proxyParser';

export const LAST_KNOWN_GOOD_CONFIG_FILE = 'last_known_good_config.json' as const;
export const CANDIDATE_CONFIG_FILE = 'candidate_config.json' as const;
export const DEFAULT_STABILITY_WINDOW_MS = 5_000;

export interface ConfigFileStore {
  read(filename: string): string | null;
  write(filename: string, content: string): void;
  remove(filename: string): void;
}

export function createBrowserConfigStore(): ConfigFileStore {
  const prefix = 'sentra_cfg_file:';
  return {
    read(filename: string): string | null {
      try {
        if (typeof localStorage === 'undefined') return null;
        return localStorage.getItem(`${prefix}${filename}`);
      } catch {
        return null;
      }
    },
    write(filename: string, content: string): void {
      try {
        if (typeof localStorage === 'undefined') return;
        localStorage.setItem(`${prefix}${filename}`, content);
      } catch {
        // Ignore quota errors
      }
    },
    remove(filename: string): void {
      try {
        if (typeof localStorage === 'undefined') return;
        localStorage.removeItem(`${prefix}${filename}`);
      } catch {
        // Ignore storage errors
      }
    },
  };
}

export function createMemoryConfigStore(): ConfigFileStore {
  const files = new Map<string, string>();
  return {
    read: (filename) => files.get(filename) ?? null,
    write: (filename, content) => {
      files.set(filename, content);
    },
    remove: (filename) => {
      files.delete(filename);
    },
  };
}

export interface CandidateValidationResult {
  valid: boolean;
  error: string | null;
  concreteOutboundCount: number;
}

const META_OUTBOUND_TYPES = new Set(['selector', 'urltest', 'direct', 'block', 'dns']);

/**
 * Validates raw JSON text (or parsed object) of a candidate sing-box 1.14+ config
 * before launching the core: verifies valid JSON, required top-level sections
 * (`inbounds`, `outbounds`, `route`), and presence of concrete proxy outbounds.
 */
export function validateCandidateSingboxJson(
  rawJsonOrObj: string | Record<string, unknown>
): CandidateValidationResult {
  let obj: Record<string, unknown>;
  if (typeof rawJsonOrObj === 'string') {
    if (!rawJsonOrObj.trim()) {
      return { valid: false, error: 'فایل candidate_config.json خالی است.', concreteOutboundCount: 0 };
    }
    try {
      const parsed = JSON.parse(rawJsonOrObj);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
          valid: false,
          error: 'ساختار ریشه candidate_config.json باید آبجکت JSON باشد.',
          concreteOutboundCount: 0,
        };
      }
      obj = parsed as Record<string, unknown>;
    } catch (err) {
      return {
        valid: false,
        error: `خطای نحوی JSON در candidate_config.json: ${err instanceof Error ? err.message : String(err)}`,
        concreteOutboundCount: 0,
      };
    }
  } else if (rawJsonOrObj && typeof rawJsonOrObj === 'object' && !Array.isArray(rawJsonOrObj)) {
    obj = rawJsonOrObj;
  } else {
    return {
      valid: false,
      error: 'پیکربندی نامعتبر است.',
      concreteOutboundCount: 0,
    };
  }

  if (!Array.isArray(obj.inbounds) || obj.inbounds.length === 0) {
    return {
      valid: false,
      error: 'بخش الزامی inbounds در کانفیگ sing-box یافت نشد یا خالی است.',
      concreteOutboundCount: 0,
    };
  }

  if (!Array.isArray(obj.outbounds) || obj.outbounds.length === 0) {
    return {
      valid: false,
      error: 'بخش الزامی outbounds در کانفیگ sing-box یافت نشد یا خالی است.',
      concreteOutboundCount: 0,
    };
  }

  if (!obj.route || typeof obj.route !== 'object' || Array.isArray(obj.route)) {
    return {
      valid: false,
      error: 'بخش الزامی route در کانفیگ sing-box یافت نشد.',
      concreteOutboundCount: 0,
    };
  }

  const outbounds = obj.outbounds as Array<Record<string, unknown>>;
  let concreteCount = 0;
  let hasDirect = false;
  for (const ob of outbounds) {
    if (!ob || typeof ob !== 'object') continue;
    const t = String(ob.type || '').trim().toLowerCase();
    if (!t) continue;
    if (t === 'direct') hasDirect = true;
    if (!META_OUTBOUND_TYPES.has(t)) {
      concreteCount += 1;
    }
  }

  if (concreteCount === 0 && !hasDirect) {
    return {
      valid: false,
      error: 'هیچ نود اوتباند معتبری در candidate_config.json وجود ندارد.',
      concreteOutboundCount: 0,
    };
  }

  return {
    valid: true,
    error: null,
    concreteOutboundCount: concreteCount,
  };
}

export interface ApplyCandidateOptions {
  candidateJson: string;
  checkConfig?: (configJson: string) => Promise<{ ok: boolean; error?: string | null }>;
  startCore: (configJson: string, filename: string) => Promise<void>;
  isCoreAlive: () => Promise<boolean> | boolean;
  stopCore?: () => Promise<void>;
  stabilityWindowMs?: number;
  pollIntervalMs?: number;
  onRollback?: (info: {
    singboxError: string;
    rolledBackToGoodConfig: boolean;
    platform: 'android' | 'windows';
    appVersion: string;
  }) => Promise<void> | void;
}

export interface ApplyCandidateResult {
  status: 'promoted' | 'rolled_back' | 'failed_no_fallback';
  activeConfigFile: typeof LAST_KNOWN_GOOD_CONFIG_FILE | typeof CANDIDATE_CONFIG_FILE | null;
  error: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Dual-file Auto-Rollback manager (`last_known_good_config.json` & `candidate_config.json`).
 *
 * Flow:
 * 1. Saves incoming config to `candidate_config.json` (never overwrites `last_known_good_config.json` first).
 * 2. Pre-validates JSON structure (`inbounds`, `outbounds`, `route`) and optional `sing-box check`.
 * 3. Starts core with `candidate_config.json` and monitors stability for `stabilityWindowMs` (default 5s).
 * 4. If validation, launch, or the first 5s stability check fails -> automatically rolls back to
 *    `last_known_good_config.json` without outage and transmits sanitized error to Sentry + `/api/v1/logs/report`.
 * 5. Promotes `candidate_config.json` -> `last_known_good_config.json` ONLY after 5s of stable execution.
 */
export class ConfigRollbackManager {
  private readonly store: ConfigFileStore;

  constructor(store: ConfigFileStore = createBrowserConfigStore()) {
    this.store = store;
  }

  public getLastKnownGoodConfig(): string | null {
    return this.store.read(LAST_KNOWN_GOOD_CONFIG_FILE);
  }

  public getCandidateConfig(): string | null {
    return this.store.read(CANDIDATE_CONFIG_FILE);
  }

  public seedLastKnownGoodConfig(configJson: string): void {
    this.store.write(LAST_KNOWN_GOOD_CONFIG_FILE, configJson);
  }

  public async applyCandidateWithRollback(
    options: ApplyCandidateOptions
  ): Promise<ApplyCandidateResult> {
    const stabilityWindowMs = options.stabilityWindowMs ?? DEFAULT_STABILITY_WINDOW_MS;
    const pollIntervalMs = Math.max(
      10,
      Math.min(options.pollIntervalMs ?? 250, Math.max(10, stabilityWindowMs))
    );

    // 1. Always stage into candidate_config.json first
    this.store.write(CANDIDATE_CONFIG_FILE, options.candidateJson);

    const handleFailureAndRollback = async (rawError: string): Promise<ApplyCandidateResult> => {
      const sanitizedErr = sanitizeClientSecrets(rawError || 'Unknown sing-box startup error');
      const platform = detectClientPlatform();

      if (options.stopCore) {
        await options.stopCore().catch(() => undefined);
      }

      const lastGood = this.store.read(LAST_KNOWN_GOOD_CONFIG_FILE);
      let rolledBack = false;

      if (lastGood && validateCandidateSingboxJson(lastGood).valid) {
        try {
          await options.startCore(lastGood, LAST_KNOWN_GOOD_CONFIG_FILE);
          rolledBack = true;
        } catch {
          rolledBack = false;
        }
      }

      if (options.onRollback) {
        await options.onRollback({
          singboxError: sanitizedErr,
          rolledBackToGoodConfig: rolledBack,
          platform,
          appVersion: APP_VERSION,
        });
      } else {
        await reportClientRollbackError({
          singboxError: sanitizedErr,
          rolledBackToGoodConfig: rolledBack,
          context: {
            candidate_staged: true,
            fallback_available: Boolean(lastGood),
          },
        });
      }

      if (rolledBack) {
        return {
          status: 'rolled_back',
          activeConfigFile: LAST_KNOWN_GOOD_CONFIG_FILE,
          error: sanitizedErr,
        };
      }

      return {
        status: 'failed_no_fallback',
        activeConfigFile: null,
        error: sanitizedErr,
      };
    };

    // 2. Pre-validate JSON structure before starting core
    const structural = validateCandidateSingboxJson(options.candidateJson);
    if (!structural.valid) {
      return handleFailureAndRollback(structural.error || 'Candidate config structure invalid');
    }

    // 3. Optional `sing-box check -c candidate_config.json` / `Libbox.checkConfig`
    if (options.checkConfig) {
      try {
        const checkRes = await options.checkConfig(options.candidateJson);
        if (!checkRes.ok) {
          return handleFailureAndRollback(
            checkRes.error || 'sing-box check failed for candidate_config.json'
          );
        }
      } catch (err) {
        return handleFailureAndRollback(
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    // 4. Launch core with candidate_config.json
    try {
      await options.startCore(options.candidateJson, CANDIDATE_CONFIG_FILE);
    } catch (err) {
      return handleFailureAndRollback(
        err instanceof Error ? err.message : String(err)
      );
    }

    // 5. Monitor core health for the full stability window (default 5 seconds)
    const deadline = Date.now() + stabilityWindowMs;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      await sleep(Math.min(pollIntervalMs, Math.max(1, remaining)));
      const alive = await options.isCoreAlive();
      if (!alive) {
        return handleFailureAndRollback(
          `sing-box exited/crashed within first ${Math.round(stabilityWindowMs / 1000)}s of candidate_config.json launch`
        );
      }
    }

    const finalAlive = await options.isCoreAlive();
    if (!finalAlive) {
      return handleFailureAndRollback(
        `sing-box crashed at end of ${Math.round(stabilityWindowMs / 1000)}s stability window`
      );
    }

    // 6. Core stayed healthy -> atomically promote candidate -> last_known_good_config.json
    this.store.write(LAST_KNOWN_GOOD_CONFIG_FILE, options.candidateJson);
    return {
      status: 'promoted',
      activeConfigFile: LAST_KNOWN_GOOD_CONFIG_FILE,
      error: null,
    };
  }
}
