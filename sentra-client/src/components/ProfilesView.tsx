import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowUpDown,
  Check,
  Gift,
  Plus,
  RefreshCw,
  Search,
  Server,
  Trash2,
  Zap,
} from 'lucide-react';
import type {
  ActiveServerSelection,
  LiveOutboundNode,
  PersonalConfigItem,
} from '../types/sentra';
import { type Language, t } from '../i18n/translations';
import { formatPing, getLatencyTier, type LatencyTier } from '../utils/proxyParser';
import {
  PING_OPT_INTERVAL_MS,
  getElapsedSecondsSinceOptimization,
  resolveOutboundLatency,
  sortOutboundsByLatency,
} from '../utils/pingOptimization';

interface ProfilesViewProps {
  lang: Language;
  outbounds: LiveOutboundNode[];
  personalConfigs: PersonalConfigItem[];
  activeServer: ActiveServerSelection | null;
  autoMode: boolean;
  autoResolving: boolean;
  testingAll: boolean;
  livePings: Record<string, number | null>;
  pingingIds: Record<string, boolean>;
  syncing: boolean;
  onSync: () => void;
  onOpenAddConfig: () => void;
  onSelectAutoFastest: () => void;
  onSelectServerOutbound: (node: LiveOutboundNode) => void;
  onSelectPersonalConfig: (cfg: PersonalConfigItem) => void;
  onPingServerOutbound: (node: LiveOutboundNode) => void;
  onPingPersonalConfig: (cfg: PersonalConfigItem) => void;
  onPingAllOutbounds: () => void;
  onDeletePersonalConfig: (id: string) => void;
  onOpenDonateModal: (cfg: PersonalConfigItem) => void;
  pingOptimizationEnabled: boolean;
  pingOptimizing: boolean;
  lastPingOptimizedAt: number | null;
  onTogglePingOptimization: (enabled: boolean) => void;
}

function latencyBadgeClasses(tier: LatencyTier): string {
  switch (tier) {
    case 'good':
      return 'border-emerald-500/30 bg-emerald-500/[0.08] text-emerald-700 dark:text-emerald-300';
    case 'fair':
      return 'border-amber-500/30 bg-amber-500/[0.08] text-amber-700 dark:text-amber-300';
    case 'poor':
    case 'timeout':
      return 'border-rose-500/30 bg-rose-500/[0.08] text-rose-700 dark:text-rose-300';
    default:
      return 'border-slate-200 dark:border-slate-700/90 bg-slate-50 dark:bg-slate-800/80 text-slate-700 dark:text-slate-200';
  }
}

export const ProfilesView: React.FC<ProfilesViewProps> = ({
  lang,
  outbounds,
  personalConfigs,
  activeServer,
  autoMode,
  autoResolving,
  testingAll,
  livePings,
  pingingIds,
  syncing,
  onSync,
  onOpenAddConfig,
  onSelectAutoFastest,
  onSelectServerOutbound,
  onSelectPersonalConfig,
  onPingServerOutbound,
  onPingPersonalConfig,
  onPingAllOutbounds,
  onDeletePersonalConfig,
  onOpenDonateModal,
  pingOptimizationEnabled,
  pingOptimizing,
  lastPingOptimizedAt,
  onTogglePingOptimization,
}) => {
  const [search, setSearch] = useState('');
  const [protocolFilter, setProtocolFilter] = useState<string>('ALL');
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!pingOptimizationEnabled || lastPingOptimizedAt === null) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [pingOptimizationEnabled, lastPingOptimizedAt]);

  const availableProtocols = useMemo(() => {
    const set = new Set<string>();
    outbounds.forEach((o) => set.add(o.protocol.toUpperCase()));
    return ['ALL', ...Array.from(set)];
  }, [outbounds]);

  const filteredOutbounds = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matched = outbounds.filter((node) => {
      if (protocolFilter !== 'ALL' && node.protocol.toUpperCase() !== protocolFilter) {
        return false;
      }
      if (!q) return true;
      return (
        node.name.toLowerCase().includes(q) ||
        node.country_name.toLowerCase().includes(q) ||
        node.country_code.toLowerCase().includes(q) ||
        node.protocol.toLowerCase().includes(q) ||
        node.server_address.toLowerCase().includes(q)
      );
    });
    return pingOptimizationEnabled ? sortOutboundsByLatency(matched, livePings) : matched;
  }, [outbounds, search, protocolFilter, pingOptimizationEnabled, livePings]);

  const elapsedSeconds = getElapsedSecondsSinceOptimization(lastPingOptimizedAt, nowMs);
  const intervalSeconds = Math.round(PING_OPT_INTERVAL_MS / 1000);

  const totalTestable = outbounds.length + personalConfigs.filter((c) => !c.is_subscription).length;

  return (
    <div className="flex-1 overflow-y-auto px-4 md:px-8 py-6 pb-24 md:pb-10 animate-sentra-view">
      <div className="mx-auto max-w-5xl space-y-8">
        {/* Section 1: Live Servers + Auto Fastest */}
        <section aria-labelledby="live-outbounds-heading" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2
              id="live-outbounds-heading"
              className="text-lg font-bold text-slate-900 dark:text-white"
            >
              {t(lang, 'serversTitle')}
            </h2>

            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid="test-all-btn"
                onClick={onPingAllOutbounds}
                disabled={totalTestable === 0 || testingAll}
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-emerald-500/50 hover:text-emerald-600 dark:hover:text-emerald-400 disabled:opacity-50 whitespace-nowrap transition duration-150 active:scale-[0.97]"
              >
                <Activity size={15} className={testingAll ? 'animate-pulse text-emerald-500' : ''} />
                <span>{testingAll ? t(lang, 'testingAll') : t(lang, 'testAll')}</span>
              </button>
              <button
                type="button"
                onClick={onSync}
                disabled={syncing}
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-emerald-500/50 hover:text-emerald-600 dark:hover:text-emerald-400 disabled:opacity-50 whitespace-nowrap transition duration-150 active:scale-[0.97]"
              >
                <RefreshCw size={15} className={syncing ? 'animate-spin text-emerald-500' : ''} />
                <span>{t(lang, 'refresh')}</span>
              </button>
            </div>
          </div>

          {/* Pinned Auto — Fastest Healthy Server Card */}
          <button
            type="button"
            data-testid="auto-fastest-card"
            onClick={onSelectAutoFastest}
            disabled={autoResolving || outbounds.length === 0}
            className={`flex w-full items-center justify-between gap-3 rounded-2xl border p-4 text-start transition duration-150 active:scale-[0.99] disabled:opacity-60 ${
              autoMode
                ? 'border-emerald-500 bg-emerald-500/[0.07] dark:bg-emerald-500/[0.1]'
                : 'border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900/80 hover:border-emerald-500/40'
            }`}
          >
            <div className="flex items-center gap-3 min-w-0">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/12 text-emerald-600 dark:text-emerald-400">
                <Zap size={19} className={autoResolving ? 'animate-pulse' : ''} />
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold text-slate-900 dark:text-white">
                    {t(lang, 'autoCardTitle')}
                  </span>
                  {autoMode && <Check size={15} className="shrink-0 text-emerald-500" />}
                </div>
                <div className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
                  {autoResolving
                    ? t(lang, 'autoTesting')
                    : autoMode && activeServer
                    ? t(lang, 'autoResolved', { name: activeServer.name })
                    : t(lang, 'autoCardDesc')}
                </div>
              </div>
            </div>

            {autoMode && activeServer?.latency_ms ? (
              <span
                dir="ltr"
                className={`shrink-0 rounded-lg border px-2.5 py-1 font-mono text-[11px] font-semibold tabular-nums ${latencyBadgeClasses(
                  getLatencyTier(activeServer.latency_ms, true)
                )}`}
              >
                {formatPing(activeServer.latency_ms, lang, true)}
              </span>
            ) : null}
          </button>

          {/* Search & Protocol Filter */}
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search
                size={15}
                className="pointer-events-none absolute top-1/2 start-3.5 -translate-y-1/2 text-slate-400"
              />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t(lang, 'searchServersPlaceholder')}
                aria-label={t(lang, 'searchServersAria')}
                className="w-full rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 ps-10 pe-3.5 py-2.5 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
              />
            </div>

            {availableProtocols.length > 2 && (
              <div className="flex items-center gap-1 overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-1">
                {availableProtocols.map((proto) => (
                  <button
                    key={proto}
                    type="button"
                    onClick={() => setProtocolFilter(proto)}
                    className={`rounded-lg px-2.5 py-1.5 font-mono text-[11px] font-semibold whitespace-nowrap transition duration-150 active:scale-95 ${
                      protocolFilter === proto
                        ? 'bg-emerald-600 text-white'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                    }`}
                  >
                    {proto === 'ALL' ? t(lang, 'filterAll') : proto}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Automated Ping Optimization Control Bar */}
          {outbounds.length > 0 && (
            <div
              data-testid="ping-optimization-bar"
              className="flex items-center justify-between gap-3 rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900/80 px-3.5 py-2.5"
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <span
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors duration-150 ${
                    pingOptimizationEnabled
                      ? 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400'
                      : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400'
                  }`}
                >
                  <ArrowUpDown
                    size={15}
                    className={pingOptimizing ? 'animate-spin' : ''}
                    aria-hidden="true"
                  />
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="text-xs font-semibold text-slate-900 dark:text-white whitespace-nowrap">
                      {t(lang, 'pingOptTitle')}
                    </span>
                    {pingOptimizationEnabled && elapsedSeconds !== null && !pingOptimizing && (
                      <>
                        <span aria-hidden="true" className="text-slate-300 dark:text-slate-600">
                          ·
                        </span>
                        <span className="font-mono text-[11px] tabular-nums text-emerald-600 dark:text-emerald-400 whitespace-nowrap">
                          {elapsedSeconds < 2
                            ? t(lang, 'pingOptJustNow')
                            : t(lang, 'pingOptUpdatedAgo', { sec: elapsedSeconds })}
                        </span>
                      </>
                    )}
                  </div>
                  <p
                    data-testid="ping-optimization-status"
                    className="truncate text-[11px] text-slate-500 dark:text-slate-400"
                  >
                    {!pingOptimizationEnabled
                      ? t(lang, 'pingOptPausedDesc')
                      : pingOptimizing || testingAll
                      ? t(lang, 'pingOptRunningDesc')
                      : t(lang, 'pingOptActiveDesc', { sec: intervalSeconds })}
                  </p>
                </div>
              </div>

              <button
                type="button"
                role="switch"
                dir="ltr"
                data-testid="ping-optimization-toggle"
                aria-checked={pingOptimizationEnabled}
                aria-label={t(lang, 'pingOptToggleAria')}
                onClick={() => onTogglePingOptimization(!pingOptimizationEnabled)}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-slate-950 ${
                  pingOptimizationEnabled
                    ? 'bg-emerald-600 dark:bg-emerald-500'
                    : 'bg-slate-300 dark:bg-slate-700'
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-150 ${
                    pingOptimizationEnabled ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>
          )}

          {/* Outbounds List */}
          {filteredOutbounds.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 dark:border-slate-800 bg-white/60 dark:bg-slate-900/40 px-6 py-12 text-center">
              <Server size={26} className="text-slate-400" />
              <p className="mt-3 text-sm font-semibold text-slate-800 dark:text-slate-200">
                {outbounds.length === 0
                  ? t(lang, 'noServersTitle')
                  : t(lang, 'noServersSearchTitle')}
              </p>
              <p className="mt-1 max-w-md text-xs text-slate-500 dark:text-slate-400">
                {outbounds.length === 0
                  ? t(lang, 'noServersDesc')
                  : t(lang, 'noServersSearchDesc')}
              </p>
              {outbounds.length === 0 && (
                <button
                  type="button"
                  onClick={onSync}
                  disabled={syncing}
                  className="mt-4 inline-flex items-center gap-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 px-4 py-2 text-xs font-semibold text-white transition duration-150 active:scale-[0.97]"
                >
                  <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
                  <span>{t(lang, 'syncNow')}</span>
                </button>
              )}
            </div>
          ) : (
            <div
              data-testid="outbounds-list"
              className="grid grid-cols-1 md:grid-cols-2 gap-3"
            >
              {filteredOutbounds.map((node, index) => {
                const isSelected =
                  !autoMode && activeServer?.kind === 'server' && activeServer.id === node.id;
                const tested = node.id in livePings;
                const resolved = resolveOutboundLatency(node, livePings);
                const ping = resolved.latencyMs;
                const isPinging = Boolean(pingingIds[node.id]);
                const tier = getLatencyTier(ping, tested);
                const isTopFastest =
                  pingOptimizationEnabled &&
                  index === 0 &&
                  node.is_online !== false &&
                  ping !== null &&
                  filteredOutbounds.length > 1;

                return (
                  <div
                    key={node.id}
                    data-testid="outbound-card"
                    data-outbound-id={node.id}
                    className={`flex items-center justify-between gap-3 rounded-2xl border p-4 transition duration-150 ${
                      isSelected
                        ? 'border-emerald-500 bg-emerald-500/[0.06] dark:bg-emerald-500/[0.08]'
                        : 'border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900/80 hover:border-slate-300 dark:hover:border-slate-700'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => onSelectServerOutbound(node)}
                      className="flex min-w-0 flex-1 items-center gap-3 text-start active:scale-[0.99] transition-transform duration-150"
                    >
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-100 dark:bg-slate-800 text-xl">
                        {node.flag || '🌐'}
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-bold text-slate-900 dark:text-white">
                            {node.name}
                          </span>
                          {isSelected && (
                            <Check size={15} className="shrink-0 text-emerald-500" />
                          )}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                          <span className="font-mono font-semibold uppercase text-emerald-600 dark:text-emerald-400">
                            {node.protocol}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>{node.country_name || node.country_code}</span>
                          <span aria-hidden="true">·</span>
                          <span>
                            {node.is_official
                              ? t(lang, 'officialServer')
                              : t(lang, 'communityServer')}
                          </span>
                          {isTopFastest && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span
                                data-testid="outbound-fastest-label"
                                className="font-semibold text-emerald-600 dark:text-emerald-400"
                              >
                                {t(lang, 'pingOptFastestTag')}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    </button>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => onPingServerOutbound(node)}
                        disabled={isPinging}
                        aria-label={t(lang, 'pingNodeAria', { name: node.name })}
                        className={`inline-flex min-w-[74px] items-center justify-center gap-1 rounded-lg border px-2.5 py-1.5 font-mono text-[11px] font-semibold tabular-nums transition duration-150 active:scale-95 ${latencyBadgeClasses(
                          isPinging ? 'idle' : tier
                        )}`}
                        dir="ltr"
                      >
                        <Activity
                          size={12}
                          className={isPinging ? 'animate-pulse text-emerald-500' : ''}
                        />
                        <span>{isPinging ? '...' : formatPing(ping, lang, tested)}</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Section 2: Personal Profiles + Community Outbound Donation CTA */}
        <section
          aria-labelledby="personal-configs-heading"
          className="space-y-4 border-t border-slate-200/80 dark:border-slate-800 pt-7"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2
              id="personal-configs-heading"
              className="text-lg font-bold text-slate-900 dark:text-white"
            >
              {t(lang, 'personalConfigsTitle')}
            </h2>

            <button
              type="button"
              onClick={onOpenAddConfig}
              className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 px-3.5 py-2 text-xs font-semibold text-white shadow-sm shadow-emerald-600/20 whitespace-nowrap transition duration-150 active:scale-[0.97]"
            >
              <Plus size={16} />
              <span>{t(lang, 'addFromClipboard')}</span>
            </button>
          </div>

          {personalConfigs.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-300 dark:border-slate-800 bg-white/60 dark:bg-slate-900/40 px-6 py-10 text-center">
              <p className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                {t(lang, 'noPersonalTitle')}
              </p>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {t(lang, 'noPersonalDesc')}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {personalConfigs.map((cfg) => {
                const isSelected =
                  !autoMode && activeServer?.kind === 'personal' && activeServer.id === cfg.id;
                const tested = cfg.id in livePings;
                const ping = tested ? livePings[cfg.id] : cfg.latency_ms;
                const isPinging = Boolean(pingingIds[cfg.id]);
                const tier = getLatencyTier(ping, tested);

                return (
                  <div
                    key={cfg.id}
                    className={`rounded-2xl border p-4 transition duration-150 ${
                      isSelected
                        ? 'border-emerald-500 bg-emerald-500/[0.06] dark:bg-emerald-500/[0.08]'
                        : 'border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900/80'
                    }`}
                  >
                    <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                      <button
                        type="button"
                        onClick={() => onSelectPersonalConfig(cfg)}
                        className="flex min-w-0 flex-1 items-center gap-3 text-start active:scale-[0.99] transition-transform duration-150"
                      >
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-100 dark:bg-slate-800 text-xl">
                          {cfg.flag}
                        </span>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-bold text-slate-900 dark:text-white">
                              {cfg.name}
                            </span>
                            {isSelected && (
                              <Check size={15} className="shrink-0 text-emerald-500" />
                            )}
                          </div>
                          <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                            <span className="font-mono font-semibold text-emerald-600 dark:text-emerald-400">
                              {cfg.protocol}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono truncate" dir="ltr">
                              {cfg.server_address}:{cfg.server_port}
                            </span>
                          </div>
                        </div>
                      </button>

                      <div className="flex flex-wrap items-center gap-2">
                        {!cfg.is_subscription && (
                          <button
                            type="button"
                            onClick={() => onOpenDonateModal(cfg)}
                            className="inline-flex items-center gap-1.5 rounded-xl border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 px-3 py-2 text-xs font-semibold text-amber-700 dark:text-amber-300 whitespace-nowrap transition duration-150 active:scale-[0.97]"
                          >
                            <Gift size={14} />
                            <span>{t(lang, 'publishDonated')}</span>
                          </button>
                        )}

                        <button
                          type="button"
                          onClick={() => onPingPersonalConfig(cfg)}
                          disabled={isPinging}
                          aria-label={t(lang, 'pingNodeAria', { name: cfg.name })}
                          className={`inline-flex min-w-[74px] items-center justify-center gap-1 rounded-xl border px-3 py-2 font-mono text-xs font-semibold tabular-nums transition duration-150 active:scale-95 ${latencyBadgeClasses(
                            isPinging ? 'idle' : tier
                          )}`}
                          dir="ltr"
                        >
                          <Activity size={13} className={isPinging ? 'animate-pulse text-emerald-500' : ''} />
                          <span>{isPinging ? '...' : formatPing(ping, lang, tested)}</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => onDeletePersonalConfig(cfg.id)}
                          aria-label={t(lang, 'deleteConfigAria', { name: cfg.name })}
                          className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 dark:border-slate-700 text-slate-500 hover:border-rose-500/50 hover:bg-rose-500/10 hover:text-rose-600 dark:hover:text-rose-400 transition duration-150 active:scale-95"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
