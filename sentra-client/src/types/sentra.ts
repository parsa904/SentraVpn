export type NavTab = 'home' | 'profiles' | 'donate' | 'settings' | 'logs';
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type RoutingMode = 'tunnel' | 'system_proxy' | 'proxy';
export type ConnectionModeId = 'web_browsing' | 'download' | 'gaming' | 'static_ip';
export type ThemeMode = 'dark' | 'light';

export interface PersistedSession {
  auth_token: string;
  subscription_token: string;
  connect_code?: string | null;
  plan_tier?: 'free' | 'pro' | 'flow_plus' | string;
  username: string;
  tier: string;
  expires_at: string | null;
}

export interface BootstrapUser {
  id: number;
  user_uuid?: string;
  username?: string | null;
  first_name?: string | null;
  telegram_id?: number | null;
  role: string;
  status: string;
}

export interface BootstrapSubscription {
  tier: string;
  plan_tier?: 'free' | 'pro' | 'flow_plus' | string;
  connect_code?: string | null;
  token: string;
  status: string;
  upload_bytes: number;
  download_bytes: number;
  used_bytes: number;
  traffic_limit_bytes: number;
  remaining_bytes: number;
  web_used_bytes?: number;
  download_used_bytes?: number;
  special_quota_bytes?: number;
  special_used_bytes?: number;
  has_used_special_trial?: boolean;
  web_browsing_used_mb: number;
  download_used_mb: number;
  static_ip_used_mb: number;
  active_devices_count: number;
  max_concurrent_devices: number;
  remaining_days: number;
  expires_at: string;
}

export interface UserDeviceItem {
  id: number;
  device_id: string;
  device_name: string;
  platform: string;
  last_active_at: string;
  created_at: string;
}

export interface ConnectionModeItem {
  id: string;
  name: string;
  icon?: string;
  status: 'active' | 'locked' | 'depleted' | string;
  badge?: string | null;
  daily_limit_mb: number;
  used_today_mb: number;
  remaining_today_mb: number;
  speed_desc?: string;
  security_desc?: string;
  description: string;
}

export interface LiveOutboundNode {
  id: string;
  db_id: number;
  name: string;
  tag: string;
  protocol: string;
  category: string;
  country_code: string;
  country_name: string;
  flag: string;
  latency_ms: number;
  health_score: number;
  is_official: boolean;
  is_online: boolean;
  server_address: string;
  server_port: number;
  uri?: string | null;
}

export interface SyncedClientPreferences {
  selected_mode?: ConnectionModeId;
  routing_mode?: RoutingMode;
  split_tunneling?: boolean;
  kill_switch?: boolean;
  auto_reconnect?: boolean;
  ping_optimization_enabled?: boolean;
  use_warp?: boolean;
  custom_dns?: string;
  selected_outbound_id?: string | null;
  auto_mode?: boolean;
  lang?: 'fa' | 'en';
  theme?: ThemeMode;
}

export interface SyncedClientState {
  personal_configs: PersonalConfigItem[];
  preferences: SyncedClientPreferences;
  updated_at: string | null;
}

export interface HeartbeatVerdictResponse {
  action: 'continue' | 'disconnect' | string;
  code?: string;
  message?: string;
  remaining_bytes?: number;
  used_bytes?: number;
  tier?: string;
  web_browsing_used_mb?: number;
  download_used_mb?: number;
  static_ip_used_mb?: number;
}

export interface BootstrapResponse {
  success: boolean;
  server_time: string;
  bot_username: string;
  user: BootstrapUser;
  subscription: BootstrapSubscription;
  devices: UserDeviceItem[];
  modes: ConnectionModeItem[];
  outbounds: LiveOutboundNode[];
  client_state?: SyncedClientState;
}

export interface PersonalConfigItem {
  id: string;
  name: string;
  uri: string;
  protocol: string;
  server_address: string;
  server_port: number;
  country_code: string;
  flag: string;
  is_subscription: boolean;
  latency_ms: number | null;
  added_at: string;
}

export interface DonatedOutboundRecord {
  id: number;
  name: string;
  protocol: string;
  server_address: string;
  server_port: number;
  country_code: string;
  flag: string;
  latency_ms: number;
  status: 'pending' | 'approved' | 'rejected' | 'inactive' | string;
  reward_days: number;
  user_note?: string | null;
  rejection_reason?: string | null;
  created_at: string;
  approved_at?: string | null;
}

export interface ActiveServerSelection {
  kind: 'server' | 'personal';
  id: string;
  name: string;
  protocol: string;
  country_code: string;
  country_name: string;
  flag: string;
  server_address: string;
  server_port: number;
  latency_ms: number | null;
  uri?: string | null;
}

export interface TelemetrySnapshot {
  download_speed_bps: number;
  upload_speed_bps: number;
  total_download_bytes: number;
  total_upload_bytes: number;
  ping_ms: number | null;
  uptime_seconds: number;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  level: 'INFO' | 'WARN' | 'ERROR' | 'SYNC';
  message: string;
}
