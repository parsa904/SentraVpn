import assert from 'node:assert/strict';
import test from 'node:test';
import type { PersonalConfigItem } from '../types/sentra';
import {
  BOOTSTRAP_POLL_INTERVAL_MS,
  MAX_SYNCED_PERSONAL_CONFIGS,
  SUBSCRIPTION_REFRESH_INTERVAL_MS,
  buildSyncStatePayload,
  mergePersonalConfigs,
  normalizeRemoteClientState,
  sanitizePersonalConfigs,
  sanitizeSyncedPreferences,
  shouldApplyRemoteState,
} from './clientSync';

function makeConfig(id: string, uri = `vless://u@1.1.1.1:443#${id}`): PersonalConfigItem {
  return {
    id,
    name: `Node ${id}`,
    uri,
    protocol: 'VLESS',
    server_address: '1.1.1.1',
    server_port: 443,
    country_code: 'DE',
    flag: '🇩🇪',
    is_subscription: false,
    latency_ms: 42,
    added_at: '2026-01-01T00:00:00Z',
  };
}

test('sanitizeSyncedPreferences preserves valid modes including gaming and strips invalid enum values', () => {
  const withGaming = sanitizeSyncedPreferences({
    selected_mode: 'gaming',
    routing_mode: 'invalid_mode',
    split_tunneling: true,
    kill_switch: false,
    auto_reconnect: true,
    ping_optimization_enabled: true,
    use_warp: true,
    custom_dns: '  9.9.9.9  ',
    selected_outbound_id: 'node-de-1',
    auto_mode: false,
    lang: 'fa',
    theme: 'dark',
  });

  assert.equal(withGaming.selected_mode, 'gaming');
  assert.equal(withGaming.routing_mode, undefined);
  assert.equal(withGaming.split_tunneling, true);
  assert.equal(withGaming.kill_switch, false);
  assert.equal(withGaming.custom_dns, '9.9.9.9');
  assert.equal(withGaming.selected_outbound_id, 'node-de-1');
  assert.equal(withGaming.lang, 'fa');
  assert.equal(withGaming.theme, 'dark');

  const withInvalidMode = sanitizeSyncedPreferences({
    selected_mode: 'unsupported_mode',
    lang: 'de',
    theme: 'sepia',
  });
  assert.equal(withInvalidMode.selected_mode, undefined);
  assert.equal(withInvalidMode.lang, undefined);
  assert.equal(withInvalidMode.theme, undefined);
});

test('sanitizePersonalConfigs deduplicates ids and enforces cap', () => {
  const many: PersonalConfigItem[] = [];
  for (let i = 0; i < MAX_SYNCED_PERSONAL_CONFIGS + 25; i++) {
    many.push(makeConfig(`cfg-${i}`));
  }
  many.unshift(makeConfig('cfg-0'));

  const cleaned = sanitizePersonalConfigs(many);
  assert.equal(cleaned.length, MAX_SYNCED_PERSONAL_CONFIGS);
  assert.equal(cleaned[0].id, 'cfg-0');
});

test('shouldApplyRemoteState only applies strictly newer remote timestamps', () => {
  assert.equal(shouldApplyRemoteState(0, null), false);
  assert.equal(shouldApplyRemoteState(0, ''), false);
  assert.equal(shouldApplyRemoteState(0, 'not-a-date'), false);

  const t1 = '2026-05-01T10:00:00.000Z';
  const t2 = '2026-05-01T10:05:00.000Z';
  assert.equal(shouldApplyRemoteState(0, t1), true);
  assert.equal(shouldApplyRemoteState(Date.parse(t1), t1), false);
  assert.equal(shouldApplyRemoteState(Date.parse(t1), t2), true);
  assert.equal(shouldApplyRemoteState(Date.parse(t2), t1), false);
});

test('mergePersonalConfigs respects authoritative remote updates and unions on initial sync', () => {
  const a = makeConfig('a', 'vless://a@1.1.1.1:443#a');
  const b = makeConfig('b', 'vless://b@2.2.2.2:443#b');
  const c = makeConfig('c', 'vless://c@3.3.3.3:443#c');

  // Authoritative remote state propagates deletions (e.g., removed on Android)
  const authoritative = mergePersonalConfigs([a, b], [b, c], true);
  assert.deepEqual(
    authoritative.map((x) => x.id),
    ['b', 'c']
  );

  // Non-authoritative merge preserves local configs before first cloud upload
  const initialUnion = mergePersonalConfigs([a, b], [b, c], false);
  assert.deepEqual(
    initialUnion.map((x) => x.id),
    ['b', 'c', 'a']
  );
});

test('buildSyncStatePayload and normalizeRemoteClientState round-trip safely', () => {
  const payload = buildSyncStatePayload([makeConfig('x')], {
    selected_mode: 'download',
    routing_mode: 'tunnel',
    use_warp: false,
    lang: 'en',
  });

  const normalized = normalizeRemoteClientState({
    ...payload,
    updated_at: '2026-05-01T12:00:00.000Z',
  });

  assert.ok(normalized);
  assert.equal(normalized.personal_configs.length, 1);
  assert.equal(normalized.personal_configs[0].id, 'x');
  assert.equal(normalized.preferences.selected_mode, 'download');
  assert.equal(normalized.updated_at, '2026-05-01T12:00:00.000Z');
});

test('background subscription refresh interval is set to 8 hours (max 3 auto requests/day)', () => {
  assert.equal(SUBSCRIPTION_REFRESH_INTERVAL_MS, 8 * 60 * 60 * 1000);
  assert.equal(BOOTSTRAP_POLL_INTERVAL_MS, 8 * 60 * 60 * 1000);
});
