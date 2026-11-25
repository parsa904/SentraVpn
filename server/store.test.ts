import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SentraStore, StoreError, hashPassword, verifyPassword } from './store.ts';

function makeTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentra-auth-test-'));
  return path.join(dir, 'sentra.sqlite');
}

test('salted scrypt hashing verifies correct passwords and rejects wrong ones', () => {
  const hash1 = hashPassword('MySecurePass!2026');
  const hash2 = hashPassword('MySecurePass!2026');
  assert.notEqual(hash1, hash2);
  assert.equal(verifyPassword('MySecurePass!2026', hash1), true);
  assert.equal(verifyPassword('WrongPass!2026', hash1), false);
});

test('registers account, persists across store restart, and allows case-insensitive sign-in', () => {
  const dbPath = makeTempDbPath();
  const store1 = new SentraStore(dbPath);

  const created = store1.registerUser({
    username: 'Parsa_Dev',
    password: 'StrongPassword99',
    device_identifier: 'windows-device-1',
    device_name: 'Windows PC',
    os: 'windows',
  });

  assert.equal(created.success, true);
  assert.equal(created.user.username, 'parsa_dev');
  assert.ok(created.subscription.token.startsWith('sentra_'));
  assert.equal(created.access_token, `jwt_sentra_${created.subscription.token}`);

  assert.throws(
    () =>
      store1.registerUser({
        username: 'PARSA_DEV',
        password: 'AnotherPassword123',
      }),
    (err: unknown) => err instanceof StoreError && err.status === 409
  );
  store1.close();

  const store2 = new SentraStore(dbPath);
  const loggedIn = store2.loginUser({
    username: '@PARSA_DEV',
    password: 'StrongPassword99',
    device_identifier: 'android-device-1',
    device_name: 'Android Mobile',
    os: 'android',
  });
  assert.equal(loggedIn.user.username, 'parsa_dev');
  assert.equal(loggedIn.subscription.token, created.subscription.token);

  assert.throws(
    () =>
      store2.loginUser({
        username: 'parsa_dev',
        password: 'WrongPassword99',
      }),
    (err: unknown) => err instanceof StoreError && err.status === 401
  );

  const bootstrap = store2.getBootstrap(loggedIn.subscription.token);
  assert.equal(bootstrap.user.username, 'parsa_dev');
  assert.equal(bootstrap.devices.length, 2);
  const liteGaming = bootstrap.modes.find((m) => m.id === 'gaming');
  assert.ok(liteGaming);
  assert.equal(liteGaming.status, 'coming_soon');
  store2.close();
});

test('syncs usage heartbeat, personal configs, and preferences across Windows and Android devices', () => {
  const dbPath = makeTempDbPath();
  const store = new SentraStore(dbPath);

  // Register on Windows
  const winSession = store.registerUser({
    username: 'sync_user',
    password: 'SyncPassword99!',
    device_identifier: 'win-pc-01',
    device_name: 'Windows PC',
    os: 'windows',
  });

  // Sign in on Android with the exact same account
  const androidSession = store.loginUser({
    username: 'sync_user',
    password: 'SyncPassword99!',
    device_identifier: 'android-01',
    device_name: 'Android Mobile',
    os: 'android',
  });
  assert.equal(androidSession.subscription.token, winSession.subscription.token);

  // Windows pushes personal configs & settings to shared DB
  const pushed = store.updateClientSyncState(winSession.subscription.token, {
    personal_configs: [
      {
        id: 'cfg-1',
        name: 'Frankfurt VLESS',
        uri: 'vless://11111111-2222-3333-4444-555555555555@fra.example.com:443#DE',
        protocol: 'VLESS',
        server_address: 'fra.example.com',
        server_port: 443,
        country_code: 'DE',
        flag: '🇩🇪',
        is_subscription: false,
        latency_ms: 68,
        added_at: '2026-11-25T10:00:00Z',
      },
    ],
    preferences: {
      selected_mode: 'download',
      routing_mode: 'tunnel',
      split_tunneling: true,
      kill_switch: true,
      auto_reconnect: true,
      ping_optimization_enabled: true,
      use_warp: true,
      custom_dns: '9.9.9.9',
    },
  });
  assert.equal(pushed.client_state.personal_configs.length, 1);
  assert.equal(pushed.client_state.preferences.custom_dns, '9.9.9.9');

  // Android reports 5 MB upload + 15 MB download usage via heartbeat
  const hb = store.processHeartbeat(androidSession.subscription.token, {
    device_id: 'android-01',
    mode: 'download',
    delta_upload_bytes: 5 * 1024 * 1024,
    delta_download_bytes: 15 * 1024 * 1024,
  });
  assert.equal(hb.action, 'continue');
  if (hb.action === 'continue') {
    assert.equal(hb.used_bytes, 20 * 1024 * 1024);
    assert.equal(hb.download_used_mb, 20);
  }

  // Windows calls bootstrap and immediately sees Android's usage + synced configs + both devices!
  const winBootstrap = store.getBootstrap(winSession.subscription.token, 'win-pc-01');
  assert.equal(winBootstrap.subscription.used_bytes, 20 * 1024 * 1024);
  assert.equal(winBootstrap.subscription.download_used_mb, 20);
  assert.equal(winBootstrap.devices.length, 2);
  assert.equal(winBootstrap.client_state.personal_configs.length, 1);
  assert.equal(winBootstrap.client_state.preferences.selected_mode, 'download');
  assert.equal(winBootstrap.client_state.preferences.custom_dns, '9.9.9.9');

  // Revoking Android device causes Android's next heartbeat to receive DEVICE_REVOKED
  store.removeDevice(winSession.subscription.token, 'android-01');
  const revokedHb = store.processHeartbeat(androidSession.subscription.token, {
    device_id: 'android-01',
    mode: 'download',
    delta_upload_bytes: 1024,
    delta_download_bytes: 1024,
  });
  assert.equal(revokedHb.action, 'disconnect');
  if (revokedHb.action === 'disconnect') {
    assert.equal(revokedHb.code, 'DEVICE_REVOKED');
  }

  store.close();
});

test('accepts legacy email-based accounts on sign-in and verifies OTP & device ownership', () => {
  const store = new SentraStore(':memory:');
  const userId = store.createEmailUserForTest('Ali.Reza@Example.com', 'LegacyPass42!', 'Ali');

  const session = store.loginUser({
    username: 'ali.reza@example.com',
    password: 'LegacyPass42!',
    device_identifier: 'dev-a',
  });
  assert.equal(session.user.first_name, 'Ali');
  assert.ok(session.subscription.token.length > 10);

  const otp = store.issueAuthCodeForUser(userId);
  assert.match(otp, /^\d{8}$/);
  const otpSession = store.loginWithCode({ code: otp, device_identifier: 'dev-b' });
  assert.equal(otpSession.subscription.token, session.subscription.token);

  assert.throws(
    () => store.loginWithCode({ code: otp }),
    (err: unknown) => err instanceof StoreError && err.status === 401
  );

  const other = store.registerUser({
    username: 'other_user',
    password: 'OtherPassword99',
    device_identifier: 'other-dev',
  });
  assert.throws(
    () => store.removeDevice(other.subscription.token, 'dev-a'),
    (err: unknown) => err instanceof StoreError && err.status === 404
  );

  const removed = store.removeDevice(session.subscription.token, 'dev-b');
  assert.equal(removed.success, true);

  const link = store.generateLinkCode(session.subscription.token);
  assert.match(link.link_code, /^\d{6}$/);

  store.close();
});

test('donated and self-added outbounds are immediately active across the entire ecosystem and block internal hosts', () => {
  const store = new SentraStore(':memory:');

  const donor = store.registerUser({
    username: 'donor_user',
    password: 'StrongPassword99!',
    device_identifier: 'donor-win',
    os: 'windows',
  });
  const otherUser = store.registerUser({
    username: 'android_user',
    password: 'StrongPassword99!',
    device_identifier: 'other-android',
    os: 'android',
  });

  // 1. User donates a VLESS Reality outbound -> immediately active ecosystem-wide
  const donated = store.donateOutbound(donor.subscription.token, {
    uri: 'vless://11111111-2222-3333-4444-555555555555@de-node.example.com:443?security=reality&sni=example.com&pbk=testkey#Germany-Community',
    name: 'Germany Community',
  });
  assert.equal(donated.success, true);
  assert.equal(donated.status, 'active');

  // 2. User adds their own Hysteria2 outbound to the ecosystem -> immediately active ecosystem-wide
  const added = store.addEcosystemOutbound(donor.subscription.token, {
    uri: 'hysteria2://secretpass@nl-fast.example.com:8443?sni=nl-fast.example.com#Netherlands-Fast',
    name: 'Netherlands Fast',
  });
  assert.equal(added.success, true);
  assert.equal(added.status, 'active');

  // 3. Another user on Android immediately sees BOTH outbounds in bootstrap
  const otherBootstrap = store.getBootstrap(otherUser.subscription.token, 'other-android');
  assert.equal(otherBootstrap.outbounds.length, 2);
  assert.ok(otherBootstrap.outbounds.some((o) => o.server_address === 'de-node.example.com'));
  assert.ok(otherBootstrap.outbounds.some((o) => o.server_address === 'nl-fast.example.com'));

  // 4. Locations catalog reflects active ecosystem nodes
  const locations = store.getClientLocations();
  assert.equal(locations.success, true);
  assert.ok(locations.locations.reduce((acc, l) => acc + l.node_count, 0) >= 2);

  // 5. Compiled Sing-box config includes both outbounds and respects explicit selection
  const compiled = store.compileClientConfig(otherUser.subscription.token, {
    mode: 'web_browsing',
    selected_outbound_id: `node-${added.id}`,
  });
  assert.equal(compiled.active_outbounds_count, 2);
  const sbOutbounds = compiled.singbox_config.outbounds as Array<Record<string, unknown>>;
  const selector = sbOutbounds.find((o) => o.tag === 'Sentra Select');
  assert.ok(selector);
  assert.equal(selector.default, '🤝 Netherlands Fast');
  assert.ok(sbOutbounds.some((o) => o.server === 'de-node.example.com'));
  assert.ok(sbOutbounds.some((o) => o.server === 'nl-fast.example.com'));

  // 6. Both Base64 V2Ray subscription and Sing-box subscription include both active outbounds
  const base64Sub = store.getSubscriptionPayload(otherUser.subscription.token);
  assert.equal(base64Sub.isSingbox, false);
  const decodedSub = Buffer.from(base64Sub.body, 'base64').toString('utf8');
  assert.ok(decodedSub.includes('de-node.example.com'));
  assert.ok(decodedSub.includes('nl-fast.example.com'));

  const singboxSub = store.getSubscriptionPayload(otherUser.subscription.token, 'singbox');
  assert.equal(singboxSub.isSingbox, true);
  const parsedSubJson = JSON.parse(singboxSub.body) as { outbounds: Array<Record<string, unknown>> };
  assert.ok(parsedSubJson.outbounds.some((o) => o.server === 'de-node.example.com'));
  assert.ok(parsedSubJson.outbounds.some((o) => o.server === 'nl-fast.example.com'));

  // 7. Anti-SSRF rejects loopback, RFC1918, and cloud metadata addresses
  for (const blockedUri of [
    'vless://11111111-2222-3333-4444-555555555555@127.0.0.1:443#Local',
    'trojan://pass@localhost:443#Localhost',
    'hysteria2://pass@169.254.169.254:443#Metadata',
    'socks://192.168.1.1:1080#Lan',
  ]) {
    assert.throws(
      () => store.donateOutbound(donor.subscription.token, { uri: blockedUri }),
      (err: unknown) => err instanceof StoreError && err.status === 400
    );
    assert.throws(
      () => store.addEcosystemOutbound(donor.subscription.token, { uri: blockedUri }),
      (err: unknown) => err instanceof StoreError && err.status === 400
    );
  }

  store.close();
});

test('keeps Gaming as coming_soon until an active gaming outbound exists, then auto-activates ecosystem-wide with smart tier entitlements', () => {
  const store = new SentraStore(':memory:');
  const user = store.registerUser({
    username: 'gamer_one',
    password: 'StrongPassword99!',
    device_identifier: 'win-gaming-rig',
    os: 'windows',
  });
  const token = user.subscription.token;

  // 0. Before any gaming outbound is added via Telegram Bot: Gaming is visible as 'coming_soon' for ALL tiers
  assert.equal(store.hasActiveGamingOutbounds(), false);
  const preLaunchBoot = store.getBootstrap(token, 'win-gaming-rig');
  assert.equal(preLaunchBoot.modes.find((m) => m.id === 'gaming')?.status, 'coming_soon');
  assert.throws(
    () => store.compileClientConfig(token, { mode: 'gaming' }),
    (err: unknown) => err instanceof StoreError && err.status === 403 && err.code === 'MODE_COMING_SOON'
  );
  assert.throws(
    () => store.generateWireguardGamingProfile(token, 'vpn.sentra.example'),
    (err: unknown) => err instanceof StoreError && err.status === 403 && err.code === 'MODE_COMING_SOON'
  );

  // Even a Flow+ user sees 'coming_soon' until admin adds an active gaming outbound
  store.setSubscriptionTierForTest(token, 'Sentra Flow+');
  assert.equal(
    store.getBootstrap(token, 'win-gaming-rig').modes.find((m) => m.id === 'gaming')?.status,
    'coming_soon'
  );
  assert.throws(
    () => store.generateWireguardGamingProfile(token, 'vpn.sentra.example'),
    (err: unknown) => err instanceof StoreError && err.status === 403 && err.code === 'MODE_COMING_SOON'
  );

  // 1. Admin adds a Gaming outbound -> Gaming automatically activates across the entire ecosystem!
  const gamingOutboundId = store.addOfficialGamingOutboundForTest(
    'vless://22222222-3333-4444-5555-666666666666@game-de.example.com:443?security=reality&sni=example.com&pbk=gamekey#DE-Gaming',
    'DE Gaming Direct',
    34
  );
  assert.equal(store.hasActiveGamingOutbounds(), true);

  // Free / Sentra Lite user: Gaming and Static IP are strictly locked server-side once active
  store.setSubscriptionTierForTest(token, 'Sentra Lite');
  const liteBoot = store.getBootstrap(token, 'win-gaming-rig');
  assert.equal(liteBoot.modes.find((m) => m.id === 'web_browsing')?.status, 'active');
  assert.equal(liteBoot.modes.find((m) => m.id === 'download')?.status, 'active');
  assert.equal(liteBoot.modes.find((m) => m.id === 'gaming')?.status, 'locked');
  assert.equal(liteBoot.modes.find((m) => m.id === 'static_ip')?.status, 'locked');

  assert.throws(
    () => store.compileClientConfig(token, { mode: 'gaming' }),
    (err: unknown) => err instanceof StoreError && err.status === 403 && err.code === 'MODE_LOCKED'
  );
  assert.throws(
    () => store.compileClientConfig(token, { mode: 'static_ip' }),
    (err: unknown) => err instanceof StoreError && err.status === 403 && err.code === 'MODE_LOCKED'
  );
  assert.throws(
    () => store.generateWireguardGamingProfile(token, 'vpn.sentra.example'),
    (err: unknown) => err instanceof StoreError && err.status === 403 && err.code === 'MODE_LOCKED'
  );

  // 2. Sentra Gaming tier: unlocks Gaming (Windows/Android optimized Sing-box + iOS WireGuard), Static IP stays locked
  store.setSubscriptionTierForTest(token, 'Sentra Gaming');
  const gamingBoot = store.getBootstrap(token, 'win-gaming-rig');
  assert.equal(gamingBoot.modes.find((m) => m.id === 'gaming')?.status, 'active');
  assert.equal(gamingBoot.modes.find((m) => m.id === 'static_ip')?.status, 'locked');

  const compiledGaming = store.compileClientConfig(token, {
    mode: 'gaming',
    use_warp: true, // must be auto-disabled in gaming mode
  });
  assert.equal(compiledGaming.mode, 'gaming');
  assert.equal(compiledGaming.gaming_optimized, true);
  assert.equal(compiledGaming.use_warp, false);
  assert.equal(compiledGaming.active_outbounds_count, 1);

  const tunInbound = compiledGaming.singbox_config.inbounds.find(
    (ib: Record<string, unknown>) => ib.type === 'tun'
  ) as Record<string, unknown>;
  assert.equal(tunInbound.mtu, 1280);
  assert.equal(tunInbound.endpoint_independent_nat, true);
  assert.equal(tunInbound.udp_timeout, '5m');
  assert.equal(tunInbound.sniff, false);
  assert.equal(tunInbound.sniff_override_destination, false);

  const urltestOutbound = (
    compiledGaming.singbox_config.outbounds as Array<Record<string, unknown>>
  ).find((o) => o.type === 'urltest');
  assert.ok(urltestOutbound);
  assert.equal(urltestOutbound.tolerance, 15);
  assert.equal(urltestOutbound.interval, '1m');

  const dnsServers = compiledGaming.singbox_config.dns.servers as Array<Record<string, unknown>>;
  assert.equal(dnsServers[0].address, 'udp://1.1.1.1');
  assert.equal(dnsServers[0].strategy, 'ipv4_only');

  // iOS WireGuard gaming profile contains valid Curve25519 keys, MTU 1280, DNS, PersistentKeepalive
  const wg = store.generateWireguardGamingProfile(token, 'vpn.sentra.example');
  assert.ok(wg.filename.startsWith('sentra-gaming-wg-'));
  assert.ok(wg.filename.endsWith('.conf'));
  assert.equal(Buffer.from(wg.client_public_key, 'base64').length, 32);
  assert.match(wg.client_address, /^10\.66\.\d+\.\d+\/32$/);
  assert.ok(wg.config.includes('[Interface]'));
  assert.ok(wg.config.includes('MTU = 1280'));
  assert.ok(wg.config.includes('DNS = 1.1.1.1, 8.8.8.8'));
  assert.ok(wg.config.includes('[Peer]'));
  assert.ok(wg.config.includes('Endpoint = vpn.sentra.example:51820'));
  assert.ok(wg.config.includes('AllowedIPs = 0.0.0.0/0'));
  assert.ok(wg.config.includes('PersistentKeepalive = 25'));

  // Static IP still strictly blocked for Gaming-only plan
  assert.throws(
    () => store.compileClientConfig(token, { mode: 'static_ip' }),
    (err: unknown) => err instanceof StoreError && err.status === 403 && err.code === 'MODE_LOCKED'
  );

  // 3. Sentra Static IP tier: unlocks Static IP ONLY, Gaming & WireGuard remain locked
  store.setSubscriptionTierForTest(token, 'Sentra Static IP');
  const staticBoot = store.getBootstrap(token, 'win-gaming-rig');
  assert.equal(staticBoot.modes.find((m) => m.id === 'static_ip')?.status, 'active');
  assert.equal(staticBoot.modes.find((m) => m.id === 'gaming')?.status, 'locked');
  assert.throws(
    () => store.generateWireguardGamingProfile(token, 'vpn.sentra.example'),
    (err: unknown) => err instanceof StoreError && err.status === 403 && err.code === 'MODE_LOCKED'
  );

  // 4. Sentra Pro / Flow+ tier: unlocks BOTH Gaming (WireGuard) and Static IP
  store.setSubscriptionTierForTest(token, 'Sentra Flow+');
  const flowBoot = store.getBootstrap(token, 'win-gaming-rig');
  assert.equal(flowBoot.modes.find((m) => m.id === 'gaming')?.status, 'active');
  assert.equal(flowBoot.modes.find((m) => m.id === 'static_ip')?.status, 'active');
  const flowWg = store.generateWireguardGamingProfile(token, 'vpn.sentra.example');
  assert.ok(flowWg.config.includes('Tier: Sentra Flow+'));

  // 5. Disabling the last active gaming outbound automatically reverts Gaming to 'coming_soon'
  store.setOutboundStatusForTest(gamingOutboundId, 'inactive');
  assert.equal(store.hasActiveGamingOutbounds(), false);
  assert.equal(
    store.getBootstrap(token, 'win-gaming-rig').modes.find((m) => m.id === 'gaming')?.status,
    'coming_soon'
  );

  store.close();
});
