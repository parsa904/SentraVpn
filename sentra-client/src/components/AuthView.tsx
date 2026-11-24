import React, { useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Globe,
  KeyRound,
  Lock,
  Moon,
  Send,
  Sun,
  User,
  UserPlus,
} from 'lucide-react';
import type { PersistedSession, ThemeMode } from '../types/sentra';
import { type Language, t } from '../i18n/translations';
import {
  loginWithCredentials,
  loginWithOtpCode,
  registerWithCredentials,
} from '../services/api';
import { validateCredentialsForm, validateOtpCode } from '../utils/proxyParser';
import { SentraLogo } from './SentraLogo';
import { WorldMapBackdrop } from './WorldMapBackdrop';

interface AuthViewProps {
  lang: Language;
  onChangeLanguage: (lang: Language) => void;
  theme: ThemeMode;
  onToggleTheme: () => void;
  onAuthenticated: (session: PersistedSession) => void;
  initialNotice?: string | null;
  botUsername?: string;
}

type AuthTab = 'login' | 'register' | 'otp';

export const AuthView: React.FC<AuthViewProps> = ({
  lang,
  onChangeLanguage,
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

  const isRtl = lang === 'fa';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (tab === 'otp') {
      const validationError = validateOtpCode(otpCode, lang);
      if (validationError) {
        setError(validationError);
        return;
      }
      setLoading(true);
      try {
        const session = await loginWithOtpCode(otpCode.trim());
        onAuthenticated(session);
      } catch (err) {
        setError(err instanceof Error ? err.message : t(lang, 'otpFailed'));
      } finally {
        setLoading(false);
      }
      return;
    }

    const validationError = validateCredentialsForm(
      username,
      password,
      tab === 'register',
      lang
    );
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
      setError(err instanceof Error ? err.message : t(lang, 'authFailed'));
    } finally {
      setLoading(false);
    }
  };

  const cleanBot = botUsername?.replace(/^@/, '').trim();
  const ArrowIcon = isRtl ? ArrowLeft : ArrowRight;

  return (
    <div className="relative flex min-h-screen w-full items-center justify-center overflow-hidden bg-slate-50 dark:bg-[#080D18] px-4 py-10 text-slate-900 dark:text-slate-100">
      <WorldMapBackdrop />

      {/* Top corner language & theme controls */}
      <div className="fixed top-4 end-4 z-20 flex items-center gap-2">
        <div
          role="radiogroup"
          aria-label={t(lang, 'languageTitle')}
          className="inline-flex h-10 items-center gap-0.5 rounded-xl border border-slate-200/80 dark:border-slate-800 bg-white/80 dark:bg-slate-900/80 p-1 backdrop-blur-md"
        >
          <Globe size={14} className="mx-1.5 text-slate-400 shrink-0" aria-hidden="true" />
          <button
            type="button"
            role="radio"
            aria-checked={lang === 'en'}
            data-testid="auth-lang-en"
            onClick={() => onChangeLanguage('en')}
            className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition duration-150 active:scale-95 ${
              lang === 'en'
                ? 'bg-emerald-600 text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            EN
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={lang === 'fa'}
            data-testid="auth-lang-fa"
            onClick={() => onChangeLanguage('fa')}
            className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition duration-150 active:scale-95 ${
              lang === 'fa'
                ? 'bg-emerald-600 text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            فارسی
          </button>
        </div>

        <button
          type="button"
          onClick={onToggleTheme}
          aria-label={theme === 'dark' ? t(lang, 'lightMode') : t(lang, 'darkMode')}
          className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200/80 dark:border-slate-800 bg-white/80 dark:bg-slate-900/80 text-slate-600 dark:text-slate-300 backdrop-blur-md transition duration-150 hover:border-emerald-500/50 hover:text-emerald-600 dark:hover:text-emerald-400 active:scale-95"
        >
          {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
        </button>
      </div>

      <main className="relative z-10 w-full max-w-[436px] animate-sentra-view">
        <div className="rounded-2xl border border-slate-200/90 dark:border-slate-800/90 bg-white/94 dark:bg-slate-900/92 p-6 sm:p-7 shadow-2xl shadow-slate-950/10 dark:shadow-black/40 backdrop-blur-xl">
          {/* Clean Brand Header — zero marketing copy */}
          <div className="flex flex-col items-center text-center">
            <div className="rounded-[20px] shadow-lg shadow-emerald-950/10 ring-1 ring-slate-200 dark:ring-white/10">
              <SentraLogo size={60} withSquircle />
            </div>
            <h1 className="mt-4 text-xl font-bold tracking-tight text-slate-900 dark:text-white">
              {t(lang, 'brand')}
            </h1>
          </div>

          {/* Auth Mode Tabs */}
          <div
            role="tablist"
            aria-label={t(lang, 'authMethodAria')}
            className="mt-6 grid grid-cols-[1fr_1fr_1.35fr] gap-1 rounded-xl bg-slate-100 dark:bg-slate-800/80 p-1"
          >
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'login'}
              onClick={() => {
                setTab('login');
                setError(null);
              }}
              className={`inline-flex items-center justify-center gap-1.5 rounded-lg py-2 px-2 text-xs font-semibold whitespace-nowrap transition duration-150 active:scale-[0.98] ${
                tab === 'login'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <Lock size={13} className="shrink-0" />
              <span>{t(lang, 'signIn')}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'register'}
              onClick={() => {
                setTab('register');
                setError(null);
              }}
              className={`inline-flex items-center justify-center gap-1.5 rounded-lg py-2 px-2 text-xs font-semibold whitespace-nowrap transition duration-150 active:scale-[0.98] ${
                tab === 'register'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <UserPlus size={13} className="shrink-0" />
              <span>{t(lang, 'signUp')}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'otp'}
              onClick={() => {
                setTab('otp');
                setError(null);
              }}
              className={`inline-flex items-center justify-center gap-1.5 rounded-lg py-2 px-2 text-xs font-semibold whitespace-nowrap transition duration-150 active:scale-[0.98] ${
                tab === 'otp'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <KeyRound size={13} className="shrink-0" />
              <span>{t(lang, 'telegramCode')}</span>
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
                  {t(lang, 'telegramCodeLabel')}
                </label>
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
                {cleanBot && (
                  <p className="mt-2 flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
                    <span>{t(lang, 'getCodeFromBot')}</span>
                    <a
                      href={`https://t.me/${cleanBot}`}
                      target="_blank"
                      rel="noopener noreferrer"
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
                    {t(lang, 'username')}
                  </label>
                  <div className="relative">
                    <User
                      size={16}
                      className="pointer-events-none absolute top-1/2 start-3.5 -translate-y-1/2 text-slate-400"
                    />
                    <input
                      id="auth-username"
                      type="text"
                      dir="ltr"
                      autoComplete="username"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="username"
                      className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-950/60 ps-10 pe-3.5 py-2.5 text-left text-sm text-slate-900 dark:text-white placeholder:text-slate-400 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                    />
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="auth-password"
                    className="mb-1.5 block text-xs font-medium text-slate-700 dark:text-slate-300"
                  >
                    {t(lang, 'password')}
                  </label>
                  <div className="relative">
                    <Lock
                      size={16}
                      className="pointer-events-none absolute top-1/2 start-3.5 -translate-y-1/2 text-slate-400"
                    />
                    <input
                      id="auth-password"
                      type="password"
                      dir="ltr"
                      autoComplete={tab === 'register' ? 'new-password' : 'current-password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-950/60 ps-10 pe-3.5 py-2.5 text-left text-sm text-slate-900 dark:text-white placeholder:text-slate-400 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                    />
                  </div>
                </div>
              </>
            )}

            <button
              type="submit"
              disabled={loading}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 active:scale-[0.98] disabled:opacity-60 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-emerald-600/20 transition duration-150"
            >
              <span>{loading ? t(lang, 'connectingServer') : t(lang, 'continueBtn')}</span>
              <ArrowIcon size={17} />
            </button>
          </form>
        </div>
      </main>
    </div>
  );
};
