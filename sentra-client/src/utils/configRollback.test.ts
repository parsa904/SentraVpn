import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CANDIDATE_CONFIG_FILE,
  ConfigRollbackManager,
  createMemoryConfigStore,
  LAST_KNOWN_GOOD_CONFIG_FILE,
  validateCandidateSingboxJson,
} from './configRollback.ts';
import { reportClientRollbackError } from './errorReporter.ts';

const VALID_GOOD_CONFIG = JSON.stringify({
  log: { level: 'warn' },
  inbounds: [{ type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: 10808 }],
  outbounds: [
    {
      type: 'vless',
      tag: 'DE-Good',
      server: '198.51.100.10',
      server_port: 443,
      uuid: '11111111-2222-3333-4444-555555555555',
    },
    { type: 'direct', tag: 'direct' },
  ],
  route: { final: 'DE-Good' },
});

const VALID_CANDIDATE_CONFIG = JSON.stringify({
  log: { level: 'warn' },
  inbounds: [{ type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: 10808 }],
  outbounds: [
    {
      type: 'trojan',
      tag: 'NL-Candidate',
      server: '198.51.100.20',
      server_port: 443,
      password: 'secret',
    },
    { type: 'direct', tag: 'direct' },
  ],
  route: { final: 'NL-Candidate' },
});

test('validateCandidateSingboxJson accepts valid sing-box 1.14+ JSON and rejects malformed/incomplete configs', () => {
  assert.equal(validateCandidateSingboxJson(VALID_CANDIDATE_CONFIG).valid, true);
  assert.equal(validateCandidateSingboxJson('{bad json').valid, false);
  assert.equal(validateCandidateSingboxJson('{}').valid, false);
  assert.equal(
    validateCandidateSingboxJson(
      JSON.stringify({ inbounds: [], outbounds: [{ type: 'direct', tag: 'direct' }], route: {} })
    ).valid,
    false
  );
  assert.equal(
    validateCandidateSingboxJson(
      JSON.stringify({
        inbounds: [{ type: 'mixed', tag: 'in' }],
        outbounds: [{ type: 'selector', tag: 'sel' }],
        route: {},
      })
    ).valid,
    false
  );
});

test('ConfigRollbackManager rolls back immediately to last_known_good_config.json when pre-check fails', async () => {
  const store = createMemoryConfigStore();
  const manager = new ConfigRollbackManager(store);
  manager.seedLastKnownGoodConfig(VALID_GOOD_CONFIG);

  const startedFiles: string[] = [];
  const rollbackReports: Array<{ singboxError: string; rolledBackToGoodConfig: boolean }> = [];

  const result = await manager.applyCandidateWithRollback({
    candidateJson: VALID_CANDIDATE_CONFIG,
    checkConfig: async () => ({
      ok: false,
      error: 'FATAL: unknown field xhttp with vless://secret-uuid@1.2.3.4:443',
    }),
    startCore: async (_json, filename) => {
      startedFiles.push(filename);
    },
    isCoreAlive: () => true,
    stabilityWindowMs: 40,
    onRollback: (info) => {
      rollbackReports.push({
        singboxError: info.singboxError,
        rolledBackToGoodConfig: info.rolledBackToGoodConfig,
      });
    },
  });

  assert.equal(result.status, 'rolled_back');
  assert.equal(result.activeConfigFile, LAST_KNOWN_GOOD_CONFIG_FILE);
  assert.deepEqual(startedFiles, [LAST_KNOWN_GOOD_CONFIG_FILE]);
  assert.equal(manager.getLastKnownGoodConfig(), VALID_GOOD_CONFIG, 'Good config must remain untouched');
  assert.equal(manager.getCandidateConfig(), VALID_CANDIDATE_CONFIG);
  assert.equal(rollbackReports.length, 1);
  assert.equal(rollbackReports[0].rolledBackToGoodConfig, true);
  assert.equal(
    rollbackReports[0].singboxError.includes('secret-uuid'),
    false,
    'Sanitized rollback error must strip secrets/UUIDs'
  );
});

test('ConfigRollbackManager detects early crash within stability window and auto-rolls back without outage', async () => {
  const store = createMemoryConfigStore();
  const manager = new ConfigRollbackManager(store);
  manager.seedLastKnownGoodConfig(VALID_GOOD_CONFIG);

  const startedFiles: string[] = [];
  let checks = 0;

  const result = await manager.applyCandidateWithRollback({
    candidateJson: VALID_CANDIDATE_CONFIG,
    checkConfig: async () => ({ ok: true }),
    startCore: async (_json, filename) => {
      startedFiles.push(filename);
    },
    isCoreAlive: () => {
      checks += 1;
      // Crash on the second stability poll
      return checks < 2;
    },
    stabilityWindowMs: 80,
    pollIntervalMs: 15,
    onRollback: () => undefined,
  });

  assert.equal(result.status, 'rolled_back');
  assert.equal(result.activeConfigFile, LAST_KNOWN_GOOD_CONFIG_FILE);
  assert.deepEqual(startedFiles, [CANDIDATE_CONFIG_FILE, LAST_KNOWN_GOOD_CONFIG_FILE]);
  assert.equal(manager.getLastKnownGoodConfig(), VALID_GOOD_CONFIG);
});

test('ConfigRollbackManager promotes candidate_config.json to last_known_good_config.json ONLY after surviving stability window', async () => {
  const store = createMemoryConfigStore();
  const manager = new ConfigRollbackManager(store);
  manager.seedLastKnownGoodConfig(VALID_GOOD_CONFIG);

  const startedFiles: string[] = [];

  const result = await manager.applyCandidateWithRollback({
    candidateJson: VALID_CANDIDATE_CONFIG,
    checkConfig: async () => ({ ok: true }),
    startCore: async (_json, filename) => {
      startedFiles.push(filename);
    },
    isCoreAlive: () => true,
    stabilityWindowMs: 40,
    pollIntervalMs: 10,
  });

  assert.equal(result.status, 'promoted');
  assert.equal(result.activeConfigFile, LAST_KNOWN_GOOD_CONFIG_FILE);
  assert.deepEqual(startedFiles, [CANDIDATE_CONFIG_FILE]);
  assert.equal(
    manager.getLastKnownGoodConfig(),
    VALID_CANDIDATE_CONFIG,
    'Candidate must be promoted to last_known_good_config.json after stability window'
  );
});

test('reportClientRollbackError posts sanitized rollback payload to /api/v1/logs/report without tokens', async () => {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: typeof input === 'string' ? input : input.toString(),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : '',
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  try {
    const ok = await reportClientRollbackError({
      platform: 'windows',
      singboxError: 'sing-box crash: Bearer super-secret-jwt-1234567890 invalid outbound',
      rolledBackToGoodConfig: true,
    });
    assert.equal(ok, true);
    const workerCall = calls.find((c) => c.url.endsWith('/api/v1/logs/report'));
    assert.ok(workerCall, 'Must POST to /api/v1/logs/report');
    assert.equal(workerCall.headers['X-Subscription-Token'], undefined, 'Must not attach user subscription token');
    assert.equal(workerCall.body.includes('super-secret-jwt-1234567890'), false, 'Secrets must be redacted');
    assert.ok(workerCall.body.includes('SingboxAutoRollback'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
