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
  type LatencyPoint,
  appendLatencySample,
  pruneLatencyHistory,
} from './utils/latencyHistory';
import {
  type TrafficPoint,
  appendTrafficSample,
  pruneTrafficHistory,
} from './utils/trafficHistory';
import {
  EMPTY_SESSION_TIMER,
  type PersistedSessionTimer,
  clearPersistedSessionTimer,
  computeSessionDurationSeconds,
  loadPersistedSessionTimer,
  pauseSessionTimer,
  reconcileWithNativeUptime,
  savePersistedSessionTimer,
  startOrResumeSessionTimer,
  stopSessionTimer,
} from './utils/sessionTimer';
import {
  type BatteryOptimizationStatus,
  type NetworkConnectionSnapshot,
  type ReconnectReason,
  RECONNECT_DEBOUNCE_MS,
  buildNetworkFingerprint,
  detectSleepWakeJump,
  getInitialAutoReconnect,
  getInitialBatteryWarningDismissed,
  persistAutoReconnect,
  persistBatteryWarningDismissed,
  shouldShowBatteryOptimizationWarning,
  shouldTriggerAutoReconnect,
} from './utils/reconnectPolicy';
import {
  PING_OPT_INTERVAL_MS,
  didOutboundOrderChange,
  getInitialPingOptimizationEnabled,
  persistPingOptimizationEnabled,
  resolveOutboundLatency,
  shouldRunPeriodicPingOptimization,
  sortOutboundsByLatency,
} from './utils/pingOptimization';
import {
  BOOTSTRAP_POLL_INTERVAL_MS,
  STATE_PUSH_DEBOUNCE_MS,
  buildSyncStatePayload,
  mergePersonalConfigs,
  normalizeRemoteClientState,
  parseIsoTimestampMs,
  shouldApplyRemoteState,
} from './utils/clientSync';
import {
  type GithubReleaseUpdate,
  addEcosystemOutboundToServer,
  checkGithubLatestRelease,
  connectVpnNative,
  disconnectVpnNative,
  donateOutboundToServer,
  fetchBootstrap,
  fetchMyDonations,
  getBatteryOptimizationStatusNative,
  isTauriRuntime,
  loadPersonalConfigs,
  logoutSession,
  openBatteryOptimizationSettingsNative,
  pingServerNode,
  pushClientSyncState,
  reconnectVpnNative,
  removeUserDevice,
  requestTelegramLinkCode,
  restorePersistedSession,
  savePersonalConfigs,
  setActiveOutboundNative,
  setAutoReconnectNative,
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
import { BatteryOptimizationBanner } from './components/BatteryOptimizationBanner';
import { HomeView } from './components/HomeView';
import { ProfilesView } from './components/ProfilesView';
import { DonateOutboundView } from './components/DonateOutboundView';
import { SettingsView } from './components/SettingsView';
import { LogsView } from './components/LogsView';
import { AddConfigModal } from './components/AddConfigModal';
import { DonateModal } from './components/DonateModal';
import { OfflineIndicator } from './components/OfflineIndicator';
import {
  loadCachedActiveServer,
  loadCachedBootstrapFromCacheStorage,
  loadCachedBootstrapSnapshot,
  loadCachedDonationsSnapshot,
  saveCachedActiveServer,
  saveCachedBootstrapSnapshot,
  saveCachedDonationsSnapshot,
} from './utils/offlineCache';

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
  const [lastConfigCachedAt, setLastConfigCachedAt] = useState<string | null>(null);
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
  const [autoReconnect, setAutoReconnect] = useState<boolean>(getInitialAutoReconnect);
  const [batteryOptStatus, setBatteryOptStatus] = useState<BatteryOptimizationStatus | null>(null);
  const [batteryWarningDismissed, setBatteryWarningDismissed] = useState<boolean>(
    getInitialBatteryWarningDismissed
  );
  const [useWarp, setUseWarp] = useState(false);
  const [customDns, setCustomDns] = useState('1.1.1.1');

  const [personalConfigs, setPersonalConfigs] = useState<PersonalConfigItem[]>([]);
  const [activeServer, setActiveServer] = useState<ActiveServerSelection | null>(null);
  const [autoMode, setAutoMode] = useState(true);
  const [autoResolving, setAutoResolving] = useState(false);
  const [testingAll, setTestingAll] = useState(false);
  const [pingOptimizationEnabled, setPingOptimizationEnabled] = useState<boolean>(
    getInitialPingOptimizationEnabled
  );
  const [pingOptimizing, setPingOptimizing] = useState(false);
  const [lastPingOptimizedAt, setLastPingOptimizedAt] = useState<number | null>(null);
  const [livePings, setLivePings] = useState<Record<string, number | null>>({});
  const [pingingIds, setPingingIds] = useState<Record<string, boolean>>({});

  const [donations, setDonations] = useState<DonatedOutboundRecord[]>([]);
  const [loadingDonations, setLoadingDonations] = useState(false);

  const [telemetry, setTelemetry] = useState<TelemetrySnapshot>(EMPTY_TELEMETRY);
  const [sessionTimer, setSessionTimer] = useState<PersistedSessionTimer>(() =>
    loadPersistedSessionTimer()
  );
  const [sessionNowMs, setSessionNowMs] = useState<number>(() => Date.now());
  const [latencyHistory, setLatencyHistory] = useState<LatencyPoint[]>([]);
  const [latencyNowMs, setLatencyNowMs] = useState<number>(() => Date.now());
  const [trafficHistory, setTrafficHistory] = useState<TrafficPoint[]>([]);
  const [trafficNowMs, setTrafficNowMs] = useState<number>(() => Date.now());
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const [addConfigOpen, setAddConfigOpen] = useState(false);
  const [donateModalConfig, setDonateModalConfig] = useState<PersonalConfigItem | null>(null);
  const [toast, setToast] = useState<{ kind: 'success' | 'error' | 'info'; text: string } | null>(null);

  const toastTimerRef = useRef<number | null>(null);
  const langRef = useRef<Language>(lang);
  langRef.current = lang;
  const autoReconnectRef = useRef<boolean>(autoReconnect);
  autoReconnectRef.current = autoReconnect;
  const sessionRef = useRef<PersistedSession | null>(session);
  sessionRef.current = session;
  const activeServerRef = useRef<ActiveServerSelection | null>(activeServer);
  activeServerRef.current = activeServer;
  const lastNativePingAtRef = useRef<number>(0);
  const userWantsConnectedRef = useRef<boolean>(false);
  const isReconnectingRef = useRef<boolean>(false);
  const pingOptimizationEnabledRef = useRef<boolean>(pingOptimizationEnabled);
  pingOptimizationEnabledRef.current = pingOptimizationEnabled;
  const pingOptimizingRef = useRef<boolean>(pingOptimizing);
  pingOptimizingRef.current = pingOptimizing;
  const testingAllRef = useRef<boolean>(testingAll);
  testingAllRef.current = testingAll;
  const autoResolvingRef = useRef<boolean>(autoResolving);
  autoResolvingRef.current = autoResolving;
  const autoModeRef = useRef<boolean>(autoMode);
  autoModeRef.current = autoMode;
  const connectionStatusRef = useRef<ConnectionStatus>(connectionStatus);
  connectionStatusRef.current = connectionStatus;
  const selectedModeRef = useRef<ConnectionModeId>(selectedMode);
  selectedModeRef.current = selectedMode;
  const lastPingOptimizedAtRef = useRef<number | null>(lastPingOptimizedAt);
  lastPingOptimizedAtRef.current = lastPingOptimizedAt;
  const livePingsRef = useRef<Record<string, number | null>>(livePings);
  livePingsRef.current = livePings;
  const outboundsRef = useRef<LiveOutboundNode[]>(bootstrap?.outbounds || []);
  outboundsRef.current = bootstrap?.outbounds || [];
  const lastOptimizedOrderIdsRef = useRef<string[]>([]);
  const reconnectAttemptsRef = useRef<number>(0);
  const reconnectDebounceRef = useRef<number | null>(null);
  const syncingInFlightRef = useRef<boolean>(false);
  const lastSyncCompletedAtRef = useRef<number>(0);
  const hydratingFromServerRef = useRef<boolean>(false);
  const hasHydratedCloudStateRef = useRef<boolean>(false);
  const lastRemoteStateUpdatedAtMsRef = useRef<number>(0);
  const syncStatePushTimerRef = useRef<number | null>(null);
  const personalConfigsRef = useRef<PersonalConfigItem[]>(personalConfigs);
  personalConfigsRef.current = personalConfigs;
  const activeTabRef = useRef<NavTab>(activeTab);
  activeTabRef.current = activeTab;
  const syncedPrefsRef = useRef({
    selected_mode: selectedMode,
    routing_mode: routingMode,
    split_tunneling: splitTunneling,
    kill_switch: killSwitch,
    auto_reconnect: autoReconnect,
    ping_optimization_enabled: pingOptimizationEnabled,
    use_warp: useWarp,
    custom_dns: customDns,
    selected_outbound_id: activeServer?.id ?? null,
    auto_mode: autoMode,
    lang,
    theme,
  });
  syncedPrefsRef.current = {
    selected_mode: selectedMode,
    routing_mode: routingMode,
    split_tunneling: splitTunneling,
    kill_switch: killSwitch,
    auto_reconnect: autoReconnect,
    ping_optimization_enabled: pingOptimizationEnabled,
    use_warp: useWarp,
    custom_dns: customDns,
    selected_outbound_id: activeServer?.id ?? null,
    auto_mode: autoMode,
    lang,
    theme,
  };

  const pushLog = useCallback((level: LogEntry['level'], message: string) => {
    const nextEntry = makeLogEntry(level, message);
    setLogs((prev) => (prev.length >= 50 ? [nextEntry] : [...prev, nextEntry]));
  }, []);

  const showToast = useCallback((kind: 'success' | 'error' | 'info', text: string) => {
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
    async (activeSession: PersistedSession, options?: { silent?: boolean }) => {
      const silent = Boolean(options?.silent);
      if (syncingInFlightRef.current && silent) return;
      syncingInFlightRef.current = true;
      if (!silent) {
        setSyncing(true);
        setSyncError(null);
        pushLog('SYNC', 'Requesting live subscription and outbounds from core...');
      }
      try {
        const data = await fetchBootstrap(activeSession.subscription_token);
        lastSyncCompletedAtRef.current = Date.now();
        setBootstrap(data);
        const cachedEnv = saveCachedBootstrapSnapshot(activeSession.subscription_token, data);
        if (cachedEnv) {
          setLastConfigCachedAt(cachedEnv.cachedAt);
        }
        setSyncError(null);

        // Reflect live account/subscription updates (e.g. Telegram upgrades or account linking)
        setSession((prev) => {
          if (!prev || prev.subscription_token !== activeSession.subscription_token) return prev;
          const nextUsername = data.user?.username || data.user?.first_name || prev.username;
          const nextTier = data.subscription?.tier || prev.tier;
          const nextExpires = data.subscription?.expires_at ?? prev.expires_at;
          if (
            nextUsername === prev.username &&
            nextTier === prev.tier &&
            nextExpires === prev.expires_at
          ) {
            return prev;
          }
          return {
            ...prev,
            username: nextUsername,
            tier: nextTier,
            expires_at: nextExpires,
          };
        });

        // Hydrate cross-device synced personal configs & preferences from database
        const remoteState = normalizeRemoteClientState(data.client_state);
        let syncedSelectedServer: ActiveServerSelection | null = null;
        if (remoteState) {
          const isFirstHydration = !hasHydratedCloudStateRef.current;
          if (
            remoteState.updated_at &&
            shouldApplyRemoteState(lastRemoteStateUpdatedAtMsRef.current, remoteState.updated_at)
          ) {
            hydratingFromServerRef.current = true;
            lastRemoteStateUpdatedAtMsRef.current = parseIsoTimestampMs(remoteState.updated_at);

            const mergedConfigs = mergePersonalConfigs(
              personalConfigsRef.current,
              remoteState.personal_configs,
              !isFirstHydration || remoteState.personal_configs.length > 0
            );
            personalConfigsRef.current = mergedConfigs;
            setPersonalConfigs(mergedConfigs);
            void savePersonalConfigs(mergedConfigs);

            const p = remoteState.preferences;
            const gamingModeInfo = data.modes.find((m) => m.id === 'gaming');
            if (p.selected_mode) {
              const safeMode: ConnectionModeId =
                p.selected_mode === 'gaming' && gamingModeInfo?.status === 'coming_soon'
                  ? 'web_browsing'
                  : p.selected_mode;
              setSelectedMode(safeMode);
              void setConnectionModeNative(safeMode).catch(() => {});
            }
            if (p.routing_mode) {
              setRoutingMode(p.routing_mode);
              void setRoutingModeNative(p.routing_mode).catch(() => {});
            }
            if (typeof p.split_tunneling === 'boolean') {
              setSplitTunneling(p.split_tunneling);
              void setSplitTunnelingNative(p.split_tunneling).catch(() => {});
            }
            if (typeof p.kill_switch === 'boolean') {
              setKillSwitch(p.kill_switch);
              void setKillSwitchNative(p.kill_switch).catch(() => {});
            }
            if (typeof p.auto_reconnect === 'boolean') {
              setAutoReconnect(p.auto_reconnect);
            }
            if (typeof p.ping_optimization_enabled === 'boolean') {
              setPingOptimizationEnabled(p.ping_optimization_enabled);
            }
            if (typeof p.use_warp === 'boolean') {
              const effectiveWarp =
                p.selected_mode === 'static_ip' || p.selected_mode === 'gaming'
                  ? false
                  : p.use_warp;
              setUseWarp(effectiveWarp);
              void setUseWarpNative(effectiveWarp).catch(() => {});
            }
            if (p.custom_dns) {
              setCustomDns(p.custom_dns);
            }
            if (typeof p.auto_mode === 'boolean') {
              setAutoMode(p.auto_mode);
            }
            if (p.lang) {
              setLang(p.lang);
            }
            if (p.theme) {
              setTheme(p.theme);
            }
            if (p.selected_outbound_id) {
              const matchedServer = data.outbounds.find((o) => o.id === p.selected_outbound_id);
              if (matchedServer) {
                syncedSelectedServer = outboundToSelection(matchedServer, undefined);
                void setActiveOutboundNative(matchedServer.id, null);
              } else {
                const matchedPersonal = mergedConfigs.find((c) => c.id === p.selected_outbound_id);
                if (matchedPersonal) {
                  syncedSelectedServer = {
                    kind: 'personal',
                    id: matchedPersonal.id,
                    name: matchedPersonal.name,
                    protocol: matchedPersonal.protocol,
                    country_code: matchedPersonal.country_code,
                    country_name:
                      matchedPersonal.country_code === 'XX'
                        ? t(langRef.current, 'personalCountry')
                        : matchedPersonal.country_code,
                    flag: matchedPersonal.flag,
                    server_address: matchedPersonal.server_address,
                    server_port: matchedPersonal.server_port,
                    latency_ms: matchedPersonal.latency_ms,
                    uri: matchedPersonal.uri,
                  };
                  void setActiveOutboundNative(null, matchedPersonal.uri);
                }
              }
            }

            window.setTimeout(() => {
              hydratingFromServerRef.current = false;
            }, 60);
          } else if (
            isFirstHydration &&
            !remoteState.updated_at &&
            personalConfigsRef.current.length > 0
          ) {
            const payload = buildSyncStatePayload(
              personalConfigsRef.current,
              syncedPrefsRef.current
            );
            void pushClientSyncState(activeSession.subscription_token, payload)
              .then((saved) => {
                const savedMs = parseIsoTimestampMs(saved.updated_at);
                if (savedMs > 0) lastRemoteStateUpdatedAtMsRef.current = savedMs;
              })
              .catch(() => {});
          }
          hasHydratedCloudStateRef.current = true;
        }

        if (!silent) {
          pushLog(
            'SYNC',
            `Synced ${data.outbounds.length} active outbounds (${data.subscription.tier}).`
          );
        }

        setActiveServer((current) => {
          if (syncedSelectedServer) {
            return syncedSelectedServer;
          }
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
          userWantsConnectedRef.current = false;
          hasHydratedCloudStateRef.current = false;
          lastRemoteStateUpdatedAtMsRef.current = 0;
          await logoutSession();
          setSession(null);
          setBootstrap(null);
          setAuthNotice(clean || t(langRef.current, 'sessionExpiredNotice'));
        } else if (!silent) {
          if (typeof navigator !== 'undefined' && !navigator.onLine) {
            pushLog('INFO', 'Offline mode active — running with locally cached configuration.');
          } else {
            setSyncError(msg);
            pushLog('WARN', `Live sync unavailable: ${msg}`);
          }
        }
      } finally {
        syncingInFlightRef.current = false;
        if (!silent) {
          setSyncing(false);
        }
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
        saveCachedDonationsSnapshot(activeSession.subscription_token, list);
      } catch (err) {
        if (typeof navigator === 'undefined' || navigator.onLine) {
          pushLog(
            'WARN',
            `Failed to load donations: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      } finally {
        setLoadingDonations(false);
      }
    },
    [pushLog]
  );

  // Persist active server selection locally so offline startups restore it immediately
  useEffect(() => {
    if (session?.subscription_token) {
      saveCachedActiveServer(session.subscription_token, activeServer);
    }
  }, [session?.subscription_token, activeServer]);

  // Log when the Service Worker finishes precaching static assets for offline use
  useEffect(() => {
    const onOfflineReady = () => {
      pushLog('INFO', 'Service Worker ready — static assets cached for instant offline boot.');
    };
    window.addEventListener('sentra:sw-offline-ready', onOfflineReady);
    return () => {
      window.removeEventListener('sentra:sw-offline-ready', onOfflineReady);
    };
  }, [pushLog]);

  // Startup bootstrap: hydrate instantly from last known local config cache (0ms offline boot), then sync in background
  useEffect(() => {
    let cancelled = false;
    const skipSplash = shouldSkipSplash();

    const init = async () => {
      const [restored, savedPersonal] = await Promise.all([
        restorePersistedSession(),
        loadPersonalConfigs(),
      ]);

      if (cancelled) return;
      setPersonalConfigs(savedPersonal);

      if (restored) {
        setSession(restored);

        // 1. Check local cached configuration synchronously first (then CacheStorage fallback)
        let cachedBootstrap = loadCachedBootstrapSnapshot(restored.subscription_token);
        if (!cachedBootstrap) {
          cachedBootstrap = await loadCachedBootstrapFromCacheStorage(restored.subscription_token);
        }
        const cachedDonations = loadCachedDonationsSnapshot(restored.subscription_token);
        const cachedSelection = loadCachedActiveServer(restored.subscription_token);

        if (cancelled) return;

        if (cachedDonations) {
          setDonations(cachedDonations);
        }

        if (cachedBootstrap) {
          const data = cachedBootstrap.data;
          setBootstrap(data);
          setLastConfigCachedAt(cachedBootstrap.cachedAt);

          const cachedRemoteState = normalizeRemoteClientState(data.client_state);
          if (cachedRemoteState) {
            hydratingFromServerRef.current = true;
            if (cachedRemoteState.updated_at) {
              lastRemoteStateUpdatedAtMsRef.current = parseIsoTimestampMs(
                cachedRemoteState.updated_at
              );
            }
            const merged = mergePersonalConfigs(
              savedPersonal,
              cachedRemoteState.personal_configs,
              cachedRemoteState.personal_configs.length > 0
            );
            personalConfigsRef.current = merged;
            setPersonalConfigs(merged);
            const p = cachedRemoteState.preferences;
            const cachedGamingInfo = data.modes.find((m) => m.id === 'gaming');
            if (p.selected_mode) {
              const safeMode: ConnectionModeId =
                p.selected_mode === 'gaming' && cachedGamingInfo?.status === 'coming_soon'
                  ? 'web_browsing'
                  : p.selected_mode;
              setSelectedMode(safeMode);
            }
            if (p.routing_mode) setRoutingMode(p.routing_mode);
            if (typeof p.split_tunneling === 'boolean') setSplitTunneling(p.split_tunneling);
            if (typeof p.kill_switch === 'boolean') setKillSwitch(p.kill_switch);
            if (typeof p.auto_reconnect === 'boolean') setAutoReconnect(p.auto_reconnect);
            if (typeof p.ping_optimization_enabled === 'boolean') {
              setPingOptimizationEnabled(p.ping_optimization_enabled);
            }
            if (typeof p.use_warp === 'boolean') {
              setUseWarp(
                p.selected_mode === 'static_ip' || p.selected_mode === 'gaming'
                  ? false
                  : p.use_warp
              );
            }
            if (p.custom_dns) setCustomDns(p.custom_dns);
            if (typeof p.auto_mode === 'boolean') setAutoMode(p.auto_mode);
            window.setTimeout(() => {
              hydratingFromServerRef.current = false;
            }, 60);
          }

          if (cachedSelection) {
            setActiveServer(cachedSelection);
          } else {
            const fastest = selectFastestHealthyServer(data.outbounds, {});
            const fallback = fastest?.node || data.outbounds[0];
            if (fallback) {
              setActiveServer(outboundToSelection(fallback, undefined));
            }
          }

          // Instant initialization! Do not block UI on splash or network latency
          setSplashDone(true);

          if (typeof navigator !== 'undefined' && navigator.onLine) {
            pushLog('SYNC', 'Initialized instantly from cached config; refreshing in background...');
            void syncWithServer(restored, { silent: true });
            void loadDonations(restored);
          } else {
            pushLog('INFO', 'Initialized instantly in offline mode from locally cached configuration.');
          }
          return;
        }

        // First-ever launch (no cached config yet)
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
          pushLog('WARN', 'Started offline with no prior cached configuration.');
          setSplashDone(true);
          return;
        }

        const minSplashDelay = skipSplash
          ? Promise.resolve()
          : new Promise<void>((resolve) => window.setTimeout(resolve, 900));
        setSplashStatusKey('splashSyncing');
        await Promise.all([syncWithServer(restored), minSplashDelay]);
        if (!cancelled) {
          void loadDonations(restored);
        }
      } else {
        const minSplashDelay =
          skipSplash || (typeof navigator !== 'undefined' && !navigator.onLine)
            ? Promise.resolve()
            : new Promise<void>((resolve) => window.setTimeout(resolve, 700));
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
  }, [syncWithServer, loadDonations, pushLog]);

  // Continuous background database sync (30s interval + focus / visibility / online events)
  const sessionToken = session?.subscription_token ?? null;
  useEffect(() => {
    if (!sessionToken) return;

    const triggerSilentSync = (force = false) => {
      const current = sessionRef.current;
      if (!current || !navigator.onLine) return;
      if (!force && Date.now() - lastSyncCompletedAtRef.current < 5_000) return;
      void syncWithServer(current, { silent: true });
      if (activeTabRef.current === 'donate') {
        void loadDonations(current);
      }
    };

    const pollTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        triggerSilentSync(true);
      }
    }, BOOTSTRAP_POLL_INTERVAL_MS);

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        triggerSilentSync(false);
      }
    };
    const onFocus = () => triggerSilentSync(false);
    const onOnline = () => triggerSilentSync(true);

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);

    return () => {
      window.clearInterval(pollTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
    };
  }, [sessionToken, syncWithServer, loadDonations]);

  // Debounced cloud sync whenever personal configs or preferences change
  const activeServerIdForSync = activeServer?.id ?? null;
  useEffect(() => {
    if (!sessionToken || !hasHydratedCloudStateRef.current || hydratingFromServerRef.current) {
      return;
    }

    if (syncStatePushTimerRef.current) {
      window.clearTimeout(syncStatePushTimerRef.current);
    }

    syncStatePushTimerRef.current = window.setTimeout(() => {
      syncStatePushTimerRef.current = null;
      const current = sessionRef.current;
      if (!current || hydratingFromServerRef.current) return;

      const payload = buildSyncStatePayload(personalConfigs, {
        selected_mode: selectedMode,
        routing_mode: routingMode,
        split_tunneling: splitTunneling,
        kill_switch: killSwitch,
        auto_reconnect: autoReconnect,
        ping_optimization_enabled: pingOptimizationEnabled,
        use_warp: useWarp,
        custom_dns: customDns,
        selected_outbound_id: activeServerIdForSync,
        auto_mode: autoMode,
        lang,
        theme,
      });

      void pushClientSyncState(current.subscription_token, payload)
        .then((saved) => {
          const savedMs = parseIsoTimestampMs(saved.updated_at);
          if (savedMs > 0) {
            lastRemoteStateUpdatedAtMsRef.current = savedMs;
          }
        })
        .catch(() => {
          // Will retry on next change or next sync cycle
        });
    }, STATE_PUSH_DEBOUNCE_MS);

    return () => {
      if (syncStatePushTimerRef.current) {
        window.clearTimeout(syncStatePushTimerRef.current);
        syncStatePushTimerRef.current = null;
      }
    };
  }, [
    sessionToken,
    personalConfigs,
    selectedMode,
    routingMode,
    splitTunneling,
    killSwitch,
    autoReconnect,
    pingOptimizationEnabled,
    useWarp,
    customDns,
    activeServerIdForSync,
    autoMode,
    lang,
    theme,
  ]);

  // Persist & synchronize Auto-Reconnect preference with native Rust/Android engines
  useEffect(() => {
    persistAutoReconnect(autoReconnect);
    void setAutoReconnectNative(autoReconnect).catch(() => {
      // ignore outside Tauri runtime
    });
  }, [autoReconnect]);

  // Check Android battery optimization on startup and whenever user returns from system Settings
  const refreshBatteryOptimizationStatus = useCallback(async () => {
    const status = await getBatteryOptimizationStatusNative();
    setBatteryOptStatus(status);
    if (status.isAndroid && !status.isOptimized) {
      setBatteryWarningDismissed(false);
      persistBatteryWarningDismissed(false);
    }
  }, []);

  useEffect(() => {
    void refreshBatteryOptimizationStatus();
    const handleResumeCheck = () => {
      if (document.visibilityState === 'visible') {
        void refreshBatteryOptimizationStatus();
      }
    };
    const handleFocusCheck = () => {
      void refreshBatteryOptimizationStatus();
    };
    document.addEventListener('visibilitychange', handleResumeCheck);
    window.addEventListener('focus', handleFocusCheck);
    return () => {
      document.removeEventListener('visibilitychange', handleResumeCheck);
      window.removeEventListener('focus', handleFocusCheck);
    };
  }, [refreshBatteryOptimizationStatus]);

  const handleOpenBatteryOptimizationSettings = useCallback(() => {
    void openBatteryOptimizationSettingsNative()
      .then((opened) => {
        if (opened) {
          pushLog('INFO', '[Battery] Opened Android battery optimization settings.');
        } else {
          showToast('error', t(langRef.current, 'batteryOptOpenFailed'));
        }
      })
      .catch(() => {
        showToast('error', t(langRef.current, 'batteryOptOpenFailed'));
      });
  }, [pushLog, showToast]);

  const handleDismissBatteryWarning = useCallback(() => {
    setBatteryWarningDismissed(true);
    persistBatteryWarningDismissed(true);
  }, []);

  // Monitor network switches (online / NetworkInformation change) and sleep/wake jumps
  useEffect(() => {
    type NavigatorWithConnection = Navigator & {
      connection?: NetworkConnectionSnapshot & {
        addEventListener?: (type: string, listener: () => void) => void;
        removeEventListener?: (type: string, listener: () => void) => void;
      };
    };

    const nav = navigator as NavigatorWithConnection;
    const conn = nav.connection;
    let lastFingerprint = buildNetworkFingerprint(conn, navigator.onLine);
    let lastTickMs = Date.now();

    const scheduleReconnect = (reason: ReconnectReason) => {
      const canReconnect = shouldTriggerAutoReconnect({
        autoReconnectEnabled: autoReconnectRef.current,
        userWantsConnected: userWantsConnectedRef.current,
        isOnline: navigator.onLine,
        isAuthenticated: Boolean(sessionRef.current),
        isReconnecting: isReconnectingRef.current,
        attemptsUsed: reconnectAttemptsRef.current,
      });
      if (!canReconnect) return;

      if (reconnectDebounceRef.current) {
        window.clearTimeout(reconnectDebounceRef.current);
      }

      reconnectDebounceRef.current = window.setTimeout(() => {
        reconnectDebounceRef.current = null;
        const stillCanReconnect = shouldTriggerAutoReconnect({
          autoReconnectEnabled: autoReconnectRef.current,
          userWantsConnected: userWantsConnectedRef.current,
          isOnline: navigator.onLine,
          isAuthenticated: Boolean(sessionRef.current),
          isReconnecting: isReconnectingRef.current,
          attemptsUsed: reconnectAttemptsRef.current,
        });
        if (!stillCanReconnect) return;

        isReconnectingRef.current = true;
        reconnectAttemptsRef.current += 1;
        setConnectionStatus('connecting');
        setConnectionError(null);
        setSessionTimer((prev) => pauseSessionTimer(prev, Date.now()));
        const noticeKey =
          reason === 'device_wake' ? 'reconnectingWake' : 'reconnectingNetwork';
        pushLog('INFO', `[AutoReconnect] ${t(langRef.current, noticeKey)}`);

        if (!isTauriRuntime()) {
          isReconnectingRef.current = false;
          return;
        }

        void reconnectVpnNative(reason)
          .then(() => {
            if (!userWantsConnectedRef.current) return;
            reconnectAttemptsRef.current = 0;
            const now = Date.now();
            setSessionNowMs(now);
            setSessionTimer((prev) => startOrResumeSessionTimer(prev, now));
            setConnectionStatus('connected');
            setConnectionError(null);
            showToast('success', t(langRef.current, 'reconnectedToast'));
          })
          .catch((err) => {
            if (!userWantsConnectedRef.current) return;
            const msg =
              err instanceof Error ? err.message : t(langRef.current, 'reconnectFailedToast');
            setConnectionStatus('error');
            setConnectionError(msg);
            pushLog('WARN', `[AutoReconnect] ${msg}`);
            showToast('error', t(langRef.current, 'reconnectFailedToast'));
          })
          .finally(() => {
            isReconnectingRef.current = false;
          });
      }, RECONNECT_DEBOUNCE_MS);
    };

    const handleOnline = () => {
      lastFingerprint = buildNetworkFingerprint(conn, true);
      scheduleReconnect('network_switch');
    };

    const handleConnectionChange = () => {
      const nextFp = buildNetworkFingerprint(conn, navigator.onLine);
      if (nextFp !== lastFingerprint) {
        lastFingerprint = nextFp;
        if (navigator.onLine) {
          scheduleReconnect('network_switch');
        }
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      const jumped = detectSleepWakeJump(lastTickMs, now);
      lastTickMs = now;
      if (jumped) {
        scheduleReconnect('device_wake');
      }
    };

    const wakeInterval = window.setInterval(() => {
      const now = Date.now();
      const jumped = detectSleepWakeJump(lastTickMs, now);
      lastTickMs = now;
      if (jumped) {
        scheduleReconnect('device_wake');
      }
    }, 5_000);

    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    conn?.addEventListener?.('change', handleConnectionChange);

    return () => {
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      conn?.removeEventListener?.('change', handleConnectionChange);
      window.clearInterval(wakeInterval);
      if (reconnectDebounceRef.current) {
        window.clearTimeout(reconnectDebounceRef.current);
        reconnectDebounceRef.current = null;
      }
    };
  }, [pushLog, showToast]);

  // Subscribe to native Tauri telemetry, logs, and System Tray / Android Notification status
  useEffect(() => {
    let cleanup: (() => void) | null = null;
    void subscribeNativeTelemetry(
      (snap) => {
        setTelemetry(snap);
        const now = Date.now();
        if (snap.uptime_seconds > 0) {
          setSessionNowMs(now);
          setSessionTimer((prev) => reconcileWithNativeUptime(prev, snap.uptime_seconds, now));
        }
        if (snap.ping_ms !== null && snap.ping_ms > 0) {
          lastNativePingAtRef.current = now;
          setLatencyNowMs(now);
          setLatencyHistory((prev) => appendLatencySample(prev, snap.ping_ms, now));
        }
        setTrafficNowMs(now);
        setTrafficHistory((prev) =>
          appendTrafficSample(prev, snap.download_speed_bps, snap.upload_speed_bps, now)
        );
      },
      (line) => pushLog('INFO', line),
      (status, errorMsg) => {
        const now = Date.now();
        setConnectionStatus(status);
        if (status === 'connected') {
          reconnectAttemptsRef.current = 0;
          setSessionNowMs(now);
          setSessionTimer((prev) => startOrResumeSessionTimer(prev, now));
        }
        if (status === 'disconnected') {
          setTelemetry(EMPTY_TELEMETRY);
          if (userWantsConnectedRef.current && autoReconnectRef.current) {
            setSessionTimer((prev) => pauseSessionTimer(prev, now));
          } else {
            setSessionTimer((prev) => stopSessionTimer(prev, now));
          }
        }
        if (errorMsg) {
          setConnectionError(errorMsg);
        } else if (status === 'connected' || status === 'disconnected') {
          setConnectionError(null);
        }
      },
      () => {
        if (sessionRef.current) {
          void syncWithServer(sessionRef.current, { silent: true });
        }
      }
    ).then((unsub) => {
      cleanup = unsub;
    });
    return () => {
      if (cleanup) cleanup();
    };
  }, [pushLog, syncWithServer]);

  // Persist Session Time state to localStorage on every transition
  useEffect(() => {
    savePersistedSessionTimer(sessionTimer);
  }, [sessionTimer]);

  // Tick Session Time counter in real time every second while an active segment is running
  const isSessionTimerRunning =
    sessionTimer.isActive && sessionTimer.activeSegmentStartedAtMs !== null;
  useEffect(() => {
    if (!isSessionTimerRunning) return;
    setSessionNowMs(Date.now());
    const timer = window.setInterval(() => {
      setSessionNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isSessionTimerRunning]);

  // Smoothly advance and prune the 60-second rolling latency & traffic windows every second
  const hasLatencyHistory = latencyHistory.length > 0;
  useEffect(() => {
    if (connectionStatus !== 'connected' && !hasLatencyHistory) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setLatencyNowMs(now);
      setLatencyHistory((prev) => pruneLatencyHistory(prev, now));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [connectionStatus, hasLatencyHistory]);

  const hasTrafficHistory = trafficHistory.length > 0;
  useEffect(() => {
    if (connectionStatus !== 'connected' && !hasTrafficHistory) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setTrafficNowMs(now);
      setTrafficHistory((prev) => pruneTrafficHistory(prev, now));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [connectionStatus, hasTrafficHistory]);

  // Reset latency & traffic chart histories when switching to a different server so histories never mix
  const activeServerId = activeServer?.id ?? null;
  const activeServerAddress = activeServer?.server_address ?? '';
  const activeServerPort = activeServer?.server_port ?? 0;
  const prevServerIdRef = useRef<string | null>(activeServerId);
  useEffect(() => {
    if (prevServerIdRef.current && prevServerIdRef.current !== activeServerId) {
      setLatencyHistory([]);
      setTrafficHistory([]);
    }
    prevServerIdRef.current = activeServerId;
  }, [activeServerId]);

  // While connected, probe real active-server RTT every 3s if native telemetry isn't emitting ping_ms
  useEffect(() => {
    if (connectionStatus !== 'connected' || !activeServerId || !activeServerAddress || activeServerPort <= 0) return;
    let cancelled = false;

    const sampleNow = async () => {
      if (cancelled) return;
      if (Date.now() - lastNativePingAtRef.current < 2500) return;
      const ms = await pingServerNode(activeServerAddress, activeServerPort);
      if (cancelled) return;
      const now = Date.now();
      setLatencyNowMs(now);
      setLatencyHistory((prev) => appendLatencySample(prev, ms, now));
      setLivePings((prev) => ({ ...prev, [activeServerId]: ms }));
      setActiveServer((curr) => (curr && curr.id === activeServerId ? { ...curr, latency_ms: ms } : curr));
    };

    void sampleNow();
    const interval = window.setInterval(() => {
      void sampleNow();
    }, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [connectionStatus, activeServerId, activeServerAddress, activeServerPort]);

  const handleAuthenticated = async (newSession: PersistedSession) => {
    setAuthNotice(null);
    hasHydratedCloudStateRef.current = false;
    lastRemoteStateUpdatedAtMsRef.current = 0;
    if (syncStatePushTimerRef.current) {
      window.clearTimeout(syncStatePushTimerRef.current);
      syncStatePushTimerRef.current = null;
    }
    setSession(newSession);
    pushLog('INFO', `Signed in as ${newSession.username || 'user'}. Session persisted.`);
    await syncWithServer(newSession);
    void loadDonations(newSession);
  };

  const handleLogout = async () => {
    userWantsConnectedRef.current = false;
    reconnectAttemptsRef.current = 0;
    hasHydratedCloudStateRef.current = false;
    lastRemoteStateUpdatedAtMsRef.current = 0;
    if (syncStatePushTimerRef.current) {
      window.clearTimeout(syncStatePushTimerRef.current);
      syncStatePushTimerRef.current = null;
    }
    if (reconnectDebounceRef.current) {
      window.clearTimeout(reconnectDebounceRef.current);
      reconnectDebounceRef.current = null;
    }
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
    setSessionTimer(EMPTY_SESSION_TIMER);
    clearPersistedSessionTimer();
    setLatencyHistory([]);
    setTrafficHistory([]);
    setLastPingOptimizedAt(null);
    setPingOptimizing(false);
    lastOptimizedOrderIdsRef.current = [];
    setActiveTab('home');
    pushLog('INFO', 'Signed out and cleared local session.');
  };

  const handleSelectMode = async (mode: ConnectionModeId) => {
    const modeMeta = bootstrap?.modes?.find((m) => m.id === mode);
    if (modeMeta?.status === 'coming_soon' || (!modeMeta && mode === 'gaming')) {
      showToast('info', t(lang, 'gamingComingSoonToast'));
      return;
    }

    setSelectedMode(mode);
    if (mode === 'static_ip') {
      setRoutingMode('tunnel');
      setKillSwitch(true);
      setUseWarp(false);
    } else if (mode === 'gaming') {
      setRoutingMode('tunnel');
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
        if (activeServerRef.current?.id === id) {
          const now = Date.now();
          setLatencyNowMs(now);
          setLatencyHistory((prev) => appendLatencySample(prev, ms, now));
        }
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
      if (serverList.length > 0 && pingOptimizationEnabledRef.current) {
        const now = Date.now();
        lastPingOptimizedAtRef.current = now;
        setLastPingOptimizedAt(now);
      }
    }
  }, [bootstrap, personalConfigs, handlePingNode, pushLog]);

  // Persist Ping Optimization toggle across sessions
  useEffect(() => {
    persistPingOptimizationEnabled(pingOptimizationEnabled);
  }, [pingOptimizationEnabled]);

  const runPingOptimizationPass = useCallback(async () => {
    const nodes = outboundsRef.current;
    if (nodes.length === 0 || pingOptimizingRef.current) return;
    // Never generate background probe traffic while actively connected in Gaming mode (prevents ping spikes/jitter)
    if (
      connectionStatusRef.current === 'connected' &&
      selectedModeRef.current === 'gaming'
    ) {
      return;
    }

    pingOptimizingRef.current = true;
    setPingOptimizing(true);
    try {
      const probeTargets = nodes.filter((node) => node.is_online !== false);
      const results = await Promise.all(
        probeTargets.map(async (node) => {
          try {
            const ms = await pingServerNode(node.server_address, node.server_port);
            return [node.id, ms] as const;
          } catch {
            return [node.id, null] as const;
          }
        })
      );

      // Abort committing if user signed out mid-sweep
      if (!sessionRef.current) return;

      const mergedPings: Record<string, number | null> = { ...livePingsRef.current };
      for (const [id, ms] of results) {
        mergedPings[id] = ms;
      }

      livePingsRef.current = mergedPings;
      setLivePings(mergedPings);

      const currentActive = activeServerRef.current;
      if (currentActive && currentActive.id in mergedPings) {
        const latestMs = mergedPings[currentActive.id];
        setActiveServer((curr) =>
          curr && curr.id === currentActive.id ? { ...curr, latency_ms: latestMs } : curr
        );
      }

      const now = Date.now();
      lastPingOptimizedAtRef.current = now;
      setLastPingOptimizedAt(now);

      if (pingOptimizationEnabledRef.current) {
        const currentOutbounds = outboundsRef.current;
        const previousOrder =
          lastOptimizedOrderIdsRef.current.length > 0
            ? lastOptimizedOrderIdsRef.current.map((id) => ({ id }))
            : currentOutbounds;
        const sorted = sortOutboundsByLatency(currentOutbounds, mergedPings);
        const nextIds = sorted.map((n) => n.id);
        const changed = didOutboundOrderChange(previousOrder, sorted);
        lastOptimizedOrderIdsRef.current = nextIds;

        // If Auto Select is active and tunnel is idle, keep its target synced to the fastest healthy node
        if (autoModeRef.current && connectionStatusRef.current === 'disconnected') {
          const fastest = selectFastestHealthyServer(currentOutbounds, mergedPings);
          if (fastest) {
            const nextSelection = outboundToSelection(fastest.node, fastest.latencyMs);
            setActiveServer(nextSelection);
            void setActiveOutboundNative(fastest.node.id, null);
          }
        }

        if (changed) {
          const topNode = sorted[0];
          const topLatency = topNode ? resolveOutboundLatency(topNode, mergedPings).latencyMs : null;
          pushLog(
            'INFO',
            topNode && topLatency !== null
              ? `Ping Optimization re-sorted ${sorted.length} outbounds (fastest: ${topNode.name} · ${topLatency} ms).`
              : `Ping Optimization re-sorted ${sorted.length} outbounds.`
          );
        }
      }
    } finally {
      pingOptimizingRef.current = false;
      setPingOptimizing(false);
    }
  }, [pushLog]);

  const outboundsCount = bootstrap?.outbounds.length ?? 0;

  // Periodic automated Ping Optimization loop (probes + re-sorts every 30s while visible)
  useEffect(() => {
    if (!session || !pingOptimizationEnabled || outboundsCount === 0) return;

    const evaluateAndRun = () => {
      const isVisible =
        typeof document === 'undefined' ? true : document.visibilityState !== 'hidden';
      if (
        shouldRunPeriodicPingOptimization({
          enabled: pingOptimizationEnabledRef.current,
          outboundsCount: outboundsRef.current.length,
          isTestingAll: testingAllRef.current,
          isAutoResolving: autoResolvingRef.current,
          isOptimizing: pingOptimizingRef.current,
          isDocumentVisible: isVisible,
          lastRunAtMs: lastPingOptimizedAtRef.current,
          nowMs: Date.now(),
          intervalMs: PING_OPT_INTERVAL_MS,
        })
      ) {
        void runPingOptimizationPass();
      }
    };

    // Run immediately on opening Profiles or initial enablement when stale/never run
    if (activeTab === 'profiles' || lastPingOptimizedAtRef.current === null) {
      evaluateAndRun();
    }

    const scheduler = window.setInterval(evaluateAndRun, 5000);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        evaluateAndRun();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      window.clearInterval(scheduler);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [session, pingOptimizationEnabled, outboundsCount, activeTab, runPingOptimizationPass]);

  const handleTogglePingOptimization = useCallback(
    (enabled: boolean) => {
      setPingOptimizationEnabled(enabled);
      pingOptimizationEnabledRef.current = enabled;
      pushLog('INFO', `Automated Ping Optimization ${enabled ? 'enabled' : 'paused'}.`);
    },
    [pushLog]
  );

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
      userWantsConnectedRef.current = false;
      reconnectAttemptsRef.current = 0;
      if (reconnectDebounceRef.current) {
        window.clearTimeout(reconnectDebounceRef.current);
        reconnectDebounceRef.current = null;
      }
      try {
        await disconnectVpnNative();
      } finally {
        const now = Date.now();
        setConnectionStatus('disconnected');
        setTelemetry(EMPTY_TELEMETRY);
        setSessionNowMs(now);
        setSessionTimer((prev) => stopSessionTimer(prev, now));
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

    userWantsConnectedRef.current = true;
    reconnectAttemptsRef.current = 0;
    setConnectionStatus('connecting');
    pushLog('INFO', `Connecting to ${targetServer.name} (${targetServer.protocol})...`);
    try {
      await connectVpnNative();
      const now = Date.now();
      setSessionNowMs(now);
      setSessionTimer((prev) => startOrResumeSessionTimer(prev, now));
      setConnectionStatus('connected');
      pushLog('INFO', `Connected securely to ${targetServer.name}.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t(lang, 'connectFailed');
      userWantsConnectedRef.current = false;
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

  const handleAddPersonalConfig = (
    item: PersonalConfigItem,
    options?: { publishToEcosystem?: boolean }
  ) => {
    setPersonalConfigs((prev) => {
      const next = [item, ...prev];
      void savePersonalConfigs(next);
      return next;
    });
    handleSelectPersonalConfig(item);
    setActiveTab('profiles');
    showToast('success', t(lang, 'configAddedToast', { name: item.name }));

    if (options?.publishToEcosystem !== false && session && !item.is_subscription) {
      void addEcosystemOutboundToServer(session.subscription_token, {
        uri: item.uri,
        name: item.name,
      })
        .then((res) => {
          pushLog('SYNC', `Outbound "${item.name}" activated across the Sentra ecosystem.`);
          if (res.message) {
            showToast('success', res.message);
          }
          void syncWithServer(session, { silent: true });
          void loadDonations(session);
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          pushLog('WARN', `Ecosystem activation skipped for "${item.name}": ${msg}`);
        });
    }
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
    pushLog('SYNC', `Donated outbound "${payload.name || 'custom'}" activated in ecosystem.`);
    showToast('success', res.message || t(lang, 'donationSubmittedDefault'));
    void loadDonations(session);
    void syncWithServer(session, { silent: true });
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
      <>
        <AuthView
          lang={lang}
          onChangeLanguage={setLang}
          theme={theme}
          onToggleTheme={toggleTheme}
          onAuthenticated={handleAuthenticated}
          initialNotice={authNotice}
          botUsername={bootstrap?.bot_username}
        />
        <OfflineIndicator lang={lang} />
      </>
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

        <BatteryOptimizationBanner
          lang={lang}
          visible={shouldShowBatteryOptimizationWarning({
            status: batteryOptStatus,
            autoReconnectEnabled: autoReconnect,
            dismissed: batteryWarningDismissed,
          })}
          onOpenSettings={handleOpenBatteryOptimizationSettings}
          onDismiss={handleDismissBatteryWarning}
        />

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
              sessionSeconds={computeSessionDurationSeconds(sessionTimer, sessionNowMs)}
              isSessionTimerRunning={isSessionTimerRunning}
              latencyHistory={latencyHistory}
              latencyNowMs={latencyNowMs}
              trafficHistory={trafficHistory}
              trafficNowMs={trafficNowMs}
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
              pingOptimizationEnabled={pingOptimizationEnabled}
              pingOptimizing={pingOptimizing}
              lastPingOptimizedAt={lastPingOptimizedAt}
              onTogglePingOptimization={handleTogglePingOptimization}
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
              autoReconnect={autoReconnect}
              batteryOptStatus={batteryOptStatus}
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
              onToggleAutoReconnect={(v) => {
                setAutoReconnect(v);
                pushLog(
                  'INFO',
                  `Auto-Reconnect on network switch & wake ${v ? 'enabled' : 'disabled'}.`
                );
              }}
              onOpenBatteryOptimizationSettings={handleOpenBatteryOptimizationSettings}
              onToggleWarp={(v) => {
                setUseWarp(v);
                void setUseWarpNative(v);
              }}
              onChangeCustomDns={setCustomDns}
              onRemoveDevice={handleRemoveDevice}
              onRequestTelegramLinkCode={handleRequestTelegramLink}
              onLogEvent={(msg) => pushLog('INFO', msg)}
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

      <OfflineIndicator lang={lang} cachedAt={lastConfigCachedAt} />

      {/* Toast Notification */}
      {toast && (
        <div
          role="status"
          className={`fixed top-16 md:top-auto md:bottom-6 end-4 md:end-6 z-50 max-w-sm rounded-xl border px-4 py-3 text-xs font-semibold shadow-xl backdrop-blur-md transition-opacity duration-200 ${
            toast.kind === 'error'
              ? 'border-rose-500/40 bg-rose-950/90 text-rose-100'
              : toast.kind === 'info'
              ? 'border-amber-500/45 bg-slate-900/95 text-amber-100'
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
