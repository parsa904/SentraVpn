import type {
  ConnectionModeId,
  PersonalConfigItem,
  RoutingMode,
  SyncedClientPreferences,
  SyncedClientState,
  ThemeMode,
} from '../types/sentra';

export const BOOTSTRAP_POLL_INTERVAL_MS = 30_000;
export const STATE_PUSH_DEBOUNCE_MS = 1_200;
export const MAX_SYNCED_PERSONAL_CONFIGS = 100;

const ALLOWED_MODES = new Set<ConnectionModeId>(['web_browsing', 'download', 'gaming', 'static_ip']);
const ALLOWED_ROUTING = new Set<RoutingMode>(['tunnel', 'system_proxy', 'proxy']);
const ALLOWED_THEMES = new Set<ThemeMode>(['dark', 'light']);

export function sanitizeSyncedPreferences(raw: unknown): SyncedClientPreferences {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const obj = raw as Record<string, unknown>;
  const out: SyncedClientPreferences = {};

  if (typeof obj.selected_mode === 'string' && ALLOWED_MODES.has(obj.selected_mode as ConnectionModeId)) {
    out.selected_mode = obj.selected_mode as ConnectionModeId;
  }
  if (typeof obj.routing_mode === 'string' && ALLOWED_ROUTING.has(obj.routing_mode as RoutingMode)) {
    out.routing_mode = obj.routing_mode as RoutingMode;
  }
  if (typeof obj.split_tunneling === 'boolean') {
    out.split_tunneling = obj.split_tunneling;
  }
  if (typeof obj.kill_switch === 'boolean') {
    out.kill_switch = obj.kill_switch;
  }
  if (typeof obj.auto_reconnect === 'boolean') {
    out.auto_reconnect = obj.auto_reconnect;
  }
  if (typeof obj.ping_optimization_enabled === 'boolean') {
    out.ping_optimization_enabled = obj.ping_optimization_enabled;
  }
  if (typeof obj.use_warp === 'boolean') {
    out.use_warp = obj.use_warp;
  }
  if (typeof obj.custom_dns === 'string') {
    const trimmed = obj.custom_dns.trim().slice(0, 64);
    if (trimmed) out.custom_dns = trimmed;
  }
  if (obj.selected_outbound_id === null || typeof obj.selected_outbound_id === 'string') {
    out.selected_outbound_id = obj.selected_outbound_id;
  }
  if (typeof obj.auto_mode === 'boolean') {
    out.auto_mode = obj.auto_mode;
  }
  if (obj.lang === 'fa' || obj.lang === 'en') {
    out.lang = obj.lang;
  }
  if (typeof obj.theme === 'string' && ALLOWED_THEMES.has(obj.theme as ThemeMode)) {
    out.theme = obj.theme as ThemeMode;
  }

  return out;
}

export function sanitizePersonalConfigs(raw: unknown): PersonalConfigItem[] {
  if (!Array.isArray(raw)) return [];
  const seenIds = new Set<string>();
  const cleaned: PersonalConfigItem[] = [];

  for (const item of raw) {
    if (cleaned.length >= MAX_SYNCED_PERSONAL_CONFIGS) break;
    if (!item || typeof item !== 'object') continue;
    const c = item as Partial<PersonalConfigItem>;
    if (typeof c.id !== 'string' || !c.id.trim()) continue;
    if (typeof c.uri !== 'string' || !c.uri.trim()) continue;
    if (seenIds.has(c.id)) continue;
    seenIds.add(c.id);

    cleaned.push({
      id: c.id,
      name: typeof c.name === 'string' && c.name.trim() ? c.name.trim() : 'Personal Node',
      uri: c.uri.trim(),
      protocol: typeof c.protocol === 'string' && c.protocol ? c.protocol : 'UNKNOWN',
      server_address: typeof c.server_address === 'string' ? c.server_address : '',
      server_port: typeof c.server_port === 'number' && Number.isFinite(c.server_port) ? c.server_port : 443,
      country_code: typeof c.country_code === 'string' && c.country_code ? c.country_code : 'XX',
      flag: typeof c.flag === 'string' && c.flag ? c.flag : '🌐',
      is_subscription: Boolean(c.is_subscription),
      latency_ms: typeof c.latency_ms === 'number' && Number.isFinite(c.latency_ms) ? c.latency_ms : null,
      added_at: typeof c.added_at === 'string' && c.added_at ? c.added_at : new Date().toISOString(),
    });
  }

  return cleaned;
}

export function parseIsoTimestampMs(iso: string | null | undefined): number {
  if (!iso || typeof iso !== 'string') return 0;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function shouldApplyRemoteState(
  lastSyncedAtMs: number,
  remoteUpdatedAt: string | null | undefined
): boolean {
  const remoteMs = parseIsoTimestampMs(remoteUpdatedAt);
  if (remoteMs <= 0) return false;
  return remoteMs > lastSyncedAtMs;
}

export function mergePersonalConfigs(
  local: PersonalConfigItem[],
  remote: PersonalConfigItem[],
  preferRemoteAuthoritative: boolean
): PersonalConfigItem[] {
  const cleanRemote = sanitizePersonalConfigs(remote);
  if (preferRemoteAuthoritative) {
    return cleanRemote;
  }

  const cleanLocal = sanitizePersonalConfigs(local);
  const seenIds = new Set<string>(cleanRemote.map((item) => item.id));
  const seenUris = new Set<string>(cleanRemote.map((item) => item.uri));
  const merged = [...cleanRemote];

  for (const item of cleanLocal) {
    if (merged.length >= MAX_SYNCED_PERSONAL_CONFIGS) break;
    if (seenIds.has(item.id) || seenUris.has(item.uri)) continue;
    seenIds.add(item.id);
    seenUris.add(item.uri);
    merged.push(item);
  }

  return merged;
}

export function buildSyncStatePayload(
  personalConfigs: PersonalConfigItem[],
  preferences: SyncedClientPreferences
): { personal_configs: PersonalConfigItem[]; preferences: SyncedClientPreferences } {
  return {
    personal_configs: sanitizePersonalConfigs(personalConfigs),
    preferences: sanitizeSyncedPreferences(preferences),
  };
}

export function normalizeRemoteClientState(raw: unknown): SyncedClientState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  return {
    personal_configs: sanitizePersonalConfigs(obj.personal_configs),
    preferences: sanitizeSyncedPreferences(obj.preferences),
    updated_at: typeof obj.updated_at === 'string' && obj.updated_at.trim() ? obj.updated_at : null,
  };
}
