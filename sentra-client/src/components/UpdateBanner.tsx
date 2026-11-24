import React from 'react';
import { ArrowUpRight, Sparkles, X } from 'lucide-react';
import { type Language, t } from '../i18n/translations';
import { isSafeReleaseUrl } from '../utils/proxyParser';

export interface ReleaseUpdateInfo {
  version: string;
  url: string;
  name?: string;
}

interface UpdateBannerProps {
  lang: Language;
  update: ReleaseUpdateInfo | null;
  onDismiss: () => void;
}

export const UpdateBanner: React.FC<UpdateBannerProps> = ({
  lang,
  update,
  onDismiss,
}) => {
  if (!update || !isSafeReleaseUrl(update.url)) return null;

  return (
    <div
      role="status"
      data-testid="update-banner"
      className="flex items-center justify-between gap-3 border-b border-emerald-500/25 bg-emerald-500/[0.08] dark:bg-emerald-500/[0.11] px-3.5 md:px-6 py-2 text-xs text-emerald-900 dark:text-emerald-200 transition-opacity duration-200"
    >
      <div className="flex items-center gap-2 min-w-0">
        <Sparkles size={14} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
        <span className="font-semibold whitespace-nowrap">{t(lang, 'updateAvailable')}</span>
        <span className="text-emerald-700/70 dark:text-emerald-300/70" aria-hidden="true">
          ·
        </span>
        <span className="truncate tabular-nums text-[11px]">
          {t(lang, 'updateVersion', { version: update.version })}
        </span>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <a
          href={update.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 active:scale-[0.97] px-2.5 py-1 text-[11px] font-semibold text-white whitespace-nowrap transition-transform duration-150"
        >
          <span>{t(lang, 'downloadUpdate')}</span>
          <ArrowUpRight size={13} />
        </a>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t(lang, 'dismissUpdate')}
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/15 active:scale-95 transition"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
};
