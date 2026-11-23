import React, { useState } from 'react';
import { AlertCircle, Gift, Send, X } from 'lucide-react';
import type { PersonalConfigItem } from '../types/sentra';

interface DonateModalProps {
  config: PersonalConfigItem | null;
  onClose: () => void;
  onConfirmDonate: (payload: {
    uri: string;
    name?: string;
    note?: string;
  }) => Promise<{ message?: string }>;
}

export const DonateModal: React.FC<DonateModalProps> = ({
  config,
  onClose,
  onConfirmDonate,
}) => {
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!config) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await onConfirmDonate({
        uri: config.uri,
        name: config.name,
        note: note.trim() || undefined,
      });
      setNote('');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ارسال اوتباند با خطا مواجه شد.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="donate-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 px-4 backdrop-blur-sm"
    >
      <div className="w-full max-w-md rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-2xl">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Gift size={18} className="text-amber-500" />
            <h2 id="donate-modal-title" className="text-base font-bold text-slate-900 dark:text-white">
              انتشار به عنوان اوتباند اهدایی
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="بستن پنجره اهدا"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
          >
            <X size={18} />
          </button>
        </div>

        <div className="mt-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 p-3.5">
          <div className="flex items-center gap-2.5">
            <span className="text-xl">{config.flag}</span>
            <div className="min-w-0">
              <div className="truncate text-xs font-bold text-slate-900 dark:text-white">
                {config.name}
              </div>
              <div className="mt-0.5 font-mono text-[11px] text-slate-500 dark:text-slate-400" dir="ltr">
                {config.protocol} · {config.server_address}:{config.server_port}
              </div>
            </div>
          </div>
        </div>

        <p className="mt-3 text-xs leading-5 text-slate-500 dark:text-slate-400">
          این کانفیگ برای بررسی و تست سلامت به پنل تلگرام ادمین ارسال می‌شود. پس از تایید، ۷ تا ۳۰ روز اشتراک رایگان روی حساب شما اعمال خواهد شد.
        </p>

        {error && (
          <div
            role="alert"
            className="mt-3 flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300"
          >
            <AlertCircle size={15} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div>
            <label
              htmlFor="donate-modal-note"
              className="mb-1.5 block text-xs font-medium text-slate-700 dark:text-slate-300"
            >
              توضیحات اختیاری (مدت اعتبار یا ظرفیت سرور)
            </label>
            <input
              id="donate-modal-note"
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="مثلاً: سرور اختصاصی آلمان، اعتبار ۱ ماهه"
              className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/60 px-3.5 py-2.5 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
            />
          </div>

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-slate-200 dark:border-slate-700 px-4 py-2 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
            >
              انصراف
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 px-4 py-2 text-xs font-semibold text-white transition"
            >
              <Send size={15} />
              <span>{submitting ? 'در حال ارسال...' : 'ارسال برای تایید'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
