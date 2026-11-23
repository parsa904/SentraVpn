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

export const App: React.FC = () => {
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme);
  const [splashDone, setSplashDone] = useState<boolean>(shouldSkipSplash);
  const [splashStatus, setSplashStatus] = useState<string>('بررسی نشست کاربری و همگام‌سازی...');
  const [session, setSession] = useState<PersistedSession | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(null);

  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

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

  const pushLog = useCallback((level: LogEntry['level'], message: string) => {
    setLogs((prev) => [...prev.slice(-199), makeLogEntry(level, message)]);
  }, []);

  const showToast = useCallback((kind: 'success' | 'error', text: string) => {
    setToast({ kind, text });
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 4200);
  }, []);

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

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  const syncWithServer = useCallback(
    async (activeSession: PersistedSession) => {
      setSyncing(true);
      setSyncError(null);
      pushLog('SYNC', 'درخواست دریافت اطلاعات اشتراک و اوتباندهای زنده از سرور...');
      try {
        const data = await fetchBootstrap(activeSession.subscription_token);
        setBootstrap(data);
        pushLog(
          'SYNC',
          `همگام‌سازی موفق: ${data.outbounds.length} اوتباند فعال دریافت شد (${data.subscription.tier}).`
        );

        // Auto-select first online outbound if nothing selected yet
        setActiveServer((current) => {
          if (current) {
            if (current.kind === 'server') {
              const refreshed = data.outbounds.find((o) => o.id === current.id);
              if (refreshed) {
                return {
                  kind: 'server',
                  id: refreshed.id,
                  name: refreshed.name,
                  protocol: refreshed.protocol,
                  country_code: refreshed.country_code,
                  country_name: refreshed.country_name,
                  flag: refreshed.flag || '🌐',
                  server_address: refreshed.server_address,
                  server_port: refreshed.server_port,
                  latency_ms: refreshed.latency_ms > 0 ? refreshed.latency_ms : current.latency_ms,
                  uri: refreshed.uri,
                };
              }
            }
            return current;
          }
          const first = data.outbounds[0];
          if (!first) return null;
          void setActiveOutboundNative(first.id, null);
          return {
            kind: 'server',
            id: first.id,
            name: first.name,
            protocol: first.protocol,
            country_code: first.country_code,
            country_name: first.country_name,
            flag: first.flag || '🌐',
            server_address: first.server_address,
            server_port: first.server_port,
            latency_ms: first.latency_ms > 0 ? first.latency_ms : null,
            uri: first.uri,
          };
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'خطا در همگام‌سازی با سرور';
        if (msg.startsWith('AUTH_EXPIRED:')) {
          const clean = msg.replace('AUTH_EXPIRED:', '').trim();
          pushLog('ERROR', `نشست منقضی شد: ${clean}`);
          await logoutSession();
          setSession(null);
          setBootstrap(null);
          setAuthNotice(clean || 'نشست کاربری شما منقضی شده است. لطفاً دوباره وارد شوید.');
        } else {
          setSyncError(msg);
          pushLog('WARN', `عدم دریافت همگام‌سازی زنده: ${msg}`);
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
          `دریافت تاریخچه اوتباندهای اهدایی ناموفق بود: ${err instanceof Error ? err.message : String(err)}`
        );
      } finally {
        setLoadingDonations(false);
      }
    },
    [pushLog]
  );

  // Startup bootstrap: restore persisted auth + personal configs in parallel with ~1.3s splash logo
  useEffect(() => {
    let cancelled = false;
    const skipSplash = shouldSkipSplash();

    const init = async () => {
      const minSplashDelay = skipSplash
        ? Promise.resolve()
        : new Promise<void>((resolve) => window.setTimeout(resolve, 1300));

      const [restored, savedPersonal] = await Promise.all([
        restorePersistedSession(),
        loadPersonalConfigs(),
      ]);

      if (cancelled) return;
      setPersonalConfigs(savedPersonal);

      if (restored) {
        setSession(restored);
        setSplashStatus('در حال همگام‌سازی اوتباندهای زنده...');
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

  // Subscribe to native Tauri telemetry & logs when available
  useEffect(() => {
    let cleanup: (() => void) | null = null;
    void subscribeNativeTelemetry(
      (snap) => setTelemetry(snap),
      (line) => pushLog('INFO', line)
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
    pushLog('INFO', `ورود موفق با حساب ${newSession.username || 'کاربر'}. نشست به‌صورت دائمی ذخیره شد.`);
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
    setConnectionStatus('disconnected');
    setTelemetry(EMPTY_TELEMETRY);
    setActiveTab('home');
    pushLog('INFO', 'خروج از حساب انجام شد و نشست محلی پاک شد.');
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
      pushLog('INFO', `حالت اتصال به ${mode} تغییر یافت.`);
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'تغییر حالت اتصال ناموفق بود.');
    }
  };

  const handleToggleConnect = async () => {
    setConnectionError(null);
    if (connectionStatus === 'connected' || connectionStatus === 'connecting') {
      try {
        await disconnectVpnNative();
      } finally {
        setConnectionStatus('disconnected');
        setTelemetry(EMPTY_TELEMETRY);
        pushLog('INFO', 'اتصال VPN قطع شد.');
      }
      return;
    }

    if (!activeServer) {
      setConnectionError('ابتدا یک سرور یا کانفیگ شخصی از بخش «پروفایل‌ها و کانفیگ‌ها» انتخاب کنید.');
      return;
    }

    setConnectionStatus('connecting');
    pushLog('INFO', `شروع اتصال به ${activeServer.name} (${activeServer.protocol})...`);
    try {
      await connectVpnNative();
      setConnectionStatus('connected');
      pushLog('INFO', `اتصال امن به ${activeServer.name} برقرار شد.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'برقراری اتصال ناموفق بود.';
      setConnectionStatus('error');
      setConnectionError(msg);
      pushLog('ERROR', msg);
    }
  };

  const handleSelectServerOutbound = (node: LiveOutboundNode) => {
    const selection: ActiveServerSelection = {
      kind: 'server',
      id: node.id,
      name: node.name,
      protocol: node.protocol,
      country_code: node.country_code,
      country_name: node.country_name,
      flag: node.flag || '🌐',
      server_address: node.server_address,
      server_port: node.server_port,
      latency_ms: node.id in livePings ? livePings[node.id] : node.latency_ms > 0 ? node.latency_ms : null,
      uri: node.uri,
    };
    setActiveServer(selection);
    void setActiveOutboundNative(node.id, null);
    pushLog('INFO', `سرور فعال روی ${node.name} (${node.protocol}) تنظیم شد.`);
    showToast('success', `سرور «${node.name}» انتخاب شد.`);
  };

  const handleSelectPersonalConfig = (cfg: PersonalConfigItem) => {
    const selection: ActiveServerSelection = {
      kind: 'personal',
      id: cfg.id,
      name: cfg.name,
      protocol: cfg.protocol,
      country_code: cfg.country_code,
      country_name: cfg.country_code === 'XX' ? 'شخصی' : cfg.country_code,
      flag: cfg.flag,
      server_address: cfg.server_address,
      server_port: cfg.server_port,
      latency_ms: cfg.id in livePings ? livePings[cfg.id] : cfg.latency_ms,
      uri: cfg.uri,
    };
    setActiveServer(selection);
    void setActiveOutboundNative(null, cfg.uri);
    pushLog('INFO', `کانفیگ شخصی «${cfg.name}» به عنوان سرور فعال انتخاب شد.`);
    showToast('success', `کانفیگ شخصی «${cfg.name}» انتخاب شد.`);
  };

  const handlePingNode = async (id: string, host: string, port: number) => {
    setPingingIds((prev) => ({ ...prev, [id]: true }));
    try {
      const ms = await pingServerNode(host, port);
      setLivePings((prev) => ({ ...prev, [id]: ms }));
      setActiveServer((curr) => (curr && curr.id === id ? { ...curr, latency_ms: ms } : curr));
      pushLog('INFO', `پینگ واقعی ${host}:${port} = ${ms ? `${ms} ms` : 'عدم پاسخ'}`);
    } finally {
      setPingingIds((prev) => ({ ...prev, [id]: false }));
    }
  };

  const handlePingAllOutbounds = async () => {
    const list = bootstrap?.outbounds || [];
    if (list.length === 0) return;
    pushLog('INFO', `شروع تست پینگ واقعی برای ${list.length} اوتباند...`);
    await Promise.all(
      list.map((node) => handlePingNode(node.id, node.server_address, node.server_port))
    );
  };

  const handleAddPersonalConfig = (item: PersonalConfigItem) => {
    setPersonalConfigs((prev) => {
      const next = [item, ...prev];
      void savePersonalConfigs(next);
      return next;
    });
    handleSelectPersonalConfig(item);
    setActiveTab('profiles');
    showToast('success', `کانفیگ «${item.name}» با موفقیت اضافه شد.`);
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
    showToast('success', 'کانفیگ شخصی حذف شد.');
  };

  const handleDonateSubmit = async (payload: {
    uri: string;
    name?: string;
    note?: string;
  }): Promise<{ message?: string }> => {
    if (!session) throw new Error('ابتدا وارد حساب کاربری خود شوید.');
    const res = await donateOutboundToServer(session.subscription_token, payload);
    pushLog('SYNC', `اوتباند اهدایی «${payload.name || 'جدید'}» برای بررسی ادمین ارسال شد.`);
    showToast(
      'success',
      res.message || 'اوتباند شما برای تایید ادمین ارسال شد. پس از تایید، اشتراک رایگان فعال می‌شود.'
    );
    void loadDonations(session);
    return res;
  };

  const handleRemoveDevice = async (deviceId: string) => {
    if (!session) return;
    await removeUserDevice(session.subscription_token, deviceId);
    pushLog('INFO', `دستگاه ${deviceId} از حساب حذف شد.`);
    showToast('success', 'دستگاه با موفقیت حذف شد.');
    await syncWithServer(session);
  };

  const handleRequestTelegramLink = async (): Promise<string> => {
    if (!session) throw new Error('ابتدا وارد حساب کاربری شوید.');
    const code = await requestTelegramLinkCode(session.subscription_token);
    pushLog('INFO', 'کد اتصال حساب تلگرام صادر شد.');
    return code;
  };

  if (!splashDone) {
    return <SplashScreen statusText={splashStatus} />;
  }

  if (!session) {
    return (
      <AuthView
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
          subscription={bootstrap?.subscription || null}
          syncing={syncing}
          onSync={() => void syncWithServer(session)}
          onOpenAddConfig={() => setAddConfigOpen(true)}
        />

        {syncError && (
          <div
            role="status"
            className="flex items-center justify-between gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 md:px-6 py-2 text-xs text-amber-800 dark:text-amber-200"
          >
            <span>{syncError}</span>
            <button
              type="button"
              onClick={() => void syncWithServer(session)}
              className="shrink-0 font-semibold underline"
            >
              تلاش مجدد
            </button>
          </div>
        )}

        <main className="relative flex flex-1 flex-col overflow-hidden">
          {activeTab === 'home' && (
            <HomeView
              connectionStatus={connectionStatus}
              connectionError={connectionError}
              selectedMode={selectedMode}
              modes={bootstrap?.modes || []}
              activeServer={activeServer}
              telemetry={telemetry}
              pingingActive={Boolean(activeServer && pingingIds[activeServer.id])}
              onToggleConnect={handleToggleConnect}
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
              outbounds={outbounds}
              personalConfigs={personalConfigs}
              activeServer={activeServer}
              livePings={livePings}
              pingingIds={pingingIds}
              syncing={syncing}
              onSync={() => void syncWithServer(session)}
              onOpenAddConfig={() => setAddConfigOpen(true)}
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
              personalConfigs={personalConfigs}
              donations={donations}
              loadingDonations={loadingDonations}
              onRefreshDonations={() => void loadDonations(session)}
              onSubmitDonation={handleDonateSubmit}
            />
          )}

          {activeTab === 'settings' && (
            <SettingsView
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
            <LogsView logs={logs} onClearLogs={() => setLogs([])} />
          )}
        </main>
      </div>

      {/* Modals */}
      <AddConfigModal
        open={addConfigOpen}
        onClose={() => setAddConfigOpen(false)}
        onAddConfig={handleAddPersonalConfig}
      />

      <DonateModal
        config={donateModalConfig}
        onClose={() => setDonateModalConfig(null)}
        onConfirmDonate={handleDonateSubmit}
      />

      {/* Toast Notification */}
      {toast && (
        <div
          role="status"
          className={`fixed top-16 md:top-auto md:bottom-6 left-4 md:left-6 z-50 max-w-sm rounded-xl border px-4 py-3 text-xs font-semibold shadow-xl backdrop-blur-md ${
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
