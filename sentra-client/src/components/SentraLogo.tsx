import React from 'react';

interface SentraLogoProps {
  size?: number;
  animated?: boolean;
  withSquircle?: boolean;
  className?: string;
}

export const SentraLogo: React.FC<SentraLogoProps> = ({
  size = 44,
  animated = false,
  withSquircle = true,
  className = '',
}) => {
  const uid = React.useId().replace(/:/g, '');
  const sGradId = `sentra-s-${uid}`;
  const archGradId = `sentra-arch-${uid}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 128 128"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={sGradId} x1="28" y1="20" x2="100" y2="108" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#10B981" />
          <stop offset="52%" stopColor="#059669" />
          <stop offset="100%" stopColor="#0F172A" />
        </linearGradient>
        <linearGradient id={archGradId} x1="20" y1="68" x2="108" y2="68" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#0F172A" stopOpacity="0.88" />
          <stop offset="50%" stopColor="#10B981" />
          <stop offset="100%" stopColor="#0F172A" stopOpacity="0.88" />
        </linearGradient>
      </defs>

      {withSquircle && (
        <rect
          x="4"
          y="4"
          width="120"
          height="120"
          rx="27"
          className="fill-white dark:fill-slate-100"
        />
      )}

      {/* Sweeping symmetric network bridge arch behind the S-ribbon */}
      <path
        d="M22 72C36 48 92 48 106 72"
        stroke={`url(#${archGradId})`}
        strokeWidth="7.5"
        strokeLinecap="round"
        className={animated ? 'animate-sentra-arch' : undefined}
      />

      {/* Crisp geometric Sentra S-ribbon */}
      <path
        d="M90 36C82 26 68 23 53 26C38 29 31 39 34 50C37 61 51 64 66 66C82 69 94 74 92 86C90 98 76 105 58 104C44 103 34 97 29 89"
        stroke={`url(#${sGradId})`}
        strokeWidth="15.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={animated ? 'animate-sentra-s' : undefined}
      />

      {/* Precision signal nodes */}
      <circle cx="91" cy="36" r="4.5" fill="#10B981" />
      <circle cx="29" cy="89" r="4.5" fill="#0F172A" />
    </svg>
  );
};
