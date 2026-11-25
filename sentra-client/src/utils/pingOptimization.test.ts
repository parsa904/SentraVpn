import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { LiveOutboundNode } from '../types/sentra';
import {
  PING_OPT_INTERVAL_MS,
  didOutboundOrderChange,
  getElapsedSecondsSinceOptimization,
  resolveOutboundLatency,
  shouldRunPeriodicPingOptimization,
  sortOutboundsByLatency,
} from './pingOptimization';

function makeNode(overrides: Partial<LiveOutboundNode> & { id: string }): LiveOutboundNode {
  return {
    id: overrides.id,
    db_id: overrides.db_id ?? 1,
    name: overrides.name ?? overrides.id,
    tag: overrides.tag ?? overrides.id,
    protocol: overrides.protocol ?? 'vless',
    category: overrides.category ?? 'general',
    country_code: overrides.country_code ?? 'DE',
    country_name: overrides.country_name ?? 'Germany',
    flag: overrides.flag ?? '🇩🇪',
    latency_ms: overrides.latency_ms ?? 0,
    health_score: overrides.health_score ?? 90,
    is_official: overrides.is_official ?? true,
    is_online: overrides.is_online ?? true,
    server_address: overrides.server_address ?? '198.51.100.1',
    server_port: overrides.server_port ?? 443,
    uri: overrides.uri ?? null,
  };
}

describe('resolveOutboundLatency', () => {
  it('prefers live measured pings over cached bootstrap latency', () => {
    const node = makeNode({ id: 'de-1', latency_ms: 140 });
    assert.deepEqual(resolveOutboundLatency(node, { 'de-1': 42.6 }), {
      latencyMs: 43,
      state: 'measured',
    });
  });

  it('marks explicitly null live pings as timeout even if cached latency existed', () => {
    const node = makeNode({ id: 'de-1', latency_ms: 55 });
    assert.deepEqual(resolveOutboundLatency(node, { 'de-1': null }), {
      latencyMs: null,
      state: 'timeout',
    });
  });

  it('falls back to cached latency when no live ping exists, or untested when 0', () => {
    assert.deepEqual(resolveOutboundLatency(makeNode({ id: 'nl-1', latency_ms: 78 }), {}), {
      latencyMs: 78,
      state: 'cached',
    });
    assert.deepEqual(resolveOutboundLatency(makeNode({ id: 'tr-1', latency_ms: 0 }), {}), {
      latencyMs: null,
      state: 'untested',
    });
  });
});

describe('sortOutboundsByLatency', () => {
  it('places lowest-latency nodes at the top and demotes untested, timeout, and offline nodes', () => {
    const nodes = [
      makeNode({ id: 'offline-fast', latency_ms: 15, is_online: false }),
      makeNode({ id: 'slow-us', latency_ms: 210 }),
      makeNode({ id: 'timeout-fr', latency_ms: 30 }),
      makeNode({ id: 'untested-jp', latency_ms: 0, health_score: 95 }),
      makeNode({ id: 'mid-nl', latency_ms: 95 }),
      makeNode({ id: 'fast-de', latency_ms: 180 }),
    ];

    const livePings: Record<string, number | null> = {
      'fast-de': 34,
      'mid-nl': 68,
      'timeout-fr': null,
      'slow-us': 190,
    };

    const sorted = sortOutboundsByLatency(nodes, livePings);
    assert.deepEqual(
      sorted.map((n) => n.id),
      ['fast-de', 'mid-nl', 'slow-us', 'untested-jp', 'timeout-fr', 'offline-fast']
    );
    // Input array must not be mutated
    assert.equal(nodes[0].id, 'offline-fast');
  });

  it('breaks identical latency ties by measured > cached, then health_score, then official', () => {
    const nodes = [
      makeNode({ id: 'cached-official', latency_ms: 50, health_score: 99, is_official: true }),
      makeNode({ id: 'measured-community', latency_ms: 120, health_score: 80, is_official: false }),
      makeNode({ id: 'measured-official', latency_ms: 120, health_score: 80, is_official: true }),
      makeNode({ id: 'measured-higher-health', latency_ms: 120, health_score: 95, is_official: false }),
    ];

    const livePings: Record<string, number | null> = {
      'measured-community': 50,
      'measured-official': 50,
      'measured-higher-health': 50,
    };

    const sorted = sortOutboundsByLatency(nodes, livePings);
    assert.deepEqual(
      sorted.map((n) => n.id),
      ['measured-higher-health', 'measured-official', 'measured-community', 'cached-official']
    );
  });
});

describe('shouldRunPeriodicPingOptimization', () => {
  it('runs immediately when enabled, visible, idle, and never run before', () => {
    assert.equal(
      shouldRunPeriodicPingOptimization({
        enabled: true,
        outboundsCount: 3,
        isTestingAll: false,
        isAutoResolving: false,
        isOptimizing: false,
        isDocumentVisible: true,
        lastRunAtMs: null,
        nowMs: 1_000,
      }),
      true
    );
  });

  it('respects cooldown interval, disabled state, busy states, and hidden visibility', () => {
    const base = {
      enabled: true,
      outboundsCount: 3,
      isTestingAll: false,
      isAutoResolving: false,
      isOptimizing: false,
      isDocumentVisible: true,
      lastRunAtMs: 10_000,
      nowMs: 10_000 + PING_OPT_INTERVAL_MS - 1,
    };
    assert.equal(shouldRunPeriodicPingOptimization(base), false);
    assert.equal(
      shouldRunPeriodicPingOptimization({ ...base, nowMs: 10_000 + PING_OPT_INTERVAL_MS }),
      true
    );
    assert.equal(
      shouldRunPeriodicPingOptimization({
        ...base,
        nowMs: 10_000 + PING_OPT_INTERVAL_MS,
        enabled: false,
      }),
      false
    );
    assert.equal(
      shouldRunPeriodicPingOptimization({
        ...base,
        nowMs: 10_000 + PING_OPT_INTERVAL_MS,
        isTestingAll: true,
      }),
      false
    );
    assert.equal(
      shouldRunPeriodicPingOptimization({
        ...base,
        nowMs: 10_000 + PING_OPT_INTERVAL_MS,
        isDocumentVisible: false,
      }),
      false
    );
  });
});

describe('order change and elapsed helpers', () => {
  it('detects order changes accurately', () => {
    assert.equal(
      didOutboundOrderChange([{ id: 'a' }, { id: 'b' }], [{ id: 'a' }, { id: 'b' }]),
      false
    );
    assert.equal(
      didOutboundOrderChange([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'a' }]),
      true
    );
  });

  it('computes non-negative elapsed seconds since last optimization', () => {
    assert.equal(getElapsedSecondsSinceOptimization(null, 5000), null);
    assert.equal(getElapsedSecondsSinceOptimization(5000, 5000), 0);
    assert.equal(getElapsedSecondsSinceOptimization(1000, 14900), 13);
    assert.equal(getElapsedSecondsSinceOptimization(9000, 5000), 0);
  });
});
