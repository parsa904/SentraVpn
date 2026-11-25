import React from 'react';
import { Loader2, Power, ShieldAlert, Zap } from 'lucide-react';
import type { ActiveServerSelection, ConnectionStatus } from '../types/sentra';
import { type Language, t } from '../i18n/translations';
import { deriveQuickConnectState } from '../utils/quickConnect';

interface QuickConnectWidgetProps {
  lang: Language;
  connectionStatus: ConnectionStatus;
  autoResolving: boolean;
  activeServer: ActiveServerSelection | null;
  autoMode: boolean;
  onToggleConnect: () => void;
}

export const QuickConnectWidget: React.FC<QuickConnectWidgetProps> = ({
  lang,
  connectionStatus,
  autoResolving,
  activeServer,
  autoMode,
  onToggleConnect,
}) => {
  const state = deriveQuickConnectState({
    connectionStatus,
    autoResolving,
    activeServer,
    autoMode,
    autoSelectLabel: t(lang, 'autoSelect'),
  });

  const statusText =
    state.tone === 'connected'
      ? t(lang, 'statusConnected')
      : autoResolving
      ? t(lang, 'autoTesting')
      : state.tone === 'connecting'
      ? t(lang, 'statusConnecting')
      : state.tone === 'error'
      ? t(lang, 'statusError')
      : t(lang, 'statusDisconnected');

  const subtitle = state.targetLabel ? `${statusText} · ${state.targetLabel}` : statusText;

  return (
    <div
      data-testid="quick-connect-widget"
      className={`flex items-center justify-between gap-3 rounded-2xl border px-3.5 py-2 backdrop-blur-md transition-colors duration-200 ${
        state.tone === 'connected'
          ? 'border-emerald-500/45 bg-emerald-500/[0.08] dark:bg-emerald-500/[0.11]'
          : state.tone === 'error'
          ? 'border-rose-500/40 bg-rose-500/[0.06] dark:bg-rose-500/[0.09]'
          : 'border-slate-200/80 dark:border-slate-800/90 bg-white/82 dark:bg-slate-900/78'
      }`}
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <div
          aria-hidden="true"
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition-colors duration-200 ${
            state.tone === 'connected'
              ? 'bg-emerald-600 text-white shadow-sm shadow-emerald-600/25'
              : state.tone === 'connecting'
              ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
              : state.tone === 'error'
              ? 'bg-rose-500/15 text-rose-600 dark:text-rose-400'
              : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
          }`}
        >
          {state.isBusy ? (
            <Loader2 size={15} className="animate-spin" />
          ) : state.tone === 'error' ? (
            <ShieldAlert size={15} />
          ) : state.tone === 'connected' ? (
            <Power size={15} />
          ) : (
            <Zap size={15} />
          )}
        </div>

        <div className="min-w-0">
          <div className="text-xs font-bold leading-tight text-slate-900 dark:text-white truncate">
            {t(lang, 'quickConnectTitle')}
          </div>
          <div
            data-testid="quick-connect-status"
            className={`mt-0.5 text-[11px] leading-tight truncate ${
              state.tone === 'connected'
                ? 'text-emerald-700 dark:text-emerald-300 font-medium'
                : state.tone === 'error'
                ? 'text-rose-600 dark:text-rose-400 font-medium'
                : 'text-slate-500 dark:text-slate-400'
            }`}
          >
            {subtitle}
          </div>
        </div>
      </div>

      <button
        type="button"
        role="switch"
        dir="ltr"
        data-testid="quick-connect-toggle"
        aria-checked={state.isChecked}
        aria-busy={state.isBusy}
        aria-label={t(lang, 'quickConnectToggleAria')}
        onClick={onToggleConnect}
        className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 active:scale-[0.96] ${
          state.tone === 'connected'
            ? 'bg-emerald-600 shadow-inner shadow-emerald-950/20'
            : state.tone === 'connecting'
            ? 'bg-emerald-500/75'
            : 'bg-slate-300 dark:bg-slate-700'
        }`}
      >
        <span
          className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform duration-200 ${
            state.isChecked ? 'translate-x-6' : 'translate-x-1'
          }`}
        />
      </button>
    </div>
  );
};
