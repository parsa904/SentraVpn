import React, { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ActiveServerSelection,
  BootstrapResponse,
  ConnectionModeId,
  ConnectionStatus,
  DonatedOutboundRecord,
  LiveOutboundNode,
  LogEntry,
  NavTab,
  PersistedSession,
  PersonalConfigItem,
  RoutingMode,
  TelemetrySnapshot,
  ThemeMode,
} from './types/sentra';
import {
  type Language,
  applyDocumentLanguage,
  getInitialLanguage,
  t,
} from './i18n/translations';
import {
  APP_VERSION,
  selectFastestHealthyServer,
} from './utils/proxyParser';
import {
  type GithubReleaseUpdate,
  checkGithubLatestRelease,
  connectVpnNative,
  disconnectVpnNative,
  donateOutboundToServer,
  fetchBootstrap,
  fetchMyDonations,
  loadPersonalConfigs,
  logoutSession,
  pingServerNode,
  removeUserDevice,
  requestTelegramLinkCode,
  restorePersistedSession,
  savePersonalConfigs,
  setActiveOutboundNative,
  setConnectionModeNative,
  setKillSwitchNative,
  setRoutingModeNative,
  setSplitTunnelingNative,
  setUseWarpNative,
  subscribeNativeTelemetry,
} from './services/api';
import { SplashScreen } from './components/SplashScreen';
import { AuthView } from './components/AuthView';
import { Sidebar } from './components/Sidebar';
import { TopSubscriptionBar } from './components/TopSubscriptionBar';
import { UpdateBanner } from './components/UpdateBanner';
import { HomeView } from './components/HomeView';
import { ProfilesView } from './components/ProfilesView';
import { DonateOutboundView } from './components/DonateOutboundView';
import { SettingsView } from './components/SettingsView';
import { LogsView } from './components/LogsView';
import { AddConfigModal } from './components/AddConfigModal';
import { DonateModal } from './components/DonateModal';

const THEME_STORAGE_KEY = 'sentra_theme_v2';

const EMPTY_TELEMETRY: TelemetrySnapshot = {
  download_speed_bps: 0,
  upload_speed_bps: 0,
  total_download_bytes: 0,
  total_upload_bytes: 0,
  ping_ms: null,
  uptime_seconds: 0,
};

function makeLogEntry(level: LogEntry['level'], message: string): LogEntry {
  const now = new Date();
  const timestamp = now.toTimeString().slice(0, 8);
  return {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    timestamp,
    level,
    message,
  };
}

function getInitialTheme(): ThemeMode {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // ignore storage errors
  }
  return 'dark';
}

function shouldSkipSplash(): boolean {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  return params.get('autostart') === '1';
}

function outboundToSelection(
  node: LiveOutboundNode,
  measuredPing: number | null | undefined
): ActiveServerSelection {
  return {
    kind: 'server',
    id: node.id,
    name: node.name,
    protocol: node.protocol,
    country_code: node.country_code,
    country_name: node.country_name,
    flag: node.flag || '🌐',
    server_address: node.server_address,
    server_port: node.server_port,
    latency_ms:
      measuredPing !== undefined
        ? measuredPing
        : node.latency_ms > 0
        ? node.latency_ms
        : null,
    uri: node.uri,
  };
}

export const App: React.FC = () => {
  const [lang, setLang] = useState<Language>(getInitialLanguage);
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme);
  const [splashDone, setSplashDone] = useState<boolean>(shouldSkipSplash);
  const [splashStatusKey, setSplashStatusKey] = useState<'splashChecking' | 'splashSyncing'>(
    'splashChecking'
  );
  const [session, setSession] = useState<PersistedSession | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(null);

  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  const [releaseUpdate, setReleaseUpdate] = useState<GithubReleaseUpdate | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);

  const [activeTab, setActiveTab] = useState<NavTab>('home');
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [selectedMode, setSelectedMode] = useState<ConnectionModeId>('web_browsing');

  const [routingMode, setRoutingMode] = useState<RoutingMode>('tunnel');
  const [splitTunneling, setSplitTunneling] = useState(true);
  const [killSwitch, setKillSwitch] = useState(true);
  const [useWarp, setUseWarp] = useState(false);
  const [customDns, setCustomDns] = useState('1.1.1.1');

  const [personalConfigs, setPersonalConfigs] = useState<PersonalConfigItem[]>([]);
  const [activeServer, setActiveServer] = useState<ActiveServerSelection | null>(null);
  const [autoMode, setAutoMode] = useState(true);
  const [autoResolving, setAutoResolving] = useState(false);
  const [testingAll, setTestingAll] = useState(false);
  const [livePings, setLivePings] = useState<Record<string, number | null>>({});
  const [pingingIds, setPingingIds] = useState<Record<string, boolean>>({});

  const [donations, setDonations] = useState<DonatedOutboundRecord[]>([]);
  const [loadingDonations, setLoadingDonations] = useState(false);

  const [telemetry, setTelemetry] = useState<TelemetrySnapshot>(EMPTY_TELEMETRY);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const [addConfigOpen, setAddConfigOpen] = useState(false);
  const [donateModalConfig, setDonateModalConfig] = useState<PersonalConfigItem | null>(null);
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const toastTimerRef = useRef<number | null>(null);
  const langRef = useRef<Language>(lang);
  langRef.current = lang;

  const pushLog = useCallback((level: LogEntry['level'], message: string) => {
    setLogs((prev) => [...prev.slice(-199), makeLogEntry(level, message)]);
  }, []);

  const showToast = useCallback((kind: 'success' | 'error', text: string) => {
    setToast({ kind, text });
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 4200);
  }, []);

  // Apply language & LTR/RTL direction immediately and persist
  useEffect(() => {
    applyDocumentLanguage(lang);
  }, [lang]);

  // Apply Dark / Light theme class to <html>
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // ignore
    }
  }, [theme]);

  // Non-blocking background check for newer GitHub Releases
  useEffect(() => {
    let cancelled = false;
    void checkGithubLatestRelease(APP_VERSION).then((update) => {
      if (!cancelled && update) {
        setReleaseUpdate(update);
        pushLog('INFO', `Update available: ${update.version} (${update.url})`);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [pushLog]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  const syncWithServer = useCallback(
    async (activeSession: PersistedSession) => {
      setSyncing(true);
      setSyncError(null);
      pushLog('SYNC', 'Requesting live subscription and outbounds from core...');
      try {
        const data = await fetchBootstrap(activeSession.subscription_token);
        setBootstrap(data);
        pushLog(
          'SYNC',
          `Synced ${data.outbounds.length} active outbounds (${data.subscription.tier}).`
        );

        setActiveServer((current) => {
          if (current) {
            if (current.kind === 'server') {
              const refreshed = data.outbounds.find((o) => o.id === current.id);
              if (refreshed) {
                return outboundToSelection(
                  refreshed,
                  refreshed.latency_ms > 0 ? refreshed.latency_ms : current.latency_ms
                );
              }
            }
            return current;
          }
          const fastestBaseline = selectFastestHealthyServer(data.outbounds, {});
          const fallback = fastestBaseline?.node || data.outbounds[0];
          if (!fallback) return null;
          void setActiveOutboundNative(fallback.id, null);
          return outboundToSelection(fallback, undefined);
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Sync failed';
        if (msg.startsWith('AUTH_EXPIRED:')) {
          const clean = msg.replace('AUTH_EXPIRED:', '').trim();
          pushLog('ERROR', `Session expired: ${clean}`);
          await logoutSession();
          setSession(null);
          setBootstrap(null);
          setAuthNotice(clean || t(langRef.current, 'sessionExpiredNotice'));
        } else {
          setSyncError(msg);
          pushLog('WARN', `Live sync unavailable: ${msg}`);
        }
      } finally {
        setSyncing(false);
      }
    },
    [pushLog]
  );

  const loadDonations = useCallback(
    async (activeSession: PersistedSession) => {
      setLoadingDonations(true);
      try {
        const list = await fetchMyDonations(activeSession.subscription_token);
        setDonations(list);
      } catch (err) {
        pushLog(
          'WARN',
          `Failed to load donations: ${err instanceof Error ? err.message : String(err)}`
        );
      } finally {
        setLoadingDonations(false);
      }
    },
    [pushLog]
  );

  // Startup bootstrap: restore persisted auth + personal configs in parallel with splash
  useEffect(() => {
    let cancelled = false;
    const skipSplash = shouldSkipSplash();

    const init = async () => {
      const minSplashDelay = skipSplash
        ? Promise.resolve()
        : new Promise<void>((resolve) => window.setTimeout(resolve, 1100));

      const [restored, savedPersonal] = await Promise.all([
        restorePersistedSession(),
        loadPersonalConfigs(),
      ]);

      if (cancelled) return;
      setPersonalConfigs(savedPersonal);

      if (restored) {
        setSession(restored);
        setSplashStatusKey('splashSyncing');
        await Promise.all([syncWithServer(restored), minSplashDelay]);
        if (!cancelled) {
          void loadDonations(restored);
        }
      } else {
        await minSplashDelay;
      }

      if (!cancelled) {
        setSplashDone(true);
      }
    };

    void init();
    return () => {
      cancelled = true;
    };
  }, [syncWithServer, loadDonations]);

  // Subscribe to native Tauri telemetry, logs, and System Tray / Android Notification status
  useEffect(() => {
    let cleanup: (() => void) | null = null;
    void subscribeNativeTelemetry(
      (snap) => setTelemetry(snap),
      (line) => pushLog('INFO', line),
      (status, errorMsg) => {
        setConnectionStatus(status);
        if (status === 'disconnected') {
          setTelemetry(EMPTY_TELEMETRY);
        }
        if (errorMsg) {
          setConnectionError(errorMsg);
        } else if (status === 'connected' || status === 'disconnected') {
          setConnectionError(null);
        }
      }
    ).then((unsub) => {
      cleanup = unsub;
    });
    return () => {
      if (cleanup) cleanup();
    };
  }, [pushLog]);

  const handleAuthenticated = async (newSession: PersistedSession) => {
    setAuthNotice(null);
    setSession(newSession);
    pushLog('INFO', `Signed in as ${newSession.username || 'user'}. Session persisted.`);
    await syncWithServer(newSession);
    void loadDonations(newSession);
  };

  const handleLogout = async () => {
    if (connectionStatus === 'connected' || connectionStatus === 'connecting') {
      try {
        await disconnectVpnNative();
      } catch {
        // ignore disconnect errors during logout
      }
    }
    await logoutSession();
    setSession(null);
    setBootstrap(null);
    setDonations([]);
    setActiveServer(null);
    setAutoMode(true);
    setConnectionStatus('disconnected');
    setTelemetry(EMPTY_TELEMETRY);
    setActiveTab('home');
    pushLog('INFO', 'Signed out and cleared local session.');
  };

  const handleSelectMode = async (mode: ConnectionModeId) => {
    setSelectedMode(mode);
    if (mode === 'static_ip') {
      setRoutingMode('tunnel');
      setKillSwitch(true);
      setUseWarp(false);
    }
    try {
      await setConnectionModeNative(mode);
      pushLog('INFO', `Connection mode switched to ${mode}.`);
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : t(lang, 'modeChangeFailed'));
    }
  };

  const handlePingNode = useCallback(
    async (id: string, host: string, port: number): Promise<number | null> => {
      setPingingIds((prev) => ({ ...prev, [id]: true }));
      try {
        const ms = await pingServerNode(host, port);
        setLivePings((prev) => ({ ...prev, [id]: ms }));
        setActiveServer((curr) => (curr && curr.id === id ? { ...curr, latency_ms: ms } : curr));
        pushLog('INFO', `Ping ${host}:${port} = ${ms ? `${ms} ms` : 'Timeout'}`);
        return ms;
      } finally {
        setPingingIds((prev) => ({ ...prev, [id]: false }));
      }
    },
    [pushLog]
  );

  const handlePingAllOutbounds = useCallback(async () => {
    const serverList = bootstrap?.outbounds || [];
    const personalList = personalConfigs.filter((c) => !c.is_subscription);
    if (serverList.length === 0 && personalList.length === 0) return;

    setTestingAll(true);
    pushLog(
      'INFO',
      `Testing latency concurrently for ${serverList.length + personalList.length} endpoints...`
    );
    try {
      await Promise.all([
        ...serverList.map((node) =>
          handlePingNode(node.id, node.server_address, node.server_port)
        ),
        ...personalList.map((cfg) =>
          handlePingNode(cfg.id, cfg.server_address, cfg.server_port)
        ),
      ]);
    } finally {
      setTestingAll(false);
    }
  }, [bootstrap, personalConfigs, handlePingNode, pushLog]);

  const handleSelectAutoFastest = useCallback(async (): Promise<ActiveServerSelection | null> => {
    const list = (bootstrap?.outbounds || []).filter((o) => o.is_online !== false);
    setAutoMode(true);
    if (list.length === 0) {
      showToast('error', t(langRef.current, 'noServersTitle'));
      return null;
    }

    setAutoResolving(true);
    pushLog('INFO', `Auto Select testing ${list.length} active servers...`);
    try {
      const entries = await Promise.all(
        list.map(async (node) => {
          const ms = await handlePingNode(node.id, node.server_address, node.server_port);
          return [node.id, ms] as const;
        })
      );
      const measuredMap: Record<string, number | null> = {};
      for (const [id, ms] of entries) {
        measuredMap[id] = ms;
      }

      const fastest = selectFastestHealthyServer(list, measuredMap);
      if (!fastest) {
        showToast('error', t(langRef.current, 'noHealthyServerFound'));
        pushLog('WARN', 'Auto Select found no reachable server.');
        return null;
      }

      const selection = outboundToSelection(fastest.node, fastest.latencyMs);
      setActiveServer(selection);
      await setActiveOutboundNative(fastest.node.id, null);
      pushLog(
        'INFO',
        `Auto Select picked ${fastest.node.name} (${fastest.latencyMs} ms).`
      );
      showToast(
        'success',
        t(langRef.current, 'autoSelectedToast', {
          name: fastest.node.name,
          ms: fastest.latencyMs,
        })
      );
      return selection;
    } finally {
      setAutoResolving(false);
    }
  }, [bootstrap, handlePingNode, pushLog, showToast]);

  const handleToggleConnect = async () => {
    setConnectionError(null);
    if (connectionStatus === 'connected' || connectionStatus === 'connecting') {
      try {
        await disconnectVpnNative();
      } finally {
        setConnectionStatus('disconnected');
        setTelemetry(EMPTY_TELEMETRY);
        pushLog('INFO', 'VPN disconnected cleanly.');
      }
      return;
    }

    let targetServer = activeServer;
    if (autoMode && (bootstrap?.outbounds.length || 0) > 0) {
      const hasMeasuredPing = Boolean(targetServer && targetServer.id in livePings);
      if (!targetServer || !hasMeasuredPing) {
        const picked = await handleSelectAutoFastest();
        if (picked) {
          targetServer = picked;
        }
      }
    }

    if (!targetServer) {
      setConnectionError(t(lang, 'selectServerFirst'));
      return;
    }

    setConnectionStatus('connecting');
    pushLog('INFO', `Connecting to ${targetServer.name} (${targetServer.protocol})...`);
    try {
      await connectVpnNative();
      setConnectionStatus('connected');
      pushLog('INFO', `Connected securely to ${targetServer.name}.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t(lang, 'connectFailed');
      setConnectionStatus('error');
      setConnectionError(msg);
      pushLog('ERROR', msg);
    }
  };

  const handleSelectServerOutbound = (node: LiveOutboundNode) => {
    setAutoMode(false);
    const selection = outboundToSelection(
      node,
      node.id in livePings ? livePings[node.id] : undefined
    );
    setActiveServer(selection);
    void setActiveOutboundNative(node.id, null);
    pushLog('INFO', `Active server set to ${node.name} (${node.protocol}).`);
    showToast('success', t(lang, 'serverSelectedToast', { name: node.name }));
  };

  const handleSelectPersonalConfig = (cfg: PersonalConfigItem) => {
    setAutoMode(false);
    const selection: ActiveServerSelection = {
      kind: 'personal',
      id: cfg.id,
      name: cfg.name,
      protocol: cfg.protocol,
      country_code: cfg.country_code,
      country_name:
        cfg.country_code === 'XX' ? t(lang, 'personalCountry') : cfg.country_code,
      flag: cfg.flag,
      server_address: cfg.server_address,
      server_port: cfg.server_port,
      latency_ms: cfg.id in livePings ? livePings[cfg.id] : cfg.latency_ms,
      uri: cfg.uri,
    };
    setActiveServer(selection);
    void setActiveOutboundNative(null, cfg.uri);
    pushLog('INFO', `Active profile set to ${cfg.name}.`);
    showToast('success', t(lang, 'serverSelectedToast', { name: cfg.name }));
  };

  const handleAddPersonalConfig = (item: PersonalConfigItem) => {
    setPersonalConfigs((prev) => {
      const next = [item, ...prev];
      void savePersonalConfigs(next);
      return next;
    });
    handleSelectPersonalConfig(item);
    setActiveTab('profiles');
    showToast('success', t(lang, 'configAddedToast', { name: item.name }));
  };

  const handleDeletePersonalConfig = (id: string) => {
    setPersonalConfigs((prev) => {
      const next = prev.filter((c) => c.id !== id);
      void savePersonalConfigs(next);
      return next;
    });
    if (activeServer?.kind === 'personal' && activeServer.id === id) {
      setActiveServer(null);
    }
    showToast('success', t(lang, 'configDeletedToast'));
  };

  const handleDonateSubmit = async (payload: {
    uri: string;
    name?: string;
    note?: string;
  }): Promise<{ message?: string }> => {
    if (!session) throw new Error(t(lang, 'signInRequired'));
    const res = await donateOutboundToServer(session.subscription_token, payload);
    pushLog('SYNC', `Donated outbound "${payload.name || 'custom'}" submitted for review.`);
    showToast('success', res.message || t(lang, 'donationSubmittedDefault'));
    void loadDonations(session);
    return res;
  };

  const handleRemoveDevice = async (deviceId: string) => {
    if (!session) return;
    await removeUserDevice(session.subscription_token, deviceId);
    pushLog('INFO', `Removed device ${deviceId}.`);
    showToast('success', t(lang, 'deviceRemovedToast'));
    await syncWithServer(session);
  };

  const handleRequestTelegramLink = async (): Promise<string> => {
    if (!session) throw new Error(t(lang, 'signInRequired'));
    const code = await requestTelegramLinkCode(session.subscription_token);
    pushLog('INFO', 'Telegram link code issued.');
    return code;
  };

  if (!splashDone) {
    return <SplashScreen statusText={t(lang, splashStatusKey)} />;
  }

  if (!session) {
    return (
      <AuthView
        lang={lang}
        onChangeLanguage={setLang}
        theme={theme}
        onToggleTheme={toggleTheme}
        onAuthenticated={handleAuthenticated}
        initialNotice={authNotice}
        botUsername={bootstrap?.bot_username}
      />
    );
  }

  const outbounds = bootstrap?.outbounds || [];
  const totalProfilesCount = outbounds.length + personalConfigs.length;

  return (
    <div className="flex h-screen w-full overflow-hidden bg-slate-50 dark:bg-[#090E1A] text-slate-900 dark:text-slate-100">
      <Sidebar
        lang={lang}
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        theme={theme}
        onToggleTheme={toggleTheme}
        onLogout={handleLogout}
        username={bootstrap?.user.username || session.username || ''}
        outboundsCount={totalProfilesCount}
      />

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopSubscriptionBar
          lang={lang}
          subscription={bootstrap?.subscription || null}
          syncing={syncing}
          onSync={() => void syncWithServer(session)}
          onOpenAddConfig={() => setAddConfigOpen(true)}
        />

        {!updateDismissed && (
          <UpdateBanner
            lang={lang}
            update={releaseUpdate}
            onDismiss={() => setUpdateDismissed(true)}
          />
        )}

        {syncError && (
          <div
            role="status"
            className="flex items-center justify-between gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 md:px-6 py-2 text-xs text-amber-800 dark:text-amber-200"
          >
            <span className="truncate">{syncError}</span>
            <button
              type="button"
              onClick={() => void syncWithServer(session)}
              className="shrink-0 font-semibold underline"
            >
              {t(lang, 'retry')}
            </button>
          </div>
        )}

        <main className="relative flex flex-1 flex-col overflow-hidden">
          {activeTab === 'home' && (
            <HomeView
              lang={lang}
              connectionStatus={connectionStatus}
              connectionError={connectionError}
              selectedMode={selectedMode}
              modes={bootstrap?.modes || []}
              activeServer={activeServer}
              autoMode={autoMode}
              autoResolving={autoResolving}
              telemetry={telemetry}
              pingingActive={Boolean(activeServer && pingingIds[activeServer.id])}
              activeServerTested={Boolean(activeServer && activeServer.id in livePings)}
              onToggleConnect={() => void handleToggleConnect()}
              onSelectMode={(m) => void handleSelectMode(m)}
              onOpenProfiles={() => setActiveTab('profiles')}
              onPingActiveServer={() => {
                if (activeServer) {
                  void handlePingNode(
                    activeServer.id,
                    activeServer.server_address,
                    activeServer.server_port
                  );
                }
              }}
            />
          )}

          {activeTab === 'profiles' && (
            <ProfilesView
              lang={lang}
              outbounds={outbounds}
              personalConfigs={personalConfigs}
              activeServer={activeServer}
              autoMode={autoMode}
              autoResolving={autoResolving}
              testingAll={testingAll}
              livePings={livePings}
              pingingIds={pingingIds}
              syncing={syncing}
              onSync={() => void syncWithServer(session)}
              onOpenAddConfig={() => setAddConfigOpen(true)}
              onSelectAutoFastest={() => void handleSelectAutoFastest()}
              onSelectServerOutbound={handleSelectServerOutbound}
              onSelectPersonalConfig={handleSelectPersonalConfig}
              onPingServerOutbound={(node) =>
                void handlePingNode(node.id, node.server_address, node.server_port)
              }
              onPingPersonalConfig={(cfg) =>
                void handlePingNode(cfg.id, cfg.server_address, cfg.server_port)
              }
              onPingAllOutbounds={() => void handlePingAllOutbounds()}
              onDeletePersonalConfig={handleDeletePersonalConfig}
              onOpenDonateModal={(cfg) => setDonateModalConfig(cfg)}
            />
          )}

          {activeTab === 'donate' && (
            <DonateOutboundView
              lang={lang}
              personalConfigs={personalConfigs}
              donations={donations}
              loadingDonations={loadingDonations}
              onRefreshDonations={() => void loadDonations(session)}
              onSubmitDonation={handleDonateSubmit}
            />
          )}

          {activeTab === 'settings' && (
            <SettingsView
              lang={lang}
              onChangeLanguage={setLang}
              theme={theme}
              onToggleTheme={toggleTheme}
              routingMode={routingMode}
              selectedMode={selectedMode}
              splitTunneling={splitTunneling}
              killSwitch={killSwitch}
              useWarp={useWarp}
              customDns={customDns}
              devices={bootstrap?.devices || []}
              maxDevices={bootstrap?.subscription.max_concurrent_devices || 0}
              botUsername={bootstrap?.bot_username || ''}
              username={bootstrap?.user.username || session.username || ''}
              onLogout={handleLogout}
              onChangeRoutingMode={(m) => {
                setRoutingMode(m);
                void setRoutingModeNative(m).catch((e) =>
                  showToast('error', e instanceof Error ? e.message : String(e))
                );
              }}
              onToggleSplitTunneling={(v) => {
                setSplitTunneling(v);
                void setSplitTunnelingNative(v);
              }}
              onToggleKillSwitch={(v) => {
                setKillSwitch(v);
                void setKillSwitchNative(v);
              }}
              onToggleWarp={(v) => {
                setUseWarp(v);
                void setUseWarpNative(v);
              }}
              onChangeCustomDns={setCustomDns}
              onRemoveDevice={handleRemoveDevice}
              onRequestTelegramLinkCode={handleRequestTelegramLink}
            />
          )}

          {activeTab === 'logs' && (
            <LogsView lang={lang} logs={logs} onClearLogs={() => setLogs([])} />
          )}
        </main>
      </div>

      {/* Modals */}
      <AddConfigModal
        lang={lang}
        open={addConfigOpen}
        onClose={() => setAddConfigOpen(false)}
        onAddConfig={handleAddPersonalConfig}
      />

      <DonateModal
        lang={lang}
        config={donateModalConfig}
        onClose={() => setDonateModalConfig(null)}
        onConfirmDonate={handleDonateSubmit}
      />

      {/* Toast Notification */}
      {toast && (
        <div
          role="status"
          className={`fixed top-16 md:top-auto md:bottom-6 end-4 md:end-6 z-50 max-w-sm rounded-xl border px-4 py-3 text-xs font-semibold shadow-xl backdrop-blur-md transition-opacity duration-200 ${
            toast.kind === 'error'
              ? 'border-rose-500/40 bg-rose-950/90 text-rose-100'
              : 'border-emerald-500/40 bg-slate-900/95 text-emerald-100'
          }`}
        >
          {toast.text}
        </div>
      )}
    </div>
  );
};
export default App;
