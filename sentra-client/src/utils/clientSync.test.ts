import assert from 'node:assert/strict';
import test from 'node:test';
import type { PersonalConfigItem } from '../types/sentra';
import {
  MAX_SYNCED_PERSONAL_CONFIGS,
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

test('sanitizeSyncedPreferences strips gaming mode and invalid enum values', () => {
  const sanitized = sanitizeSyncedPreferences({
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

  assert.equal(sanitized.selected_mode, undefined);
  assert.equal(sanitized.routing_mode, undefined);
  assert.equal(sanitized.split_tunneling, true);
  assert.equal(sanitized.kill_switch, false);
  assert.equal(sanitized.custom_dns, '9.9.9.9');
  assert.equal(sanitized.selected_outbound_id, 'node-de-1');
  assert.equal(sanitized.lang, 'fa');
  assert.equal(sanitized.theme, 'dark');
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
