/**
 * Unified shared configuration constants for Sentra Connect client.
 */

export const DEFAULT_TELEGRAM_BOT_USERNAME = '@sentraconnect_bot';

export const DEFAULT_API_BASE_URL = 'https://sentra-core.kziepr.workers.dev';

export const DEFAULT_CUSTOM_DNS = '1.1.1.1';

export const THEME_STORAGE_KEY = 'sentra_theme_v2';
export const SESSION_STORAGE_KEY = 'sentra_session_v2';
export const PERSONAL_CONFIGS_KEY = 'sentra_personal_configs_v2';
export const DEVICE_ID_KEY = 'sentra_device_id_v2';

export function normalizeBaseUrl(url: string | undefined): string {
  return (url || '').trim().replace(/\/+$/, '');
}

const ENV_API_BASE_URL =
  typeof import.meta !== 'undefined' && import.meta.env
    ? (import.meta.env.VITE_API_BASE_URL as string | undefined)
    : undefined;

export const API_BASE_URL =
  normalizeBaseUrl(ENV_API_BASE_URL) || DEFAULT_API_BASE_URL;

/**
 * Normalizes a Telegram bot handle by trimming whitespace and removing any
 * leading `@` symbols, falling back to DEFAULT_TELEGRAM_BOT_USERNAME.
 * Safe for both `https://t.me/<username>` URLs and `@<username>` labels.
 */
export function normalizeTelegramBotUsername(
  botUsername?: string | null
): string {
  return (
    botUsername?.replace(/^@+/, '').trim() || DEFAULT_TELEGRAM_BOT_USERNAME
  ).replace(/^@+/, '');
}
