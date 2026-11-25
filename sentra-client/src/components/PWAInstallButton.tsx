import React, { useState } from 'react';
import { Download, Share, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';
import type { Language } from '../i18n/translations';

interface PWAInstallButtonProps {
  lang: Language;
  variant?: 'sidebar' | 'compact';
}

export const PWAInstallButton: React.FC<PWAInstallButtonProps> = ({
  lang,
  variant = 'compact',
}) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  const label = lang === 'fa' ? 'نصب اپلیکیشن' : 'Install App';
  const iosLabel = lang === 'fa' ? 'نصب در iOS' : 'Install on iOS';

  if (isInstallable) {
    if (variant === 'sidebar') {
      return (
        <button
          type="button"
          onClick={() => void install()}
          className="flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-[13px] font-medium text-emerald-700 dark:text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/15 transition duration-150 active:scale-[0.98]"
        >
          <Download size={18} className="shrink-0" />
          <span className="truncate">{label}</span>
        </button>
      );
    }

    return (
      <button
        type="button"
        onClick={() => void install()}
        aria-label={label}
        className="inline-flex h-9 w-9 sm:h-auto sm:w-auto items-center justify-center gap-1.5 rounded-xl border border-emerald-500/40 bg-emerald-500/10 sm:px-3 sm:py-2 text-xs font-semibold text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20 whitespace-nowrap transition duration-150 active:scale-[0.97]"
      >
        <Download size={15} className="shrink-0" />
        <span className="hidden sm:inline">{label}</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        {variant === 'sidebar' ? (
          <button
            type="button"
            onClick={() => setShowIOSGuide(true)}
            className="flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-[13px] font-medium text-emerald-700 dark:text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/15 transition duration-150 active:scale-[0.98]"
          >
            <Share size={18} className="shrink-0" />
            <span className="truncate">{iosLabel}</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setShowIOSGuide(true)}
            aria-label={iosLabel}
            className="inline-flex h-9 w-9 sm:h-auto sm:w-auto items-center justify-center gap-1.5 rounded-xl border border-emerald-500/40 bg-emerald-500/10 sm:px-3 sm:py-2 text-xs font-semibold text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20 whitespace-nowrap transition duration-150 active:scale-[0.97]"
          >
            <Share size={15} className="shrink-0" />
            <span className="hidden sm:inline">{iosLabel}</span>
          </button>
        )}

        {showIOSGuide && (
          <div
            role="dialog"
            aria-modal="true"
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm"
          >
            <div className="w-full max-w-sm rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-2xl">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                  {lang === 'fa' ? 'نصب سنترا در آیفون و آیپد' : 'Install on iPhone / iPad'}
                </h3>
                <button
                  type="button"
                  onClick={() => setShowIOSGuide(false)}
                  aria-label={lang === 'fa' ? 'بستن' : 'Close'}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <X size={16} />
                </button>
              </div>
              <p className="mt-3 text-xs leading-6 text-slate-600 dark:text-slate-300">
                {lang === 'fa' ? (
                  <>
                    ۱. در نوار پایین مرورگر Safari روی دکمه <strong>Share</strong> ضربه بزنید.
                    <br />
                    ۲. گزینه <strong>Add to Home Screen</strong> را انتخاب کنید.
                  </>
                ) : (
                  <>
                    1. Tap the <strong>Share</strong> button in the Safari toolbar.
                    <br />
                    2. Scroll down and tap <strong>Add to Home Screen</strong>.
                  </>
                )}
              </p>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="mt-4 w-full rounded-xl bg-emerald-600 hover:bg-emerald-500 py-2 text-xs font-semibold text-white transition"
              >
                {lang === 'fa' ? 'متوجه شدم' : 'Got it'}
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};
