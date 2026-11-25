import type { ActiveServerSelection, ConnectionStatus } from '../types/sentra';

export interface QuickConnectViewState {
  /** Whether the toggle switch should render in its active/on position */
  isChecked: boolean;
  /** Whether a connect or auto-select probe is actively in flight */
  isBusy: boolean;
  /** Semantic status tone for icons, text, and switch accent */
  tone: 'connected' | 'connecting' | 'error' | 'idle';
  /** Target label to pair with the connection status (server name or auto-select fallback) */
  targetLabel: string | null;
}

export function deriveQuickConnectState(params: {
  connectionStatus: ConnectionStatus;
  autoResolving: boolean;
  activeServer: ActiveServerSelection | null;
  autoMode: boolean;
  autoSelectLabel: string;
}): QuickConnectViewState {
  const { connectionStatus, autoResolving, activeServer, autoMode, autoSelectLabel } = params;
  const isConnected = connectionStatus === 'connected';
  const isConnecting = connectionStatus === 'connecting' || autoResolving;
  const isError = connectionStatus === 'error' && !autoResolving;

  const tone: QuickConnectViewState['tone'] = isConnected
    ? 'connected'
    : isConnecting
    ? 'connecting'
    : isError
    ? 'error'
    : 'idle';

  const targetLabel = activeServer
    ? activeServer.name
    : autoMode
    ? autoSelectLabel
    : null;

  return {
    isChecked: isConnected || isConnecting,
    isBusy: isConnecting,
    tone,
    targetLabel,
  };
}
