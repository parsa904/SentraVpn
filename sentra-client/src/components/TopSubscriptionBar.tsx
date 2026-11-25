import React from 'react';
import { CalendarClock, HardDrive, Plus, RefreshCw, Smartphone } from 'lucide-react';
import type { BootstrapSubscription } from '../types/sentra';
import { type Language, t } from '../i18n/translations';
import {
  computeUsagePercent,
  formatBytes,
  formatRemainingDays,
} from '../utils/proxyParser';
import { PWAInstallButton } from './PWAInstallButton';

interface TopSubscriptionBarProps {
  lang: Language;
  subscription: BootstrapSubscription | null;
  syncing: boolean;
  onSync: () => void;
  onOpenAddConfig: () => void;
}

export const TopSubscriptionBar: React.FC<TopSubscriptionBarProps> = ({
  lang,
  subscription,
  syncing,
  onSync,
  onOpenAddConfig,
}) => {
  const usedBytes = subscription?.used_bytes ?? 0;
  const limitBytes = subscription?.traffic_limit_bytes ?? 0;
  const usagePct = computeUsagePercent(usedBytes, limitBytes);

  return (
    <header className="sticky top-0 z-20 flex items-center justify-between gap-2.5 border-b border-slate-200/80 dark:border-slate-800/90 bg-white/85 dark:bg-[#0B1220]/85 px-3.5 md:px-6 py-2.5 md:py-3 backdrop-blur-xl">
      {/* Real Subscription Metrics */}
      <div className="flex items-center gap-x-3.5 md:gap-x-5 min-w-0">
        <div className="min-w-0 shrink-0">
          <div className="text-[10px] md:text-[11px] text-slate-500 dark:text-slate-400">
            {t(lang, 'activePlan')}
          </div>
          <div className="text-xs md:text-sm font-bold text-slate-900 dark:text-white truncate max-w-[96px] sm:max-w-none capitalize">
            {subscription?.tier || t(lang, 'syncing')}
          </div>
        </div>

        <div className="h-6 md:h-7 w-px bg-slate-200 dark:bg-slate-800 shrink-0" />

        {/* Real Volume Bar */}
        <div className="flex flex-col gap-1 min-w-[96px] sm:min-w-[144px]">
          <div className="flex items-center justify-between gap-2 text-[10px] md:text-[11px] text-slate-600 dark:text-slate-300">
            <span className="hidden sm:inline-flex items-center gap-1 text-slate-500 dark:text-slate-400">
              <HardDrive size={13} />
              <span>{t(lang, 'volume')}</span>
            </span>
            <span className="font-mono tabular-nums truncate" dir="ltr">
              {subscription
                ? `${formatBytes(usedBytes)} / ${formatBytes(limitBytes)}`
                : '—'}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
            <div
              className="h-full rounded-full bg-emerald-500 transition-all duration-300"
              style={{ width: `${usagePct}%` }}
            />
          </div>
        </div>

        <div className="hidden lg:block h-7 w-px bg-slate-200 dark:bg-slate-800" />

        {/* Real Remaining Days */}
        <div className="hidden lg:flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 whitespace-nowrap">
          <CalendarClock size={14} className="text-slate-400 shrink-0" />
          <span className="tabular-nums">
            {subscription ? formatRemainingDays(subscription.remaining_days, lang) : '—'}
          </span>
        </div>

        <div className="hidden xl:block h-7 w-px bg-slate-200 dark:bg-slate-800" />

        {/* Real Connected Devices */}
        <div className="hidden xl:flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 whitespace-nowrap">
          <Smartphone size={14} className="text-slate-400 shrink-0" />
          <span className="tabular-nums">
            {subscription
              ? t(lang, 'devicesRatio', {
                  used: subscription.active_devices_count ?? 0,
                  max: subscription.max_concurrent_devices ?? 0,
                })
              : '—'}
          </span>
        </div>
      </div>

      {/* Action Controls */}
      <div className="flex items-center gap-1.5 md:gap-2 shrink-0">
        <PWAInstallButton lang={lang} variant="compact" />
        <button
          type="button"
          onClick={onSync}
          disabled={syncing}
          aria-label={t(lang, 'refreshAria')}
          className="inline-flex h-9 w-9 sm:h-auto sm:w-auto items-center justify-center gap-1.5 rounded-xl border border-slate-200 dark:border-slate-700/90 bg-white dark:bg-slate-900 sm:px-3 sm:py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-emerald-500/50 hover:text-emerald-600 dark:hover:text-emerald-400 disabled:opacity-60 whitespace-nowrap transition duration-150 active:scale-[0.97]"
        >
          <RefreshCw size={15} className={syncing ? 'animate-spin text-emerald-500' : ''} />
          <span className="hidden sm:inline">{syncing ? t(lang, 'syncing') : t(lang, 'refresh')}</span>
        </button>

        <button
          type="button"
          onClick={onOpenAddConfig}
          aria-label={t(lang, 'addConfigAria')}
          className="inline-flex h-9 w-9 sm:h-auto sm:w-auto items-center justify-center gap-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 active:scale-[0.97] sm:px-3.5 sm:py-2 text-xs font-semibold text-white shadow-sm shadow-emerald-600/20 whitespace-nowrap transition duration-150"
        >
          <Plus size={17} />
          <span className="hidden sm:inline">{t(lang, 'addConfig')}</span>
        </button>
      </div>
    </header>
  );
};
