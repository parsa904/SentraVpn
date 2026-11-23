import React from 'react';

interface WorldMapBackdropProps {
  activeCountryCode?: string;
  isConnected?: boolean;
}

const COUNTRY_COORDS: Record<string, { x: number; y: number }> = {
  DE: { x: 528, y: 162 },
  NL: { x: 512, y: 155 },
  FI: { x: 562, y: 118 },
  GB: { x: 492, y: 158 },
  FR: { x: 506, y: 176 },
  CH: { x: 521, y: 178 },
  SE: { x: 544, y: 124 },
  AT: { x: 540, y: 175 },
  PL: { x: 550, y: 156 },
  IT: { x: 534, y: 194 },
  TR: { x: 586, y: 204 },
  AE: { x: 644, y: 256 },
  US: { x: 224, y: 198 },
  CA: { x: 234, y: 140 },
  SG: { x: 774, y: 326 },
  JP: { x: 860, y: 214 },
  IR: { x: 636, y: 228 },
};

export const WorldMapBackdrop: React.FC<WorldMapBackdropProps> = ({
  activeCountryCode,
  isConnected = false,
}) => {
  const uid = React.useId().replace(/:/g, '');
  const dotPatternId = `world-dots-${uid}`;
  const target =
    activeCountryCode && COUNTRY_COORDS[activeCountryCode.toUpperCase()]
      ? COUNTRY_COORDS[activeCountryCode.toUpperCase()]
      : null;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden select-none"
    >
      <svg
        viewBox="0 0 1000 500"
        preserveAspectRatio="xMidYMid slice"
        className="h-full w-full opacity-[0.14] dark:opacity-[0.18]"
      >
        <defs>
          {/* Crisp Hiddify-style micro dot-matrix fill inside continent paths */}
          <pattern id={dotPatternId} width="8" height="8" patternUnits="userSpaceOnUse">
            <circle
              cx="2.5"
              cy="2.5"
              r="1.45"
              className="fill-slate-600 dark:fill-slate-300"
            />
          </pattern>
        </defs>

        {/* Fine geographic graticule */}
        <g className="stroke-slate-400 dark:stroke-slate-600" strokeWidth="0.5" strokeOpacity="0.4">
          <line x1="0" y1="125" x2="1000" y2="125" strokeDasharray="2 6" />
          <line x1="0" y1="250" x2="1000" y2="250" strokeDasharray="2 6" />
          <line x1="0" y1="375" x2="1000" y2="375" strokeDasharray="2 6" />
          <line x1="250" y1="0" x2="250" y2="500" strokeDasharray="2 6" />
          <line x1="500" y1="0" x2="500" y2="500" strokeDasharray="2 6" />
          <line x1="750" y1="0" x2="750" y2="500" strokeDasharray="2 6" />
        </g>

        {/* Refined vector world continents filled with crisp dot-matrix */}
        <g fill={`url(#${dotPatternId})`}>
          {/* North America & Central America */}
          <path d="M58,108 L86,88 L138,76 L194,76 L246,84 L298,104 L322,126 L306,154 L286,162 L276,184 L262,196 L256,222 L238,238 L222,232 L214,252 L226,274 L212,286 L194,274 L176,252 L152,238 L134,210 L118,176 L98,148 L72,134 Z" />
          {/* Greenland */}
          <path d="M334,50 L376,38 L414,48 L424,74 L398,104 L366,108 L342,92 L328,70 Z" />
          {/* South America */}
          <path d="M236,288 L266,284 L298,302 L326,326 L344,352 L336,382 L316,408 L296,438 L278,468 L262,468 L254,436 L248,400 L238,366 L226,334 L224,306 Z" />
          {/* UK & Ireland */}
          <path d="M478,144 L494,136 L502,152 L494,166 L480,164 Z" />
          {/* Continental Europe & Scandinavia */}
          <path d="M510,118 L536,92 L566,86 L588,102 L582,128 L608,136 L604,164 L584,182 L568,194 L552,188 L542,202 L528,194 L518,182 L500,194 L484,194 L478,178 L496,166 L508,150 Z" />
          {/* Africa */}
          <path d="M474,220 L516,210 L558,216 L584,230 L602,258 L628,284 L622,312 L602,344 L590,378 L568,414 L544,428 L526,410 L518,376 L510,338 L496,310 L468,298 L452,272 L456,242 Z" />
          {/* Madagascar */}
          <path d="M618,364 L628,360 L632,386 L618,396 L612,380 Z" />
          {/* Middle East & Asia */}
          <path d="M598,112 L662,88 L738,84 L824,94 L896,112 L926,138 L904,166 L878,186 L856,214 L840,248 L814,274 L786,288 L766,304 L746,294 L728,274 L710,308 L690,298 L674,264 L646,274 L620,276 L596,254 L592,226 L580,206 L604,184 L612,152 Z" />
          {/* Japan */}
          <path d="M860,192 L878,198 L880,222 L862,236 L850,226 Z" />
          {/* Indonesia & Maritime SE Asia */}
          <path d="M748,318 L776,326 L804,334 L834,344 L826,356 L792,350 L756,340 L740,328 Z" />
          {/* Australia */}
          <path d="M798,370 L842,358 L886,370 L908,398 L904,432 L878,452 L842,450 L806,432 L788,402 Z" />
          {/* New Zealand */}
          <path d="M926,440 L942,434 L946,458 L930,468 Z" />
        </g>

        {/* Active route arc from origin to selected server */}
        {target && (
          <g>
            <path
              d={`M636,228 Q${(636 + target.x) / 2},${Math.min(228, target.y) - 62} ${target.x},${target.y}`}
              fill="none"
              stroke={isConnected ? '#10B981' : '#059669'}
              strokeWidth="1.8"
              strokeDasharray="4 4"
              strokeOpacity="0.95"
            />
            <circle cx="636" cy="228" r="3.5" fill="#64748B" />
            <circle
              cx={target.x}
              cy={target.y}
              r="14"
              fill={isConnected ? '#10B981' : '#059669'}
              fillOpacity="0.28"
            />
            <circle
              cx={target.x}
              cy={target.y}
              r="4.5"
              fill={isConnected ? '#10B981' : '#059669'}
            />
          </g>
        )}
      </svg>

      {/* Soft radial focus vignette */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_28%,rgba(248,250,252,0.85)_100%)] dark:bg-[radial-gradient(ellipse_at_center,transparent_22%,rgba(9,14,26,0.88)_100%)]" />
    </div>
  );
};
