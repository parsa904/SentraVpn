import React from 'react';
import {
  Activity,
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  Download,
  Globe,
  Lock,
  Power,
  ShieldCheck,
} from 'lucide-react';
import type {
  ActiveServerSelection,
  ConnectionModeId,
  ConnectionModeItem,
  ConnectionStatus,
  TelemetrySnapshot,
} from '../types/sentra';
import { formatDuration, formatPing, formatSpeed } from '../utils/proxyParser';
import { WorldMapBackdrop } from './WorldMapBackdrop';

interface HomeViewProps {
  connectionStatus: ConnectionStatus;
  connectionError: string | null;
  selectedMode: ConnectionModeId;
  modes: ConnectionModeItem[];
  activeServer: ActiveServerSelection | null;
  telemetry: TelemetrySnapshot;
  pingingActive: boolean;
  onToggleConnect: () => void;
  onSelectMode: (mode: ConnectionModeId) => void;
  onOpenProfiles: () => void;
  onPingActiveServer: () => void;
}

const FALLBACK_MODES: Array<{
  id: ConnectionModeId;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}> = [
  { id: 'web_browsing', label: 'وب‌گردی', icon: Globe },
  { id: 'download', label: 'دانلود', icon: Download },
  { id: 'static_ip', label: 'آی‌پی ثابت', icon: ShieldCheck },
];

export const HomeView: React.FC<HomeViewProps> = ({
  connectionStatus,
  connectionError,
  selectedMode,
  modes,
  activeServer,
  telemetry,
  pingingActive,
  onToggleConnect,
  onSelectMode,
  onOpenProfiles,
  onPingActiveServer,
}) => {
  const isConnected = connectionStatus === 'connected';
  const isConnecting = connectionStatus === 'connecting';

  const modeById = new Map(modes.map((m) => [m.id, m]));

  const statusLabel = isConnected
    ? 'متصل و امن'
    : isConnecting
    ? 'در حال برقراری اتصال...'
    : connectionStatus === 'error'
    ? 'خطا در اتصال'
    : 'آماده اتصال';

  const displayPing = telemetry.ping_ms ?? activeServer?.latency_ms ?? null;

  return (
    <section className="relative flex flex-1 flex-col justify-between overflow-hidden px-4 md:px-8 py-6 pb-24 md:pb-8">
      <WorldMapBackdrop
        activeCountryCode={activeServer?.country_code}
        isConnected={isConnected}
      />

      {/* Top Mode Selector (strictly 3 modes: Web Browsing, Download, Static IP — Gaming hidden) */}
      <div className="relative z-10 mx-auto w-full max-w-md">
        <div
          role="radiogroup"
          aria-label="حالت اتصال"
          className="grid grid-cols-3 gap-1.5 rounded-2xl border border-slate-200/80 dark:border-slate-800/90 bg-white/80 dark:bg-slate-900/75 p-1.5 backdrop-blur-md"
        >
          {FALLBACK_MODES.map((m) => {
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
                className={`flex items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold transition ${
                  isSelected
                    ? 'bg-emerald-600 text-white shadow-sm shadow-emerald-600/25'
                    : isLocked
                    ? 'cursor-not-allowed text-slate-400 dark:text-slate-600'
                    : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/80'
                }`}
              >
                {isLocked ? <Lock size={14} /> : <Icon size={14} />}
                <span>{serverInfo?.name || m.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Center Hero Power Orb */}
      <div className="relative z-10 my-auto flex flex-col items-center justify-center py-8">
        <div className="relative flex items-center justify-center">
          {/* Concentric rings when connecting or connected */}
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
            className={`relative flex h-44 w-44 items-center justify-center rounded-full border transition-all duration-300 ${
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
              aria-label={isConnected ? 'قطع اتصال VPN' : 'برقراری اتصال VPN'}
              className={`group flex h-32 w-32 flex-col items-center justify-center gap-2 rounded-full transition-all duration-300 focus:outline-none focus:ring-4 focus:ring-emerald-500/30 ${
                isConnected
                  ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-600/35 hover:bg-emerald-500'
                  : isConnecting
                  ? 'bg-emerald-600/90 text-white'
                  : 'bg-slate-900 dark:bg-white text-white dark:text-slate-950 hover:scale-[1.03] active:scale-[0.98]'
              }`}
            >
              <Power
                size={36}
                className={`transition-transform duration-300 ${
                  isConnected ? 'scale-105' : 'group-hover:scale-110'
                }`}
              />
              <span className="text-xs font-bold">
                {isConnected ? 'قطع اتصال' : isConnecting ? 'در حال اتصال' : 'اتصال'}
              </span>
            </button>
          </div>
        </div>

        {/* Status, Timer & Real Ping */}
        <div className="mt-6 flex flex-col items-center gap-2 text-center">
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
              aria-label="تست پینگ سرور فعال"
              className="inline-flex items-center gap-1.5 font-mono tabular-nums text-slate-600 dark:text-slate-300 hover:text-emerald-600 dark:hover:text-emerald-400 disabled:opacity-50 transition"
              dir="ltr"
            >
              <Activity size={14} className={pingingActive ? 'animate-pulse text-emerald-500' : ''} />
              <span>{pingingActive ? '...' : formatPing(displayPing)}</span>
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
      <div className="relative z-10 mx-auto w-full max-w-2xl">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-2xl border border-slate-200/90 dark:border-slate-800/90 bg-white/88 dark:bg-slate-900/85 px-4 py-3.5 shadow-xl shadow-slate-950/5 dark:shadow-black/30 backdrop-blur-xl">
          {/* Active Server Info */}
          <div className="flex items-center gap-3 min-w-0">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-100 dark:bg-slate-800 text-2xl">
              {activeServer?.flag || '🌐'}
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-bold text-slate-900 dark:text-white">
                  {activeServer ? activeServer.name : 'سروری انتخاب نشده است'}
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
                  : 'برای انتخاب سرور، روی دکمه تغییر سرور کلیک کنید'}
              </div>
            </div>
          </div>

          {/* Live Speeds + Switch Server */}
          <div className="flex items-center justify-between sm:justify-end gap-4 shrink-0 border-t sm:border-t-0 border-slate-200/70 dark:border-slate-800 pt-3 sm:pt-0">
            <div className="flex items-center gap-3.5 font-mono text-xs tabular-nums" dir="ltr">
              <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                <ArrowDown size={14} />
                <span>{formatSpeed(telemetry.download_speed_bps)}</span>
              </span>
              <span className="inline-flex items-center gap-1 text-sky-600 dark:text-sky-400">
                <ArrowUp size={14} />
                <span>{formatSpeed(telemetry.upload_speed_bps)}</span>
              </span>
            </div>

            <button
              type="button"
              onClick={onOpenProfiles}
              className="inline-flex items-center gap-1 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/80 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:border-emerald-500/50 hover:text-emerald-600 dark:hover:text-emerald-400 transition"
            >
              <span>تغییر سرور</span>
              <ChevronLeft size={16} />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
};
