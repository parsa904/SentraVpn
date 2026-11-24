import React from 'react';
import { SentraLogo } from './SentraLogo';

interface SplashScreenProps {
  statusText: string;
}

export const SplashScreen: React.FC<SplashScreenProps> = ({ statusText }) => {
  return (
    <div
      data-testid="splash-screen"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center overflow-hidden bg-slate-50 dark:bg-[#080D18] text-slate-900 dark:text-slate-100 select-none px-6"
    >
      {/* Subtle architectural concentric aura behind the bridge emblem */}
      <div className="relative flex flex-col items-center justify-center">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute h-64 w-64 rounded-full bg-emerald-500/15 blur-3xl animate-sentra-glow"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute h-52 w-52 rounded-full border border-emerald-500/20 animate-sentra-ripple"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute h-52 w-52 rounded-full border border-emerald-500/15 animate-sentra-ripple-delayed"
        />

        {/* Official SENTRA / SECURE CONNECT Full Lockup */}
        <div className="relative z-10">
          <SentraLogo variant="full" size={188} animated />
        </div>

        {/* Suspension-Bridge Signal Arch Loader */}
        <svg
          width="176"
          height="26"
          viewBox="0 0 176 26"
          fill="none"
          aria-hidden="true"
          className="relative z-10 mt-6"
        >
          <path
            d="M8 20 Q88 2 168 20"
            className="stroke-slate-300 dark:stroke-slate-800"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
          <path
            d="M8 20 Q88 2 168 20"
            stroke="#10B981"
            strokeWidth="2.5"
            strokeLinecap="round"
            className="animate-sentra-cable-signal"
          />
        </svg>

        <p className="relative z-10 mt-2 text-xs font-medium tracking-wide text-slate-500 dark:text-slate-400">
          {statusText}
        </p>
      </div>
    </div>
  );
};
