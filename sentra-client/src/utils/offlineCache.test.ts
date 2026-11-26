import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearOfflineConfigCache,
  hashCacheScope,
  loadCachedActiveServer,
  loadCachedBootstrapSnapshot,
  loadCachedDonationsSnapshot,
  saveCachedActiveServer,
  saveCachedBootstrapSnapshot,
  saveCachedDonationsSnapshot,
} from './offlineCache.ts';
import type { ActiveServerSelection, BootstrapResponse, DonatedOutboundRecord } from '../types/sentra.ts';

class MemoryStorage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

function makeSampleBootstrap(username: string): BootstrapResponse {
  return {
    success: true,
    server_time: '2026-11-25T12:00:00Z',
    bot_username: '@sentraconnect_bot',
    user: {
      id: 1,
      user_uuid: 'uuid-1',
      username,
      first_name: username,
      telegram_id: null,
      role: 'user',
      status: 'active',
    },
    subscription: {
      tier: 'Sentra Pro',
      token: `sentra_${username}`,
      status: 'active',
      upload_bytes: 1024,
      download_bytes: 2048,
      used_bytes: 3072,
      traffic_limit_bytes: 10_000_000,
      remaining_bytes: 9_996_928,
      web_browsing_used_mb: 1,
      download_used_mb: 2,
      static_ip_used_mb: 0,
      active_devices_count: 1,
      max_concurrent_devices: 3,
      remaining_days: 30,
      expires_at: '2026-12-25T12:00:00Z',
    },
    devices: [],
    modes: [
      {
        id: 'web_browsing',
        name: 'Web',
        status: 'active',
        daily_limit_mb: 2048,
        used_today_mb: 1,
        remaining_today_mb: 2047,
        speed_desc: 'Fast',
        security_desc: 'TLS',
        description: 'Web',
      },
      {
        id: 'gaming',
        name: 'Gaming',
        status: 'active',
        daily_limit_mb: 204800,
        used_today_mb: 0,
        remaining_today_mb: 204800,
        speed_desc: 'Ultra-Low Ping',
        security_desc: 'Full-Cone NAT',
        description: 'Gaming',
      },
    ],
    outbounds: [
      {
        id: 'node-1',
        db_id: 1,
        name: 'Frankfurt Pro',
        tag: 'DE-1',
        protocol: 'VLESS',
        category: 'web_browsing',
        country_code: 'DE',
        country_name: 'Germany',
        flag: '🇩🇪',
        latency_ms: 54,
        health_score: 100,
        is_official: true,
        is_online: true,
        server_address: 'de.example.com',
        server_port: 443,
        uri: 'vless://1111@de.example.com:443#DE',
      },
    ],
  };
}

test('caches and restores last known configuration synchronously with token scope isolation', async () => {
  const storage = new MemoryStorage();
  const tokenA = 'sentra_alpha_token_12345';
  const tokenB = 'sentra_beta_token_67890';

  assert.notEqual(hashCacheScope(tokenA), hashCacheScope(tokenB));
  assert.equal(hashCacheScope(tokenA).includes('alpha'), false);

  const saved = saveCachedBootstrapSnapshot(tokenA, makeSampleBootstrap('alice'), storage);
  assert.ok(saved);
  assert.equal(saved.data.modes.some((m) => m.id === 'gaming'), true);

  const restoredA = loadCachedBootstrapSnapshot(tokenA, storage);
  assert.ok(restoredA);
  assert.equal(restoredA.data.user.username, 'alice');
  assert.equal(restoredA.data.outbounds.length, 1);
  assert.equal(restoredA.data.outbounds[0].name, 'Frankfurt Pro');

  // Different account token must NOT see Alice's cached configuration
  assert.equal(loadCachedBootstrapSnapshot(tokenB, storage), null);

  // Donations & active server selection cache
  const donations: DonatedOutboundRecord[] = [
    {
      id: 7,
      name: 'Community NL',
      protocol: 'HYSTERIA2',
      server_address: 'nl.example.com',
      server_port: 8443,
      country_code: 'NL',
      flag: '🇳🇱',
      latency_ms: 48,
      status: 'active',
      reward_days: 7,
      created_at: '2026-11-25T10:00:00Z',
    },
  ];
  saveCachedDonationsSnapshot(tokenA, donations, storage);
  const restoredDonations = loadCachedDonationsSnapshot(tokenA, storage);
  assert.equal(restoredDonations?.length, 1);
  assert.equal(restoredDonations?.[0].name, 'Community NL');

  const activeSel: ActiveServerSelection = {
    kind: 'server',
    id: 'node-1',
    name: 'Frankfurt Pro',
    protocol: 'VLESS',
    country_code: 'DE',
    country_name: 'Germany',
    flag: '🇩🇪',
    server_address: 'de.example.com',
    server_port: 443,
    latency_ms: 54,
    is_official: true,
  };
  saveCachedActiveServer(tokenA, activeSel, storage);
  assert.equal(loadCachedActiveServer(tokenA, storage)?.id, 'node-1');

  // Logout clears cached config cleanly
  await clearOfflineConfigCache(tokenA, storage);
  assert.equal(loadCachedBootstrapSnapshot(tokenA, storage), null);
  assert.equal(loadCachedDonationsSnapshot(tokenA, storage), null);
  assert.equal(loadCachedActiveServer(tokenA, storage), null);
});
