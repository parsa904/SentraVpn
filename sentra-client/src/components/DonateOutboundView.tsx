import React, { useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ClipboardPaste,
  Clock,
  Gift,
  RefreshCw,
  Send,
  XCircle,
} from 'lucide-react';
import type { DonatedOutboundRecord, PersonalConfigItem } from '../types/sentra';
import { type Language, t } from '../i18n/translations';
import { formatPing, isSupportedProxyUri } from '../utils/proxyParser';

interface DonateOutboundViewProps {
  lang: Language;
  personalConfigs: PersonalConfigItem[];
  donations: DonatedOutboundRecord[];
  loadingDonations: boolean;
  onRefreshDonations: () => void;
  onSubmitDonation: (payload: {
    uri: string;
    name?: string;
    note?: string;
  }) => Promise<{ message?: string }>;
}

export const DonateOutboundView: React.FC<DonateOutboundViewProps> = ({
  lang,
  personalConfigs,
  donations,
  loadingDonations,
  onRefreshDonations,
  onSubmitDonation,
}) => {
  const [uri, setUri] = useState('');
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const donatablePersonal = personalConfigs.filter((c) => !c.is_subscription);

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setUri(text.trim());
    } catch {
      setError(t(lang, 'clipboardError'));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);

    const trimmed = uri.trim();
    if (!trimmed) {
      setError(t(lang, 'donationUriRequired'));
      return;
    }
    if (!isSupportedProxyUri(trimmed)) {
      setError(t(lang, 'donationUriUnsupported'));
      return;
    }

    setSubmitting(true);
    try {
      const res = await onSubmitDonation({
        uri: trimmed,
        name: name.trim() || undefined,
        note: note.trim() || undefined,
      });
      setSuccessMsg(res.message || t(lang, 'donationSubmittedDefault'));
      setUri('');
      setName('');
      setNote('');
    } catch (err) {
      setError(err instanceof Error ? err.message : t(lang, 'donationSubmitError'));
    } finally {
      setSubmitting(false);
    }
  };

  const renderStatus = (rec: DonatedOutboundRecord) => {
    if (rec.status === 'approved' || rec.status === 'active') {
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 size={15} />
          <span>
            {rec.reward_days > 0
              ? t(lang, 'statusApprovedDays', { days: rec.reward_days })
              : t(lang, 'statusApproved')}
          </span>
        </span>
      );
    }
    if (rec.status === 'rejected') {
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-rose-600 dark:text-rose-400">
          <XCircle size={15} />
          <span>{t(lang, 'statusRejected')}</span>
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-600 dark:text-amber-400">
        <Clock size={15} />
        <span>{t(lang, 'statusPending')}</span>
      </span>
    );
  };

  return (
    <div className="animate-sentra-view flex-1 overflow-y-auto px-4 md:px-8 py-6 pb-24 md:pb-10">
      <div className="mx-auto max-w-4xl space-y-7">
        {/* Donation Form Card */}
        <section className="rounded-2xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-5 md:p-6">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-amber-500/12 text-amber-600 dark:text-amber-400">
              <Gift size={22} />
            </div>
            <div>
              <h2 className="text-base md:text-lg font-bold text-slate-900 dark:text-white">
                {t(lang, 'donateTitle')}
              </h2>
              <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
                {t(lang, 'donateDesc')}
              </p>
            </div>
          </div>

          {donatablePersonal.length > 0 && (
            <div className="mt-5">
              <div className="mb-2 text-xs font-medium text-slate-600 dark:text-slate-300">
                {t(lang, 'quickPickPersonal')}
              </div>
              <div className="flex flex-wrap gap-2">
                {donatablePersonal.map((cfg) => (
                  <button
                    key={cfg.id}
                    type="button"
                    onClick={() => {
                      setUri(cfg.uri);
                      setName(cfg.name);
                      setError(null);
                    }}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/80 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-emerald-500/50 active:scale-[0.97] transition"
                  >
                    <span>{cfg.flag}</span>
                    <span>{cfg.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="mt-4 flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5 text-xs text-rose-700 dark:text-rose-300"
            >
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {successMsg && (
            <div
              role="status"
              className="mt-4 flex items-start gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2.5 text-xs text-emerald-700 dark:text-emerald-300"
            >
              <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
              <span>{successMsg}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="mt-5 space-y-4">
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label
                  htmlFor="donate-uri"
                  className="text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  {t(lang, 'configUriLabel')}
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
                id="donate-uri"
                rows={3}
                dir="ltr"
                value={uri}
                onChange={(e) => setUri(e.target.value)}
                placeholder="vless://... | vmess://... | trojan://... | hy2://... | ss://... | tuic://... | wireguard://..."
                className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-950/60 p-3 font-mono text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label
                  htmlFor="donate-name"
                  className="mb-1.5 block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  {t(lang, 'serverNameOptional')}
                </label>
                <input
                  id="donate-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t(lang, 'serverNamePlaceholder')}
                  className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-950/60 px-3.5 py-2.5 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                />
              </div>

              <div>
                <label
                  htmlFor="donate-note"
                  className="mb-1.5 block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  {t(lang, 'noteOptional')}
                </label>
                <input
                  id="donate-note"
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={t(lang, 'notePlaceholder')}
                  className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-950/60 px-3.5 py-2.5 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                />
              </div>
            </div>

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={submitting}
                className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 active:scale-[0.98] disabled:opacity-60 px-5 py-2.5 text-xs font-semibold text-white shadow-sm shadow-emerald-600/20 transition"
              >
                <Send size={15} />
                <span>
                  {submitting ? t(lang, 'submittingDonation') : t(lang, 'submitDonation')}
                </span>
              </button>
            </div>
          </form>
        </section>

        {/* User Donation History & Reward Status */}
        <section className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-base font-bold text-slate-900 dark:text-white">
              {t(lang, 'myDonationsTitle')}
            </h3>

            <button
              type="button"
              onClick={onRefreshDonations}
              disabled={loadingDonations}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-emerald-500/50 active:scale-[0.97] transition"
            >
              <RefreshCw
                size={15}
                className={loadingDonations ? 'animate-spin text-emerald-500' : ''}
              />
              <span>{t(lang, 'refreshStatus')}</span>
            </button>
          </div>

          {donations.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-300 dark:border-slate-800 bg-white/60 dark:bg-slate-900/40 px-6 py-10 text-center">
              <p className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                {t(lang, 'noDonationsTitle')}
              </p>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {t(lang, 'noDonationsDesc')}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-slate-200/80 dark:divide-slate-800 rounded-2xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900/80 overflow-hidden">
              {donations.map((rec) => (
                <div
                  key={rec.id}
                  className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-100 dark:bg-slate-800 text-xl">
                      {rec.flag || '🌐'}
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-bold text-slate-900 dark:text-white">
                          {rec.name}
                        </span>
                        <span className="font-mono text-[11px] font-semibold uppercase text-emerald-600 dark:text-emerald-400">
                          {rec.protocol}
                        </span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-slate-500 dark:text-slate-400">
                        <span className="font-mono" dir="ltr">
                          {rec.server_address}:{rec.server_port}
                        </span>
                        <span>·</span>
                        <span className="font-mono tabular-nums" dir="ltr">
                          {formatPing(rec.latency_ms, lang)}
                        </span>
                        {rec.user_note && (
                          <>
                            <span>·</span>
                            <span className="truncate max-w-[240px]">{rec.user_note}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="shrink-0">{renderStatus(rec)}</div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
