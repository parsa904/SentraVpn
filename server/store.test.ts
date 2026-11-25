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
  assert.equal(
    bootstrap.modes.some((m) => m.id === 'gaming'),
    false
  );
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
