import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_SESSION_TIMER,
  computeSessionDurationSeconds,
  parseSessionTimer,
  pauseSessionTimer,
  reconcileWithNativeUptime,
  serializeSessionTimer,
  startOrResumeSessionTimer,
  stopSessionTimer,
} from './sessionTimer';

test('startOrResumeSessionTimer accumulates real-time seconds cleanly', () => {
  const t0 = 1_700_000_000_000;
  const started = startOrResumeSessionTimer(EMPTY_SESSION_TIMER, t0);
  assert.equal(started.isActive, true);
  assert.equal(started.activeSegmentStartedAtMs, t0);
  assert.equal(computeSessionDurationSeconds(started, t0), 0);
  assert.equal(computeSessionDurationSeconds(started, t0 + 65_400), 65);
});

test('pauseSessionTimer and resume preserve accumulated session time across auto-reconnect', () => {
  const t0 = 1_700_000_000_000;
  const started = startOrResumeSessionTimer(EMPTY_SESSION_TIMER, t0);

  // Connected for 120 seconds, then pauses during network switch
  const paused = pauseSessionTimer(started, t0 + 120_000);
  assert.equal(paused.isActive, true);
  assert.equal(paused.activeSegmentStartedAtMs, null);
  assert.equal(paused.accumulatedSeconds, 120);
  assert.equal(computeSessionDurationSeconds(paused, t0 + 135_000), 120);

  // Reconnects 15 seconds later and continues accumulating
  const resumed = startOrResumeSessionTimer(paused, t0 + 135_000);
  assert.equal(resumed.isActive, true);
  assert.equal(resumed.accumulatedSeconds, 120);
  assert.equal(resumed.sessionStartedAtMs, t0);
  assert.equal(computeSessionDurationSeconds(resumed, t0 + 165_000), 150);
});

test('stopSessionTimer freezes final accumulated duration and next session starts fresh', () => {
  const t0 = 1_700_000_000_000;
  const started = startOrResumeSessionTimer(EMPTY_SESSION_TIMER, t0);
  const stopped = stopSessionTimer(started, t0 + 305_000);

  assert.equal(stopped.isActive, false);
  assert.equal(stopped.activeSegmentStartedAtMs, null);
  assert.equal(computeSessionDurationSeconds(stopped, t0 + 500_000), 305);

  // Starting a brand-new session resets accumulated seconds to 0
  const fresh = startOrResumeSessionTimer(stopped, t0 + 500_000);
  assert.equal(fresh.isActive, true);
  assert.equal(fresh.accumulatedSeconds, 0);
  assert.equal(computeSessionDurationSeconds(fresh, t0 + 504_000), 4);
});

test('reconcileWithNativeUptime adopts live uptime from an already-running daemon', () => {
  const now = 1_700_000_600_000;
  const reconciled = reconcileWithNativeUptime(EMPTY_SESSION_TIMER, 185, now);
  assert.equal(reconciled.isActive, true);
  assert.equal(computeSessionDurationSeconds(reconciled, now), 185);
  assert.equal(computeSessionDurationSeconds(reconciled, now + 10_000), 195);
});

test('serializeSessionTimer and parseSessionTimer round-trip and sanitize invalid payloads', () => {
  const now = 1_700_000_500_000;
  const active = startOrResumeSessionTimer(EMPTY_SESSION_TIMER, now - 42_000);
  const restored = parseSessionTimer(serializeSessionTimer(active), now);

  assert.equal(restored.isActive, true);
  assert.equal(computeSessionDurationSeconds(restored, now), 42);

  // Corrupted or future-dated payloads are safely sanitized
  assert.deepEqual(parseSessionTimer('{invalid json', now), EMPTY_SESSION_TIMER);
  const futureCorrupt = parseSessionTimer(
    JSON.stringify({
      accumulatedSeconds: -50,
      activeSegmentStartedAtMs: now + 999_999,
      sessionStartedAtMs: -1,
      isActive: true,
    }),
    now
  );
  assert.equal(futureCorrupt.accumulatedSeconds, 0);
  assert.equal(futureCorrupt.activeSegmentStartedAtMs, null);
});
