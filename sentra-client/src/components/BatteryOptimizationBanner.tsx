import React from 'react';
import { BatteryWarning, Settings, X } from 'lucide-react';
import { type Language, t } from '../i18n/translations';

interface BatteryOptimizationBannerProps {
  lang: Language;
  visible: boolean;
  onOpenSettings: () => void;
  onDismiss: () => void;
}

export const BatteryOptimizationBanner: React.FC<BatteryOptimizationBannerProps> = ({
  lang,
  visible,
  onOpenSettings,
  onDismiss,
}) => {
  if (!visible) return null;

  return (
    <div
      role="alert"
      data-testid="battery-opt-banner"
      className="flex flex-wrap sm:flex-nowrap items-center justify-between gap-2.5 border-b border-amber-500/30 bg-amber-500/[0.09] dark:bg-amber-500/[0.12] px-3.5 md:px-6 py-2.5 text-xs text-amber-950 dark:text-amber-100 transition-opacity duration-200"
    >
      <div className="flex items-start sm:items-center gap-2.5 min-w-0 flex-1">
        <BatteryWarning
          size={16}
          className="mt-0.5 sm:mt-0 shrink-0 text-amber-600 dark:text-amber-400"
        />
        <div className="min-w-0 flex flex-col sm:flex-row sm:items-center sm:gap-1.5">
          <span className="font-semibold shrink-0">{t(lang, 'batteryOptBannerTitle')}</span>
          <span
            className="hidden sm:inline text-amber-700/60 dark:text-amber-300/60"
            aria-hidden="true"
          >
            ·
          </span>
          <span className="text-[11px] leading-snug text-amber-900/85 dark:text-amber-200/90 sm:truncate">
            {t(lang, 'batteryOptBannerDesc')}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0 ms-auto">
        <button
          type="button"
          data-testid="battery-opt-settings-btn"
          onClick={onOpenSettings}
          className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 active:scale-[0.97] px-2.5 py-1.5 text-[11px] font-semibold text-white whitespace-nowrap transition-transform duration-150"
        >
          <Settings size={13} />
          <span>{t(lang, 'batteryOptSettingsBtn')}</span>
        </button>
        <button
          type="button"
          data-testid="battery-opt-dismiss-btn"
          onClick={onDismiss}
          aria-label={t(lang, 'batteryOptDismissAria')}
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-amber-800 dark:text-amber-300 hover:bg-amber-500/15 active:scale-95 transition"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
};
