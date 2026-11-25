import React, { useState } from 'react';
import {
  BatteryWarning,
  Check,
  ChevronDown,
  Copy,
  Globe,
  Link2,
  LogOut,
  Moon,
  Network,
  Send,
  Settings,
  Shield,
  SlidersHorizontal,
  Smartphone,
  Sun,
  Trash2,
} from 'lucide-react';
import type {
  ConnectionModeId,
  RoutingMode,
  ThemeMode,
  UserDeviceItem,
} from '../types/sentra';
import { type Language, type TranslationKey, t } from '../i18n/translations';
import type { BatteryOptimizationStatus } from '../utils/reconnectPolicy';
import { NetworkSpeedTestCard } from './NetworkSpeedTestCard';

interface SettingsViewProps {
  lang: Language;
  onChangeLanguage: (lang: Language) => void;
  theme: ThemeMode;
  onToggleTheme: () => void;
  routingMode: RoutingMode;
  selectedMode: ConnectionModeId;
  splitTunneling: boolean;
  killSwitch: boolean;
  autoReconnect: boolean;
  batteryOptStatus: BatteryOptimizationStatus | null;
  useWarp: boolean;
  customDns: string;
  devices: UserDeviceItem[];
  maxDevices: number;
  botUsername: string;
  username: string;
  onLogout: () => void;
  onChangeRoutingMode: (mode: RoutingMode) => void;
  onToggleSplitTunneling: (enabled: boolean) => void;
  onToggleKillSwitch: (enabled: boolean) => void;
  onToggleAutoReconnect: (enabled: boolean) => void;
  onOpenBatteryOptimizationSettings: () => void;
  onToggleWarp: (enabled: boolean) => void;
  onChangeCustomDns: (dns: string) => void;
  onRemoveDevice: (deviceId: string) => Promise<void>;
  onRequestTelegramLinkCode: () => Promise<string>;
  onLogEvent?: (message: string) => void;
}

const ROUTING_OPTIONS: Array<{
  id: RoutingMode;
  titleKey: TranslationKey;
  descKey: TranslationKey;
}> = [
  { id: 'tunnel', titleKey: 'routeTunnelTitle', descKey: 'routeTunnelDesc' },
  { id: 'system_proxy', titleKey: 'routeSysProxyTitle', descKey: 'routeSysProxyDesc' },
  { id: 'proxy', titleKey: 'routeLocalProxyTitle', descKey: 'routeLocalProxyDesc' },
];

export const SettingsView: React.FC<SettingsViewProps> = ({
  lang,
  onChangeLanguage,
  theme,
  onToggleTheme,
  routingMode,
  selectedMode,
  splitTunneling,
  killSwitch,
  autoReconnect,
  batteryOptStatus,
  useWarp,
  customDns,
  devices,
  maxDevices,
  botUsername,
  username,
  onLogout,
  onChangeRoutingMode,
  onToggleSplitTunneling,
  onToggleKillSwitch,
  onToggleAutoReconnect,
  onOpenBatteryOptimizationSettings,
  onToggleWarp,
  onChangeCustomDns,
  onRemoveDevice,
  onRequestTelegramLinkCode,
  onLogEvent,
}) => {
  const [advancedNetworkOpen, setAdvancedNetworkOpen] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [linkCode, setLinkCode] = useState<string | null>(null);
  const [linkLoading, setLinkLoading] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const isStaticIp = selectedMode === 'static_ip';
  const isGaming = selectedMode === 'gaming';
  const isWarpDisabled = isStaticIp || isGaming;
  const cleanBot = botUsername?.replace(/^@/, '').trim();

  const handleGenerateLinkCode = async () => {
    setLinkError(null);
    setLinkLoading(true);
    try {
      const code = await onRequestTelegramLinkCode();
      setLinkCode(code);
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : t(lang, 'otpFailed'));
    } finally {
      setLinkLoading(false);
    }
  };

  const handleCopyCode = async () => {
    if (!linkCode) return;
    try {
      await navigator.clipboard.writeText(`/link ${linkCode}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // ignore clipboard errors
    }
  };

  return (
    <div className="animate-sentra-view flex-1 overflow-y-auto px-4 md:px-8 py-6 pb-24 md:pb-10">
      <div className="mx-auto max-w-4xl space-y-5">
        {/* Language Selector (English default LTR / فارسی RTL) */}
        <section className="rounded-2xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                <Globe size={18} />
              </div>
              <div>
                <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                  {t(lang, 'languageTitle')}
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {t(lang, 'languageDesc')}
                </p>
              </div>
            </div>

            <div
              role="radiogroup"
              aria-label={t(lang, 'languageTitle')}
              className="grid grid-cols-2 gap-1.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-100/80 dark:bg-slate-950/60 p-1 sm:w-auto w-full"
            >
              <button
                type="button"
                role="radio"
                aria-checked={lang === 'en'}
                data-testid="lang-option-en"
                onClick={() => onChangeLanguage('en')}
                className={`rounded-lg px-3.5 py-2 text-xs font-semibold transition-all duration-150 active:scale-[0.98] ${
                  lang === 'en'
                    ? 'bg-emerald-600 text-white shadow-sm'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {t(lang, 'langEnglish')}
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={lang === 'fa'}
                data-testid="lang-option-fa"
                onClick={() => onChangeLanguage('fa')}
                className={`rounded-lg px-3.5 py-2 text-xs font-semibold transition-all duration-150 active:scale-[0.98] ${
                  lang === 'fa'
                    ? 'bg-emerald-600 text-white shadow-sm'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {t(lang, 'langPersian')}
              </button>
            </div>
          </div>
        </section>

        {/* Appearance */}
        <section className="rounded-2xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-5">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200">
                {theme === 'dark' ? <Moon size={18} /> : <Sun size={18} />}
              </div>
              <div>
                <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                  {t(lang, 'appearanceTitle')}
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {t(lang, 'appearanceDesc')}
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={onToggleTheme}
              className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3.5 py-2 text-xs font-semibold text-slate-800 dark:text-slate-100 hover:border-emerald-500/50 active:scale-[0.97] transition"
            >
              {theme === 'dark' ? <Sun size={15} className="text-amber-400" /> : <Moon size={15} />}
              <span>{theme === 'dark' ? t(lang, 'lightMode') : t(lang, 'darkMode')}</span>
            </button>
          </div>
        </section>

        {/* Routing & Core Security */}
        <section className="rounded-2xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-5 space-y-5">
          <div className="flex items-center gap-2.5">
            <Network size={18} className="text-emerald-500" />
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">
              {t(lang, 'routingTitle')}
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
            {ROUTING_OPTIONS.map((opt) => {
              const disabled = isStaticIp && opt.id !== 'tunnel';
              const active = routingMode === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  disabled={disabled}
                  onClick={() => onChangeRoutingMode(opt.id)}
                  className={`rounded-xl border p-3.5 text-start transition active:scale-[0.99] ${
                    active
                      ? 'border-emerald-500 bg-emerald-500/[0.07]'
                      : disabled
                      ? 'cursor-not-allowed border-slate-200/50 dark:border-slate-800/60 opacity-50'
                      : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
                  }`}
                >
                  <div className="text-xs font-bold text-slate-900 dark:text-white">
                    {t(lang, opt.titleKey)}
                  </div>
                  <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                    {t(lang, opt.descKey)}
                  </div>
                </button>
              );
            })}
          </div>

          <div className="divide-y divide-slate-200/70 dark:divide-slate-800">
            <div className="flex items-center justify-between gap-4 py-3">
              <div>
                <div className="text-xs font-semibold text-slate-900 dark:text-white">
                  {t(lang, 'splitTunnelTitle')}
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400">
                  {t(lang, 'splitTunnelDesc')}
                </div>
              </div>
              <button
                type="button"
                role="switch"
                dir="ltr"
                aria-checked={splitTunneling}
                aria-label={t(lang, 'splitTunnelAria')}
                onClick={() => onToggleSplitTunneling(!splitTunneling)}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                  splitTunneling ? 'bg-emerald-600' : 'bg-slate-300 dark:bg-slate-700'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform duration-150 ${
                    splitTunneling ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>

            <div className="flex items-center justify-between gap-4 py-3">
              <div>
                <div className="text-xs font-semibold text-slate-900 dark:text-white">
                  {t(lang, 'killSwitchTitle')}
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400">
                  {t(lang, 'killSwitchDesc')}
                </div>
              </div>
              <button
                type="button"
                role="switch"
                dir="ltr"
                aria-checked={killSwitch}
                aria-label={t(lang, 'killSwitchAria')}
                onClick={() => onToggleKillSwitch(!killSwitch)}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                  killSwitch ? 'bg-emerald-600' : 'bg-slate-300 dark:bg-slate-700'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform duration-150 ${
                    killSwitch ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>

            <div className="flex items-center justify-between gap-4 py-3">
              <div>
                <div className="text-xs font-semibold text-slate-900 dark:text-white">
                  {t(lang, 'autoReconnectTitle')}
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400">
                  {t(lang, 'autoReconnectDesc')}
                </div>
              </div>
              <button
                type="button"
                role="switch"
                dir="ltr"
                data-testid="auto-reconnect-switch"
                aria-checked={autoReconnect}
                aria-label={t(lang, 'autoReconnectAria')}
                onClick={() => onToggleAutoReconnect(!autoReconnect)}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                  autoReconnect ? 'bg-emerald-600' : 'bg-slate-300 dark:bg-slate-700'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform duration-150 ${
                    autoReconnect ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>

            {batteryOptStatus?.isAndroid && (
              <div
                data-testid="battery-opt-settings-row"
                className="flex flex-wrap sm:flex-nowrap items-center justify-between gap-3 py-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-900 dark:text-white">
                    {batteryOptStatus.isOptimized && (
                      <BatteryWarning
                        size={14}
                        className="shrink-0 text-amber-500"
                      />
                    )}
                    <span>{t(lang, 'batteryOptSettingsTitle')}</span>
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">
                    {t(lang, 'batteryOptSettingsDesc')}
                  </div>
                </div>
                {batteryOptStatus.isOptimized ? (
                  <button
                    type="button"
                    data-testid="battery-opt-settings-row-btn"
                    onClick={onOpenBatteryOptimizationSettings}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 active:scale-[0.97] px-3 py-1.5 text-xs font-semibold text-amber-700 dark:text-amber-300 transition"
                  >
                    <Settings size={14} />
                    <span>{t(lang, 'batteryOptOpenSettings')}</span>
                  </button>
                ) : (
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
                    <Check size={13} />
                    <span>{t(lang, 'batteryOptUnrestricted')}</span>
                  </span>
                )}
              </div>
            )}

            {/* Collapsible Advanced Network Settings Accordion */}
            <div className="pt-3">
              <button
                type="button"
                data-testid="advanced-network-accordion-toggle"
                aria-expanded={advancedNetworkOpen}
                aria-controls="advanced-network-panel"
                onClick={() => setAdvancedNetworkOpen((prev) => !prev)}
                className="flex w-full items-center justify-between gap-3 rounded-xl border border-slate-200/80 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 px-3.5 py-3 text-start hover:border-emerald-500/40 transition"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <SlidersHorizontal
                    size={16}
                    aria-hidden="true"
                    className="shrink-0 text-emerald-500"
                  />
                  <div className="min-w-0">
                    <div className="text-xs font-bold text-slate-900 dark:text-white">
                      {t(lang, 'advancedNetworkTitle')}
                    </div>
                    <div className="truncate text-[11px] text-slate-500 dark:text-slate-400">
                      {t(lang, 'advancedNetworkDesc')}
                    </div>
                  </div>
                </div>
                <ChevronDown
                  size={16}
                  aria-hidden="true"
                  className={`shrink-0 text-slate-400 transition-transform duration-200 ${
                    advancedNetworkOpen ? 'rotate-180 text-emerald-500' : ''
                  }`}
                />
              </button>

              {advancedNetworkOpen && (
                <div
                  id="advanced-network-panel"
                  data-testid="advanced-network-accordion-panel"
                  className="mt-3 rounded-xl border border-slate-200/80 dark:border-slate-800/90 bg-slate-50/40 dark:bg-slate-950/35 px-4 py-2 divide-y divide-slate-200/70 dark:divide-slate-800"
                >
                  <div className="flex items-center justify-between gap-4 py-3">
                    <div>
                      <div className="text-xs font-semibold text-slate-900 dark:text-white">
                        {t(lang, 'warpTitle')}
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400">
                        {isStaticIp
                          ? t(lang, 'warpStaticDisabled')
                          : isGaming
                          ? t(lang, 'warpGamingDisabled')
                          : t(lang, 'warpDesc')}
                      </div>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      dir="ltr"
                      disabled={isWarpDisabled}
                      aria-checked={useWarp && !isWarpDisabled}
                      aria-label={t(lang, 'warpAria')}
                      onClick={() => onToggleWarp(!useWarp)}
                      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-40 ${
                        useWarp && !isWarpDisabled ? 'bg-emerald-600' : 'bg-slate-300 dark:bg-slate-700'
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform duration-150 ${
                          useWarp && !isWarpDisabled ? 'translate-x-6' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </div>

                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-3">
                    <div>
                      <label
                        htmlFor="custom-dns-input"
                        className="text-xs font-semibold text-slate-900 dark:text-white"
                      >
                        {t(lang, 'customDnsTitle')}
                      </label>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400">
                        {t(lang, 'customDnsDesc')}
                      </div>
                    </div>
                    <input
                      id="custom-dns-input"
                      type="text"
                      dir="ltr"
                      value={customDns}
                      onChange={(e) => onChangeCustomDns(e.target.value)}
                      className="w-full sm:w-56 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950/80 px-3 py-2 font-mono text-xs text-slate-900 dark:text-slate-100 focus:border-emerald-500 focus:outline-none"
                    />
                  </div>

                  <div className="pb-2">
                    <NetworkSpeedTestCard lang={lang} onLogEvent={onLogEvent} />
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Real Connected Devices */}
        <section className="rounded-2xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <Smartphone size={18} className="text-emerald-500" />
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                {t(lang, 'devicesTitle')}
              </h2>
            </div>
            <span className="font-mono text-xs tabular-nums text-slate-500 dark:text-slate-400" dir="ltr">
              {devices.length} / {maxDevices || '—'}
            </span>
          </div>

          {devices.length === 0 ? (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t(lang, 'noDevicesText')}
            </p>
          ) : (
            <div className="divide-y divide-slate-200/70 dark:divide-slate-800">
              {devices.map((dev) => (
                <div
                  key={dev.device_id}
                  className="flex items-center justify-between gap-3 py-3"
                >
                  <div className="min-w-0">
                    <div className="truncate text-xs font-semibold text-slate-900 dark:text-white">
                      {dev.device_name || dev.platform}
                    </div>
                    <div
                      className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400 font-mono"
                      dir="ltr"
                    >
                      {dev.platform} · {dev.device_id.slice(0, 12)}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={removingId === dev.device_id}
                    onClick={async () => {
                      setRemovingId(dev.device_id);
                      try {
                        await onRemoveDevice(dev.device_id);
                      } finally {
                        setRemovingId(null);
                      }
                    }}
                    aria-label={t(lang, 'removeDeviceAria', {
                      name: dev.device_name || dev.device_id,
                    })}
                    className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-xs text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 active:scale-[0.97] disabled:opacity-50 transition"
                  >
                    <Trash2 size={14} />
                    <span>{t(lang, 'remove')}</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Telegram Account Linking */}
        <section className="rounded-2xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <Shield size={18} className="shrink-0 text-emerald-500" />
              <div className="min-w-0">
                <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                  {t(lang, 'telegramLinkTitle')}
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {t(lang, 'telegramLinkDesc')}
                </p>
              </div>
            </div>

            <button
              type="button"
              disabled={linkLoading}
              onClick={handleGenerateLinkCode}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 active:scale-[0.97] disabled:opacity-60 px-3.5 py-2 text-xs font-semibold text-white transition"
            >
              <Link2 size={15} />
              <span>{linkLoading ? t(lang, 'loadingCode') : t(lang, 'getLinkCode')}</span>
            </button>
          </div>

          {linkError && (
            <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">
              {linkError}
            </p>
          )}

          {linkCode && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
              <div className="space-y-1">
                <div className="text-xs text-slate-700 dark:text-slate-200">
                  {t(lang, 'sendCommandToBot')}
                </div>
                <div
                  className="font-mono text-sm font-bold text-emerald-700 dark:text-emerald-300"
                  dir="ltr"
                >
                  /link {linkCode}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleCopyCode}
                  className="inline-flex items-center gap-1 rounded-lg border border-emerald-500/40 bg-white/80 dark:bg-slate-900 px-3 py-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-300 active:scale-[0.97] transition"
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                  <span>{copied ? t(lang, 'copied') : t(lang, 'copyCommand')}</span>
                </button>
                {cleanBot && (
                  <a
                    href={`https://t.me/${cleanBot}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white active:scale-[0.97] transition"
                  >
                    <Send size={14} />
                    <span dir="ltr">@{cleanBot}</span>
                  </a>
                )}
              </div>
            </div>
          )}
        </section>

        {/* Account & Session Logout */}
        <section className="rounded-2xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-5">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                {t(lang, 'accountTitle')}
              </h2>
              <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
                {username
                  ? t(lang, 'signedInAs', { username })
                  : t(lang, 'sessionSaved')}
              </p>
            </div>
            <button
              type="button"
              onClick={onLogout}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-rose-500/30 bg-rose-500/10 hover:bg-rose-500/20 active:scale-[0.97] px-3.5 py-2 text-xs font-semibold text-rose-600 dark:text-rose-400 transition"
            >
              <LogOut size={15} />
              <span>{t(lang, 'signOut')}</span>
            </button>
          </div>
        </section>
      </div>
    </div>
  );
};
