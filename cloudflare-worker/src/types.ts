export interface Env {
  DB: D1Database;
  TELOXIDE_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  ADMIN_CHAT_ID?: string;
  BOT_USERNAME?: string;
  PUBLIC_BASE_URL?: string;
  BRIDGE_SECRET_KEY?: string;
  QUALITY_ENGINE_SECRET?: string;
  PRO_SUBSCRIPTION_PRICE?: string;
  ALLOWED_ORIGINS?: string;
  WIREGUARD_SERVER_PUBLIC_KEY?: string;
  WIREGUARD_PORT?: string;
  WIREGUARD_KEY_SALT?: string;
}

export type ConnectionMode = 'web_browsing' | 'download' | 'gaming' | 'static_ip';

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
  latency_ms: number;
  speed_mbps: number;
  assigned_tier: string;
  health_score: number;
  status: 'pending' | 'active' | 'inactive' | 'rejected';
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
}

export interface WarpAccountRow {
  id: number;
  account_id: string;
  private_key: string;
  public_key: string;
  ipv4_address: string;
  ipv6_address: string;
  reserved: string;
  license_key: string | null;
  is_active: number;
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
  error_msg?: string | null;
}

export interface HealthReportPayload {
  checked_at?: string;
  runner?: string;
  results: HealthReportNodeResult[];
}
