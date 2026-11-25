import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { area as d3Area, bisector, curveMonotoneX, line as d3Line, scaleLinear } from 'd3';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { type Language, t } from '../i18n/translations';
import { formatSpeed } from '../utils/proxyParser';
import {
  TRAFFIC_WINDOW_MS,
  type TrafficPoint,
  computeTrafficDomainMax,
  computeTrafficStats,
  formatCompactTrafficTick,
} from '../utils/trafficHistory';

interface TrafficHistoryChartProps {
  lang: Language;
  history: TrafficPoint[];
  nowMs: number;
  isConnected: boolean;
}

const CHART_HEIGHT = 78;
const MARGIN = { top: 6, right: 10, bottom: 18, left: 46 };
const DOWNLOAD_STROKE = '#10B981';
const UPLOAD_STROKE = '#0EA5E9';

export const TrafficHistoryChart: React.FC<TrafficHistoryChartProps> = ({
  lang,
  history,
  nowMs,
  isConnected,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(560);
  const [hoveredPoint, setHoveredPoint] = useState<TrafficPoint | null>(null);
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

  const stats = useMemo(() => computeTrafficStats(history), [history]);
  const domainMax = useMemo(() => computeTrafficDomainMax(history), [history]);
  const windowStart = nowMs - TRAFFIC_WINDOW_MS;

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

  const yTicks = useMemo(() => [0, domainMax / 2, domainMax], [domainMax]);

  const { visiblePoints, downloadLinePath, downloadAreaPath, uploadLinePath, uploadAreaPath } =
    useMemo(() => {
      const visible = history.filter(
        (pt) => pt.timestamp >= windowStart && pt.timestamp <= nowMs + 1_000
      );

      const dlLine = d3Line<TrafficPoint>()
        .x((d) => xScale(d.timestamp))
        .y((d) => yScale(d.downloadBps))
        .curve(curveMonotoneX);

      const dlArea = d3Area<TrafficPoint>()
        .x((d) => xScale(d.timestamp))
        .y0(innerHeight)
        .y1((d) => yScale(d.downloadBps))
        .curve(curveMonotoneX);

      const ulLine = d3Line<TrafficPoint>()
        .x((d) => xScale(d.timestamp))
        .y((d) => yScale(d.uploadBps))
        .curve(curveMonotoneX);

      const ulArea = d3Area<TrafficPoint>()
        .x((d) => xScale(d.timestamp))
        .y0(innerHeight)
        .y1((d) => yScale(d.uploadBps))
        .curve(curveMonotoneX);

      return {
        visiblePoints: visible,
        downloadLinePath: dlLine(visible) || '',
        downloadAreaPath: dlArea(visible) || '',
        uploadLinePath: ulLine(visible) || '',
        uploadAreaPath: ulArea(visible) || '',
      };
    }, [history, windowStart, nowMs, xScale, yScale, innerHeight]);

  const latestPoint = visiblePoints.length > 0 ? visiblePoints[visiblePoints.length - 1] : null;
  const bisectTimestamp = useMemo(
    () => bisector<TrafficPoint, number>((d) => d.timestamp).center,
    []
  );

  const handlePointerMove = (e: React.PointerEvent<SVGRectElement>) => {
    if (visiblePoints.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = Math.max(0, Math.min(innerWidth, e.clientX - rect.left));
    const hoveredTs = xScale.invert(relX);
    const idx = bisectTimestamp(visiblePoints, hoveredTs);
    const pt = visiblePoints[Math.max(0, Math.min(visiblePoints.length - 1, idx))];
    setHoveredPoint(pt || null);
  };

  const hoveredAgeSec = hoveredPoint
    ? Math.max(0, Math.round((nowMs - hoveredPoint.timestamp) / 1000))
    : null;

  return (
    <figure
      data-testid="traffic-history-chart"
      aria-label={t(lang, 'trafficChartAria')}
      className="mt-3 border-t border-slate-200/70 dark:border-slate-800/80 pt-2.5"
    >
      {/* Header: Title + Unboxed Series Legend & Peak / Hover Readout */}
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 text-[11px]">
        <div className="flex items-center gap-2.5 min-w-0">
          <figcaption className="font-semibold text-slate-700 dark:text-slate-200 whitespace-nowrap">
            {t(lang, 'trafficChartTitle')}
          </figcaption>
          <span aria-hidden="true" className="text-slate-300 dark:text-slate-700">
            ·
          </span>
          <div className="flex items-center gap-2.5 text-slate-500 dark:text-slate-400">
            <span className="inline-flex items-center gap-1 whitespace-nowrap">
              <span
                aria-hidden="true"
                className="inline-block h-0.5 w-2.5 rounded-full bg-emerald-500"
              />
              <span>{t(lang, 'trafficDownloadLegend')}</span>
            </span>
            <span className="inline-flex items-center gap-1 whitespace-nowrap">
              <span
                aria-hidden="true"
                className="inline-block h-0.5 w-2.5 rounded-full bg-sky-500"
              />
              <span>{t(lang, 'trafficUploadLegend')}</span>
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400">
          {hoveredPoint ? (
            <span
              data-testid="traffic-hover-readout"
              className="inline-flex items-center gap-2 font-mono tabular-nums font-semibold"
              dir="ltr"
            >
              <span className="inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
                <ArrowDown size={11} aria-hidden="true" />
                {formatSpeed(hoveredPoint.downloadBps)}
              </span>
              <span className="inline-flex items-center gap-0.5 text-sky-600 dark:text-sky-400">
                <ArrowUp size={11} aria-hidden="true" />
                {formatSpeed(hoveredPoint.uploadBps)}
              </span>
              <span className="text-slate-400 dark:text-slate-600">·</span>
              <span className="font-sans font-normal text-slate-500 dark:text-slate-400">
                {hoveredAgeSec === 0
                  ? t(lang, 'latencyNowLabel')
                  : t(lang, 'latencySecondsAgo', { sec: hoveredAgeSec ?? 0 })}
              </span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <span>{t(lang, 'trafficPeakLabel')}</span>
              <span
                data-testid="traffic-peak-value"
                className="inline-flex items-center gap-2 font-mono font-semibold tabular-nums"
                dir="ltr"
              >
                <span className="text-emerald-600 dark:text-emerald-400">
                  ↓ {formatSpeed(stats.peakDownloadBps)}
                </span>
                <span className="text-sky-600 dark:text-sky-400">
                  ↑ {formatSpeed(stats.peakUploadBps)}
                </span>
              </span>
            </span>
          )}
        </div>
      </div>

      {/* Responsive Dual-Series D3 Line Chart */}
      <div ref={containerRef} className="relative w-full" dir="ltr">
        <svg
          width="100%"
          height={CHART_HEIGHT}
          viewBox={`0 0 ${width} ${CHART_HEIGHT}`}
          role="img"
          aria-label={t(lang, 'trafficChartAria')}
          className="block overflow-visible select-none"
        >
          <defs>
            <linearGradient id={`traffic-dl-grad-${gradientId}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={DOWNLOAD_STROKE} stopOpacity="0.24" />
              <stop offset="100%" stopColor={DOWNLOAD_STROKE} stopOpacity="0.01" />
            </linearGradient>
            <linearGradient id={`traffic-ul-grad-${gradientId}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={UPLOAD_STROKE} stopOpacity="0.18" />
              <stop offset="100%" stopColor={UPLOAD_STROKE} stopOpacity="0.01" />
            </linearGradient>
          </defs>

          <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
            {/* Horizontal Y-axis gridlines & compact throughput labels */}
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
                    {formatCompactTrafficTick(tick)}
                  </text>
                </g>
              );
            })}

            {/* X-axis relative 60s labels */}
            <text
              x={0}
              y={innerHeight + 13}
              textAnchor="start"
              className="fill-slate-400 dark:fill-slate-500 font-mono text-[9px] tabular-nums"
            >
              -60s
            </text>
            <text
              x={innerWidth / 2}
              y={innerHeight + 13}
              textAnchor="middle"
              className="fill-slate-400 dark:fill-slate-500 font-mono text-[9px] tabular-nums"
            >
              -30s
            </text>
            <text
              x={innerWidth}
              y={innerHeight + 13}
              textAnchor="end"
              className="fill-slate-400 dark:fill-slate-500 text-[9px] font-medium"
            >
              {t(lang, 'latencyNowLabel')}
            </text>

            {/* Upload area & line */}
            {visiblePoints.length >= 2 && uploadAreaPath && (
              <path d={uploadAreaPath} fill={`url(#traffic-ul-grad-${gradientId})`} />
            )}
            {visiblePoints.length >= 2 && uploadLinePath && (
              <path
                data-testid="traffic-upload-path"
                d={uploadLinePath}
                fill="none"
                stroke={UPLOAD_STROKE}
                strokeWidth={1.75}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}

            {/* Download area & line */}
            {visiblePoints.length >= 2 && downloadAreaPath && (
              <path d={downloadAreaPath} fill={`url(#traffic-dl-grad-${gradientId})`} />
            )}
            {visiblePoints.length >= 2 && downloadLinePath && (
              <path
                data-testid="traffic-download-path"
                d={downloadLinePath}
                fill="none"
                stroke={DOWNLOAD_STROKE}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}

            {/* Single-point live endpoints before second sample arrives */}
            {latestPoint && !hoveredPoint && (
              <>
                <circle
                  cx={xScale(latestPoint.timestamp)}
                  cy={yScale(latestPoint.uploadBps)}
                  r={2.5}
                  fill={UPLOAD_STROKE}
                />
                <g
                  transform={`translate(${xScale(latestPoint.timestamp)},${yScale(
                    latestPoint.downloadBps
                  )})`}
                >
                  <circle r={5} fill={DOWNLOAD_STROKE} fillOpacity={0.2} />
                  <circle r={2.6} fill={DOWNLOAD_STROKE} />
                </g>
              </>
            )}

            {/* Interactive Hover Crosshair */}
            {hoveredPoint && (
              <g>
                <line
                  x1={xScale(hoveredPoint.timestamp)}
                  x2={xScale(hoveredPoint.timestamp)}
                  y1={0}
                  y2={innerHeight}
                  className="stroke-slate-400/70 dark:stroke-slate-500/70"
                  strokeDasharray="2 2"
                  strokeWidth={1}
                />
                <circle
                  cx={xScale(hoveredPoint.timestamp)}
                  cy={yScale(hoveredPoint.uploadBps)}
                  r={3.8}
                  fill={UPLOAD_STROKE}
                  stroke="white"
                  strokeWidth={1.5}
                />
                <circle
                  cx={xScale(hoveredPoint.timestamp)}
                  cy={yScale(hoveredPoint.downloadBps)}
                  r={4.2}
                  fill={DOWNLOAD_STROKE}
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

        {/* Restrained empty state when no live traffic samples exist */}
        {visiblePoints.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center pb-3">
            <span className="rounded-lg bg-slate-100/85 dark:bg-slate-950/75 px-2.5 py-1 text-[11px] text-slate-500 dark:text-slate-400 backdrop-blur-sm">
              {isConnected
                ? t(lang, 'trafficEmptyConnected')
                : t(lang, 'trafficEmptyDisconnected')}
            </span>
          </div>
        )}
      </div>
    </figure>
  );
};
