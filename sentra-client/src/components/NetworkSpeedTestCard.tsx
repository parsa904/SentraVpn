import React, { useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Gauge,
  Loader2,
  Play,
  RotateCw,
  Square,
} from 'lucide-react';
import { type Language, t } from '../i18n/translations';
import { formatBytes } from '../utils/proxyParser';
import {
  type SpeedTestProgress,
  type SpeedTestResult,
  TOTAL_SPEED_TEST_PROBES,
  formatThroughputMBps,
  isAbortError,
  runNetworkSpeedTest,
} from '../utils/speedTest';

interface NetworkSpeedTestCardProps {
  lang: Language;
  onLogEvent?: (message: string) => void;
}

export const NetworkSpeedTestCard: React.FC<NetworkSpeedTestCardProps> = ({
  lang,
  onLogEvent,
}) => {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<SpeedTestProgress | null>(null);
  const [result, setResult] = useState<SpeedTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const handleStartTest = async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setRunning(true);
    setError(null);
    setCancelled(false);
    setProgress({
      phase: 'latency',
      completedProbes: 0,
      totalProbes: TOTAL_SPEED_TEST_PROBES,
      phaseStep: 0,
      phaseTotal: 2,
      currentMBps: null,
      downloadMBps: null,
      uploadMBps: null,
      latencyMs: null,
    });

    onLogEvent?.('Starting sequential network speed test (latency, download, upload)...');

    try {
      const res = await runNetworkSpeedTest({
        signal: controller.signal,
        onProgress: (p) => setProgress(p),
      });
      setResult(res);
      onLogEvent?.(
        `Speed test completed: Down ${formatThroughputMBps(res.downloadMBps)}, Up ${formatThroughputMBps(res.uploadMBps)}${res.latencyMs !== null ? `, Ping ${res.latencyMs} ms` : ''}.`
      );
    } catch (err) {
      if (isAbortError(err)) {
        setCancelled(true);
        onLogEvent?.('Network speed test cancelled by user.');
      } else {
        const message = err instanceof Error ? err.message : t(lang, 'speedTestError');
        setError(message);
        onLogEvent?.(`Network speed test failed: ${message}`);
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
      setRunning(false);
    }
  };

  const handleCancelTest = () => {
    abortRef.current?.abort();
  };

  const displayDownload = running
    ? progress?.downloadMBps ?? null
    : result?.downloadMBps ?? null;
  const displayUpload = running
    ? progress?.uploadMBps ?? null
    : result?.uploadMBps ?? null;
  const displayLatency = running
    ? progress?.latencyMs ?? null
    : result?.latencyMs ?? null;

  const progressPct =
    running && progress
      ? Math.min(100, Math.round((progress.completedProbes / Math.max(1, progress.totalProbes)) * 100))
      : result && !error
      ? 100
      : 0;

  const phaseText = (() => {
    if (!running || !progress) return null;
    if (progress.phase === 'latency') {
      return t(lang, 'speedTestPhaseLatency', {
        step: Math.min(progress.phaseStep + 1, progress.phaseTotal),
        total: progress.phaseTotal,
      });
    }
    if (progress.phase === 'download') {
      return t(lang, 'speedTestPhaseDownload', {
        step: Math.min(progress.phaseStep + 1, progress.phaseTotal),
        total: progress.phaseTotal,
      });
    }
    if (progress.phase === 'upload') {
      return t(lang, 'speedTestPhaseUpload', {
        step: Math.min(progress.phaseStep + 1, progress.phaseTotal),
        total: progress.phaseTotal,
      });
    }
    return null;
  })();

  return (
    <div
      data-testid="network-speed-test-panel"
      className="pt-3 space-y-3.5"
    >
      <div className="flex flex-wrap sm:flex-nowrap items-center justify-between gap-3">
        <div className="flex items-start gap-2.5 min-w-0">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
            <Gauge size={16} aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <div className="text-xs font-semibold text-slate-900 dark:text-white">
              {t(lang, 'speedTestTitle')}
            </div>
            <div className="text-[11px] text-slate-500 dark:text-slate-400">
              {t(lang, 'speedTestDesc')}
            </div>
          </div>
        </div>

        {running ? (
          <button
            type="button"
            data-testid="cancel-speed-test-btn"
            onClick={handleCancelTest}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-rose-500/35 bg-rose-500/10 hover:bg-rose-500/20 active:scale-[0.97] px-3.5 py-2 text-xs font-semibold text-rose-600 dark:text-rose-400 transition"
          >
            <Square size={12} className="fill-current" aria-hidden="true" />
            <span>{t(lang, 'speedTestCancelBtn')}</span>
          </button>
        ) : (
          <button
            type="button"
            data-testid="run-speed-test-btn"
            onClick={() => void handleStartTest()}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 active:scale-[0.97] px-3.5 py-2 text-xs font-semibold text-white shadow-sm shadow-emerald-600/20 transition"
          >
            {result ? (
              <RotateCw size={13} aria-hidden="true" />
            ) : (
              <Play size={13} className="fill-current" aria-hidden="true" />
            )}
            <span>{result ? t(lang, 'speedTestRetestBtn') : t(lang, 'speedTestRunBtn')}</span>
          </button>
        )}
      </div>

      {/* Live Progress Bar while probes are running */}
      {running && (
        <div
          data-testid="speed-test-progress"
          role="status"
          aria-live="polite"
          className="space-y-1.5"
        >
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span className="inline-flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-300">
              <Loader2 size={12} className="animate-spin shrink-0" aria-hidden="true" />
              <span>{phaseText}</span>
            </span>
            <span className="font-mono tabular-nums text-slate-500 dark:text-slate-400" dir="ltr">
              {progressPct}%
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
            <div
              className="h-full rounded-full bg-emerald-500 transition-all duration-300"
              style={{ width: `${Math.max(8, progressPct)}%` }}
            />
          </div>
        </div>
      )}

      {/* Results Grid: Download MB/s, Upload MB/s, Latency ms */}
      {(running || result) && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
          <div className="rounded-xl border border-slate-200/80 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-950/60 px-3.5 py-2.5">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400">
              <ArrowDown size={13} className="text-emerald-500 shrink-0" aria-hidden="true" />
              <span>{t(lang, 'speedTestDownloadLabel')}</span>
            </div>
            <div
              data-testid="speed-test-download-value"
              dir="ltr"
              className={`mt-1 font-mono text-sm font-bold tabular-nums ${
                displayDownload !== null
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-slate-400 dark:text-slate-600'
              }`}
            >
              {formatThroughputMBps(displayDownload)}
            </div>
          </div>

          <div className="rounded-xl border border-slate-200/80 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-950/60 px-3.5 py-2.5">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400">
              <ArrowUp size={13} className="text-sky-500 shrink-0" aria-hidden="true" />
              <span>{t(lang, 'speedTestUploadLabel')}</span>
            </div>
            <div
              data-testid="speed-test-upload-value"
              dir="ltr"
              className={`mt-1 font-mono text-sm font-bold tabular-nums ${
                displayUpload !== null
                  ? 'text-sky-600 dark:text-sky-400'
                  : 'text-slate-400 dark:text-slate-600'
              }`}
            >
              {formatThroughputMBps(displayUpload)}
            </div>
          </div>

          <div className="rounded-xl border border-slate-200/80 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-950/60 px-3.5 py-2.5">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400">
              <Activity size={13} className="text-slate-500 dark:text-slate-400 shrink-0" aria-hidden="true" />
              <span>{t(lang, 'speedTestLatencyLabel')}</span>
            </div>
            <div
              data-testid="speed-test-latency-value"
              dir="ltr"
              className={`mt-1 font-mono text-sm font-bold tabular-nums ${
                displayLatency !== null
                  ? 'text-slate-900 dark:text-white'
                  : 'text-slate-400 dark:text-slate-600'
              }`}
            >
              {displayLatency !== null ? `${displayLatency} ms` : '—'}
            </div>
          </div>
        </div>
      )}

      {result && !running && !error && (
        <div
          data-testid="speed-test-summary"
          className="text-[11px] text-slate-500 dark:text-slate-400"
        >
          {t(lang, 'speedTestCompletedMeta', {
            probes: result.probesCount,
            transferred: formatBytes(result.totalBytesDownloaded + result.totalBytesUploaded),
            sec: (result.durationMs / 1000).toFixed(1),
          })}
        </div>
      )}

      {cancelled && !running && (
        <p role="status" className="text-xs text-slate-500 dark:text-slate-400">
          {t(lang, 'speedTestCancelled')}
        </p>
      )}

      {error && !running && (
        <p
          role="alert"
          data-testid="speed-test-error"
          className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300"
        >
          {error}
        </p>
      )}
    </div>
  );
};
