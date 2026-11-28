export interface Env {
  DB: D1Database;
  SENTRA_KV?: KVNamespace;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  ADMIN_TELEGRAM_ID?: string;
  ADMIN_CHAT_ID?: string;
  ADMIN_TELEGRAM_IDS?: string;
  BOT_USERNAME?: string;
  PUBLIC_BASE_URL?: string;
  QUALITY_ENGINE_SECRET?: string;
  PRO_SUBSCRIPTION_PRICE?: string;
  ALLOWED_ORIGINS?: string;
  WIREGUARD_SERVER_PUBLIC_KEY?: string;
  WIREGUARD_PORT?: string;
  WIREGUARD_KEY_SALT?: string;
  SENTRY_DSN_WORKER?: string;
  SENTRY_WEBHOOK_SECRET?: string;
  RELEASES_CHANNEL_ID?: string;
  MINIAPP_URL?: string;
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
}

export type ConnectionMode = 'web_browsing' | 'download' | 'gaming' | 'static_ip';
export type PlanTier = 'free' | 'pro' | 'flow_plus';

export interface UserRow {
  id: number;
  user_uuid: string;
  telegram_id: number | null;
  username: string | null;
  email: string | null;
  password_hash: string | null;
  first_name: string;
  last_name: string | null;
  role: 'user' | 'admin' | 'reseller';
  status: 'active' | 'suspended' | 'banned';
  auth_code: string | null;
  auth_code_expires_at: string | null;
  link_code: string | null;
  link_code_expires_at: string | null;
  outbound_reward_banned: number;
  created_at: string;
  updated_at: string;
}

export interface SubscriptionRow {
  id: number;
  user_id: number;
  tier: string;
  plan_tier?: PlanTier | null;
  connect_code?: string | null;
  token: string;
  status: 'active' | 'expired' | 'depleted' | 'disabled';
  upload_bytes: number;
  download_bytes: number;
  traffic_limit_bytes: number;
  speed_limit_bps: number;
  max_concurrent_devices: number;
  web_browsing_used_mb: number;
  download_used_mb: number;
  static_ip_used_mb: number;
  web_used_bytes?: number;
  download_used_bytes?: number;
  special_quota_bytes?: number;
  special_used_bytes?: number;
  has_used_special_trial?: number;
  account_rev?: number;
  last_quota_reset: string;
  starts_at: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface OutboundRow {
  id: number;
  tag: string;
  protocol: string;
  mode_category: string;
  server_address: string;
  server_port: number;
  uuid: string | null;
  password: string | null;
  network_transport: string;
  tls_enabled: number;
  tls_sni: string | null;
  reality_public_key: string | null;
  reality_short_id: string | null;
  min_tier: string;
  country_code: string;
  is_active: number;
  weight: number;
}

export interface DonatedOutboundRow {
  id: number;
  donor_user_id: number | null;
  tag: string;
  protocol: string;
  server_address: string;
  server_port: number;
  config_json: string;
  compiled_outbound_json?: string | null;
  validation_error?: string | null;
  latency_ms: number;
  speed_mbps: number;
  assigned_tier: string;
  health_score: number;
  status: 'pending' | 'active' | 'inactive' | 'rejected' | 'quarantined';
  fail_count: number;
  raw_link: string | null;
  rejection_reason: string | null;
  fingerprint_sha256: string | null;
  offline_since: string | null;
  is_official: number;
  label: string | null;
  country_code: string;
  country_name: string;
  allow_web: number;
  allow_download: number;
  allow_gaming: number;
  allow_static_ip: number;
  gemini_ok: number;
  trading_safe: number;
  speed_score: number;
  jitter_ms: number;
  last_online_at: string | null;
  allocation_mode: string;
  last_checked_at: string;
  reward_granted?: number;
  created_at?: string;
  updated_at?: string;
}

export interface HealthReportNodeResult {
  outbound_id: number;
  latency_ms: number;
  jitter_ms: number;
  speed_mbps: number;
  speed_score: number;
  health_score: number;
  gemini_ok: boolean;
  trading_safe: boolean;
  is_healthy: boolean;
  security_passed: boolean;
  quarantined?: boolean;
  validation_error?: string | null;
  compiled_outbound_json?: string | null;
  error_msg?: string | null;
}

export interface SubscriptionSourceRow {
  id: number;
  category: string;
  sub_url: string;
  tag: string | null;
  submitted_by_user_id?: number | null;
  status?: 'pending' | 'active' | 'rejected';
  total_nodes: number;
  healthy_nodes: number;
  last_sync_at: string | null;
  created_at?: string | null;
}

export interface AppReleaseFileRow {
  platform: 'android' | 'windows';
  version: string;
  github_url: string;
  telegram_file_id: string | null;
  updated_at: string | null;
}

export interface DiscoveredSubNodeReport {
  tag: string;
  protocol: string;
  server_address: string;
  server_port: number;
  config_json: string;
  compiled_outbound_json?: string | null;
  raw_link: string;
  fingerprint_sha256: string;
  country_code: string;
  country_name: string;
  latency_ms: number;
  jitter_ms: number;
  speed_mbps: number;
  speed_score: number;
  health_score: number;
  gemini_ok: boolean;
  trading_safe: boolean;
}

export interface SubscriptionSourceHealthReport {
  source_id: number;
  category: string;
  total_nodes: number;
  healthy_nodes: number;
  quarantined_nodes?: number;
  error_msg?: string | null;
  discovered_nodes?: DiscoveredSubNodeReport[];
}

export interface BundleCheckSummary {
  plan_tier: PlanTier;
  passed: boolean;
  node_count: number;
  error?: string | null;
}

export interface HealthReportPayload {
  checked_at?: string;
  runner?: string;
  results: HealthReportNodeResult[];
  subscription_reports?: SubscriptionSourceHealthReport[];
  bundle_checks?: BundleCheckSummary[];
}
