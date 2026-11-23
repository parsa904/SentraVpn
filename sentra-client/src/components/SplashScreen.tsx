import React from 'react';
import { SentraLogo } from './SentraLogo';

interface SplashScreenProps {
  statusText: string;
}

export const SplashScreen: React.FC<SplashScreenProps> = ({ statusText }) => {
  return (
    <div
      data-testid="splash-screen"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-slate-50 dark:bg-[#080D18] text-slate-900 dark:text-slate-100 select-none"
    >
      <div className="relative flex items-center justify-center">
        <div className="absolute h-44 w-44 rounded-full bg-emerald-500/20 blur-3xl animate-sentra-glow" />
        <div className="relative rounded-[28px] p-1 shadow-2xl shadow-emerald-950/20 ring-1 ring-slate-200/80 dark:ring-white/10">
          <SentraLogo size={96} animated withSquircle />
        </div>
      </div>

      <div className="mt-7 flex flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
          Sentra
        </h1>
        <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
          {statusText}
        </p>
      </div>
    </div>
  );
};
