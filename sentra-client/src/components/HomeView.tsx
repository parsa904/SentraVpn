import React from 'react';
import {
  Activity,
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Download,
  Globe,
  Lock,
  Power,
  ShieldCheck,
  Zap,
} from 'lucide-react';
import type {
  ActiveServerSelection,
  ConnectionModeId,
  ConnectionModeItem,
  ConnectionStatus,
  TelemetrySnapshot,
} from '../types/sentra';
import { type Language, type TranslationKey, t } from '../i18n/translations';
import {
  formatDuration,
  formatPing,
  formatSpeed,
  getLatencyTier,
} from '../utils/proxyParser';
import { WorldMapBackdrop } from './WorldMapBackdrop';

interface HomeViewProps {
  lang: Language;
  connectionStatus: ConnectionStatus;
  connectionError: string | null;
  selectedMode: ConnectionModeId;
  modes: ConnectionModeItem[];
  activeServer: ActiveServerSelection | null;
  autoMode: boolean;
  autoResolving: boolean;
  telemetry: TelemetrySnapshot;
  pingingActive: boolean;
  activeServerTested: boolean;
  onToggleConnect: () => void;
  onSelectMode: (mode: ConnectionModeId) => void;
  onOpenProfiles: () => void;
  onPingActiveServer: () => void;
}

const MODE_DEFINITIONS: Array<{
  id: ConnectionModeId;
  labelKey: TranslationKey;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}> = [
  { id: 'web_browsing', labelKey: 'modeWeb', icon: Globe },
  { id: 'download', labelKey: 'modeDownload', icon: Download },
  { id: 'static_ip', labelKey: 'modeStaticIp', icon: ShieldCheck },
];

export const HomeView: React.FC<HomeViewProps> = ({
  lang,
  connectionStatus,
  connectionError,
  selectedMode,
  modes,
  activeServer,
  autoMode,
  autoResolving,
  telemetry,
  pingingActive,
  activeServerTested,
  onToggleConnect,
  onSelectMode,
  onOpenProfiles,
  onPingActiveServer,
}) => {
  const isConnected = connectionStatus === 'connected';
  const isConnecting = connectionStatus === 'connecting' || autoResolving;
  const isRtl = lang === 'fa';
  const ChevronIcon = isRtl ? ChevronLeft : ChevronRight;

  const modeById = new Map(modes.map((m) => [m.id, m]));

  const statusLabel = isConnected
    ? t(lang, 'statusConnected')
    : autoResolving
    ? t(lang, 'autoTesting')
    : isConnecting
    ? t(lang, 'statusConnecting')
    : connectionStatus === 'error'
    ? t(lang, 'statusError')
    : t(lang, 'statusDisconnected');

  const displayPing = telemetry.ping_ms ?? activeServer?.latency_ms ?? null;
  const pingTier = getLatencyTier(displayPing, activeServerTested);
  const pingColorClass =
    pingTier === 'good'
      ? 'text-emerald-600 dark:text-emerald-400'
      : pingTier === 'fair'
      ? 'text-amber-600 dark:text-amber-400'
      : pingTier === 'poor' || pingTier === 'timeout'
      ? 'text-rose-600 dark:text-rose-400'
      : 'text-slate-600 dark:text-slate-300';

  return (
    <section className="relative flex flex-1 flex-col justify-between overflow-y-auto overflow-x-hidden px-4 md:px-8 py-5 pb-24 md:pb-8 animate-sentra-view">
      <WorldMapBackdrop
        activeCountryCode={activeServer?.country_code}
        isConnected={isConnected}
      />

      {/* Top Mode Selector (strictly 3 modes: Web, Download, Static IP — Gaming hidden) */}
      <div className="relative z-10 mx-auto w-full max-w-md shrink-0">
        <div
          role="radiogroup"
          aria-label={t(lang, 'connectionModeAria')}
          className="grid grid-cols-3 gap-1.5 rounded-2xl border border-slate-200/80 dark:border-slate-800/90 bg-white/80 dark:bg-slate-900/75 p-1.5 backdrop-blur-md"
        >
          {MODE_DEFINITIONS.map((m) => {
            const Icon = m.icon;
            const serverInfo = modeById.get(m.id);
            const isLocked = serverInfo?.status === 'locked';
            const isSelected = selectedMode === m.id;
            return (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={isSelected}
                disabled={isLocked}
                onClick={() => onSelectMode(m.id)}
                className={`flex items-center justify-center gap-1.5 rounded-xl px-2.5 py-2 text-xs font-semibold whitespace-nowrap transition duration-150 active:scale-[0.97] ${
                  isSelected
                    ? 'bg-emerald-600 text-white shadow-sm shadow-emerald-600/25'
                    : isLocked
                    ? 'cursor-not-allowed text-slate-400 dark:text-slate-600'
                    : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/80'
                }`}
              >
                {isLocked ? <Lock size={13} className="shrink-0" /> : <Icon size={13} className="shrink-0" />}
                <span className="truncate">{t(lang, m.labelKey)}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Center Hero Power Orb */}
      <div className="relative z-10 my-auto flex flex-col items-center justify-center py-6">
        <div className="relative flex items-center justify-center">
          {isConnecting && (
            <>
              <span className="pointer-events-none absolute h-52 w-52 rounded-full border border-emerald-500/40 animate-sentra-ripple" />
              <span className="pointer-events-none absolute h-52 w-52 rounded-full border border-emerald-500/30 animate-sentra-ripple-delayed" />
            </>
          )}
          {isConnected && (
            <span className="pointer-events-none absolute h-56 w-56 rounded-full bg-emerald-500/18 blur-2xl" />
          )}

          {/* Outer hairline ring */}
          <div
            className={`relative flex h-44 w-44 items-center justify-center rounded-full border transition-all duration-200 ${
              isConnected
                ? 'border-emerald-500/50 bg-emerald-500/8 shadow-2xl shadow-emerald-500/20'
                : isConnecting
                ? 'border-emerald-500/40 bg-emerald-500/5'
                : 'border-slate-300/80 dark:border-slate-700/80 bg-white/60 dark:bg-slate-900/60 shadow-xl shadow-slate-950/10 dark:shadow-black/30'
            }`}
          >
            {isConnecting && (
              <svg
                className="pointer-events-none absolute inset-0 h-full w-full animate-sentra-orbit"
                viewBox="0 0 176 176"
                aria-hidden="true"
              >
                <circle
                  cx="88"
                  cy="88"
                  r="85"
                  fill="none"
                  stroke="#10B981"
                  strokeWidth="2.5"
                  strokeDasharray="110 420"
                  strokeLinecap="round"
                />
              </svg>
            )}

            <button
              type="button"
              onClick={onToggleConnect}
              aria-label={isConnected ? t(lang, 'disconnectAria') : t(lang, 'connectAria')}
              className={`group flex h-32 w-32 flex-col items-center justify-center gap-2 rounded-full transition-transform duration-150 focus:outline-none focus-visible:ring-4 focus-visible:ring-emerald-500/30 ${
                isConnected
                  ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-600/35 hover:bg-emerald-500 active:scale-[0.96]'
                  : isConnecting
                  ? 'bg-emerald-600/90 text-white active:scale-[0.97]'
                  : 'bg-slate-900 dark:bg-white text-white dark:text-slate-950 hover:scale-[1.03] active:scale-[0.96]'
              }`}
            >
              <Power
                size={34}
                className={`transition-transform duration-150 ${
                  isConnected ? 'scale-105' : 'group-hover:scale-110'
                }`}
              />
              <span className="text-xs font-bold tracking-tight">
                {isConnected
                  ? t(lang, 'disconnect')
                  : isConnecting
                  ? t(lang, 'connecting')
                  : t(lang, 'connect')}
              </span>
            </button>
          </div>
        </div>

        {/* Status, Timer & Real Latency */}
        <div className="mt-5 flex flex-col items-center gap-2 text-center">
          <div className="flex items-center gap-2">
            <span
              className={`h-2 w-2 rounded-full ${
                isConnected
                  ? 'bg-emerald-500'
                  : isConnecting
                  ? 'bg-amber-400 animate-pulse'
                  : connectionStatus === 'error'
                  ? 'bg-rose-500'
                  : 'bg-slate-400 dark:bg-slate-600'
              }`}
            />
            <span className="text-base font-bold text-slate-900 dark:text-white">
              {statusLabel}
            </span>
          </div>

          <div className="flex items-center gap-4 text-xs text-slate-500 dark:text-slate-400">
            <span className="font-mono tabular-nums" dir="ltr">
              {formatDuration(telemetry.uptime_seconds)}
            </span>
            <span className="h-3.5 w-px bg-slate-300 dark:bg-slate-700" />
            <button
              type="button"
              onClick={onPingActiveServer}
              disabled={!activeServer || pingingActive}
              aria-label={t(lang, 'testActivePingAria')}
              className={`inline-flex items-center gap-1.5 font-mono tabular-nums hover:opacity-80 disabled:opacity-50 transition ${pingColorClass}`}
              dir="ltr"
            >
              <Activity size={14} className={pingingActive ? 'animate-pulse text-emerald-500' : ''} />
              <span>{pingingActive ? '...' : formatPing(displayPing, lang, activeServerTested)}</span>
            </button>
          </div>

          {connectionError && (
            <p
              role="alert"
              className="mt-2 max-w-md rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-2 text-xs text-rose-700 dark:text-rose-300"
            >
              {connectionError}
            </p>
          )}
        </div>
      </div>

      {/* Bottom Floating Active Server Bar */}
      <div className="relative z-10 mx-auto w-full max-w-2xl shrink-0">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3.5 rounded-2xl border border-slate-200/90 dark:border-slate-800/90 bg-white/88 dark:bg-slate-900/85 px-4 py-3.5 shadow-xl shadow-slate-950/5 dark:shadow-black/30 backdrop-blur-xl">
          {/* Active Server Info */}
          <div className="flex items-center gap-3 min-w-0">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-100 dark:bg-slate-800 text-xl">
              {autoMode && !activeServer ? (
                <Zap size={18} className="text-emerald-500" />
              ) : (
                activeServer?.flag || '🌐'
              )}
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <span className="truncate text-sm font-bold text-slate-900 dark:text-white">
                  {autoMode
                    ? activeServer
                      ? `${t(lang, 'autoSelect')} · ${activeServer.name}`
                      : t(lang, 'autoSelect')
                    : activeServer
                    ? activeServer.name
                    : t(lang, 'noServerSelected')}
                </span>
                {activeServer && (
                  <span className="shrink-0 font-mono text-[11px] font-semibold uppercase text-emerald-600 dark:text-emerald-400">
                    {activeServer.protocol}
                  </span>
                )}
              </div>
              <div className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
                {activeServer
                  ? `${activeServer.country_name || activeServer.country_code} · ${activeServer.server_address}`
                  : autoMode
                  ? t(lang, 'autoFastestSub')
                  : t(lang, 'selectServerHint')}
              </div>
            </div>
          </div>

          {/* Live Speeds + Switch Server */}
          <div className="flex items-center justify-between sm:justify-end gap-3.5 shrink-0 border-t sm:border-t-0 border-slate-200/70 dark:border-slate-800 pt-3 sm:pt-0">
            <div className="flex items-center gap-3 font-mono text-xs tabular-nums" dir="ltr">
              <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                <ArrowDown size={13} />
                <span>{formatSpeed(telemetry.download_speed_bps)}</span>
              </span>
              <span className="inline-flex items-center gap-1 text-sky-600 dark:text-sky-400">
                <ArrowUp size={13} />
                <span>{formatSpeed(telemetry.upload_speed_bps)}</span>
              </span>
            </div>

            <button
              type="button"
              onClick={onOpenProfiles}
              className="inline-flex items-center gap-1 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/80 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:border-emerald-500/50 hover:text-emerald-600 dark:hover:text-emerald-400 whitespace-nowrap transition duration-150 active:scale-[0.97]"
            >
              <span>{t(lang, 'changeServer')}</span>
              <ChevronIcon size={15} />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
};
