import React, { useMemo, useState } from 'react';
import {
  Activity,
  Check,
  Gift,
  Plus,
  RefreshCw,
  Search,
  Server,
  Trash2,
} from 'lucide-react';
import type {
  ActiveServerSelection,
  LiveOutboundNode,
  PersonalConfigItem,
} from '../types/sentra';
import { formatPing } from '../utils/proxyParser';

interface ProfilesViewProps {
  outbounds: LiveOutboundNode[];
  personalConfigs: PersonalConfigItem[];
  activeServer: ActiveServerSelection | null;
  livePings: Record<string, number | null>;
  pingingIds: Record<string, boolean>;
  syncing: boolean;
  onSync: () => void;
  onOpenAddConfig: () => void;
  onSelectServerOutbound: (node: LiveOutboundNode) => void;
  onSelectPersonalConfig: (cfg: PersonalConfigItem) => void;
  onPingServerOutbound: (node: LiveOutboundNode) => void;
  onPingPersonalConfig: (cfg: PersonalConfigItem) => void;
  onPingAllOutbounds: () => void;
  onDeletePersonalConfig: (id: string) => void;
  onOpenDonateModal: (cfg: PersonalConfigItem) => void;
}

export const ProfilesView: React.FC<ProfilesViewProps> = ({
  outbounds,
  personalConfigs,
  activeServer,
  livePings,
  pingingIds,
  syncing,
  onSync,
  onOpenAddConfig,
  onSelectServerOutbound,
  onSelectPersonalConfig,
  onPingServerOutbound,
  onPingPersonalConfig,
  onPingAllOutbounds,
  onDeletePersonalConfig,
  onOpenDonateModal,
}) => {
  const [search, setSearch] = useState('');
  const [protocolFilter, setProtocolFilter] = useState<string>('ALL');

  const availableProtocols = useMemo(() => {
    const set = new Set<string>();
    outbounds.forEach((o) => set.add(o.protocol.toUpperCase()));
    return ['ALL', ...Array.from(set)];
  }, [outbounds]);

  const filteredOutbounds = useMemo(() => {
    const q = search.trim().toLowerCase();
    return outbounds.filter((node) => {
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
  }, [outbounds, search, protocolFilter]);

  return (
    <div className="flex-1 overflow-y-auto px-4 md:px-8 py-6 pb-24 md:pb-10">
      <div className="mx-auto max-w-5xl space-y-8">
        {/* Section 1: Live Telegram & Sentra Outbounds */}
        <section aria-labelledby="live-outbounds-heading" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2
                id="live-outbounds-heading"
                className="text-lg font-bold text-slate-900 dark:text-white"
              >
                سرورها و اوتباندهای زنده سنترا
              </h2>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                همگام‌سازی مستقیم با اوتباندهای فعال ثبت‌شده در ربات تلگرام
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onPingAllOutbounds}
                disabled={outbounds.length === 0}
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-emerald-500/50 hover:text-emerald-600 dark:hover:text-emerald-400 disabled:opacity-50 transition"
              >
                <Activity size={16} />
                <span>تست پینگ همه</span>
              </button>
              <button
                type="button"
                onClick={onSync}
                disabled={syncing}
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-emerald-500/50 hover:text-emerald-600 dark:hover:text-emerald-400 disabled:opacity-50 transition"
              >
                <RefreshCw size={16} className={syncing ? 'animate-spin text-emerald-500' : ''} />
                <span>بروزرسانی</span>
              </button>
            </div>
          </div>

          {/* Search & Protocol Filter */}
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search
                size={16}
                className="pointer-events-none absolute top-1/2 right-3.5 -translate-y-1/2 text-slate-400"
              />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="جستجو بر اساس نام، کشور یا پروتکل..."
                aria-label="جستجوی سرورها"
                className="w-full rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 pr-10 pl-3.5 py-2.5 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
              />
            </div>

            {availableProtocols.length > 2 && (
              <div className="flex items-center gap-1 overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-1">
                {availableProtocols.map((proto) => (
                  <button
                    key={proto}
                    type="button"
                    onClick={() => setProtocolFilter(proto)}
                    className={`rounded-lg px-2.5 py-1.5 font-mono text-[11px] font-semibold transition ${
                      protocolFilter === proto
                        ? 'bg-emerald-600 text-white'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                    }`}
                  >
                    {proto === 'ALL' ? 'همه' : proto}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Outbounds List */}
          {filteredOutbounds.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 dark:border-slate-800 bg-white/60 dark:bg-slate-900/40 px-6 py-12 text-center">
              <Server size={28} className="text-slate-400" />
              <p className="mt-3 text-sm font-semibold text-slate-800 dark:text-slate-200">
                {outbounds.length === 0
                  ? 'هنوز اوتباند فعالی از سرور دریافت نشده است'
                  : 'سروری مطابق جستجوی شما یافت نشد'}
              </p>
              <p className="mt-1 max-w-md text-xs text-slate-500 dark:text-slate-400">
                {outbounds.length === 0
                  ? 'برای دریافت لیست زنده سرورهای ثبت‌شده در تلگرام، روی بروزرسانی کلیک کنید.'
                  : 'فیلتر یا عبارت جستجو را تغییر دهید.'}
              </p>
              {outbounds.length === 0 && (
                <button
                  type="button"
                  onClick={onSync}
                  disabled={syncing}
                  className="mt-4 inline-flex items-center gap-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 px-4 py-2 text-xs font-semibold text-white transition"
                >
                  <RefreshCw size={15} className={syncing ? 'animate-spin' : ''} />
                  <span>همگام‌سازی با سرور</span>
                </button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {filteredOutbounds.map((node) => {
                const isSelected =
                  activeServer?.kind === 'server' && activeServer.id === node.id;
                const ping =
                  node.id in livePings
                    ? livePings[node.id]
                    : node.latency_ms > 0
                    ? node.latency_ms
                    : null;
                const isPinging = Boolean(pingingIds[node.id]);

                return (
                  <div
                    key={node.id}
                    className={`flex items-center justify-between gap-3 rounded-2xl border p-4 transition ${
                      isSelected
                        ? 'border-emerald-500 bg-emerald-500/[0.06] dark:bg-emerald-500/[0.08]'
                        : 'border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900/80 hover:border-slate-300 dark:hover:border-slate-700'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => onSelectServerOutbound(node)}
                      className="flex min-w-0 flex-1 items-center gap-3 text-right"
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
                          <span>·</span>
                          <span>{node.country_name || node.country_code}</span>
                          <span>·</span>
                          <span>{node.is_official ? 'سرور رسمی' : 'اهدایی کاربران'}</span>
                        </div>
                      </div>
                    </button>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => onPingServerOutbound(node)}
                        disabled={isPinging}
                        aria-label={`تست پینگ ${node.name}`}
                        className="inline-flex min-w-[68px] items-center justify-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700/90 bg-slate-50 dark:bg-slate-800/80 px-2.5 py-1.5 font-mono text-[11px] tabular-nums text-slate-700 dark:text-slate-200 hover:border-emerald-500/50 transition"
                        dir="ltr"
                      >
                        <Activity
                          size={12}
                          className={
                            isPinging
                              ? 'animate-pulse text-emerald-500'
                              : ping && ping < 180
                              ? 'text-emerald-500'
                              : ping
                              ? 'text-amber-500'
                              : 'text-slate-400'
                          }
                        />
                        <span>{isPinging ? '...' : formatPing(ping)}</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Section 2: Personal Configs + Community Outbound Donation CTA */}
        <section
          aria-labelledby="personal-configs-heading"
          className="space-y-4 border-t border-slate-200/80 dark:border-slate-800 pt-7"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2
                id="personal-configs-heading"
                className="text-lg font-bold text-slate-900 dark:text-white"
              >
                کانفیگ‌های شخصی و لینک اشتراک
              </h2>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                کانفیگ‌های شخصی خود را اضافه کنید و در صورت تمایل برای دریافت اشتراک رایگان اهدا نمایید
              </p>
            </div>

            <button
              type="button"
              onClick={onOpenAddConfig}
              className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 px-3.5 py-2 text-xs font-semibold text-white shadow-sm shadow-emerald-600/20 transition"
            >
              <Plus size={18} />
              <span>افزودن کانفیگ از کلیپ‌بورد</span>
            </button>
          </div>

          {personalConfigs.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-300 dark:border-slate-800 bg-white/60 dark:bg-slate-900/40 px-6 py-10 text-center">
              <p className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                هنوز کانفیگ شخصی اضافه نکرده‌اید
              </p>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                پشتیبانی کامل از VLESS، VMess، Trojan، Shadowsocks، Hysteria2، TUIC، WireGuard و لینک اشتراک
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {personalConfigs.map((cfg) => {
                const isSelected =
                  activeServer?.kind === 'personal' && activeServer.id === cfg.id;
                const ping = cfg.id in livePings ? livePings[cfg.id] : cfg.latency_ms;
                const isPinging = Boolean(pingingIds[cfg.id]);

                return (
                  <div
                    key={cfg.id}
                    className={`rounded-2xl border p-4 transition ${
                      isSelected
                        ? 'border-emerald-500 bg-emerald-500/[0.06] dark:bg-emerald-500/[0.08]'
                        : 'border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900/80'
                    }`}
                  >
                    <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                      <button
                        type="button"
                        onClick={() => onSelectPersonalConfig(cfg)}
                        className="flex min-w-0 flex-1 items-center gap-3 text-right"
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
                            <span>·</span>
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
                            className="inline-flex items-center gap-1.5 rounded-xl border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 px-3 py-2 text-xs font-semibold text-amber-700 dark:text-amber-300 transition"
                          >
                            <Gift size={15} />
                            <span>انتشار به عنوان اوتباند اهدایی (دریافت اشتراک رایگان)</span>
                          </button>
                        )}

                        <button
                          type="button"
                          onClick={() => onPingPersonalConfig(cfg)}
                          disabled={isPinging}
                          aria-label={`تست پینگ ${cfg.name}`}
                          className="inline-flex items-center gap-1 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/80 px-3 py-2 font-mono text-xs tabular-nums text-slate-700 dark:text-slate-200 hover:border-emerald-500/50 transition"
                          dir="ltr"
                        >
                          <Activity size={14} className={isPinging ? 'animate-pulse text-emerald-500' : ''} />
                          <span>{isPinging ? '...' : formatPing(ping)}</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => onDeletePersonalConfig(cfg.id)}
                          aria-label={`حذف کانفیگ ${cfg.name}`}
                          className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 dark:border-slate-700 text-slate-500 hover:border-rose-500/50 hover:bg-rose-500/10 hover:text-rose-600 dark:hover:text-rose-400 transition"
                        >
                          <Trash2 size={16} />
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
