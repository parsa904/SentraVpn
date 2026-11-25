import type {
  BootstrapResponse,
  ConnectionModeId,
  DonatedOutboundRecord,
  HeartbeatVerdictResponse,
  PersistedSession,
  PersonalConfigItem,
  RoutingMode,
  SyncedClientPreferences,
  SyncedClientState,
  TelemetrySnapshot,
} from '../types/sentra';
import {
  isNewerVersion,
  isSafeReleaseUrl,
  parseAuthSessionResponse,
  type RawAuthApiResponse,
} from '../utils/proxyParser';
import type { BatteryOptimizationStatus } from '../utils/reconnectPolicy';

const SESSION_STORAGE_KEY = 'sentra_session_v2';
const PERSONAL_CONFIGS_KEY = 'sentra_personal_configs_v2';
const DEVICE_ID_KEY = 'sentra_device_id_v2';

const REMOTE_BACKEND_URLS = [
  import.meta.env.VITE_API_BASE_URL as string | undefined,
  'http://116.203.188.124:8080',
  'https://head.cyberservice.sbs:8443',
].filter((u): u is string => Boolean(u && u.trim()));

function getActiveBackendUrls(): string[] {
  if (!isTauriRuntime() && typeof window !== 'undefined' && window.location?.origin) {
    const configured = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim();
    return configured ? [configured, ''] : [''];
  }
  return REMOTE_BACKEND_URLS;
}

interface TauriGlobalBridge {
  __TAURI_INTERNALS__?: {
    invoke?: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  };
  __TAURI__?: {
    core?: {
      invoke?: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
    };
    event?: {
      listen?: <T>(
        event: string,
        handler: (ev: { payload: T }) => void
      ) => Promise<() => void>;
    };
  };
}

function getTauriBridge(): TauriGlobalBridge {
  return window as unknown as TauriGlobalBridge;
}

export function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  const w = getTauriBridge();
  return Boolean(w.__TAURI_INTERNALS__?.invoke || w.__TAURI__?.core?.invoke);
}

async function invokeTauri<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const w = getTauriBridge();
  const invoker = w.__TAURI__?.core?.invoke || w.__TAURI_INTERNALS__?.invoke;
  if (!invoker) {
    throw new Error('محیط بومی Tauri در دسترس نیست.');
  }
  return invoker<T>(cmd, args);
}

function getOrCreateWebDeviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing && existing.length >= 8) return existing;
    const generated =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? `web-${crypto.randomUUID()}`
        : `web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(DEVICE_ID_KEY, generated);
    return generated;
  } catch {
    return 'web-ephemeral-device';
  }
}

function saveLocalSession(session: PersistedSession | null): void {
  try {
    if (!session) {
      localStorage.removeItem(SESSION_STORAGE_KEY);
    } else {
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    }
  } catch {
    // ignore storage quota errors
  }
}

function loadLocalSession(): PersistedSession | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedSession>;
    if (!parsed.subscription_token) return null;
    return {
      auth_token: parsed.auth_token || parsed.subscription_token,
      subscription_token: parsed.subscription_token,
      username: parsed.username || '',
      tier: parsed.tier || '',
      expires_at: parsed.expires_at ?? null,
    };
  } catch {
    return null;
  }
}

async function saveAndroidEncryptedSession(session: PersistedSession | null): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    if (!session) {
      await invokeTauri('clear_persisted_session').catch(() =>
        invokeTauri('plugin:sentra-vpn|clear_session')
      );
    } else {
      const serialized = JSON.stringify({
        ...session,
        remaining_bytes: 0,
      });
      await invokeTauri('save_persisted_session', {
        sessionJson: serialized,
      }).catch(() =>
        invokeTauri('plugin:sentra-vpn|save_session', {
          payload: serialized,
        })
      );
    }
  } catch {
    // Rust AuthManager / localStorage already persists session on desktop
  }
}

async function loadAndroidEncryptedSession(): Promise<PersistedSession | null> {
  if (!isTauriRuntime()) return null;
  try {
    const rawFromCommand = await invokeTauri<string | null>('load_persisted_session').catch(
      () => null
    );
    let rawJson = rawFromCommand;
    if (!rawJson) {
      const pluginRes = await invokeTauri<{ found?: boolean; payload?: string }>(
        'plugin:sentra-vpn|load_session'
      ).catch(() => null);
      if (pluginRes?.found && pluginRes.payload) {
        rawJson = pluginRes.payload;
      }
    }
    if (rawJson) {
      const parsed = JSON.parse(rawJson) as Partial<PersistedSession>;
      if (parsed.subscription_token) {
        return {
          auth_token: parsed.auth_token || parsed.subscription_token,
          subscription_token: parsed.subscription_token,
          username: parsed.username || '',
          tier: parsed.tier || '',
          expires_at: parsed.expires_at ?? null,
        };
      }
    }
  } catch {
    // ignore on desktop
  }
  return null;
}

async function fetchBackendJson<T>(
  path: string,
  options?: RequestInit & { timeoutMs?: number }
): Promise<T> {
  let lastError = 'امکان برقراری ارتباط با سرور مرکزی سنترا وجود ندارد.';
  const timeoutMs = options?.timeoutMs ?? 10000;
  const isCredentialAuthPath =
    path.startsWith('/api/v1/auth/login') ||
    path.startsWith('/api/v1/auth/register') ||
    path.startsWith('/api/v1/auth/code-login') ||
    path.startsWith('/api/v1/auth/exchange-code');

  for (const baseUrl of getActiveBackendUrls()) {
    const url = baseUrl ? `${baseUrl.replace(/\/$/, '')}${path}` : path;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(options?.headers || {}),
        },
      });
      clearTimeout(timer);

      if (response.status === 401 || response.status === 403) {
        let detail = isCredentialAuthPath
          ? 'نام کاربری یا رمز عبور اشتباه است.'
          : 'نشست کاربری منقضی یا لغو شده است. لطفاً دوباره وارد شوید.';
        try {
          const errJson = (await response.json()) as { error?: string; message?: string };
          if (errJson.error || errJson.message) {
            detail = errJson.error || errJson.message || detail;
          }
        } catch {
          // keep default message
        }
        throw new Error(isCredentialAuthPath ? detail : `AUTH_EXPIRED:${detail}`);
      }

      const text = await response.text();
      let parsed: Record<string, unknown> = {};
      try {
        parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        parsed = {};
      }

      if (!response.ok) {
        const msg =
          (typeof parsed.error === 'string' && parsed.error) ||
          (typeof parsed.message === 'string' && parsed.message) ||
          `خطای سرور (${response.status})`;
        throw new Error(msg);
      }

      return parsed as T;
    } catch (err) {
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith('AUTH_EXPIRED:')) {
        throw err;
      }
      // If server responded with a clear application error (not a network/abort error), throw immediately
      if (
        !message.includes('Failed to fetch') &&
        !message.includes('AbortError') &&
        !message.includes('aborted') &&
        !message.includes('NetworkError') &&
        !message.includes('Load failed')
      ) {
        throw err;
      }
      lastError = 'ارتباط با سرور سنترا برقرار نشد. اینترنت خود را بررسی کنید.';
    }
  }

  throw new Error(lastError);
}

export async function restorePersistedSession(): Promise<PersistedSession | null> {
  if (isTauriRuntime()) {
    try {
      const state = await invokeTauri<{
        is_authenticated?: boolean;
        auth_token?: string | null;
        subscription_token?: string | null;
        username?: string;
        tier?: string;
        expires_at?: string | null;
      }>('get_client_state');

      if (state?.is_authenticated && state.subscription_token) {
        const session: PersistedSession = {
          auth_token: state.auth_token || state.subscription_token,
          subscription_token: state.subscription_token,
          username: state.username || '',
          tier: state.tier || '',
          expires_at: state.expires_at ?? null,
        };
        saveLocalSession(session);
        return session;
      }
    } catch {
      // fall through to encrypted prefs / localStorage
    }

    const encrypted = await loadAndroidEncryptedSession();
    if (encrypted) {
      saveLocalSession(encrypted);
      return encrypted;
    }
  }

  return loadLocalSession();
}

export async function loginWithCredentials(
  username: string,
  password: string
): Promise<PersistedSession> {
  if (isTauriRuntime()) {
    const state = await invokeTauri<{
      auth_token?: string | null;
      subscription_token?: string | null;
      username?: string;
      tier?: string;
      expires_at?: string | null;
    }>('login_with_credentials', { username, password });

    if (!state.subscription_token) {
      throw new Error('توکن احراز هویت از سرور دریافت نشد.');
    }
    const session: PersistedSession = {
      auth_token: state.auth_token || state.subscription_token,
      subscription_token: state.subscription_token,
      username: state.username || username,
      tier: state.tier || '',
      expires_at: state.expires_at ?? null,
    };
    saveLocalSession(session);
    await saveAndroidEncryptedSession(session);
    return session;
  }

  const data = await fetchBackendJson<RawAuthApiResponse>('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      username,
      password,
      device_identifier: getOrCreateWebDeviceId(),
      device_name: navigator.userAgent.slice(0, 48),
      os: 'web',
    }),
  });

  const session = parseAuthSessionResponse(data, username);
  if (!session) {
    throw new Error('پاسخ ورود از سرور فاقد توکن معتبر است.');
  }
  saveLocalSession(session);
  return session;
}

export async function registerWithCredentials(
  username: string,
  password: string
): Promise<PersistedSession> {
  if (isTauriRuntime()) {
    const state = await invokeTauri<{
      auth_token?: string | null;
      subscription_token?: string | null;
      username?: string;
      tier?: string;
      expires_at?: string | null;
    }>('register_with_credentials', { username, password });

    if (!state.subscription_token) {
      throw new Error('ثبت‌نام انجام شد اما توکن نشست دریافت نشد.');
    }
    const session: PersistedSession = {
      auth_token: state.auth_token || state.subscription_token,
      subscription_token: state.subscription_token,
      username: state.username || username,
      tier: state.tier || '',
      expires_at: state.expires_at ?? null,
    };
    saveLocalSession(session);
    await saveAndroidEncryptedSession(session);
    return session;
  }

  const data = await fetchBackendJson<RawAuthApiResponse>('/api/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      username,
      password,
      device_identifier: getOrCreateWebDeviceId(),
      device_name: navigator.userAgent.slice(0, 48),
      os: 'web',
    }),
  });

  const session = parseAuthSessionResponse(data, username);
  if (!session) {
    throw new Error('پاسخ ثبت‌نام از سرور فاقد توکن معتبر است.');
  }
  saveLocalSession(session);
  return session;
}

export async function loginWithOtpCode(code: string): Promise<PersistedSession> {
  if (isTauriRuntime()) {
    const state = await invokeTauri<{
      auth_token?: string | null;
      subscription_token?: string | null;
      username?: string;
      tier?: string;
      expires_at?: string | null;
    }>('login_with_code', { code });

    if (!state.subscription_token) {
      throw new Error('ورود با کد ناموفق بود.');
    }
    const session: PersistedSession = {
      auth_token: state.auth_token || state.subscription_token,
      subscription_token: state.subscription_token,
      username: state.username || '',
      tier: state.tier || '',
      expires_at: state.expires_at ?? null,
    };
    saveLocalSession(session);
    await saveAndroidEncryptedSession(session);
    return session;
  }

  const data = await fetchBackendJson<RawAuthApiResponse>('/api/v1/auth/code-login', {
    method: 'POST',
    body: JSON.stringify({
      code,
      device_identifier: getOrCreateWebDeviceId(),
      device_name: navigator.userAgent.slice(0, 48),
      os: 'web',
    }),
  });

  const session = parseAuthSessionResponse(data);
  if (!session) {
    throw new Error('کد واردشده معتبر نیست یا منقضی شده است.');
  }
  saveLocalSession(session);
  return session;
}

export async function logoutSession(): Promise<void> {
  saveLocalSession(null);
  await saveAndroidEncryptedSession(null);
  if (isTauriRuntime()) {
    try {
      await invokeTauri('logout');
    } catch {
      // already cleared locally
    }
  }
}

export async function fetchBootstrap(token: string): Promise<BootstrapResponse> {
  let raw: BootstrapResponse;
  const webDeviceId = getOrCreateWebDeviceId();

  if (isTauriRuntime()) {
    try {
      raw = await invokeTauri<BootstrapResponse>('fetch_client_bootstrap');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith('AUTH_EXPIRED:')) {
        saveLocalSession(null);
        await saveAndroidEncryptedSession(null);
        throw new Error(msg);
      }
      // Fallback to direct HTTP if backend state wasn't hydrated yet (e.g., Android EncryptedSharedPreferences restore)
      raw = await fetchBackendJson<BootstrapResponse>(
        `/api/v1/client/bootstrap?token=${encodeURIComponent(token)}`,
        {
          headers: {
            'X-Subscription-Token': token,
            'X-Device-Id': webDeviceId,
          },
        }
      );
    }
  } else {
    raw = await fetchBackendJson<BootstrapResponse>(
      `/api/v1/client/bootstrap?token=${encodeURIComponent(token)}`,
      {
        headers: {
          'X-Subscription-Token': token,
          'X-Device-Id': webDeviceId,
        },
      }
    );
  }

  // Keep persisted local/Android session in sync with live subscription tier/expiry/username (e.g. Telegram upgrades)
  const existing = loadLocalSession();
  if (existing && existing.subscription_token === token && raw.subscription) {
    const refreshed: PersistedSession = {
      ...existing,
      username: raw.user?.username || raw.user?.first_name || existing.username,
      tier: raw.subscription.tier || existing.tier,
      expires_at: raw.subscription.expires_at ?? existing.expires_at,
    };
    if (
      refreshed.username !== existing.username ||
      refreshed.tier !== existing.tier ||
      refreshed.expires_at !== existing.expires_at
    ) {
      saveLocalSession(refreshed);
      void saveAndroidEncryptedSession(refreshed);
    }
  }

  // Strictly guarantee gaming mode stays hidden in UI
  return {
    ...raw,
    modes: (raw.modes || []).filter((m) => m.id !== 'gaming'),
    outbounds: raw.outbounds || [],
    devices: raw.devices || [],
  };
}

export async function fetchClientSyncState(token: string): Promise<SyncedClientState> {
  if (isTauriRuntime()) {
    try {
      const res = await invokeTauri<SyncedClientState>('fetch_client_state_from_server');
      return {
        personal_configs: Array.isArray(res?.personal_configs) ? res.personal_configs : [],
        preferences: res?.preferences || {},
        updated_at: res?.updated_at ?? null,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith('AUTH_EXPIRED:')) throw new Error(msg);
      // fall through to HTTP
    }
  }

  const res = await fetchBackendJson<SyncedClientState>(
    `/api/v1/client/sync-state?token=${encodeURIComponent(token)}`,
    {
      headers: {
        'X-Subscription-Token': token,
        'X-Device-Id': getOrCreateWebDeviceId(),
      },
    }
  );
  return {
    personal_configs: Array.isArray(res?.personal_configs) ? res.personal_configs : [],
    preferences: res?.preferences || {},
    updated_at: res?.updated_at ?? null,
  };
}

export async function pushClientSyncState(
  token: string,
  payload: {
    personal_configs?: PersonalConfigItem[];
    preferences?: SyncedClientPreferences;
  }
): Promise<SyncedClientState> {
  if (isTauriRuntime()) {
    try {
      const res = await invokeTauri<SyncedClientState>('sync_client_state_to_server', {
        payload,
      });
      return {
        personal_configs: Array.isArray(res?.personal_configs) ? res.personal_configs : [],
        preferences: res?.preferences || {},
        updated_at: res?.updated_at ?? null,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith('AUTH_EXPIRED:')) throw new Error(msg);
      // fall through to HTTP
    }
  }

  const res = await fetchBackendJson<SyncedClientState>(
    `/api/v1/client/sync-state?token=${encodeURIComponent(token)}`,
    {
      method: 'PUT',
      headers: {
        'X-Subscription-Token': token,
        'X-Device-Id': getOrCreateWebDeviceId(),
      },
      body: JSON.stringify(payload),
    }
  );
  return {
    personal_configs: Array.isArray(res?.personal_configs) ? res.personal_configs : [],
    preferences: res?.preferences || {},
    updated_at: res?.updated_at ?? null,
  };
}

export async function sendUsageHeartbeat(
  token: string,
  payload: {
    mode?: ConnectionModeId;
    delta_upload_bytes: number;
    delta_download_bytes: number;
  }
): Promise<HeartbeatVerdictResponse> {
  if (isTauriRuntime()) {
    try {
      return await invokeTauri<HeartbeatVerdictResponse>('report_usage_heartbeat', {
        mode: payload.mode ?? null,
        deltaUploadBytes: Math.max(0, Math.round(payload.delta_upload_bytes)),
        deltaDownloadBytes: Math.max(0, Math.round(payload.delta_download_bytes)),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith('AUTH_EXPIRED:')) throw new Error(msg);
      // fall through to HTTP
    }
  }

  const deviceId = getOrCreateWebDeviceId();
  return fetchBackendJson<HeartbeatVerdictResponse>(
    `/api/v1/client/heartbeat?token=${encodeURIComponent(token)}`,
    {
      method: 'POST',
      headers: {
        'X-Subscription-Token': token,
        'X-Device-Id': deviceId,
      },
      body: JSON.stringify({
        device_id: deviceId,
        mode: payload.mode || 'web_browsing',
        delta_upload_bytes: Math.max(0, Math.round(payload.delta_upload_bytes)),
        delta_download_bytes: Math.max(0, Math.round(payload.delta_download_bytes)),
      }),
    }
  );
}

export async function donateOutboundToServer(
  token: string,
  payload: { uri: string; name?: string; note?: string }
): Promise<{ success: boolean; id?: number; latency_ms?: number; message?: string }> {
  if (isTauriRuntime()) {
    try {
      return await invokeTauri<{ success: boolean; id?: number; latency_ms?: number; message?: string }>(
        'donate_user_outbound',
        {
          uri: payload.uri,
          name: payload.name || null,
          note: payload.note || null,
        }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('ابتدا وارد')) {
        throw err;
      }
    }
  }

  return fetchBackendJson<{ success: boolean; id?: number; latency_ms?: number; message?: string }>(
    `/api/v1/client/outbounds/donate?token=${encodeURIComponent(token)}`,
    {
      method: 'POST',
      headers: { 'X-Subscription-Token': token },
      body: JSON.stringify({
        uri: payload.uri,
        name: payload.name || undefined,
        note: payload.note || undefined,
      }),
      timeoutMs: 15000,
    }
  );
}

export async function fetchMyDonations(token: string): Promise<DonatedOutboundRecord[]> {
  let res: { donations?: DonatedOutboundRecord[] };
  if (isTauriRuntime()) {
    try {
      res = await invokeTauri<{ donations?: DonatedOutboundRecord[] }>('get_my_donated_outbounds');
      return res.donations || [];
    } catch {
      // fall through to HTTP
    }
  }

  res = await fetchBackendJson<{ donations?: DonatedOutboundRecord[] }>(
    `/api/v1/client/outbounds/my-donations?token=${encodeURIComponent(token)}`,
    {
      headers: { 'X-Subscription-Token': token },
    }
  );
  return res.donations || [];
}

export async function pingServerNode(host: string, port: number): Promise<number | null> {
  if (!host) return null;
  if (isTauriRuntime()) {
    try {
      const ms = await invokeTauri<number>('ping_server_node', { host, port });
      return ms > 0 ? ms : null;
    } catch {
      return null;
    }
  }

  // Real HTTP timing probe fallback in browser preview (never synthetic random numbers)
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  const start = performance.now();
  try {
    await fetch(`https://${host}:${port}`, {
      mode: 'no-cors',
      cache: 'no-store',
      signal: controller.signal,
    });
    clearTimeout(timer);
    return Math.max(1, Math.round(performance.now() - start));
  } catch {
    clearTimeout(timer);
    return null;
  }
}

export async function setActiveOutboundNative(
  outboundId: string | null,
  personalUri: string | null
): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    await invokeTauri('set_selected_outbound', {
      outboundId,
      personalUri,
    });
  } catch {
    // ignore outside desktop
  }
}

export async function setConnectionModeNative(mode: ConnectionModeId): Promise<void> {
  if (!isTauriRuntime()) return;
  await invokeTauri('set_connection_mode', { mode });
}

export async function setRoutingModeNative(routingMode: RoutingMode): Promise<void> {
  if (!isTauriRuntime()) return;
  await invokeTauri('set_routing_mode', { routingMode });
}

export async function setSplitTunnelingNative(enabled: boolean): Promise<void> {
  if (!isTauriRuntime()) return;
  await invokeTauri('toggle_split_tunneling', { enabled });
}

export async function setKillSwitchNative(enabled: boolean): Promise<void> {
  if (!isTauriRuntime()) return;
  await invokeTauri('toggle_kill_switch', { enabled });
}

export async function setAutoReconnectNative(enabled: boolean): Promise<void> {
  if (!isTauriRuntime()) return;
  await invokeTauri('set_auto_reconnect', { enabled });
}

export async function setUseWarpNative(enabled: boolean): Promise<void> {
  if (!isTauriRuntime()) return;
  await invokeTauri('set_use_warp', { enabled });
}

export async function connectVpnNative(): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error(
      'Native VPN tunnel is only available in the installed Windows or Android Sentra app.'
    );
  }
  await invokeTauri('connect_vpn');
}

export async function reconnectVpnNative(reason: 'network_switch' | 'device_wake'): Promise<void> {
  if (!isTauriRuntime()) return;
  await invokeTauri('reconnect_vpn', { reason });
}

export async function getBatteryOptimizationStatusNative(): Promise<BatteryOptimizationStatus> {
  if (!isTauriRuntime()) {
    return { isAndroid: false, isOptimized: false, canOpenSettings: false };
  }
  try {
    const res = await invokeTauri<Partial<BatteryOptimizationStatus>>(
      'get_battery_optimization_status'
    );
    return {
      isAndroid: Boolean(res?.isAndroid),
      isOptimized: Boolean(res?.isOptimized),
      canOpenSettings: Boolean(res?.canOpenSettings),
    };
  } catch {
    return { isAndroid: false, isOptimized: false, canOpenSettings: false };
  }
}

export async function openBatteryOptimizationSettingsNative(): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  return invokeTauri<boolean>('open_battery_optimization_settings');
}

export async function disconnectVpnNative(): Promise<void> {
  if (!isTauriRuntime()) return;
  await invokeTauri('disconnect_vpn');
}

export interface GithubReleaseUpdate {
  version: string;
  url: string;
  name?: string;
}

const GITHUB_RELEASES_API =
  'https://api.github.com/repos/parsa904/SentraVpn/releases/latest';

export async function checkGithubLatestRelease(
  currentVersion: string
): Promise<GithubReleaseUpdate | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const resp = await fetch(GITHUB_RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      tag_name?: string;
      html_url?: string;
      name?: string;
    };
    const tag = (data.tag_name || '').trim();
    const url = (data.html_url || '').trim();
    if (!tag || !url || !isSafeReleaseUrl(url)) return null;
    if (!isNewerVersion(currentVersion, tag)) return null;
    return {
      version: tag,
      url,
      name: data.name?.trim() || undefined,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function removeUserDevice(token: string, deviceId: string): Promise<void> {
  if (isTauriRuntime()) {
    await invokeTauri('remove_user_device', { deviceId });
    return;
  }
  await fetchBackendJson(
    `/api/v1/client/devices/remove?token=${encodeURIComponent(token)}`,
    {
      method: 'POST',
      headers: { 'X-Subscription-Token': token },
      body: JSON.stringify({ device_id: deviceId }),
    }
  );
}

export async function requestTelegramLinkCode(token: string): Promise<string> {
  if (isTauriRuntime()) {
    return invokeTauri<string>('get_telegram_link_code');
  }
  const data = await fetchBackendJson<{ code?: string; link_code?: string }>(
    `/api/v1/auth/link-token?token=${encodeURIComponent(token)}`,
    {
      method: 'POST',
      headers: { 'X-Subscription-Token': token },
    }
  );
  const code = data.code || data.link_code;
  if (!code) throw new Error('کد اتصال تلگرام از سرور دریافت نشد.');
  return code;
}

export async function loadPersonalConfigs(): Promise<PersonalConfigItem[]> {
  if (isTauriRuntime()) {
    try {
      const json = await invokeTauri<string>('load_personal_configs');
      const parsed = JSON.parse(json) as PersonalConfigItem[];
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // fallback to localStorage
    }
  }
  try {
    const raw = localStorage.getItem(PERSONAL_CONFIGS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PersonalConfigItem[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function savePersonalConfigs(items: PersonalConfigItem[]): Promise<void> {
  const serialized = JSON.stringify(items);
  try {
    localStorage.setItem(PERSONAL_CONFIGS_KEY, serialized);
  } catch {
    // ignore storage errors
  }
  if (isTauriRuntime()) {
    try {
      await invokeTauri('save_personal_configs', { configsJson: serialized });
    } catch {
      // ignore if unavailable
    }
  }
}

export async function subscribeNativeTelemetry(
  onTelemetry: (snap: TelemetrySnapshot) => void,
  onLog: (line: string) => void,
  onStatus?: (status: 'connected' | 'connecting' | 'disconnected' | 'error', error?: string) => void,
  onSubscriptionSynced?: () => void
): Promise<() => void> {
  if (!isTauriRuntime()) return () => {};
  const listen = getTauriBridge().__TAURI__?.event?.listen;
  if (!listen) return () => {};
  try {
    type RawTelemetryPayload = {
      download_speed_bps?: number;
      upload_speed_bps?: number;
      total_download_bytes?: number;
      total_upload_bytes?: number;
      ping_ms?: number | null;
      uptime_seconds?: number;
    };
    type RawLogPayload =
      | string
      | { timestamp?: string; level?: string; message?: string };
    type RawStatusPayload = {
      status?: string;
      error?: string | null;
    };

    const handleTelemetry = (ev: { payload: RawTelemetryPayload }) => {
      const p = ev.payload || {};
      onTelemetry({
        download_speed_bps: p.download_speed_bps || 0,
        upload_speed_bps: p.upload_speed_bps || 0,
        total_download_bytes: p.total_download_bytes || 0,
        total_upload_bytes: p.total_upload_bytes || 0,
        ping_ms: p.ping_ms && p.ping_ms > 0 ? p.ping_ms : null,
        uptime_seconds: p.uptime_seconds || 0,
      });
    };

    const handleLog = (ev: { payload: RawLogPayload }) => {
      if (typeof ev.payload === 'string') {
        onLog(ev.payload);
      } else if (ev.payload && typeof ev.payload.message === 'string') {
        const prefix = ev.payload.level ? `[${ev.payload.level}] ` : '';
        onLog(`${prefix}${ev.payload.message}`);
      }
    };

    const handleStatus = (ev: { payload: RawStatusPayload }) => {
      if (!onStatus) return;
      const raw = (ev.payload?.status || '').toLowerCase();
      if (raw === 'connected') onStatus('connected');
      else if (raw === 'connecting') onStatus('connecting');
      else if (raw === 'error') onStatus('error', ev.payload?.error || undefined);
      else if (raw === 'disconnected') onStatus('disconnected', ev.payload?.error || undefined);
    };

    const handleSubscriptionSynced = () => {
      if (onSubscriptionSynced) {
        onSubscriptionSynced();
      }
    };

    const unlisten1 = await listen<RawTelemetryPayload>('vpn-telemetry', handleTelemetry);
    const unlisten2 = await listen<RawTelemetryPayload>('telemetry-speed', handleTelemetry);
    const unlisten3 = await listen<RawLogPayload>('vpn-log', handleLog);
    const unlisten4 = await listen<RawLogPayload>('telemetry-log', handleLog);
    const unlisten5 = await listen<RawStatusPayload>('connection-status-changed', handleStatus);
    const unlisten6 = await listen<unknown>('subscription-synced', handleSubscriptionSynced);

    return () => {
      unlisten1();
      unlisten2();
      unlisten3();
      unlisten4();
      unlisten5();
      unlisten6();
    };
  } catch {
    return () => {};
  }
}
