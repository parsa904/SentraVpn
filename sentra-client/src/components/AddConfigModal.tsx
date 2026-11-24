import React, { useMemo, useState } from 'react';
import { AlertCircle, ClipboardPaste, Plus, X } from 'lucide-react';
import type { PersonalConfigItem } from '../types/sentra';
import { type Language, t } from '../i18n/translations';
import { buildPersonalConfigItem, parseProxyInput } from '../utils/proxyParser';

interface AddConfigModalProps {
  lang: Language;
  open: boolean;
  onClose: () => void;
  onAddConfig: (item: PersonalConfigItem) => void;
}

export const AddConfigModal: React.FC<AddConfigModalProps> = ({
  lang,
  open,
  onClose,
  onAddConfig,
}) => {
  const [rawInput, setRawInput] = useState('');
  const [customName, setCustomName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const preview = useMemo(() => {
    if (!rawInput.trim()) return null;
    try {
      return parseProxyInput(rawInput, customName);
    } catch {
      return null;
    }
  }, [rawInput, customName]);

  if (!open) return null;

  const handlePaste = async () => {
    setError(null);
    try {
      const text = await navigator.clipboard.readText();
      if (text) setRawInput(text.trim());
    } catch {
      setError(t(lang, 'clipboardError'));
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const item = buildPersonalConfigItem(rawInput, customName);
      onAddConfig(item);
      setRawInput('');
      setCustomName('');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t(lang, 'invalidLink'));
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-config-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 px-4 backdrop-blur-sm"
    >
      <div className="animate-sentra-view w-full max-w-lg rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-2xl">
        <div className="flex items-center justify-between gap-3">
          <h2 id="add-config-title" className="text-base font-bold text-slate-900 dark:text-white">
            {t(lang, 'addModalTitle')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t(lang, 'closeModalAria')}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-700 dark:hover:text-slate-200 active:scale-95 transition"
          >
            <X size={18} />
          </button>
        </div>

        <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
          {t(lang, 'addModalDesc')}
        </p>

        {error && (
          <div
            role="alert"
            className="mt-4 flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5 text-xs text-rose-700 dark:text-rose-300"
          >
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label
                htmlFor="modal-config-uri"
                className="text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                {t(lang, 'addModalUriLabel')}
              </label>
              <button
                type="button"
                onClick={handlePaste}
                className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400 hover:underline"
              >
                <ClipboardPaste size={14} />
                <span>{t(lang, 'pasteClipboard')}</span>
              </button>
            </div>
            <textarea
              id="modal-config-uri"
              rows={3}
              dir="ltr"
              value={rawInput}
              onChange={(e) => {
                setRawInput(e.target.value);
                setError(null);
              }}
              placeholder="vless://uuid@host:443?security=reality#MyServer"
              className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/60 p-3 font-mono text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
            />
          </div>

          <div>
            <label
              htmlFor="modal-config-name"
              className="mb-1.5 block text-xs font-medium text-slate-700 dark:text-slate-300"
            >
              {t(lang, 'addModalNameLabel')}
            </label>
            <input
              id="modal-config-name"
              type="text"
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              placeholder={t(lang, 'addModalNamePlaceholder')}
              className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/60 px-3.5 py-2.5 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
            />
          </div>

          {preview && (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.07] px-3.5 py-2.5 text-xs">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-lg">{preview.flag}</span>
                <span className="truncate font-semibold text-slate-900 dark:text-white">
                  {preview.name}
                </span>
              </div>
              <span
                className="shrink-0 font-mono text-[11px] font-semibold text-emerald-700 dark:text-emerald-300"
                dir="ltr"
              >
                {preview.protocol} · {preview.server_address}:{preview.server_port}
              </span>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-slate-200 dark:border-slate-700 px-4 py-2 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 active:scale-[0.97] transition"
            >
              {t(lang, 'cancel')}
            </button>
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 active:scale-[0.97] px-4 py-2 text-xs font-semibold text-white transition"
            >
              <Plus size={16} />
              <span>{t(lang, 'addBtn')}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
