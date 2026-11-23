import React, { useState } from 'react';
import {
  Check,
  Copy,
  Link2,
  LogOut,
  Moon,
  Network,
  Send,
  Shield,
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

interface SettingsViewProps {
  theme: ThemeMode;
  onToggleTheme: () => void;
  routingMode: RoutingMode;
  selectedMode: ConnectionModeId;
  splitTunneling: boolean;
  killSwitch: boolean;
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
  onToggleWarp: (enabled: boolean) => void;
  onChangeCustomDns: (dns: string) => void;
  onRemoveDevice: (deviceId: string) => Promise<void>;
  onRequestTelegramLinkCode: () => Promise<string>;
}

const ROUTING_OPTIONS: Array<{ id: RoutingMode; title: string; desc: string }> = [
  { id: 'tunnel', title: 'حالت Tunnel (سراسری)', desc: 'عبور کل ترافیک سیستم از تونل امن' },
  { id: 'system_proxy', title: 'پروکسی سیستم (System Proxy)', desc: 'تنظیم خودکار پروکسی برای مرورگرها' },
  { id: 'proxy', title: 'پروکسی محلی (Local Proxy)', desc: 'فقط پورت SOCKS/HTTP بدون تغییر سیستم' },
];

export const SettingsView: React.FC<SettingsViewProps> = ({
  theme,
  onToggleTheme,
  routingMode,
  selectedMode,
  splitTunneling,
  killSwitch,
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
  onToggleWarp,
  onChangeCustomDns,
  onRemoveDevice,
  onRequestTelegramLinkCode,
}) => {
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [linkCode, setLinkCode] = useState<string | null>(null);
  const [linkLoading, setLinkLoading] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const isStaticIp = selectedMode === 'static_ip';
  const cleanBot = botUsername?.replace(/^@/, '').trim();

  const handleGenerateLinkCode = async () => {
    setLinkError(null);
    setLinkLoading(true);
    try {
      const code = await onRequestTelegramLinkCode();
      setLinkCode(code);
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : 'دریافت کد اتصال ناموفق بود.');
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
    <div className="flex-1 overflow-y-auto px-4 md:px-8 py-6 pb-24 md:pb-10">
      <div className="mx-auto max-w-4xl space-y-6">
        {/* Appearance */}
        <section className="rounded-2xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-5">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200">
                {theme === 'dark' ? <Moon size={18} /> : <Sun size={18} />}
              </div>
              <div>
                <h2 className="text-sm font-bold text-slate-900 dark:text-white">ظاهر برنامه</h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  تغییر آنی بین پوسته تاریک (Dark) و روشن (Light)
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={onToggleTheme}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3.5 py-2 text-xs font-semibold text-slate-800 dark:text-slate-100 hover:border-emerald-500/50 transition"
            >
              {theme === 'dark' ? <Sun size={15} className="text-amber-400" /> : <Moon size={15} />}
              <span>{theme === 'dark' ? 'حالت روشن' : 'حالت تاریک'}</span>
            </button>
          </div>
        </section>

        {/* Routing & Core Security */}
        <section className="rounded-2xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-5 space-y-5">
          <div className="flex items-center gap-2.5">
            <Network size={18} className="text-emerald-500" />
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">
              مسیریابی و امنیت شبکه
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
                  className={`rounded-xl border p-3.5 text-right transition ${
                    active
                      ? 'border-emerald-500 bg-emerald-500/[0.07]'
                      : disabled
                      ? 'cursor-not-allowed border-slate-200/50 dark:border-slate-800/60 opacity-50'
                      : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
                  }`}
                >
                  <div className="text-xs font-bold text-slate-900 dark:text-white">{opt.title}</div>
                  <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                    {opt.desc}
                  </div>
                </button>
              );
            })}
          </div>

          <div className="divide-y divide-slate-200/70 dark:divide-slate-800">
            <div className="flex items-center justify-between gap-4 py-3">
              <div>
                <div className="text-xs font-semibold text-slate-900 dark:text-white">
                  مسیریابی هوشمند ایران (Split Tunneling)
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400">
                  عبور مستقیم سایت‌ها و بانک‌های داخلی (.ir) بدون افت سرعت
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={splitTunneling}
                aria-label="تغییر وضعیت Split Tunneling"
                onClick={() => onToggleSplitTunneling(!splitTunneling)}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition ${
                  splitTunneling ? 'bg-emerald-600' : 'bg-slate-300 dark:bg-slate-700'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${
                    splitTunneling ? '-translate-x-6' : '-translate-x-1'
                  }`}
                />
              </button>
            </div>

            <div className="flex items-center justify-between gap-4 py-3">
              <div>
                <div className="text-xs font-semibold text-slate-900 dark:text-white">
                  محافظ قطع ناگهانی (Kill-Switch)
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400">
                  جلوگیری از نشت آی‌پی واقعی در صورت قطع شدن تونل
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={killSwitch}
                aria-label="تغییر وضعیت Kill-Switch"
                onClick={() => onToggleKillSwitch(!killSwitch)}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition ${
                  killSwitch ? 'bg-emerald-600' : 'bg-slate-300 dark:bg-slate-700'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${
                    killSwitch ? '-translate-x-6' : '-translate-x-1'
                  }`}
                />
              </button>
            </div>

            <div className="flex items-center justify-between gap-4 py-3">
              <div>
                <div className="text-xs font-semibold text-slate-900 dark:text-white">
                  لایه Cloudflare WARP
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400">
                  {isStaticIp
                    ? 'در حالت آی‌پی ثابت برای حفظ ثبات آی‌پی به‌صورت خودکار خاموش است'
                    : 'بهبود دسترسی به سرویس‌های حساس و کاهش کپچا'}
                </div>
              </div>
              <button
                type="button"
                role="switch"
                disabled={isStaticIp}
                aria-checked={useWarp && !isStaticIp}
                aria-label="تغییر وضعیت Cloudflare WARP"
                onClick={() => onToggleWarp(!useWarp)}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition disabled:opacity-40 ${
                  useWarp && !isStaticIp ? 'bg-emerald-600' : 'bg-slate-300 dark:bg-slate-700'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${
                    useWarp && !isStaticIp ? '-translate-x-6' : '-translate-x-1'
                  }`}
                />
              </button>
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-3">
              <div>
                <label
                  htmlFor="custom-dns-input"
                  className="text-xs font-semibold text-slate-900 dark:text-white"
                >
                  سرور DNS اختصاصی
                </label>
                <div className="text-[11px] text-slate-500 dark:text-slate-400">
                  پشتیبانی از DoH یا IPv4 استاندارد (مثلاً 1.1.1.1)
                </div>
              </div>
              <input
                id="custom-dns-input"
                type="text"
                dir="ltr"
                value={customDns}
                onChange={(e) => onChangeCustomDns(e.target.value)}
                className="w-full sm:w-56 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/60 px-3 py-2 font-mono text-xs text-slate-900 dark:text-slate-100 focus:border-emerald-500 focus:outline-none"
              />
            </div>
          </div>
        </section>

        {/* Real Connected Devices */}
        <section className="rounded-2xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <Smartphone size={18} className="text-emerald-500" />
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                دستگاه‌های متصل به حساب
              </h2>
            </div>
            <span className="font-mono text-xs tabular-nums text-slate-500 dark:text-slate-400">
              {devices.length} / {maxDevices || '—'}
            </span>
          </div>

          {devices.length === 0 ? (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              اطلاعات دستگاه‌های فعال هنوز از سرور دریافت نشده است.
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
                    <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400 font-mono">
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
                    aria-label={`حذف دستگاه ${dev.device_name || dev.device_id}`}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-xs text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 disabled:opacity-50 transition"
                  >
                    <Trash2 size={14} />
                    <span>حذف</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Telegram Account Linking */}
        <section className="rounded-2xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <Shield size={18} className="text-emerald-500" />
              <div>
                <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                  اتصال حساب به ربات تلگرام
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  برای دریافت پیام تایید اوتباندهای اهدایی و مدیریت اشتراک در تلگرام
                </p>
              </div>
            </div>

            <button
              type="button"
              disabled={linkLoading}
              onClick={handleGenerateLinkCode}
              className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 px-3.5 py-2 text-xs font-semibold text-white transition"
            >
              <Link2 size={15} />
              <span>{linkLoading ? 'در حال دریافت...' : 'دریافت کد اتصال'}</span>
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
                  دستور زیر را برای ربات ارسال کنید:
                </div>
                <div className="font-mono text-sm font-bold text-emerald-700 dark:text-emerald-300" dir="ltr">
                  /link {linkCode}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleCopyCode}
                  className="inline-flex items-center gap-1 rounded-lg border border-emerald-500/40 bg-white/80 dark:bg-slate-900 px-3 py-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-300"
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                  <span>{copied ? 'کپی شد' : 'کپی دستور'}</span>
                </button>
                {cleanBot && (
                  <a
                    href={`https://t.me/${cleanBot}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white"
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
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">حساب کاربری و نشست</h2>
              <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
                {username ? `وارد شده با حساب ${username}` : 'نشست فعال روی این دستگاه ذخیره شده است'}
              </p>
            </div>
            <button
              type="button"
              onClick={onLogout}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-rose-500/30 bg-rose-500/10 hover:bg-rose-500/20 px-3.5 py-2 text-xs font-semibold text-rose-600 dark:text-rose-400 transition"
            >
              <LogOut size={15} />
              <span>خروج از حساب</span>
            </button>
          </div>
        </section>
      </div>
    </div>
  );
};
