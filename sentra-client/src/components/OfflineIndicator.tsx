import React from 'react';
import { WifiOff } from 'lucide-react';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import type { Language } from '../i18n/translations';

interface OfflineIndicatorProps {
  lang: Language;
  cachedAt?: string | null;
}

export const OfflineIndicator: React.FC<OfflineIndicatorProps> = ({ lang, cachedAt }) => {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  const formattedTime = (() => {
    if (!cachedAt) return null;
    const ms = Date.parse(cachedAt);
    if (Number.isNaN(ms)) return null;
    try {
      return new Intl.DateTimeFormat(lang === 'fa' ? 'fa-IR' : 'en-US', {
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(ms));
    } catch {
      return null;
    }
  })();

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-16 md:bottom-5 start-4 z-40 flex items-center gap-2 rounded-xl border border-amber-500/35 bg-amber-950/92 px-3.5 py-2 text-xs font-medium text-amber-100 shadow-lg backdrop-blur-md"
    >
      <WifiOff size={14} className="shrink-0 text-amber-400" />
      <span>
        {lang === 'fa'
          ? formattedTime
            ? `حالت آفلاین — آخرین پیکربندی ذخیره‌شده (${formattedTime}) فعال است.`
            : 'حالت آفلاین — آخرین پیکربندی ذخیره‌شده فعال است.'
          : formattedTime
            ? `Offline Mode — Using cached configuration (${formattedTime}).`
            : 'Offline Mode — Using cached configuration.'}
      </span>
    </div>
  );
};
