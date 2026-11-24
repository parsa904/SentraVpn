export const AUTO_RECONNECT_STORAGE_KEY = 'sentra_auto_reconnect_v1';
export const SLEEP_WAKE_GAP_MS = 15_000;
export const RECONNECT_DEBOUNCE_MS = 1_500;
export const RECONNECT_BASE_DELAY_MS = 1_500;
export const MAX_RECONNECT_ATTEMPTS = 3;

export type ReconnectReason = 'network_switch' | 'device_wake';

export interface NetworkConnectionSnapshot {
  type?: string;
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
}

export interface AutoReconnectDecisionParams {
  autoReconnectEnabled: boolean;
  userWantsConnected: boolean;
  isOnline: boolean;
  isAuthenticated: boolean;
  isReconnecting: boolean;
  attemptsUsed: number;
  maxAttempts?: number;
}

/**
 * Returns true when wall-clock time jumped forward significantly past the expected
 * heartbeat tick interval, indicating the OS/device woke from sleep or Doze.
 */
export function detectSleepWakeJump(
  lastTickMs: number,
  nowMs: number,
  thresholdMs: number = SLEEP_WAKE_GAP_MS
): boolean {
  if (!Number.isFinite(lastTickMs) || !Number.isFinite(nowMs)) return false;
  if (thresholdMs <= 0) return false;
  return nowMs - lastTickMs >= thresholdMs;
}

/**
 * Bounded exponential backoff schedule (1.5s -> 3s -> 6s -> capped at 12s).
 */
export function computeReconnectBackoffMs(
  attempt: number,
  baseDelayMs: number = RECONNECT_BASE_DELAY_MS
): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const safeBase = Math.max(250, baseDelayMs);
  return Math.min(safeBase * Math.pow(2, safeAttempt - 1), 12_000);
}

/**
 * Produces a stable network interface fingerprint from NetworkInformation API + online state
 * so Wi-Fi <-> Cellular <-> Ethernet switches or offline -> online recovery can be detected.
 */
export function buildNetworkFingerprint(
  conn?: NetworkConnectionSnapshot | null,
  online: boolean = true
): string {
  const state = online ? 'online' : 'offline';
  const type = (conn?.type || 'unknown').toLowerCase().trim();
  const effective = (conn?.effectiveType || 'unknown').toLowerCase().trim();
  return `${state}|${type}|${effective}`;
}

/**
 * Central pure gate determining whether Sentra should automatically re-establish
 * the VPN tunnel after a network change or wake-from-sleep trigger.
 */
export function shouldTriggerAutoReconnect(params: AutoReconnectDecisionParams): boolean {
  const limit = params.maxAttempts ?? MAX_RECONNECT_ATTEMPTS;
  if (!params.autoReconnectEnabled) return false;
  if (!params.userWantsConnected) return false;
  if (!params.isAuthenticated) return false;
  if (!params.isOnline) return false;
  if (params.isReconnecting) return false;
  if (params.attemptsUsed >= limit) return false;
  return true;
}

export function getInitialAutoReconnect(): boolean {
  try {
    const saved = localStorage.getItem(AUTO_RECONNECT_STORAGE_KEY);
    if (saved === 'false') return false;
    if (saved === 'true') return true;
  } catch {
    // ignore storage errors
  }
  return true;
}

export function persistAutoReconnect(enabled: boolean): void {
  try {
    localStorage.setItem(AUTO_RECONNECT_STORAGE_KEY, enabled ? 'true' : 'false');
  } catch {
    // ignore storage errors
  }
}

export const BATTERY_WARNING_DISMISSED_KEY = 'sentra_battery_opt_dismissed_v1';

export interface BatteryOptimizationStatus {
  isAndroid: boolean;
  isOptimized: boolean;
  canOpenSettings: boolean;
}

export interface BatteryWarningVisibilityParams {
  status: BatteryOptimizationStatus | null;
  autoReconnectEnabled: boolean;
  dismissed: boolean;
}

/**
 * Shows the Android battery optimization warning banner only on Android devices
 * where battery optimization is currently enabled, auto-reconnect is active,
 * and the user has not dismissed the banner.
 */
export function shouldShowBatteryOptimizationWarning(
  params: BatteryWarningVisibilityParams
): boolean {
  if (!params.status) return false;
  if (!params.status.isAndroid) return false;
  if (!params.status.isOptimized) return false;
  if (!params.autoReconnectEnabled) return false;
  if (params.dismissed) return false;
  return true;
}

export function getInitialBatteryWarningDismissed(): boolean {
  try {
    return localStorage.getItem(BATTERY_WARNING_DISMISSED_KEY) === 'true';
  } catch {
    return false;
  }
}

export function persistBatteryWarningDismissed(dismissed: boolean): void {
  try {
    if (dismissed) {
      localStorage.setItem(BATTERY_WARNING_DISMISSED_KEY, 'true');
    } else {
      localStorage.removeItem(BATTERY_WARNING_DISMISSED_KEY);
    }
  } catch {
    // ignore storage errors
  }
}
