import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveQuickConnectState } from './quickConnect';
import type { ActiveServerSelection } from '../types/sentra';

const SAMPLE_SERVER: ActiveServerSelection = {
  kind: 'server',
  id: 'de-fra-1',
  name: 'Frankfurt #1',
  protocol: 'VLESS',
  country_code: 'DE',
  country_name: 'Germany',
  flag: '🇩🇪',
  server_address: '198.51.100.10',
  server_port: 443,
  latency_ms: 48,
  uri: 'vless://test@198.51.100.10:443#Frankfurt',
};

test('deriveQuickConnectState maps disconnected, connecting, connected, and error states accurately', () => {
  const idle = deriveQuickConnectState({
    connectionStatus: 'disconnected',
    autoResolving: false,
    activeServer: SAMPLE_SERVER,
    autoMode: false,
    autoSelectLabel: 'Auto Select',
  });
  assert.deepEqual(idle, {
    isChecked: false,
    isBusy: false,
    tone: 'idle',
    targetLabel: 'Frankfurt #1',
  });

  const resolving = deriveQuickConnectState({
    connectionStatus: 'disconnected',
    autoResolving: true,
    activeServer: null,
    autoMode: true,
    autoSelectLabel: 'Auto Select',
  });
  assert.deepEqual(resolving, {
    isChecked: true,
    isBusy: true,
    tone: 'connecting',
    targetLabel: 'Auto Select',
  });

  const connected = deriveQuickConnectState({
    connectionStatus: 'connected',
    autoResolving: false,
    activeServer: SAMPLE_SERVER,
    autoMode: true,
    autoSelectLabel: 'Auto Select',
  });
  assert.deepEqual(connected, {
    isChecked: true,
    isBusy: false,
    tone: 'connected',
    targetLabel: 'Frankfurt #1',
  });

  const errored = deriveQuickConnectState({
    connectionStatus: 'error',
    autoResolving: false,
    activeServer: null,
    autoMode: false,
    autoSelectLabel: 'Auto Select',
  });
  assert.deepEqual(errored, {
    isChecked: false,
    isBusy: false,
    tone: 'error',
    targetLabel: null,
  });
});
