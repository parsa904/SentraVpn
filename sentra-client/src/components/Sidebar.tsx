import React from 'react';
import {
  FileTerminal,
  Gift,
  Home,
  Layers,
  LogOut,
  Moon,
  Settings,
  Sun,
} from 'lucide-react';
import type { NavTab, ThemeMode } from '../types/sentra';
import { type Language, type TranslationKey, t } from '../i18n/translations';
import { SentraLogo } from './SentraLogo';
import { PWAInstallButton } from './PWAInstallButton';

interface SidebarProps {
  lang: Language;
  activeTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  theme: ThemeMode;
  onToggleTheme: () => void;
  onLogout: () => void;
  username: string;
  outboundsCount: number;
}

const NAV_ITEMS: Array<{
  id: NavTab;
  labelKey: TranslationKey;
  shortKey: TranslationKey;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}> = [
  { id: 'home', labelKey: 'navHome', shortKey: 'navHomeShort', icon: Home },
  { id: 'profiles', labelKey: 'navProfiles', shortKey: 'navProfilesShort', icon: Layers },
  { id: 'donate', labelKey: 'navDonate', shortKey: 'navDonateShort', icon: Gift },
  { id: 'settings', labelKey: 'navSettings', shortKey: 'navSettingsShort', icon: Settings },
  { id: 'logs', labelKey: 'navLogs', shortKey: 'navLogsShort', icon: FileTerminal },
];

export const Sidebar: React.FC<SidebarProps> = ({
  lang,
  activeTab,
  onSelectTab,
  theme,
  onToggleTheme,
  onLogout,
  username,
  outboundsCount,
}) => {
  return (
    <>
      {/* Desktop Sidebar (flips automatically via logical border-e) */}
      <aside
        aria-label={t(lang, 'mainMenuAria')}
        className="hidden md:flex md:w-60 lg:w-[260px] shrink-0 flex-col justify-between border-e border-slate-200/80 dark:border-slate-800/90 bg-white/85 dark:bg-[#0B1220]/90 backdrop-blur-xl"
      >
        <div>
          {/* Brand Header */}
          <div className="flex items-center gap-3 px-5 py-5 border-b border-slate-200/70 dark:border-slate-800/80">
            <SentraLogo size={38} withSquircle animated />
            <div className="min-w-0">
              <div className="text-base font-bold tracking-tight text-slate-900 dark:text-white">
                {t(lang, 'brand')}
              </div>
              {username && (
                <div className="truncate text-xs text-slate-500 dark:text-slate-400" dir="ltr">
                  {username}
                </div>
              )}
            </div>
          </div>

          {/* Primary Navigation */}
          <nav className="p-3 space-y-1">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onSelectTab(item.id)}
                  aria-current={active ? 'page' : undefined}
                  className={`flex w-full items-center justify-between gap-3 rounded-xl px-3.5 py-2.5 text-start text-[13px] font-medium transition duration-150 active:scale-[0.98] ${
                    active
                      ? 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-400 font-semibold'
                      : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/70 hover:text-slate-900 dark:hover:text-slate-100'
                  }`}
                >
                  <span className="flex items-center gap-3 min-w-0">
                    <Icon
                      size={19}
                      className={
                        active
                          ? 'shrink-0 text-emerald-600 dark:text-emerald-400'
                          : 'shrink-0 text-slate-400 dark:text-slate-500'
                      }
                    />
                    <span className="truncate">{t(lang, item.labelKey)}</span>
                  </span>
                  {item.id === 'profiles' && outboundsCount > 0 && (
                    <span className="font-mono text-[11px] tabular-nums text-slate-400 dark:text-slate-500">
                      {outboundsCount}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Bottom Utility Actions */}
        <div className="border-t border-slate-200/70 dark:border-slate-800/80 p-3 space-y-1">
          <PWAInstallButton lang={lang} variant="sidebar" />
          <button
            type="button"
            onClick={onToggleTheme}
            className="flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-[13px] font-medium text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/70 hover:text-slate-900 dark:hover:text-slate-100 transition duration-150 active:scale-[0.98]"
          >
            {theme === 'dark' ? (
              <>
                <Sun size={18} className="shrink-0 text-amber-400" />
                <span>{t(lang, 'lightMode')}</span>
              </>
            ) : (
              <>
                <Moon size={18} className="shrink-0 text-slate-500" />
                <span>{t(lang, 'darkMode')}</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={onLogout}
            className="flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-[13px] font-medium text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 transition duration-150 active:scale-[0.98]"
          >
            <LogOut size={18} className="shrink-0" />
            <span>{t(lang, 'signOut')}</span>
          </button>
        </div>
      </aside>

      {/* Mobile Bottom Tab Bar */}
      <nav
        aria-label={t(lang, 'mobileNavAria')}
        className="fixed inset-x-0 bottom-0 z-30 flex md:hidden items-center justify-around border-t border-slate-200/90 dark:border-slate-800 bg-white/95 dark:bg-[#0B1220]/95 px-1 py-1.5 backdrop-blur-xl"
      >
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectTab(item.id)}
              aria-current={active ? 'page' : undefined}
              className={`flex flex-1 flex-col items-center justify-center gap-1 rounded-lg py-1.5 text-[10px] font-medium transition duration-150 active:scale-95 ${
                active
                  ? 'text-emerald-600 dark:text-emerald-400 font-semibold'
                  : 'text-slate-500 dark:text-slate-400'
              }`}
            >
              <Icon size={19} />
              <span className="truncate max-w-[68px]">{t(lang, item.shortKey)}</span>
            </button>
          );
        })}
      </nav>
    </>
  );
};
