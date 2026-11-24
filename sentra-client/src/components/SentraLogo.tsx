import React from 'react';
import logoIconDark from '../assets/logo-icon-dark.png';
import logoIconLight from '../assets/logo-icon-light.png';
import logoFullDark from '../assets/logo-full-dark.png';
import logoFullLight from '../assets/logo-full-light.png';

interface SentraLogoProps {
  /** 'icon' = Bridge-S emblem, 'full' = Bridge-S + SENTRA / SECURE CONNECT lockup */
  variant?: 'icon' | 'full';
  /** Pixel dimension (width & height for icon, width for full lockup) */
  size?: number;
  /** 'auto' adapts to Light/Dark theme, 'dark' forces obsidian ink, 'light' forces crisp white ink */
  tone?: 'auto' | 'dark' | 'light';
  /** Enables entrance reveal, subtle float, and specular bridge light sweep */
  animated?: boolean;
  /** Wraps the icon mark in a crisp white squircle tile matching desktop/mobile OS icons */
  withSquircle?: boolean;
  className?: string;
}

export const SentraLogo: React.FC<SentraLogoProps> = ({
  variant = 'icon',
  size = 44,
  tone = 'auto',
  animated = false,
  withSquircle = false,
  className = '',
}) => {
  const isFull = variant === 'full';
  const darkAsset = isFull ? logoFullDark : logoIconDark;
  const lightAsset = isFull ? logoFullLight : logoIconLight;

  // Inside a white squircle we always render dark obsidian ink for maximum contrast
  const effectiveTone = withSquircle ? 'dark' : tone;

  const renderImages = (imgClass: string) => {
    if (effectiveTone === 'dark') {
      return (
        <img
          src={darkAsset}
          alt="Sentra"
          draggable={false}
          className={`select-none object-contain ${imgClass}`}
        />
      );
    }
    if (effectiveTone === 'light') {
      return (
        <img
          src={lightAsset}
          alt="Sentra"
          draggable={false}
          className={`select-none object-contain ${imgClass}`}
        />
      );
    }
    return (
      <>
        <img
          src={darkAsset}
          alt="Sentra"
          draggable={false}
          className={`block dark:hidden select-none object-contain ${imgClass}`}
        />
        <img
          src={lightAsset}
          alt="Sentra"
          draggable={false}
          className={`hidden dark:block select-none object-contain ${imgClass}`}
        />
      </>
    );
  };

  if (withSquircle && !isFull) {
    const pad = Math.max(4, Math.round(size * 0.12));
    const radius = Math.round(size * 0.24);
    return (
      <div
        style={{ width: size, height: size, borderRadius: radius, padding: pad }}
        className={`group relative inline-flex shrink-0 items-center justify-center overflow-hidden bg-white shadow-sm ring-1 ring-slate-200/90 dark:ring-white/15 transition-transform duration-200 hover:scale-[1.03] ${
          animated ? 'animate-sentra-logo-reveal' : ''
        } ${className}`}
      >
        {renderImages('h-full w-full')}
        {animated && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 -start-1/2 w-1/2 bg-gradient-to-r from-transparent via-emerald-400/30 to-transparent animate-sentra-sheen"
          />
        )}
      </div>
    );
  }

  if (isFull) {
    return (
      <div
        style={{ width: size }}
        className={`relative inline-flex shrink-0 items-center justify-center ${
          animated ? 'animate-sentra-logo-reveal' : ''
        } ${className}`}
      >
        <div className={animated ? 'w-full animate-sentra-bridge-float' : 'w-full'}>
          {renderImages('w-full h-auto')}
        </div>
      </div>
    );
  }

  return (
    <div
      style={{ width: size, height: size }}
      className={`relative inline-flex shrink-0 items-center justify-center ${
        animated ? 'animate-sentra-logo-reveal' : ''
      } ${className}`}
    >
      <div className={animated ? 'h-full w-full animate-sentra-bridge-float' : 'h-full w-full'}>
        {renderImages('h-full w-full')}
      </div>
    </div>
  );
};
