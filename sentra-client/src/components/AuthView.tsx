import React, { useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Eye,
  EyeOff,
  Globe,
  KeyRound,
  Loader2,
  Lock,
  Mail,
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
import { normalizeTelegramBotUsername } from '../constants';

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
  const [tab, setTab] = useState<AuthTab>('otp');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(initialNotice || null);

  const isRtl = lang === 'fa';

  const switchTab = (next: AuthTab) => {
    setTab(next);
    setError(null);
    setShowPassword(false);
    setShowConfirmPassword(false);
  };

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
      lang,
      tab === 'register' ? { confirmPassword, email } : undefined
    );
    if (validationError) {
      setError(validationError);
      return;
    }

    setLoading(true);
    try {
      const session =
        tab === 'register'
          ? await registerWithCredentials(
              username.trim().toLowerCase(),
              password,
              confirmPassword,
              email.trim() || undefined
            )
          : await loginWithCredentials(username.trim(), password);
      onAuthenticated(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : t(lang, 'authFailed'));
    } finally {
      setLoading(false);
    }
  };

  const cleanBot = normalizeTelegramBotUsername(botUsername);
  const ArrowIcon = isRtl ? ArrowLeft : ArrowRight;

  return (
    <div className="relative flex min-h-screen w-full items-center justify-center overflow-hidden bg-slate-50 dark:bg-[#080D18] px-4 py-10 text-slate-900 dark:text-slate-100">
      {/* Living dot-matrix world map with flowing encrypted bridge routes */}
      <WorldMapBackdrop ambientRoutes />

      {/* Subtle atmospheric depth orbs (pure compositor transforms, never harsh neon) */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-28 start-1/4 h-96 w-96 rounded-full bg-emerald-500/[0.08] dark:bg-emerald-500/[0.11] blur-3xl animate-sentra-ambient-drift"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-32 end-1/4 h-[26rem] w-[26rem] rounded-full bg-sky-500/[0.07] dark:bg-sky-500/[0.09] blur-3xl animate-sentra-ambient-drift-reverse"
      />

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
            onClick={() => {
              setError(null);
              onChangeLanguage('en');
            }}
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
            onClick={() => {
              setError(null);
              onChangeLanguage('fa');
            }}
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

      <main className="relative z-10 w-full max-w-[436px] animate-sentra-auth-card">
        <div className="relative overflow-hidden rounded-2xl border border-slate-200/90 dark:border-slate-800/90 bg-white/92 dark:bg-slate-900/88 p-6 sm:p-7 shadow-2xl shadow-slate-950/10 dark:shadow-black/50 backdrop-blur-xl">
          {/* Precision top-edge specular hairline */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-emerald-500/55 to-transparent"
          />

          {/* Official Brand Lockup with organic orbital halo + suspension-bridge signal arch */}
          <div className="relative flex flex-col items-center text-center pt-2 pb-1">
            <div className="relative flex items-center justify-center">
              {/* Soft breathing radial aura behind emblem */}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute h-40 w-40 rounded-full bg-emerald-500/[0.11] dark:bg-emerald-500/[0.15] blur-2xl animate-sentra-glow"
              />

              {/* Dual ultra-fine counter-rotating orbital arcs */}
              <svg
                aria-hidden="true"
                viewBox="0 0 196 196"
                className="pointer-events-none absolute h-[188px] w-[188px] animate-sentra-orbit-gentle"
              >
                <circle
                  cx="98"
                  cy="98"
                  r="90"
                  fill="none"
                  stroke="#10B981"
                  strokeOpacity="0.22"
                  strokeWidth="1.2"
                  strokeDasharray="68 180 28 288"
                  strokeLinecap="round"
                />
              </svg>
              <svg
                aria-hidden="true"
                viewBox="0 0 196 196"
                className="pointer-events-none absolute h-[164px] w-[164px] animate-sentra-orbit-gentle-reverse"
              >
                <circle
                  cx="98"
                  cy="98"
                  r="76"
                  fill="none"
                  stroke="#0EA5E9"
                  strokeOpacity="0.18"
                  strokeWidth="1"
                  strokeDasharray="40 220 18 200"
                  strokeLinecap="round"
                />
              </svg>

              <div className="relative z-10">
                <SentraLogo variant="full" size={148} animated />
              </div>
            </div>

            {/* Suspension-bridge signal arch mirroring the Sentra emblem */}
            <svg
              width="148"
              height="18"
              viewBox="0 0 148 18"
              fill="none"
              aria-hidden="true"
              className="mt-2"
            >
              <path
                d="M6 14 Q74 1 142 14"
                className="stroke-slate-200 dark:stroke-slate-800"
                strokeWidth="1.75"
                strokeLinecap="round"
              />
              <path
                d="M6 14 Q74 1 142 14"
                stroke="#10B981"
                strokeWidth="2"
                strokeLinecap="round"
                className="animate-sentra-cable-signal"
              />
            </svg>

            <h1 className="sr-only">{t(lang, 'brand')}</h1>
          </div>

          {/* Auth Mode Tabs — 8-Digit Connect Code Primary + Unified Sign In & Sign Up */}
          <div
            role="tablist"
            aria-label={t(lang, 'authMethodAria')}
            className="mt-5 grid grid-cols-3 gap-1 rounded-xl bg-slate-100/90 dark:bg-slate-800/80 p-1 animate-sentra-stagger-1"
          >
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'otp'}
              data-testid="auth-tab-connect-code"
              onClick={() => switchTab('otp')}
              className={`inline-flex items-center justify-center gap-1.5 rounded-lg py-2 px-2 text-xs font-semibold whitespace-nowrap transition duration-150 active:scale-[0.98] ${
                tab === 'otp'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <KeyRound size={13} className="shrink-0" />
              <span>{t(lang, 'telegramCode')}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'login'}
              data-testid="auth-tab-login"
              onClick={() => switchTab('login')}
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
              data-testid="auth-tab-register"
              onClick={() => switchTab('register')}
              className={`inline-flex items-center justify-center gap-1.5 rounded-lg py-2 px-2 text-xs font-semibold whitespace-nowrap transition duration-150 active:scale-[0.98] ${
                tab === 'register'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <UserPlus size={13} className="shrink-0" />
              <span>{t(lang, 'signUp')}</span>
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

          <form
            key={tab}
            onSubmit={handleSubmit}
            className="mt-5 space-y-4 animate-sentra-tab-panel"
            noValidate
          >
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

                {tab === 'register' && (
                  <div>
                    <div className="mb-1.5 flex items-center justify-between">
                      <label
                        htmlFor="auth-email"
                        className="text-xs font-medium text-slate-700 dark:text-slate-300"
                      >
                        {t(lang, 'emailOptional')}
                      </label>
                      <span className="text-[11px] text-slate-400 dark:text-slate-500">
                        {t(lang, 'optionalTag')}
                      </span>
                    </div>
                    <div className="relative">
                      <Mail
                        size={16}
                        className="pointer-events-none absolute top-1/2 start-3.5 -translate-y-1/2 text-slate-400"
                      />
                      <input
                        id="auth-email"
                        type="email"
                        dir="ltr"
                        autoComplete="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder={t(lang, 'emailPlaceholder')}
                        className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-950/60 ps-10 pe-3.5 py-2.5 text-left text-sm text-slate-900 dark:text-white placeholder:text-slate-400 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                      />
                    </div>
                  </div>
                )}

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
                      type={showPassword ? 'text' : 'password'}
                      dir="ltr"
                      autoComplete={tab === 'register' ? 'new-password' : 'current-password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-950/60 ps-10 pe-10 py-2.5 text-left text-sm text-slate-900 dark:text-white placeholder:text-slate-400 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                    />
                    <button
                      type="button"
                      data-testid="toggle-password-visibility"
                      aria-label={showPassword ? t(lang, 'hidePassword') : t(lang, 'showPassword')}
                      aria-pressed={showPassword}
                      onClick={() => setShowPassword((prev) => !prev)}
                      className="absolute top-1/2 end-2.5 -translate-y-1/2 rounded-lg p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
                    >
                      {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>

                {tab === 'register' && (
                  <div>
                    <label
                      htmlFor="auth-confirm-password"
                      className="mb-1.5 block text-xs font-medium text-slate-700 dark:text-slate-300"
                    >
                      {t(lang, 'confirmPassword')}
                    </label>
                    <div className="relative">
                      <Lock
                        size={16}
                        className="pointer-events-none absolute top-1/2 start-3.5 -translate-y-1/2 text-slate-400"
                      />
                      <input
                        id="auth-confirm-password"
                        type={showConfirmPassword ? 'text' : 'password'}
                        dir="ltr"
                        autoComplete="new-password"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        placeholder="••••••••"
                        className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-950/60 ps-10 pe-10 py-2.5 text-left text-sm text-slate-900 dark:text-white placeholder:text-slate-400 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                      />
                      <button
                        type="button"
                        data-testid="toggle-confirm-password-visibility"
                        aria-label={
                          showConfirmPassword ? t(lang, 'hidePassword') : t(lang, 'showPassword')
                        }
                        aria-pressed={showConfirmPassword}
                        onClick={() => setShowConfirmPassword((prev) => !prev)}
                        className="absolute top-1/2 end-2.5 -translate-y-1/2 rounded-lg p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
                      >
                        {showConfirmPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}

            <button
              type="submit"
              disabled={loading}
              className="group flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 active:scale-[0.98] disabled:opacity-60 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-emerald-600/20 transition duration-150"
            >
              {loading && <Loader2 size={16} className="animate-spin shrink-0" aria-hidden="true" />}
              <span>{loading ? t(lang, 'connectingServer') : t(lang, 'continueBtn')}</span>
              {!loading && (
                <ArrowIcon
                  size={17}
                  className={`transition-transform duration-150 ${
                    isRtl ? 'group-hover:-translate-x-0.5' : 'group-hover:translate-x-0.5'
                  }`}
                />
              )}
            </button>
          </form>
        </div>
      </main>
    </div>
  );
};
