import React, { useMemo, useState } from 'react';
import { Check, Copy, Trash2 } from 'lucide-react';
import type { LogEntry } from '../types/sentra';

interface LogsViewProps {
  logs: LogEntry[];
  onClearLogs: () => void;
}

export const LogsView: React.FC<LogsViewProps> = ({ logs, onClearLogs }) => {
  const [filter, setFilter] = useState<'ALL' | 'INFO' | 'SYNC' | 'WARN' | 'ERROR'>('ALL');
  const [copied, setCopied] = useState(false);

  const visibleLogs = useMemo(() => {
    if (filter === 'ALL') return logs;
    return logs.filter((l) => l.level === filter);
  }, [logs, filter]);

  const handleCopyAll = async () => {
    try {
      const content = visibleLogs
        .map((l) => `[${l.timestamp}] [${l.level}] ${l.message}`)
        .join('\n');
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // ignore clipboard errors
    }
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden px-4 md:px-8 py-6 pb-24 md:pb-8">
      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-slate-900 dark:text-white">
              گزارش‌های سیستم (Logs)
            </h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              رویدادهای واقعی اتصال، همگام‌سازی و هسته شبکه
            </p>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-1">
              {(['ALL', 'INFO', 'SYNC', 'WARN', 'ERROR'] as const).map((lvl) => (
                <button
                  key={lvl}
                  type="button"
                  onClick={() => setFilter(lvl)}
                  className={`rounded-lg px-2.5 py-1 font-mono text-[11px] font-semibold transition ${
                    filter === lvl
                      ? 'bg-emerald-600 text-white'
                      : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  {lvl === 'ALL' ? 'همه' : lvl}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={handleCopyAll}
              disabled={visibleLogs.length === 0}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-emerald-500/50 disabled:opacity-50 transition"
            >
              {copied ? <Check size={15} className="text-emerald-500" /> : <Copy size={15} />}
              <span>{copied ? 'کپی شد' : 'کپی'}</span>
            </button>

            <button
              type="button"
              onClick={onClearLogs}
              disabled={logs.length === 0}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 disabled:opacity-50 transition"
            >
              <Trash2 size={15} />
              <span>پاک‌سازی</span>
            </button>
          </div>
        </div>

        <div
          dir="ltr"
          className="flex-1 overflow-y-auto rounded-2xl border border-slate-200/90 dark:border-slate-800 bg-slate-950 p-4 font-mono text-xs leading-6 text-slate-200"
        >
          {visibleLogs.length === 0 ? (
            <div className="py-12 text-center font-sans text-slate-500">
              هنوز گزارشی ثبت نشده است.
            </div>
          ) : (
            <div className="space-y-1">
              {visibleLogs.map((entry) => (
                <div key={entry.id} className="flex items-start gap-2.5 break-all">
                  <span className="shrink-0 text-slate-500 tabular-nums">{entry.timestamp}</span>
                  <span
                    className={`shrink-0 font-bold ${
                      entry.level === 'ERROR'
                        ? 'text-rose-400'
                        : entry.level === 'WARN'
                        ? 'text-amber-400'
                        : entry.level === 'SYNC'
                        ? 'text-sky-400'
                        : 'text-emerald-400'
                    }`}
                  >
                    [{entry.level}]
                  </span>
                  <span className="text-slate-200">{entry.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
