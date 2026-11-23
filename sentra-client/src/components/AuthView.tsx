import React, { useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  KeyRound,
  Lock,
  Moon,
  Send,
  Sun,
  User,
  UserPlus,
} from 'lucide-react';
import type { PersistedSession, ThemeMode } from '../types/sentra';
import {
  loginWithCredentials,
  loginWithOtpCode,
  registerWithCredentials,
} from '../services/api';
import { validateCredentialsForm, validateOtpCode } from '../utils/proxyParser';
import { SentraLogo } from './SentraLogo';
import { WorldMapBackdrop } from './WorldMapBackdrop';

interface AuthViewProps {
  theme: ThemeMode;
  onToggleTheme: () => void;
  onAuthenticated: (session: PersistedSession) => void;
  initialNotice?: string | null;
  botUsername?: string;
}

type AuthTab = 'login' | 'register' | 'otp';

export const AuthView: React.FC<AuthViewProps> = ({
  theme,
  onToggleTheme,
  onAuthenticated,
  initialNotice,
  botUsername,
}) => {
  const [tab, setTab] = useState<AuthTab>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(initialNotice || null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (tab === 'otp') {
      const validationError = validateOtpCode(otpCode);
      if (validationError) {
        setError(validationError);
        return;
      }
      setLoading(true);
      try {
        const session = await loginWithOtpCode(otpCode.trim());
        onAuthenticated(session);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'ورود با کد ناموفق بود.');
      } finally {
        setLoading(false);
      }
      return;
    }

    const validationError = validateCredentialsForm(username, password, tab === 'register');
    if (validationError) {
      setError(validationError);
      return;
    }

    setLoading(true);
    try {
      const session =
        tab === 'register'
          ? await registerWithCredentials(username.trim(), password)
          : await loginWithCredentials(username.trim(), password);
      onAuthenticated(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'احراز هویت ناموفق بود.');
    } finally {
      setLoading(false);
    }
  };

  const cleanBot = botUsername?.replace(/^@/, '').trim();

  return (
    <div className="relative flex min-h-screen w-full items-center justify-center overflow-hidden bg-slate-50 dark:bg-[#080D18] px-4 py-10 text-slate-900 dark:text-slate-100">
      <WorldMapBackdrop />

      {/* Top corner theme switcher */}
      <div className="fixed top-4 left-4 z-20">
        <button
          type="button"
          onClick={onToggleTheme}
          aria-label={theme === 'dark' ? 'تغییر به حالت روشن' : 'تغییر به حالت تاریک'}
          className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200/80 dark:border-slate-800 bg-white/80 dark:bg-slate-900/80 text-slate-600 dark:text-slate-300 backdrop-blur-md transition hover:border-emerald-500/50 hover:text-emerald-600 dark:hover:text-emerald-400"
        >
          {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
        </button>
      </div>

      <main className="relative z-10 w-full max-w-[420px]">
        <div className="rounded-2xl border border-slate-200/90 dark:border-slate-800/90 bg-white/92 dark:bg-slate-900/90 p-7 shadow-2xl shadow-slate-950/10 dark:shadow-black/40 backdrop-blur-xl">
          {/* Header Brand */}
          <div className="flex flex-col items-center text-center">
            <div className="rounded-[20px] shadow-lg shadow-emerald-950/10 ring-1 ring-slate-200 dark:ring-white/10">
              <SentraLogo size={64} withSquircle />
            </div>
            <h1 className="mt-4 text-xl font-bold tracking-tight text-slate-900 dark:text-white">
              Sentra
            </h1>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              ورود یک‌باره و امن — نشست شما روی دستگاه ذخیره می‌ماند
            </p>
          </div>

          {/* Auth Mode Tabs */}
          <div
            role="tablist"
            aria-label="روش احراز هویت"
            className="mt-6 grid grid-cols-3 gap-1 rounded-xl bg-slate-100 dark:bg-slate-800/80 p-1"
          >
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'login'}
              onClick={() => {
                setTab('login');
                setError(null);
              }}
              className={`inline-flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-semibold transition ${
                tab === 'login'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <Lock size={14} />
              <span>ورود</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'register'}
              onClick={() => {
                setTab('register');
                setError(null);
              }}
              className={`inline-flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-semibold transition ${
                tab === 'register'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <UserPlus size={14} />
              <span>ثبت‌نام</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'otp'}
              onClick={() => {
                setTab('otp');
                setError(null);
              }}
              className={`inline-flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-semibold transition ${
                tab === 'otp'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <KeyRound size={14} />
              <span>کد تلگرام</span>
            </button>
          </div>

          {error && (
            <div
              role="alert"
              className="mt-4 flex items-start gap-2.5 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5 text-xs leading-5 text-rose-700 dark:text-rose-300"
            >
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="mt-5 space-y-4" noValidate>
            {tab === 'otp' ? (
              <div>
                <label
                  htmlFor="auth-otp"
                  className="mb-1.5 block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  کد ورود ۸ رقمی دریافتی از ربات تلگرام
                </label>
                <div className="relative">
                  <input
                    id="auth-otp"
                    type="text"
                    inputMode="numeric"
                    maxLength={8}
                    dir="ltr"
                    value={otpCode}
                    onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
                    placeholder="12345678"
                    className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-950/60 px-4 py-2.5 text-center font-mono text-base tracking-[0.28em] text-slate-900 dark:text-white placeholder:text-slate-400 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                  />
                </div>
                {cleanBot && (
                  <p className="mt-2 flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
                    <span>دریافت کد از ربات رسمی:</span>
                    <a
                      href={`https://t.me/${cleanBot}`}
                      target="_blank"
                      rel="noreferrer"
                      dir="ltr"
                      className="inline-flex items-center gap-1 font-mono text-emerald-600 dark:text-emerald-400 hover:underline"
                    >
                      <Send size={12} />@{cleanBot}
                    </a>
                  </p>
                )}
              </div>
            ) : (
              <>
                <div>
                  <label
                    htmlFor="auth-username"
                    className="mb-1.5 block text-xs font-medium text-slate-700 dark:text-slate-300"
                  >
                    نام کاربری
                  </label>
                  <div className="relative">
                    <User
                      size={16}
                      className="pointer-events-none absolute top-1/2 right-3.5 -translate-y-1/2 text-slate-400"
                    />
                    <input
                      id="auth-username"
                      type="text"
                      dir="ltr"
                      autoComplete="username"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="username"
                      className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-950/60 pr-10 pl-3.5 py-2.5 text-left text-sm text-slate-900 dark:text-white placeholder:text-slate-400 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                    />
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="auth-password"
                    className="mb-1.5 block text-xs font-medium text-slate-700 dark:text-slate-300"
                  >
                    رمز عبور
                  </label>
                  <div className="relative">
                    <Lock
                      size={16}
                      className="pointer-events-none absolute top-1/2 right-3.5 -translate-y-1/2 text-slate-400"
                    />
                    <input
                      id="auth-password"
                      type="password"
                      dir="ltr"
                      autoComplete={tab === 'register' ? 'new-password' : 'current-password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-950/60 pr-10 pl-3.5 py-2.5 text-left text-sm text-slate-900 dark:text-white placeholder:text-slate-400 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                    />
                  </div>
                </div>
              </>
            )}

            <button
              type="submit"
              disabled={loading}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 disabled:opacity-60 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-emerald-600/20 transition"
            >
              <span>
                {loading
                  ? 'در حال ارتباط با سرور...'
                  : tab === 'register'
                  ? 'ساخت حساب و ورود'
                  : tab === 'otp'
                  ? 'تایید کد و ورود'
                  : 'ورود به حساب'}
              </span>
              <ArrowLeft size={18} />
            </button>
          </form>
        </div>
      </main>
    </div>
  );
};
