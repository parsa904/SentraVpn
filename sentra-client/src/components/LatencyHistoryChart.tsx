import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { area as d3Area, bisector, curveMonotoneX, line as d3Line, scaleLinear } from 'd3';
import { Activity } from 'lucide-react';
import { type Language, t } from '../i18n/translations';
import {
  LATENCY_WINDOW_MS,
  type LatencyPoint,
  computeLatencyDomainMax,
  computeLatencyStats,
} from '../utils/latencyHistory';
import { getLatencyTier } from '../utils/proxyParser';

interface LatencyHistoryChartProps {
  lang: Language;
  history: LatencyPoint[];
  nowMs: number;
  isConnected: boolean;
}

const CHART_HEIGHT = 86;
const MARGIN = { top: 8, right: 12, bottom: 20, left: 36 };

export const LatencyHistoryChart: React.FC<LatencyHistoryChartProps> = ({
  lang,
  history,
  nowMs,
  isConnected,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(560);
  const [hoveredPoint, setHoveredPoint] = useState<LatencyPoint | null>(null);
  const gradientId = useId().replace(/:/g, '');

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const updateWidth = () => {
      const next = Math.floor(el.getBoundingClientRect().width);
      if (next > 120) setWidth(next);
    };
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const stats = useMemo(() => computeLatencyStats(history), [history]);
  const domainMax = useMemo(() => computeLatencyDomainMax(history), [history]);
  const windowStart = nowMs - LATENCY_WINDOW_MS;

  const innerWidth = Math.max(80, width - MARGIN.left - MARGIN.right);
  const innerHeight = CHART_HEIGHT - MARGIN.top - MARGIN.bottom;

  const xScale = useMemo(
    () => scaleLinear().domain([windowStart, nowMs]).range([0, innerWidth]),
    [windowStart, nowMs, innerWidth]
  );

  const yScale = useMemo(
    () => scaleLinear().domain([0, domainMax]).range([innerHeight, 0]),
    [domainMax, innerHeight]
  );

  const yTicks = useMemo(() => {
    const mid = Math.round(domainMax / 2);
    return [0, mid, domainMax];
  }, [domainMax]);

  const { linePath, areaPath, validPoints } = useMemo(() => {
    const visible = history.filter(
      (pt) => pt.timestamp >= windowStart && pt.timestamp <= nowMs + 1_000
    );
    const valid = visible.filter(
      (pt): pt is LatencyPoint & { latencyMs: number } =>
        typeof pt.latencyMs === 'number' && pt.latencyMs > 0
    );

    const lineGen = d3Line<LatencyPoint>()
      .defined((d) => typeof d.latencyMs === 'number' && d.latencyMs > 0)
      .x((d) => xScale(d.timestamp))
      .y((d) => yScale(d.latencyMs as number))
      .curve(curveMonotoneX);

    const areaGen = d3Area<LatencyPoint>()
      .defined((d) => typeof d.latencyMs === 'number' && d.latencyMs > 0)
      .x((d) => xScale(d.timestamp))
      .y0(innerHeight)
      .y1((d) => yScale(d.latencyMs as number))
      .curve(curveMonotoneX);

    return {
      linePath: lineGen(visible) || '',
      areaPath: areaGen(visible) || '',
      validPoints: valid,
    };
  }, [history, windowStart, nowMs, xScale, yScale, innerHeight]);

  const activeTier = getLatencyTier(stats.currentMs, stats.validCount > 0);
  const strokeColor =
    activeTier === 'poor'
      ? '#F43F5E'
      : activeTier === 'fair'
      ? '#F59E0B'
      : '#10B981';

  const currentColorClass =
    activeTier === 'poor'
      ? 'text-rose-600 dark:text-rose-400'
      : activeTier === 'fair'
      ? 'text-amber-600 dark:text-amber-400'
      : stats.currentMs !== null
      ? 'text-emerald-600 dark:text-emerald-400'
      : 'text-slate-500 dark:text-slate-400';

  const latestValid = validPoints.length > 0 ? validPoints[validPoints.length - 1] : null;
  const bisectTimestamp = useMemo(
    () => bisector<LatencyPoint, number>((d) => d.timestamp).center,
    []
  );

  const handlePointerMove = (e: React.PointerEvent<SVGRectElement>) => {
    if (validPoints.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = Math.max(0, Math.min(innerWidth, e.clientX - rect.left));
    const hoveredTs = xScale.invert(relX);
    const idx = bisectTimestamp(validPoints, hoveredTs);
    const pt = validPoints[Math.max(0, Math.min(validPoints.length - 1, idx))];
    setHoveredPoint(pt || null);
  };

  const hoveredAgeSec = hoveredPoint
    ? Math.max(0, Math.round((nowMs - hoveredPoint.timestamp) / 1000))
    : null;

  return (
    <figure
      data-testid="latency-history-chart"
      aria-label={t(lang, 'latencyChartAria')}
      className="rounded-2xl border border-slate-200/85 dark:border-slate-800/90 bg-white/82 dark:bg-slate-900/78 px-4 py-3 shadow-lg shadow-slate-950/5 dark:shadow-black/25 backdrop-blur-xl"
    >
      {/* Header: Title + Live Summary Stats */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Activity
            size={14}
            className={
              isConnected
                ? 'shrink-0 text-emerald-500'
                : 'shrink-0 text-slate-400 dark:text-slate-500'
            }
          />
          <figcaption className="text-xs font-bold text-slate-800 dark:text-slate-100">
            {t(lang, 'latencyChartTitle')}
          </figcaption>
          {isConnected && (
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse"
            />
          )}
        </div>

        <div className="flex items-center gap-3 text-[11px] text-slate-500 dark:text-slate-400">
          {hoveredPoint && hoveredPoint.latencyMs !== null ? (
            <span
              data-testid="latency-hover-readout"
              className="inline-flex items-center gap-1.5 font-mono tabular-nums font-semibold text-slate-900 dark:text-white"
              dir="ltr"
            >
              <span style={{ color: strokeColor }}>{hoveredPoint.latencyMs} ms</span>
              <span className="text-slate-400 dark:text-slate-500">·</span>
              <span className="font-sans font-normal text-slate-500 dark:text-slate-400">
                {hoveredAgeSec === 0
                  ? t(lang, 'latencyNowLabel')
                  : t(lang, 'latencySecondsAgo', { sec: hoveredAgeSec ?? 0 })}
              </span>
            </span>
          ) : (
            <>
              <span className="inline-flex items-center gap-1">
                <span>{t(lang, 'latencyAvgLabel')}</span>
                <span
                  data-testid="latency-avg-value"
                  className={`font-mono font-semibold tabular-nums ${currentColorClass}`}
                  dir="ltr"
                >
                  {stats.avgMs !== null ? `${stats.avgMs} ms` : '—'}
                </span>
              </span>
              {stats.minMs !== null && stats.maxMs !== null && (
                <span className="hidden sm:inline-flex items-center gap-1">
                  <span>{t(lang, 'latencyRangeLabel')}</span>
                  <span
                    data-testid="latency-range-value"
                    className="font-mono font-semibold tabular-nums text-slate-700 dark:text-slate-300"
                    dir="ltr"
                  >
                    {stats.minMs}–{stats.maxMs} ms
                  </span>
                </span>
              )}
            </>
          )}
        </div>
      </div>

      {/* Responsive D3 Line Chart */}
      <div ref={containerRef} className="relative w-full" dir="ltr">
        <svg
          width="100%"
          height={CHART_HEIGHT}
          viewBox={`0 0 ${width} ${CHART_HEIGHT}`}
          role="img"
          aria-label={t(lang, 'latencyChartAria')}
          className="block overflow-visible select-none"
        >
          <defs>
            <linearGradient id={`latency-grad-${gradientId}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={strokeColor} stopOpacity="0.28" />
              <stop offset="100%" stopColor={strokeColor} stopOpacity="0.01" />
            </linearGradient>
          </defs>

          <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
            {/* Horizontal Y-axis gridlines & labels */}
            {yTicks.map((tick) => {
              const y = yScale(tick);
              return (
                <g key={tick} transform={`translate(0,${y})`}>
                  <line
                    x1={0}
                    x2={innerWidth}
                    className="stroke-slate-200/80 dark:stroke-slate-800"
                    strokeDasharray={tick === 0 ? undefined : '2 3'}
                    strokeWidth={1}
                  />
                  <text
                    x={-6}
                    dy="0.32em"
                    textAnchor="end"
                    className="fill-slate-400 dark:fill-slate-500 font-mono text-[9px] tabular-nums"
                  >
                    {tick}
                  </text>
                </g>
              );
            })}

            {/* X-axis relative 60s labels */}
            <text
              x={0}
              y={innerHeight + 14}
              textAnchor="start"
              className="fill-slate-400 dark:fill-slate-500 font-mono text-[9px] tabular-nums"
            >
              -60s
            </text>
            <text
              x={innerWidth / 2}
              y={innerHeight + 14}
              textAnchor="middle"
              className="fill-slate-400 dark:fill-slate-500 font-mono text-[9px] tabular-nums"
            >
              -30s
            </text>
            <text
              x={innerWidth}
              y={innerHeight + 14}
              textAnchor="end"
              className="fill-slate-400 dark:fill-slate-500 text-[9px] font-medium"
            >
              {t(lang, 'latencyNowLabel')}
            </text>

            {/* Area fill & monotone D3 line */}
            {validPoints.length >= 2 && areaPath && (
              <path d={areaPath} fill={`url(#latency-grad-${gradientId})`} />
            )}
            {validPoints.length >= 2 && linePath && (
              <path
                data-testid="latency-line-path"
                d={linePath}
                fill="none"
                stroke={strokeColor}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}

            {/* Single-point baseline marker before second sample arrives */}
            {validPoints.length === 1 && latestValid && (
              <line
                x1={0}
                x2={xScale(latestValid.timestamp)}
                y1={yScale(latestValid.latencyMs)}
                y2={yScale(latestValid.latencyMs)}
                stroke={strokeColor}
                strokeOpacity={0.35}
                strokeDasharray="3 3"
                strokeWidth={1.5}
              />
            )}

            {/* Live endpoint indicator */}
            {latestValid && !hoveredPoint && (
              <g
                transform={`translate(${xScale(latestValid.timestamp)},${yScale(
                  latestValid.latencyMs
                )})`}
              >
                <circle r={5.5} fill={strokeColor} fillOpacity={0.22} />
                <circle r={2.8} fill={strokeColor} />
              </g>
            )}

            {/* Interactive Hover Crosshair */}
            {hoveredPoint && hoveredPoint.latencyMs !== null && (
              <g>
                <line
                  x1={xScale(hoveredPoint.timestamp)}
                  x2={xScale(hoveredPoint.timestamp)}
                  y1={0}
                  y2={innerHeight}
                  stroke={strokeColor}
                  strokeOpacity={0.45}
                  strokeDasharray="2 2"
                  strokeWidth={1}
                />
                <circle
                  cx={xScale(hoveredPoint.timestamp)}
                  cy={yScale(hoveredPoint.latencyMs)}
                  r={4.5}
                  fill={strokeColor}
                  stroke="white"
                  strokeWidth={1.5}
                />
              </g>
            )}

            {/* Pointer capture overlay */}
            <rect
              x={0}
              y={0}
              width={innerWidth}
              height={innerHeight}
              fill="transparent"
              onPointerMove={handlePointerMove}
              onPointerLeave={() => setHoveredPoint(null)}
            />
          </g>
        </svg>

        {/* Restrained empty state when no real latency samples have arrived yet */}
        {validPoints.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center pb-3">
            <span className="rounded-lg bg-slate-100/85 dark:bg-slate-950/75 px-2.5 py-1 text-[11px] text-slate-500 dark:text-slate-400 backdrop-blur-sm">
              {isConnected
                ? t(lang, 'latencyEmptyConnected')
                : t(lang, 'latencyEmptyDisconnected')}
            </span>
          </div>
        )}
      </div>
    </figure>
  );
};
