export const SESSION_TIMER_STORAGE_KEY = 'sentra_session_timer_v1';

export interface PersistedSessionTimer {
  /** Total accumulated whole seconds from prior active segments in this connection session. */
  accumulatedSeconds: number;
  /** Epoch ms when the currently running connected segment started, or null if paused/stopped. */
  activeSegmentStartedAtMs: number | null;
  /** Epoch ms when the overall connection session first began, or null if never started. */
  sessionStartedAtMs: number | null;
  /** Whether the session is currently active or temporarily paused for auto-reconnect. */
  isActive: boolean;
}

export const EMPTY_SESSION_TIMER: PersistedSessionTimer = {
  accumulatedSeconds: 0,
  activeSegmentStartedAtMs: null,
  sessionStartedAtMs: null,
  isActive: false,
};

function sanitizeNonNegativeInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function sanitizeTimestamp(value: unknown, maxMs?: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  if (maxMs !== undefined && value > maxMs + 60_000) return null;
  return Math.floor(value);
}

/**
 * Computes the real-time total accumulated seconds for the current session at `nowMs`.
 */
export function computeSessionDurationSeconds(
  state: PersistedSessionTimer,
  nowMs: number
): number {
  const base = sanitizeNonNegativeInt(state.accumulatedSeconds);
  if (state.activeSegmentStartedAtMs === null) {
    return base;
  }
  const elapsedMs = Math.max(0, nowMs - state.activeSegmentStartedAtMs);
  return base + Math.floor(elapsedMs / 1000);
}

/**
 * Starts a new connection session or resumes an active session that was paused
 * during a transient network switch / auto-reconnect.
 */
export function startOrResumeSessionTimer(
  state: PersistedSessionTimer,
  nowMs: number,
  nativeUptimeSeconds = 0
): PersistedSessionTimer {
  const safeNative = sanitizeNonNegativeInt(nativeUptimeSeconds);

  // Already running — preserve continuity and reconcile if native daemon uptime is ahead
  if (state.isActive && state.activeSegmentStartedAtMs !== null) {
    const currentTotal = computeSessionDurationSeconds(state, nowMs);
    if (safeNative > currentTotal + 2 && state.accumulatedSeconds === 0) {
      const anchoredStart = Math.max(1, nowMs - safeNative * 1000);
      return {
        accumulatedSeconds: 0,
        activeSegmentStartedAtMs: anchoredStart,
        sessionStartedAtMs: state.sessionStartedAtMs
          ? Math.min(state.sessionStartedAtMs, anchoredStart)
          : anchoredStart,
        isActive: true,
      };
    }
    return state;
  }

  // Resuming an active session paused during auto-reconnect
  if (state.isActive && state.activeSegmentStartedAtMs === null) {
    return {
      accumulatedSeconds: sanitizeNonNegativeInt(state.accumulatedSeconds),
      activeSegmentStartedAtMs: nowMs,
      sessionStartedAtMs: state.sessionStartedAtMs ?? nowMs,
      isActive: true,
    };
  }

  // Starting a brand-new connection session
  const anchoredStart = safeNative > 0 ? Math.max(1, nowMs - safeNative * 1000) : nowMs;
  return {
    accumulatedSeconds: 0,
    activeSegmentStartedAtMs: anchoredStart,
    sessionStartedAtMs: anchoredStart,
    isActive: true,
  };
}

/**
 * Reconciles timer state with real native tunnel `uptime_seconds` telemetry
 * (e.g., when opening the UI while a background VPN daemon is already running).
 */
export function reconcileWithNativeUptime(
  state: PersistedSessionTimer,
  nativeUptimeSeconds: number,
  nowMs: number
): PersistedSessionTimer {
  const safeNative = sanitizeNonNegativeInt(nativeUptimeSeconds);
  if (safeNative <= 0) return state;

  if (!state.isActive || state.activeSegmentStartedAtMs === null) {
    const anchoredStart = Math.max(1, nowMs - safeNative * 1000);
    return {
      accumulatedSeconds: state.isActive ? sanitizeNonNegativeInt(state.accumulatedSeconds) : 0,
      activeSegmentStartedAtMs: anchoredStart,
      sessionStartedAtMs:
        state.isActive && state.sessionStartedAtMs
          ? Math.min(state.sessionStartedAtMs, anchoredStart)
          : anchoredStart,
      isActive: true,
    };
  }

  const currentTotal = computeSessionDurationSeconds(state, nowMs);
  if (safeNative > currentTotal + 2 && state.accumulatedSeconds === 0) {
    const anchoredStart = Math.max(1, nowMs - safeNative * 1000);
    return {
      ...state,
      activeSegmentStartedAtMs: anchoredStart,
      sessionStartedAtMs: state.sessionStartedAtMs
        ? Math.min(state.sessionStartedAtMs, anchoredStart)
        : anchoredStart,
    };
  }

  return state;
}

/**
 * Banks elapsed time and pauses the active segment without ending the session
 * (used during network-switch or sleep-wake auto-reconnects).
 */
export function pauseSessionTimer(
  state: PersistedSessionTimer,
  nowMs: number
): PersistedSessionTimer {
  if (!state.isActive || state.activeSegmentStartedAtMs === null) {
    return state;
  }
  return {
    accumulatedSeconds: computeSessionDurationSeconds(state, nowMs),
    activeSegmentStartedAtMs: null,
    sessionStartedAtMs: state.sessionStartedAtMs ?? state.activeSegmentStartedAtMs,
    isActive: true,
  };
}

/**
 * Finalizes the current connection session upon disconnect, preserving the
 * final accumulated duration as a usage insight until the next session begins.
 */
export function stopSessionTimer(
  state: PersistedSessionTimer,
  nowMs: number
): PersistedSessionTimer {
  const total = computeSessionDurationSeconds(state, nowMs);
  if (total === 0 && !state.isActive && state.activeSegmentStartedAtMs === null) {
    return state;
  }
  return {
    accumulatedSeconds: total,
    activeSegmentStartedAtMs: null,
    sessionStartedAtMs: state.sessionStartedAtMs,
    isActive: false,
  };
}

export function serializeSessionTimer(state: PersistedSessionTimer): string {
  return JSON.stringify({
    accumulatedSeconds: sanitizeNonNegativeInt(state.accumulatedSeconds),
    activeSegmentStartedAtMs: sanitizeTimestamp(state.activeSegmentStartedAtMs),
    sessionStartedAtMs: sanitizeTimestamp(state.sessionStartedAtMs),
    isActive: Boolean(state.isActive),
  });
}

export function parseSessionTimer(raw: string | null, nowMs = Date.now()): PersistedSessionTimer {
  if (!raw) return EMPTY_SESSION_TIMER;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedSessionTimer>;
    if (!parsed || typeof parsed !== 'object') return EMPTY_SESSION_TIMER;
    const accumulatedSeconds = sanitizeNonNegativeInt(parsed.accumulatedSeconds);
    const activeSegmentStartedAtMs = sanitizeTimestamp(parsed.activeSegmentStartedAtMs, nowMs);
    const sessionStartedAtMs = sanitizeTimestamp(parsed.sessionStartedAtMs, nowMs);
    const isActive = Boolean(parsed.isActive);
    return {
      accumulatedSeconds,
      activeSegmentStartedAtMs: isActive ? activeSegmentStartedAtMs : null,
      sessionStartedAtMs,
      isActive,
    };
  } catch {
    return EMPTY_SESSION_TIMER;
  }
}

export function loadPersistedSessionTimer(nowMs = Date.now()): PersistedSessionTimer {
  try {
    if (typeof localStorage === 'undefined') return EMPTY_SESSION_TIMER;
    return parseSessionTimer(localStorage.getItem(SESSION_TIMER_STORAGE_KEY), nowMs);
  } catch {
    return EMPTY_SESSION_TIMER;
  }
}

export function savePersistedSessionTimer(state: PersistedSessionTimer): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(SESSION_TIMER_STORAGE_KEY, serializeSessionTimer(state));
  } catch {
    // ignore storage quota errors
  }
}

export function clearPersistedSessionTimer(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(SESSION_TIMER_STORAGE_KEY);
  } catch {
    // ignore storage errors
  }
}
