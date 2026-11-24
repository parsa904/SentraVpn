import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_RECONNECT_ATTEMPTS,
  SLEEP_WAKE_GAP_MS,
  buildNetworkFingerprint,
  computeReconnectBackoffMs,
  detectSleepWakeJump,
  shouldShowBatteryOptimizationWarning,
  shouldTriggerAutoReconnect,
} from './reconnectPolicy';

test('detectSleepWakeJump triggers only when elapsed wall-clock gap meets sleep threshold', () => {
  const base = 1_700_000_000_000;
  assert.equal(detectSleepWakeJump(base, base + 5_000), false);
  assert.equal(detectSleepWakeJump(base, base + SLEEP_WAKE_GAP_MS - 1), false);
  assert.equal(detectSleepWakeJump(base, base + SLEEP_WAKE_GAP_MS), true);
  assert.equal(detectSleepWakeJump(base, base + 120_000), true);
  // Negative clock adjustments (NTP skew backwards) must not falsely trigger wake
  assert.equal(detectSleepWakeJump(base, base - 30_000), false);
});

test('computeReconnectBackoffMs grows exponentially and caps safely', () => {
  assert.equal(computeReconnectBackoffMs(1), 1_500);
  assert.equal(computeReconnectBackoffMs(2), 3_000);
  assert.equal(computeReconnectBackoffMs(3), 6_000);
  assert.equal(computeReconnectBackoffMs(4), 12_000);
  assert.equal(computeReconnectBackoffMs(8), 12_000);
  assert.equal(computeReconnectBackoffMs(0), 1_500);
});

test('buildNetworkFingerprint distinguishes Wi-Fi, cellular, and offline states', () => {
  const wifi = buildNetworkFingerprint({ type: 'wifi', effectiveType: '4g' }, true);
  const cellular = buildNetworkFingerprint({ type: 'cellular', effectiveType: '4g' }, true);
  const offline = buildNetworkFingerprint({ type: 'wifi', effectiveType: '4g' }, false);
  const fallback = buildNetworkFingerprint(null, true);

  assert.notEqual(wifi, cellular);
  assert.notEqual(wifi, offline);
  assert.equal(fallback, 'online|unknown|unknown');
});

test('shouldTriggerAutoReconnect allows reconnect only when all safety invariants hold', () => {
  const valid = {
    autoReconnectEnabled: true,
    userWantsConnected: true,
    isOnline: true,
    isAuthenticated: true,
    isReconnecting: false,
    attemptsUsed: 0,
  };

  assert.equal(shouldTriggerAutoReconnect(valid), true);
  assert.equal(shouldTriggerAutoReconnect({ ...valid, attemptsUsed: MAX_RECONNECT_ATTEMPTS - 1 }), true);

  // Suppressed when toggle disabled
  assert.equal(shouldTriggerAutoReconnect({ ...valid, autoReconnectEnabled: false }), false);
  // Suppressed after manual disconnect
  assert.equal(shouldTriggerAutoReconnect({ ...valid, userWantsConnected: false }), false);
  // Suppressed when offline
  assert.equal(shouldTriggerAutoReconnect({ ...valid, isOnline: false }), false);
  // Suppressed when signed out
  assert.equal(shouldTriggerAutoReconnect({ ...valid, isAuthenticated: false }), false);
  // Suppressed when already reconnecting (coalescing)
  assert.equal(shouldTriggerAutoReconnect({ ...valid, isReconnecting: true }), false);
  // Suppressed once retry budget is exhausted
  assert.equal(shouldTriggerAutoReconnect({ ...valid, attemptsUsed: MAX_RECONNECT_ATTEMPTS }), false);
});

test('shouldShowBatteryOptimizationWarning triggers only on optimized Android with auto-reconnect active', () => {
  const androidOptimized = { isAndroid: true, isOptimized: true, canOpenSettings: true };
  const androidUnrestricted = { isAndroid: true, isOptimized: false, canOpenSettings: true };
  const desktop = { isAndroid: false, isOptimized: false, canOpenSettings: false };

  assert.equal(
    shouldShowBatteryOptimizationWarning({
      status: androidOptimized,
      autoReconnectEnabled: true,
      dismissed: false,
    }),
    true
  );

  assert.equal(
    shouldShowBatteryOptimizationWarning({
      status: androidUnrestricted,
      autoReconnectEnabled: true,
      dismissed: false,
    }),
    false
  );

  assert.equal(
    shouldShowBatteryOptimizationWarning({
      status: desktop,
      autoReconnectEnabled: true,
      dismissed: false,
    }),
    false
  );

  assert.equal(
    shouldShowBatteryOptimizationWarning({
      status: androidOptimized,
      autoReconnectEnabled: false,
      dismissed: false,
    }),
    false
  );

  assert.equal(
    shouldShowBatteryOptimizationWarning({
      status: androidOptimized,
      autoReconnectEnabled: true,
      dismissed: true,
    }),
    false
  );

  assert.equal(
    shouldShowBatteryOptimizationWarning({
      status: null,
      autoReconnectEnabled: true,
      dismissed: false,
    }),
    false
  );
});
