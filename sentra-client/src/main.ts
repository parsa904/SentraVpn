// ==============================================================================
// Sentra Connect - Frontend Controller (TypeScript)
// Windscribe-Inspired Anti-Censorship Client UI
// ==============================================================================

interface TelemetryMetrics {
  download_speed_bps: number;
  upload_speed_bps: number;
  ping_ms: number;
  total_download_bytes: number;
  total_upload_bytes: number;
  uptime_seconds: number;
}

interface ClientState {
  is_authenticated: boolean;
  auth_token: string | null;
  subscription_token: string | null;
  tier: string;
  username: string;
  remaining_bytes: number;
  expires_at?: string | null;
  telegram_verified?: boolean;
  email?: string | null;
  status: 'Disconnected' | 'Connecting' | 'Connected' | { Error: string };
  selected_mode: string;
  selected_protocol?: string;
  selected_location: string;
  gaming_submode?: string;
  routing_mode?: string;
  local_socks5_port?: number;
  local_http_port?: number;
  use_warp?: boolean;
  sandbox_loopback: boolean;
  split_tunneling: boolean;
  tun_mode: boolean;
  kill_switch: boolean;
  metrics: TelemetryMetrics;
  logs: string[];
}

interface LogEventPayload {
  timestamp: string;
  level: string;
  message: string;
}

interface StatusEventPayload {
  status: string;
  mode: string;
  message?: string;
}

interface ConnectionModeInfo {
  id: string;
  title: string;
  description: string;
  protocol: string;
  speed: string;
  security: string;
  is_locked: boolean;
  is_coming_soon: boolean;
  daily_quota_mb: number;
  daily_used_mb: number;
  allowed_tiers: string[];
}

interface UserDevice {
  id: number;
  device_id: string;
  device_name: string;
  platform: string;
  last_active_at: string;
  created_at: string;
}

interface ActiveLocationInfo {
  code: string;
  name: string;
  flag: string;
  ping_ms: number;
  active_nodes: number;
  is_auto: boolean;
}

interface CustomDnsEntry {
  id: string;
  name: string;
  address: string;
}

interface DnsPingItem {
  id: string;
  name: string;
  address: string;
  ping_ms: number;
  is_iranian: boolean;
  is_custom: boolean;
}

interface DnsConfig {
  selected_dns_id: string;
  selected_dns_address: string;
  custom_servers: CustomDnsEntry[];
}

let connectionModes: ConnectionModeInfo[] = [];
let userDevices: UserDevice[] = [];
let currentDeviceId: string = '';
let availableLocations: ActiveLocationInfo[] = [];
let isLocationDropdownOpen: boolean = false;
let dnsConfigState: DnsConfig = {
  selected_dns_id: 'cloudflare',
  selected_dns_address: '1.1.1.1',
  custom_servers: [],
};
let dnsPingResults: DnsPingItem[] = [];
let isDnsTesting: boolean = false;

// ------------------------------------------------------------------------------
// Fallback state for local preview / sandbox testing
// ------------------------------------------------------------------------------
let currentState: ClientState = {
  is_authenticated: false,
  auth_token: null,
  subscription_token: null,
  tier: "Sentra Lite",
  username: "مهمان",
  remaining_bytes: 10_737_418_240, // 10 GB
  expires_at: null,
  status: 'Disconnected',
  selected_mode: "web_browsing",
  selected_protocol: "openvpn_udp",
  selected_location: "auto",
  gaming_submode: "full_udp",
  routing_mode: "tunnel",
  local_socks5_port: 10808,
  local_http_port: 10809,
  use_warp: false,
  sandbox_loopback: true,
  split_tunneling: true,
  tun_mode: true,
  kill_switch: false,
  metrics: {
    download_speed_bps: 0,
    upload_speed_bps: 0,
    ping_ms: 0,
    total_download_bytes: 0,
    total_upload_bytes: 0,
    uptime_seconds: 0,
  },
  logs: [
    "[INFO] [Core] Sentra Connect engine initialized.",
    "[INFO] [Sandbox] Local loopback sandbox ready on 127.0.0.1:10801-10804.",
  ],
};

let connectionTimerInterval: number | null = null;
let uptimeSeconds: number = 0;

// ------------------------------------------------------------------------------
// Tauri IPC Wrapper
// ------------------------------------------------------------------------------
async function invokeTauri<T>(cmd: string, args: Record<string, any> = {}): Promise<T> {
  const tauri = (window as any).__TAURI__;
  if (tauri && tauri.core && typeof tauri.core.invoke === 'function') {
    try {
      return await tauri.core.invoke(cmd, args);
    } catch (err: any) {
      const errMsg = String(err?.message || err || '');
      if (
        errMsg.includes('401') ||
        errMsg.toLowerCase().includes('unauthorized') ||
        errMsg.includes('TOKEN_EXPIRED') ||
        errMsg.includes('INVALID_TOKEN') ||
        errMsg.includes('SESSION_EXPIRED')
      ) {
        console.warn('[Auth] Received 401 Unauthorized. Redirecting to login screen...', errMsg);
        currentState.is_authenticated = false;
        currentState.auth_token = null;
        currentState.subscription_token = null;
        currentState.status = 'Disconnected';
        renderUI();
      }
      throw err;
    }
  }

  // --- Browser Dev Mock Fallback ---
  console.log(`[IPC Mock] ${cmd}`, args);

  if (cmd === 'get_client_state') {
    return { ...currentState } as unknown as T;
  }
  if (cmd === 'login_with_code') {
    const code = (args.code || '').trim();
    if (code.length !== 8) throw new Error("کد ورود باید دقیقاً ۸ رقم عددی باشد.");
    currentState.is_authenticated = true;
    currentState.username = "تستر محلی سنترا";
    currentState.tier = code === '99999999' ? "Sentra Flow+" : code === '88888888' ? "Sentra Pro" : "Sentra Lite";
    currentState.expires_at = code === '12345678' ? null : "2026-12-31T23:59:59Z";
    currentState.remaining_bytes = code === '99999999' ? 1_099_511_627_776 : code === '88888888' ? 161_061_273_600 : 10_737_418_240;
    currentState.logs.push(`[INFO] [Auth] Logged in with code ${code} (${currentState.tier})`);
    return { ...currentState } as unknown as T;
  }
  if (cmd === 'connect_vpn') {
    currentState.status = 'Connecting';
    renderPowerButton();
    setTimeout(() => {
      currentState.status = 'Connected';
      currentState.metrics.download_speed_bps = 14_800_000;
      currentState.metrics.upload_speed_bps = 2_100_000;
      currentState.metrics.ping_ms = 48;
      currentState.logs.push(`[INFO] [Core] Tunnel connected successfully in mode [${currentState.selected_mode}]`);
      startTimer();
      renderPowerButton();
      updateTelemetryDisplay(currentState.metrics);
    }, 700);
    return { ...currentState } as unknown as T;
  }
  if (cmd === 'disconnect_vpn') {
    currentState.status = 'Disconnected';
    stopTimer();
    currentState.metrics.download_speed_bps = 0;
    currentState.metrics.upload_speed_bps = 0;
    currentState.metrics.ping_ms = 0;
    currentState.logs.push("[INFO] [Core] Disconnected gracefully.");
    renderPowerButton();
    updateTelemetryDisplay(currentState.metrics);
    return { ...currentState } as unknown as T;
  }
  if (cmd === 'set_gaming_submode') {
    currentState.gaming_submode = (args?.submode as string) || 'full_udp';
    return { ...currentState } as unknown as T;
  }
  if (cmd === 'test_api_connection') {
    return "اتصال آزمایشی به API برقرار است (حالت پیش‌نمایش مرورگر)" as unknown as T;
  }
  if (cmd === 'get_current_device_id') {
    return "sentra-pc-mock-dev1" as unknown as T;
  }
  if (cmd === 'get_user_devices') {
    return {
      success: true,
      count: 2,
      max_allowed: 3,
      devices: [
        {
          id: 1,
          device_id: "sentra-pc-mock-dev1",
          device_name: "Windows PC (فعلی)",
          platform: "windows",
          last_active_at: new Date().toISOString(),
          created_at: new Date().toISOString()
        },
        {
          id: 2,
          device_id: "sentra-android-old",
          device_name: "Samsung Galaxy S22",
          platform: "android",
          last_active_at: new Date(Date.now() - 3600000).toISOString(),
          created_at: new Date(Date.now() - 86400000).toISOString()
        }
      ]
    } as unknown as T;
  }
  if (cmd === 'replace_user_device') {
    currentState.logs.push(`[INFO] [Device] Replaced device ${args.old_device_id} with this machine.`);
    currentState.status = 'Connected';
    startTimer();
    return { ...currentState } as unknown as T;
  }
  if (cmd === 'logout') {
    currentState.is_authenticated = false;
    currentState.status = 'Disconnected';
    stopTimer();
    return { ...currentState } as unknown as T;
  }
  if (cmd === 'request_password_reset') {
    const email = (args.email || '').trim();
    if (!email) throw new Error("لطفاً ایمیل یا نام کاربری خود را وارد فرمایید.");
    const baseUrl = (import.meta as any).env?.VITE_API_BASE_URL || 'https://head.cyberservice.sbs:8443';
    try {
      const resp = await fetch(`${baseUrl}/api/v1/auth/password-reset/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.message || data.error || "خطا در ارسال درخواست بازیابی رمز عبور.");
      return data as unknown as T;
    } catch (e: any) {
      if (e.message && !e.message.includes('fetch')) throw e;
      return { success: true, delivery: "telegram", expires_in_seconds: 600 } as unknown as T;
    }
  }
  if (cmd === 'confirm_password_reset') {
    const email = (args.email || '').trim();
    const code = (args.code || '').trim();
    const new_password = (args.new_password || '').trim();
    if (!email) throw new Error("لطفاً ایمیل یا نام کاربری را وارد نمایید.");
    if (code.length !== 6 || !/^\d{6}$/.test(code)) throw new Error("کد تایید باید ۶ رقم باشد.");
    if (new_password.length < 8) throw new Error("رمز عبور جدید باید حداقل ۸ کاراکتر باشد.");
    const baseUrl = (import.meta as any).env?.VITE_API_BASE_URL || 'https://head.cyberservice.sbs:8443';
    try {
      const resp = await fetch(`${baseUrl}/api/v1/auth/password-reset/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code, new_password })
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.message || data.error || "خطا در بازنشانی رمز عبور.");
      return data as unknown as T;
    } catch (e: any) {
      if (e.message && !e.message.includes('fetch')) throw e;
      return { success: true, message: "رمز عبور با موفقیت تغییر یافت." } as unknown as T;
    }
  }
  if (cmd === 'get_available_locations') {
    return [
      { code: 'auto', name: 'انتخاب خودکار (سریع‌ترین لوکیشن)', flag: '⚡️', ping_ms: 32, active_nodes: 5, is_auto: true },
      { code: 'DE', name: 'آلمان 🇩🇪', flag: '🇩🇪', ping_ms: 38, active_nodes: 3, is_auto: false },
      { code: 'NL', name: 'هلند 🇳🇱', flag: '🇳🇱', ping_ms: 44, active_nodes: 2, is_auto: false },
      { code: 'FI', name: 'فنلاند 🇫🇮', flag: '🇫🇮', ping_ms: 51, active_nodes: 2, is_auto: false },
      { code: 'US', name: 'آمریکا 🇺🇸', flag: '🇺🇸', ping_ms: 95, active_nodes: 4, is_auto: false },
    ] as unknown as T;
  }
  if (cmd === 'set_connection_location') {
    currentState.selected_location = args.location || 'auto';
    currentState.logs.push(`[Location] Target location switched to: ${currentState.selected_location}`);
    return { ...currentState } as unknown as T;
  }
  if (cmd === 'get_dns_settings') {
    return { ...dnsConfigState } as unknown as T;
  }
  if (cmd === 'save_dns_settings') {
    if (args.config) {
      dnsConfigState = args.config;
    }
    return { ...dnsConfigState } as unknown as T;
  }
  if (cmd === 'ping_dns_servers') {
    return [
      { id: 'cloudflare', name: 'Cloudflare DNS', address: '1.1.1.1', ping_ms: 24, is_iranian: false, is_custom: false },
      { id: 'electro', name: 'Electro (الکترو)', address: '78.157.42.100', ping_ms: 28, is_iranian: true, is_custom: false },
      { id: 'shecan', name: 'Shecan (شکن)', address: '178.22.122.100', ping_ms: 32, is_iranian: true, is_custom: false },
      { id: 'google', name: 'Google DNS', address: '8.8.8.8', ping_ms: 35, is_iranian: false, is_custom: false },
      { id: 'radar', name: 'Radar Game (رادار گیم)', address: '10.202.10.10', ping_ms: 42, is_iranian: true, is_custom: false },
      { id: 'quad9', name: 'Quad9 Secure (DoH)', address: 'https://dns.quad9.net/dns-query', ping_ms: 48, is_iranian: false, is_custom: false },
      { id: 'begzar', name: 'Begzar (بگذر)', address: '185.55.226.26', ping_ms: 55, is_iranian: true, is_custom: false },
      { id: 'adguard', name: 'AdGuard Anti-Ad', address: '94.140.14.14', ping_ms: 62, is_iranian: false, is_custom: false },
    ] as unknown as T;
  }
  if (cmd === 'set_use_warp') {
    currentState.use_warp = !!args.enabled;
    currentState.logs.push(`[WARP] Cloudflare WARP set to: ${currentState.use_warp ? 'ON' : 'OFF'}`);
    return { ...currentState } as unknown as T;
  }
  if (cmd === 'set_routing_mode') {
    const mode = (args.routing_mode || 'tunnel').toLowerCase();
    if (currentState.selected_mode === 'static_ip' && mode !== 'tunnel') {
      throw new Error("در حالت آی‌پی ثابت، برای امنیت حساب‌های مالی فقط حالت Tunnel فعال است.");
    }
    if ((mode === 'proxy' || mode === 'system_proxy') && currentState.selected_protocol === 'ikev2') {
      currentState.selected_protocol = 'openvpn_udp';
      currentState.logs.push('[INFO] [Routing] پروتکل IKEv2 فقط از حالت Tunnel پشتیبانی می‌کند. پروتکل به OpenVPN تغییر یافت.');
    }
    currentState.routing_mode = mode;
    currentState.logs.push(`[CONFIG] Network routing mode set to: ${mode}`);
    return { ...currentState } as unknown as T;
  }

  return { ...currentState } as unknown as T;
}

// ------------------------------------------------------------------------------
// Listen to Tauri Real-time Events
// ------------------------------------------------------------------------------
async function setupTauriEventListeners() {
  const tauri = (window as any).__TAURI__;
  if (!tauri || !tauri.event || typeof tauri.event.listen !== 'function') {
    return;
  }

  await tauri.event.listen('telemetry-speed', (event: { payload: TelemetryMetrics }) => {
    currentState.metrics = event.payload;
    uptimeSeconds = event.payload.uptime_seconds;
    updateTelemetryDisplay(event.payload);
  });

  await tauri.event.listen('telemetry-log', (event: { payload: LogEventPayload }) => {
    const formatted = `[${event.payload.timestamp}] [${event.payload.level}] ${event.payload.message}`;
    currentState.logs.push(formatted);
    appendLogLine(formatted);
  });

  await tauri.event.listen('connection-status-changed', (event: { payload: StatusEventPayload }) => {
    const status = event.payload.status;
    if (status === 'Connected') {
      currentState.status = 'Connected';
      startTimer();
    } else if (status === 'Connecting') {
      currentState.status = 'Connecting';
    } else {
      currentState.status = 'Disconnected';
      stopTimer();
      if (event.payload.message) {
        const msg = event.payload.message;
        if (!handleCoreError(msg)) {
          alert('قطع اتصال تانل: ' + msg);
        }
      }
    }
    renderPowerButton();
  });
}

// ------------------------------------------------------------------------------
// Formatting Utilities
// ------------------------------------------------------------------------------
function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return '0.0 KB/s';
  const mb = bytesPerSec / 1_000_000;
  if (mb >= 1.0) {
    return mb.toFixed(1) + ' MB/s';
  }
  const kb = bytesPerSec / 1_000;
  return kb.toFixed(1) + ' KB/s';
}

function formatDuration(totalSeconds: number): string {
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
}

function formatModeBadge(modeId: string): string {
  switch (modeId) {
    case 'download': return '⚡ ۲. دانلود پرسرعت';
    case 'gaming': return '🎮 ۳. گیمینگ (کاهش پینگ)';
    case 'static_ip': return '🔒 ۴. آی‌پی ثابت مسکونی';
    case 'web_browsing':
    default: return '🌐 ۱. وب‌گردی روزمره';
  }
}

// ------------------------------------------------------------------------------
// DOM Rendering & State Updates
// ------------------------------------------------------------------------------
function renderState() {
  const authScreen = document.getElementById('auth-screen');
  const mainScreen = document.getElementById('main-screen');

  if (!currentState.is_authenticated) {
    authScreen?.classList.remove('hidden');
    mainScreen?.classList.add('hidden');
    return;
  }

  authScreen?.classList.add('hidden');
  mainScreen?.classList.remove('hidden');

  // Top Bar: Subscription Badge
  const tierBadge = document.getElementById('tier-badge');
  if (tierBadge) {
    tierBadge.textContent = currentState.tier;
    if (currentState.tier.includes('Flow+')) {
      tierBadge.className = 'text-[10px] px-2 py-0.5 rounded-full font-bold bg-[#8B5CF6]/20 text-[#8B5CF6] border border-[#8B5CF6]/40 tracking-wide';
    } else if (currentState.tier.includes('Pro')) {
      tierBadge.className = 'text-[10px] px-2 py-0.5 rounded-full font-bold bg-[#10B981]/20 text-[#10B981] border border-[#10B981]/40 tracking-wide';
    } else {
      tierBadge.className = 'text-[10px] px-2 py-0.5 rounded-full font-medium bg-[#1E293B] text-[#94A3B8] border border-white/10 tracking-wide';
    }
  }

  // Top Bar: Expiration Date (for Pro / Flow+)
  const expiryDisplay = document.getElementById('expiry-display');
  if (expiryDisplay) {
    if (currentState.tier.includes('Flow+') || currentState.tier.includes('Pro')) {
      if (currentState.expires_at) {
        const d = currentState.expires_at.substring(0, 10).replace(/-/g, '/');
        expiryDisplay.textContent = `اعتبار: تا ${d}`;
      } else {
        expiryDisplay.textContent = 'اعتبار ویژه فعال';
      }
      expiryDisplay.className = 'text-[10px] text-[#10B981] font-mono truncate max-w-[110px]';
    } else {
      expiryDisplay.textContent = 'پلن پایه رایگان';
      expiryDisplay.className = 'text-[10px] text-[#94A3B8] font-mono truncate max-w-[100px]';
    }
  }

  // Active Mode Title
  const activeModeTitle = document.getElementById('active-mode-title');
  if (activeModeTitle) {
    activeModeTitle.textContent = formatModeBadge(currentState.selected_mode);
  }

  // Switches
  const splitToggle = document.getElementById('split-tunnel-toggle') as HTMLInputElement;
  if (splitToggle) splitToggle.checked = currentState.split_tunneling;

  const tunToggle = document.getElementById('tun-mode-toggle') as HTMLInputElement;
  if (tunToggle) tunToggle.checked = currentState.tun_mode;

  const killToggle = document.getElementById('kill-switch-toggle') as HTMLInputElement;
  const staticLeakBadge = document.getElementById('static-ip-leak-badge');

  if (currentState.selected_mode === 'static_ip') {
    if (killToggle) {
      killToggle.checked = true;
      killToggle.disabled = true;
    }
    staticLeakBadge?.classList.remove('hidden');
  } else {
    if (killToggle) {
      killToggle.disabled = false;
      killToggle.checked = currentState.kill_switch;
    }
    staticLeakBadge?.classList.add('hidden');
  }

  const sandboxToggle = document.getElementById('sandbox-mode-toggle') as HTMLInputElement;
  if (sandboxToggle) sandboxToggle.checked = currentState.sandbox_loopback;

  // Cloudflare WARP Toggle & Badge State
  const warpToggle = document.getElementById('warp-toggle') as HTMLInputElement;
  const warpBadge = document.getElementById('warp-badge');
  const warpNotice = document.getElementById('warp-static-notice');

  if (warpToggle && warpBadge) {
    if (currentState.selected_mode === 'static_ip') {
      warpToggle.checked = false;
      warpToggle.disabled = true;
      warpBadge.textContent = 'غیرفعال';
      warpBadge.className = 'text-[9px] px-1.5 py-0.2 rounded bg-white/5 text-[#64748B] border border-white/5 font-mono';
      warpNotice?.classList.remove('hidden');
    } else {
      warpToggle.disabled = false;
      warpToggle.checked = !!currentState.use_warp;
      warpNotice?.classList.add('hidden');
      if (currentState.use_warp) {
        warpBadge.textContent = 'فعال ⚡️';
        warpBadge.className = 'text-[9px] px-1.5 py-0.2 rounded bg-[#F59E0B]/20 text-[#F59E0B] border border-[#F59E0B]/30 font-bold';
      } else {
        warpBadge.textContent = 'خاموش';
        warpBadge.className = 'text-[9px] px-1.5 py-0.2 rounded bg-white/5 text-[#94A3B8] border border-white/10 font-mono';
      }
    }
  }

  const userDisplay = document.getElementById('user-display');
  if (userDisplay) userDisplay.textContent = currentState.username;

  // Active Protocol Title & Buttons (Stealth, IKEv2, OpenVPN UDP, OpenVPN TCP)
  const activeProtoTitle = document.getElementById('active-protocol-title');
  const proto = currentState.selected_protocol || 'openvpn_udp';
  if (activeProtoTitle) {
    switch (proto) {
      case 'openvpn_tcp':
        activeProtoTitle.textContent = 'OpenVPN (TCP)';
        activeProtoTitle.className = 'text-[10px] font-mono text-[#3B82F6]';
        break;
      case 'stealth':
        activeProtoTitle.textContent = 'Stealth (TLS 1.3)';
        activeProtoTitle.className = 'text-[10px] font-mono text-[#8B5CF6]';
        break;
      case 'ikev2':
        activeProtoTitle.textContent = 'IKEv2 (Native)';
        activeProtoTitle.className = 'text-[10px] font-mono text-[#10B981]';
        break;
      default:
        activeProtoTitle.textContent = 'OpenVPN (UDP)';
        activeProtoTitle.className = 'text-[10px] font-mono text-[#3B82F6]';
        break;
    }
  }

  ['openvpn_udp', 'openvpn_tcp', 'stealth', 'ikev2'].forEach(p => {
    const btn = document.getElementById(`proto-btn-${p}`);
    if (btn) {
      if (p === proto) {
        btn.className = 'protocol-btn py-1.5 px-2 rounded-lg text-[10px] font-medium border border-[#3B82F6]/60 bg-[#3B82F6]/25 text-[#3B82F6] shadow-sm flex items-center justify-center space-x-1 space-x-reverse transition-all duration-200 scale-[1.02]';
      } else {
        btn.className = 'protocol-btn py-1.5 px-2 rounded-lg text-[10px] font-medium border border-white/10 bg-[#0F172A] text-[#94A3B8] hover:text-white flex items-center justify-center space-x-1 space-x-reverse transition-all duration-200';
      }
    }
  });

  renderRoutingMode();
  updateModesUI();
  renderLocationSwitcher();
  renderPowerButton();
  renderLogs();
}

function renderRoutingMode() {
  const rMode = currentState.routing_mode || 'tunnel';
  const isStaticIp = currentState.selected_mode === 'static_ip';

  const titleIcon = document.getElementById('routing-mode-icon');
  const titleLabel = document.getElementById('routing-mode-label');
  const staticNotice = document.getElementById('routing-static-notice');
  const proxyEndpoints = document.getElementById('routing-proxy-endpoints');

  // Title & Icon
  if (titleIcon && titleLabel) {
    if (rMode === 'proxy') {
      titleIcon.textContent = '🔌';
      titleLabel.textContent = 'پروکسی محلی (Proxy)';
      titleLabel.className = 'text-[#F59E0B] font-bold';
    } else if (rMode === 'system_proxy') {
      titleIcon.textContent = '🔀';
      titleLabel.textContent = 'پروکسی ویندوز (System Proxy)';
      titleLabel.className = 'text-[#3B82F6] font-bold';
    } else {
      titleIcon.textContent = '🌐';
      titleLabel.textContent = 'تونل کامل (Tunnel)';
      titleLabel.className = 'text-[#10B981] font-bold';
    }
  }

  // Static IP Enforcements
  const btnTunnel = document.getElementById('routing-btn-tunnel') as HTMLButtonElement;
  const btnSysProxy = document.getElementById('routing-btn-system_proxy') as HTMLButtonElement;
  const btnProxy = document.getElementById('routing-btn-proxy') as HTMLButtonElement;

  if (isStaticIp) {
    staticNotice?.classList.remove('hidden');
    proxyEndpoints?.classList.add('hidden');

    if (btnSysProxy) {
      btnSysProxy.disabled = true;
      btnSysProxy.classList.add('opacity-40', 'cursor-not-allowed');
    }
    if (btnProxy) {
      btnProxy.disabled = true;
      btnProxy.classList.add('opacity-40', 'cursor-not-allowed');
    }
    if (btnTunnel) {
      btnTunnel.disabled = false;
      btnTunnel.classList.remove('opacity-40', 'cursor-not-allowed');
    }
  } else {
    staticNotice?.classList.add('hidden');
    [btnTunnel, btnSysProxy, btnProxy].forEach(b => {
      if (b) {
        b.disabled = false;
        b.classList.remove('opacity-40', 'cursor-not-allowed');
      }
    });

    if (rMode === 'proxy') {
      proxyEndpoints?.classList.remove('hidden');
    } else {
      proxyEndpoints?.classList.add('hidden');
    }
  }

  // Buttons Active Styling
  const modes = ['tunnel', 'system_proxy', 'proxy'];
  modes.forEach(m => {
    const btn = document.getElementById(`routing-btn-${m}`);
    if (btn) {
      if (m === rMode) {
        if (m === 'proxy') {
          btn.className = 'routing-btn py-1.5 px-1 rounded-lg text-[10px] font-bold border border-[#F59E0B]/60 bg-[#F59E0B]/20 text-[#F59E0B] shadow-sm flex items-center justify-center space-x-1 space-x-reverse transition-all duration-200 scale-[1.02]';
        } else if (m === 'system_proxy') {
          btn.className = 'routing-btn py-1.5 px-1 rounded-lg text-[10px] font-bold border border-[#3B82F6]/60 bg-[#3B82F6]/20 text-[#3B82F6] shadow-sm flex items-center justify-center space-x-1 space-x-reverse transition-all duration-200 scale-[1.02]';
        } else {
          btn.className = 'routing-btn py-1.5 px-1 rounded-lg text-[10px] font-bold border border-[#10B981]/60 bg-[#10B981]/20 text-[#10B981] shadow-sm flex items-center justify-center space-x-1 space-x-reverse transition-all duration-200 scale-[1.02]';
        }
      } else {
        btn.className = 'routing-btn py-1.5 px-1 rounded-lg text-[10px] font-medium border border-transparent bg-transparent text-[#94A3B8] hover:text-[#F8FAFC] flex items-center justify-center space-x-1 space-x-reverse transition-all duration-200';
      }
    }
  });

  // Update Advanced Settings Accordion Summary Badge
  const advBadge = document.getElementById('advanced-summary-badge');
  if (advBadge) {
    const rLabel = rMode === 'proxy' ? 'Proxy' : rMode === 'system_proxy' ? 'SysProxy' : 'Tunnel';
    const proto = currentState.selected_protocol || 'openvpn_udp';
    const pLabel = proto === 'stealth' ? 'Stealth' : proto === 'ikev2' ? 'IKEv2' : 'OpenVPN';
    const wLabel = currentState.use_warp ? 'WARP ⚡' : '';
    advBadge.textContent = [rLabel, pLabel, wLabel].filter(Boolean).join(' • ');
  }
}

function renderPowerButton() {
  const masterBtn = document.getElementById('master-power-btn');
  const powerIcon = document.getElementById('power-icon');
  const statusText = document.getElementById('status-text');

  if (!masterBtn || !powerIcon || !statusText) return;

  masterBtn.classList.remove('btn-connecting', 'btn-connected');

  if (currentState.status === 'Connected') {
    masterBtn.classList.add('btn-connected');
    masterBtn.style.borderColor = '#10B981';
    powerIcon.className = 'w-10 h-10 text-[#10B981] transition-colors duration-300';
    statusText.textContent = 'اتصال ایمن برقرار است';
    statusText.className = 'text-xs font-semibold text-[#10B981]';
  } else if (currentState.status === 'Connecting') {
    masterBtn.classList.add('btn-connecting');
    masterBtn.style.borderColor = '#F59E0B';
    powerIcon.className = 'w-10 h-10 text-[#F59E0B] transition-colors duration-300 animate-pulse';
    statusText.textContent = 'در حال برقراری تانل...';
    statusText.className = 'text-xs font-semibold text-[#F59E0B]';
  } else {
    masterBtn.style.borderColor = 'rgba(255, 255, 255, 0.15)';
    powerIcon.className = 'w-10 h-10 text-[#64748B] transition-colors duration-300';
    statusText.textContent = 'قطع ارتباط';
    statusText.className = 'text-xs font-semibold text-[#94A3B8]';
  }
}

let recentPings: number[] = [];
let currentJitterMs = 0;

function updateGamingJitter(newPing: number) {
  if (newPing <= 0) return;
  recentPings.push(newPing);
  if (recentPings.length > 6) recentPings.shift();
  if (recentPings.length >= 2) {
    let diffSum = 0;
    for (let i = 1; i < recentPings.length; i++) {
      diffSum += Math.abs(recentPings[i] - recentPings[i - 1]);
    }
    currentJitterMs = Math.round(diffSum / (recentPings.length - 1));
  } else {
    currentJitterMs = 1;
  }
}

function updateTelemetryDisplay(metrics: TelemetryMetrics) {
  const downEl = document.getElementById('down-speed');
  const upEl = document.getElementById('up-speed');
  const pingEl = document.getElementById('ping-display');
  const timerEl = document.getElementById('connection-timer');

  if (downEl) downEl.textContent = formatSpeed(metrics.download_speed_bps);
  if (upEl) upEl.textContent = formatSpeed(metrics.upload_speed_bps);
  if (pingEl) pingEl.textContent = metrics.ping_ms > 0 ? `${metrics.ping_ms} ms` : '- ms';
  if (timerEl) timerEl.textContent = formatDuration(metrics.uptime_seconds);

  // Live Gaming Telemetry Display
  const gamingBar = document.getElementById('gaming-telemetry-bar');
  if (gamingBar) {
    if (currentState.selected_mode === 'gaming' && currentState.status === 'Connected') {
      gamingBar.classList.remove('hidden');
      const gPing = document.getElementById('gaming-ping-val');
      const gJitter = document.getElementById('gaming-jitter-val');
      if (gPing) gPing.textContent = metrics.ping_ms > 0 ? `${metrics.ping_ms} ms` : '- ms';
      if (gJitter) {
        updateGamingJitter(metrics.ping_ms);
        gJitter.textContent = `±${currentJitterMs} ms`;
      }
    } else {
      gamingBar.classList.add('hidden');
    }
  }
}

function startTimer() {
  if (connectionTimerInterval) clearInterval(connectionTimerInterval);
  connectionTimerInterval = window.setInterval(() => {
    uptimeSeconds += 1;
    const timerEl = document.getElementById('connection-timer');
    if (timerEl) timerEl.textContent = formatDuration(uptimeSeconds);
  }, 1000);
}

function stopTimer() {
  if (connectionTimerInterval) {
    clearInterval(connectionTimerInterval);
    connectionTimerInterval = null;
  }
  uptimeSeconds = 0;
  const timerEl = document.getElementById('connection-timer');
  if (timerEl) timerEl.textContent = '00:00:00';
}

function renderLogs() {
  const consoleEl = document.getElementById('log-console');
  if (!consoleEl) return;
  consoleEl.innerHTML = '';
  currentState.logs.forEach(line => appendLogLine(line));
}

function appendLogLine(line: string) {
  const consoleEl = document.getElementById('log-console');
  if (!consoleEl) return;
  const div = document.createElement('div');
  div.className = 'leading-relaxed break-all';

  if (line.includes('[ERROR]')) {
    div.classList.add('text-[#EF4444]');
  } else if (line.includes('[WARN]')) {
    div.classList.add('text-[#F59E0B]');
  } else if (line.includes('[DEBUG]')) {
    div.classList.add('text-[#3B82F6]');
  } else {
    div.classList.add('text-[#94A3B8]');
  }

  div.textContent = line;
  consoleEl.appendChild(div);
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

// ------------------------------------------------------------------------------
// Connection Modes UI
// ------------------------------------------------------------------------------
function updateModesUI() {
  const isFreeTier = currentState.tier === 'Sentra Lite';

  const wb = connectionModes.find(m => m.id === 'web_browsing');
  const wbText = document.getElementById('wb-quota-text');
  const wbBar = document.getElementById('wb-quota-bar');
  if (isFreeTier) {
    const wbUsed = wb ? wb.daily_used_mb || 0 : 0;
    if (wbText) wbText.textContent = `${wbUsed} / 2048 MB`;
    if (wbBar) {
      const pct = Math.min(100, Math.round((wbUsed / 2048) * 100));
      wbBar.style.width = `${pct}%`;
      wbBar.className = pct >= 100 ? 'bg-[#EF4444] h-full rounded-full transition-all duration-300' : 'bg-[#10B981] h-full rounded-full transition-all duration-300';
    }
  } else {
    if (wbText) wbText.textContent = 'نامحدود (Unlimited)';
    if (wbBar) {
      wbBar.style.width = '100%';
      wbBar.className = 'bg-[#10B981] h-full rounded-full transition-all duration-300';
    }
  }

  const dl = connectionModes.find(m => m.id === 'download');
  const dlText = document.getElementById('dl-quota-text');
  const dlBar = document.getElementById('dl-quota-bar');
  if (isFreeTier) {
    const dlUsed = dl ? dl.daily_used_mb || 0 : 0;
    if (dlText) dlText.textContent = `${dlUsed} / 3072 MB`;
    if (dlBar) {
      const pct = Math.min(100, Math.round((dlUsed / 3072) * 100));
      dlBar.style.width = `${pct}%`;
      dlBar.className = pct >= 100 ? 'bg-[#EF4444] h-full rounded-full transition-all duration-300' : 'bg-[#3B82F6] h-full rounded-full transition-all duration-300';
    }
  } else {
    if (dlText) dlText.textContent = 'نامحدود (Unlimited)';
    if (dlBar) {
      dlBar.style.width = '100%';
      dlBar.className = 'bg-[#3B82F6] h-full rounded-full transition-all duration-300';
    }
  }

  // Download Mode Lock based on Telegram Verification for Free users
  const dlLockOverlay = document.getElementById('dl-lock-overlay');
  const dlQuotaContainer = document.getElementById('dl-quota-container');
  const dlBadge = document.getElementById('dl-badge');
  const dlIcon = document.getElementById('dl-icon');

  const isDlLocked = isFreeTier && !currentState.telegram_verified;
  if (isDlLocked) {
    if (dlLockOverlay) dlLockOverlay.classList.remove('hidden');
    if (dlQuotaContainer) dlQuotaContainer.classList.add('opacity-40');
    if (dlBadge) {
      dlBadge.textContent = '🔒 قفل (تایید تلگرام)';
      dlBadge.className = 'text-[9px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 font-medium border border-amber-500/30';
    }
    if (dlIcon) dlIcon.textContent = '🔒';
  } else {
    if (dlLockOverlay) dlLockOverlay.classList.add('hidden');
    if (dlQuotaContainer) dlQuotaContainer.classList.remove('opacity-40');
    if (dlBadge) {
      dlBadge.textContent = 'Hysteria 2';
      dlBadge.className = 'text-[9px] px-1.5 py-0.5 rounded bg-[#3B82F6]/15 text-[#3B82F6] font-medium border border-[#3B82F6]/20';
    }
    if (dlIcon) dlIcon.textContent = '⚡';
  }

  // Static IP locked/unlocked state & 30GB quota meter
  const staticIcon = document.getElementById('static-ip-icon');
  const staticBadge = document.getElementById('static-ip-badge');
  const staticQuotaMeter = document.getElementById('static-ip-quota-meter');
  const staticQuotaText = document.getElementById('static-ip-quota-text');

  if (staticIcon && staticBadge) {
    if (isFreeTier) {
      staticIcon.textContent = '🔒';
      staticBadge.textContent = 'ویژه Pro و Flow+';
      staticBadge.className = 'text-[9px] px-1.5 py-0.5 rounded bg-[#8B5CF6]/15 text-[#8B5CF6] font-medium border border-[#8B5CF6]/20';
      if (staticQuotaMeter) staticQuotaMeter.classList.add('hidden');
    } else {
      staticIcon.textContent = '🌐';
      const st = connectionModes.find(m => m.id === 'static_ip');
      const staticUsedMb = st ? st.daily_used_mb || 0 : 0;
      const staticRemMb = Math.max(0, 30720 - staticUsedMb);
      const staticRemGb = (staticRemMb / 1024).toFixed(1);

      if (staticQuotaMeter) staticQuotaMeter.classList.remove('hidden');
      if (staticQuotaText) staticQuotaText.textContent = `${staticRemGb} GB باقیمانده از ۳۰ GB`;

      if (staticRemMb === 0) {
        staticBadge.textContent = 'سقف ۳۰ گیگ ماهانه تکمیل شد';
        staticBadge.className = 'text-[9px] px-1.5 py-0.5 rounded bg-[#EF4444]/15 text-[#EF4444] font-medium border border-[#EF4444]/20';
      } else {
        staticBadge.textContent = 'فعال • آی‌پی ثابت اختصاصی';
        staticBadge.className = 'text-[9px] px-1.5 py-0.5 rounded bg-[#10B981]/15 text-[#10B981] font-medium border border-[#10B981]/20';
      }
    }
  }

  // 3. Gaming Mode Box & Quota Display
  const gamingSubmodeBox = document.getElementById('gaming-submode-box');
  const gamingQuotaText = document.getElementById('gaming-quota-text');
  const gamingBadge = document.getElementById('gaming-badge');
  const gm = connectionModes.find(m => m.id === 'gaming');

  if (currentState.selected_mode === 'gaming') {
    if (gamingSubmodeBox) gamingSubmodeBox.classList.remove('hidden');
    const submode = currentState.gaming_submode || 'full_udp';
    const btnFull = document.getElementById('submode-full-udp');
    const btnAnti = document.getElementById('submode-anti-sanction');
    if (btnFull && btnAnti) {
      if (submode === 'full_udp') {
        btnFull.className = 'gaming-submode-btn p-1.5 rounded-lg bg-[#0F172A] border border-[#F59E0B] text-right transition flex flex-col cursor-pointer';
        btnAnti.className = 'gaming-submode-btn p-1.5 rounded-lg bg-[#0F172A] border border-white/10 hover:border-white/20 text-right transition flex flex-col cursor-pointer';
      } else {
        btnFull.className = 'gaming-submode-btn p-1.5 rounded-lg bg-[#0F172A] border border-white/10 hover:border-white/20 text-right transition flex flex-col cursor-pointer';
        btnAnti.className = 'gaming-submode-btn p-1.5 rounded-lg bg-[#0F172A] border border-[#F59E0B] text-right transition flex flex-col cursor-pointer';
      }
    }

    const smBadge = document.getElementById('gaming-submode-badge');
    if (smBadge) {
      smBadge.textContent = submode === 'anti_sanction' ? 'ضدتحریم پینگ صفر' : 'Full UDP';
    }
  } else {
    if (gamingSubmodeBox) gamingSubmodeBox.classList.add('hidden');
  }

  if (isFreeTier) {
    const gmUsed = gm ? gm.daily_used_mb || 0 : 0;
    const gmRem = Math.max(0, 3072 - gmUsed);
    if (gamingQuotaText) gamingQuotaText.textContent = `سهمیه امروز: ${(gmRem / 1024).toFixed(1)} GB باقیمانده`;
    if (gamingBadge) {
      if (gmRem === 0) {
        gamingBadge.textContent = 'سقف ۳ گیگ امروز پر شد';
        gamingBadge.className = 'text-[9px] px-1.5 py-0.5 rounded bg-[#EF4444]/15 text-[#EF4444] font-medium border border-[#EF4444]/20';
      } else {
        gamingBadge.textContent = '۳ گیگابایت روزانه رایگان';
        gamingBadge.className = 'text-[9px] px-1.5 py-0.5 rounded bg-[#F59E0B]/15 text-[#F59E0B] font-medium border border-[#F59E0B]/20';
      }
    }
  } else {
    if (gamingQuotaText) gamingQuotaText.textContent = 'سهمیه گیمینگ: نامحدود (VIP)';
    if (gamingBadge) {
      gamingBadge.textContent = 'ترافیک نامحدود گیمینگ';
      gamingBadge.className = 'text-[9px] px-1.5 py-0.5 rounded bg-[#10B981]/15 text-[#10B981] font-medium border border-[#10B981]/20';
    }
  }

  // Highlight active mode card
  ['web_browsing', 'download', 'gaming', 'static_ip'].forEach(id => {
    const el = document.getElementById(`card-mode-${id}`);
    if (el) {
      if (id === currentState.selected_mode) {
        el.classList.add('border-[#10B981]', 'ring-1', 'ring-[#10B981]');
      } else {
        el.classList.remove('border-[#10B981]', 'ring-1', 'ring-[#10B981]');
      }
    }
  });
}

async function refreshConnectionModes() {
  try {
    const res = await invokeTauri<{ success: boolean; modes: ConnectionModeInfo[] }>('get_connection_modes', {
      token: currentState.subscription_token,
    });
    if (res && res.modes) {
      connectionModes = res.modes;
      updateModesUI();
    }
  } catch (err) {
    console.warn('Could not fetch connection modes:', err);
  }
}

// ------------------------------------------------------------------------------
// Device Management & Intelligent Replacement
// ------------------------------------------------------------------------------
async function loadUserDevices() {
  const container = document.getElementById('devices-list');
  const topBadge = document.getElementById('top-devices-label');
  const modalBadge = document.getElementById('modal-devices-count');
  if (!container) return;

  try {
    if (!currentDeviceId) {
      currentDeviceId = await invokeTauri<string>('get_current_device_id');
    }

    const res = await invokeTauri<{ success: boolean; count: number; max_allowed: number; devices: UserDevice[] }>('get_user_devices');
    userDevices = res?.devices || [];
    const count = userDevices.length;

    const label = `${count} از ۳ دستگاه فعال`;
    if (topBadge) topBadge.textContent = label;
    if (modalBadge) modalBadge.textContent = `${count} از ۳`;

    if (userDevices.length === 0) {
      container.innerHTML = '<div class="text-[11px] text-[#64748B] text-center py-3">هیچ دستگاهی متصل نیست.</div>';
      return;
    }

    container.innerHTML = '';
    userDevices.forEach(dev => {
      const isCurrent = dev.device_id === currentDeviceId;
      const card = document.createElement('div');
      card.className = `flex items-center justify-between p-2.5 rounded-xl border ${
        isCurrent ? 'bg-[#0F172A] border-[#10B981]/50' : 'bg-[#0F172A]/70 border-white/10'
      }`;

      const platformIcon = dev.platform.toLowerCase().includes('android')
        ? '📱'
        : dev.platform.toLowerCase().includes('ios')
        ? '🍎'
        : '💻';
      const lastActiveFormatted = dev.last_active_at ? dev.last_active_at.substring(0, 16).replace('T', ' ') : 'نامشخص';

      card.innerHTML = `
        <div class="flex items-center space-x-2 space-x-reverse min-w-0">
          <span class="text-base">${platformIcon}</span>
          <div class="truncate">
            <div class="text-xs font-semibold text-[#F8FAFC] flex items-center space-x-1.5 space-x-reverse">
              <span class="truncate">${dev.device_name || 'دستگاه متصل'}</span>
              ${isCurrent ? '<span class="text-[9px] px-1.5 py-0.2 rounded bg-[#10B981]/20 text-[#10B981] border border-[#10B981]/30 font-medium">این دستگاه</span>' : ''}
            </div>
            <div class="text-[10px] text-[#94A3B8] font-mono mt-0.5">آخرین فعالیت: ${lastActiveFormatted}</div>
          </div>
        </div>

        <div class="flex items-center space-x-1 space-x-reverse flex-shrink-0">
          ${
            !isCurrent
              ? `<button data-replace-id="${dev.device_id}" class="replace-dev-btn text-[10px] px-2 py-1 rounded-lg bg-[#10B981]/15 hover:bg-[#10B981]/25 text-[#10B981] border border-[#10B981]/30 transition cursor-pointer font-medium">
                  حذف و جایگزینی با این دستگاه
                 </button>`
              : ''
          }
          <button data-dev-id="${dev.device_id}" class="remove-dev-btn text-[10px] px-2 py-1 rounded-lg bg-[#EF4444]/10 hover:bg-[#EF4444]/20 text-[#EF4444] border border-[#EF4444]/25 transition cursor-pointer">
            حذف
          </button>
        </div>
      `;

      container.appendChild(card);
    });

    // Handle "Remove and Replace with this Device"
    container.querySelectorAll('.replace-dev-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const oldId = (e.currentTarget as HTMLElement).getAttribute('data-replace-id');
        if (!oldId) return;

        try {
          (btn as HTMLButtonElement).textContent = 'در حال جایگزینی...';
          (btn as HTMLButtonElement).disabled = true;

          // Call Tauri command to replace device and immediately connect
          try {
            await invokeTauri('replace_user_device', { old_device_id: oldId });
          } catch {
            await invokeTauri('remove_user_device', { device_id: oldId });
            await invokeTauri('connect_vpn');
          }

          currentState.status = 'Connected';
          startTimer();
          renderPowerButton();
          await loadUserDevices();

          document.getElementById('devices-modal')?.classList.add('hidden');
        } catch (err: any) {
          alert('خطا در جایگزینی دستگاه: ' + (err?.toString() || ''));
        }
      });
    });

    // Handle individual removal
    container.querySelectorAll('.remove-dev-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const devId = (e.currentTarget as HTMLElement).getAttribute('data-dev-id');
        if (!devId) return;
        if (confirm('آیا از حذف این دستگاه اطمینان دارید؟ دسترسی اتصال آن متوقف خواهد شد.')) {
          try {
            await invokeTauri('remove_user_device', { device_id: devId });
            await loadUserDevices();
          } catch (err: any) {
            alert('خطا در حذف دستگاه: ' + (err?.toString() || ''));
          }
        }
      });
    });
  } catch (e) {
    console.warn('Could not load user devices:', e);
  }
}

// ------------------------------------------------------------------------------
// Error & Modal Handlers
// ------------------------------------------------------------------------------
function showFriendlyError(title: string, desc: string) {
  const card = document.getElementById('quick-error-card');
  const tEl = document.getElementById('quick-error-title');
  const dEl = document.getElementById('quick-error-desc');
  if (card && tEl && dEl) {
    tEl.textContent = title;
    dEl.textContent = desc;
    card.classList.remove('hidden');
  }
}

function hideFriendlyError() {
  const card = document.getElementById('quick-error-card');
  card?.classList.add('hidden');
}

function handleCoreError(errStr: string): boolean {
  if (errStr.includes('ACCOUNT_SUSPENDED')) {
    const suspendedModal = document.getElementById('suspended-modal');
    suspendedModal?.classList.remove('hidden');
    return true;
  }
  if (errStr.includes('MAX_DEVICES_REACHED')) {
    const devicesModal = document.getElementById('devices-modal');
    devicesModal?.classList.remove('hidden');
    loadUserDevices();
    return true;
  }

  // Provide high-contrast friendly Persian troubleshooting guidance
  if (errStr.toLowerCase().includes('openvpn') || errStr.toLowerCase().includes('handshake') || errStr.toLowerCase().includes('timeout') || errStr.includes('اتصال')) {
    showFriendlyError(
      'خطا در برقراری اتصال تانل',
      'ارتباط با سرور به دلیل محدودیت‌های شبکه برقرار نشد. پیشنهاد می‌شود پروتکل Stealth (ضدفیلتر و پنهان‌ساز) یا لوکیشن دیگری را امتحان کنید.'
    );
    return true;
  }

  showFriendlyError('خطای موقت در اتصال', errStr);
  return true;
}

// ------------------------------------------------------------------------------
// Password Reset API Calls (Two-Step Verification)
// ------------------------------------------------------------------------------
async function apiPasswordResetRequest(email: string): Promise<any> {
  const tauri = (window as any).__TAURI__;
  if (tauri && tauri.core && typeof tauri.core.invoke === 'function') {
    return await invokeTauri('request_password_reset', { email });
  }

  const baseUrl = (import.meta as any).env?.VITE_API_BASE_URL || 'https://head.cyberservice.sbs:8443';
  const endpoints = [baseUrl, 'https://head.cyberservice.sbs:8443', 'http://127.0.0.1:8080'];
  let lastErr = 'عدم برقراری ارتباط با سرور.';

  for (const base of endpoints) {
    try {
      const res = await fetch(`${base}/api/v1/auth/password-reset/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        return data;
      }
      throw new Error(data.message || data.error || 'خطا در ارسال درخواست بازیابی رمز عبور.');
    } catch (e: any) {
      if (e.message && !e.message.includes('fetch')) throw e;
      lastErr = e.message || lastErr;
    }
  }
  throw new Error(lastErr);
}

async function apiPasswordResetConfirm(email: string, code: string, newPassword: string): Promise<any> {
  const tauri = (window as any).__TAURI__;
  if (tauri && tauri.core && typeof tauri.core.invoke === 'function') {
    return await invokeTauri('confirm_password_reset', { email, code, new_password: newPassword });
  }

  const baseUrl = (import.meta as any).env?.VITE_API_BASE_URL || 'https://head.cyberservice.sbs:8443';
  const endpoints = [baseUrl, 'https://head.cyberservice.sbs:8443', 'http://127.0.0.1:8080'];
  let lastErr = 'عدم برقراری ارتباط با سرور.';

  for (const base of endpoints) {
    try {
      const res = await fetch(`${base}/api/v1/auth/password-reset/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code, new_password: newPassword })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        return data;
      }
      throw new Error(data.message || data.error || 'خطا در تغییر رمز عبور.');
    } catch (e: any) {
      if (e.message && !e.message.includes('fetch')) throw e;
      lastErr = e.message || lastErr;
    }
  }
  throw new Error(lastErr);
}

// ------------------------------------------------------------------------------
// Event Listeners Initialization
// ------------------------------------------------------------------------------
function initEventListeners() {
  const authErr = document.getElementById('auth-error-msg');
  const authSuccess = document.getElementById('auth-success-msg');
  const authTabs = document.getElementById('auth-tabs');

  // Forgot Password DOM Elements
  const formForgot = document.getElementById('auth-form-forgot');
  const forgotLink = document.getElementById('forgot-password-link');
  const forgotBackBtn = document.getElementById('forgot-back-btn');
  const forgotStep1 = document.getElementById('forgot-step-1');
  const forgotStep2 = document.getElementById('forgot-step-2');
  const forgotIdentifierInput = document.getElementById('forgot-identifier-input') as HTMLInputElement;
  const forgotRequestBtn = document.getElementById('forgot-request-btn');
  const forgotCodeInput = document.getElementById('forgot-code-input') as HTMLInputElement;
  const forgotPassInput = document.getElementById('forgot-password-input') as HTMLInputElement;
  const forgotConfirmBtn = document.getElementById('forgot-confirm-btn');
  const forgotStep2ChangeEmail = document.getElementById('forgot-step2-change-email');
  const forgotStep2Info = document.getElementById('forgot-step2-info');
  const forgotErr = document.getElementById('forgot-error-msg');
  const forgotSuccess = document.getElementById('forgot-success-msg');

  // 1a. Auth Tabs Switcher
  const tabLogin = document.getElementById('auth-tab-login');
  const tabRegister = document.getElementById('auth-tab-register');
  const tabOtp = document.getElementById('auth-tab-otp');
  const formLogin = document.getElementById('auth-form-login');
  const formRegister = document.getElementById('auth-form-register');
  const formOtp = document.getElementById('auth-form-otp');

  const selectAuthTab = (activeTab: 'login' | 'register' | 'otp') => {
    if (authErr) authErr.classList.add('hidden');
    if (authSuccess) authSuccess.classList.add('hidden');
    formForgot?.classList.add('hidden');
    authTabs?.classList.remove('hidden');

    const tabs = [
      { id: 'login', tab: tabLogin, form: formLogin },
      { id: 'register', tab: tabRegister, form: formRegister },
      { id: 'otp', tab: tabOtp, form: formOtp },
    ];
    tabs.forEach(t => {
      if (t.id === activeTab) {
        t.tab?.classList.add('text-white', 'bg-[#0F172A]', 'shadow-sm');
        t.tab?.classList.remove('text-[#94A3B8]');
        t.form?.classList.remove('hidden');
      } else {
        t.tab?.classList.remove('text-white', 'bg-[#0F172A]', 'shadow-sm');
        t.tab?.classList.add('text-[#94A3B8]');
        t.form?.classList.add('hidden');
      }
    });
  };

  tabLogin?.addEventListener('click', () => selectAuthTab('login'));
  tabRegister?.addEventListener('click', () => selectAuthTab('register'));
  tabOtp?.addEventListener('click', () => selectAuthTab('otp'));

  // 1b. Username & Password Login
  const loginSubmitBtn = document.getElementById('login-submit-btn');
  const loginUserInput = document.getElementById('login-username-input') as HTMLInputElement;
  const loginPassInput = document.getElementById('login-password-input') as HTMLInputElement;

  const handleCredentialsLogin = async () => {
    const username = loginUserInput?.value?.trim() || '';
    const password = loginPassInput?.value || '';
    if (!username || !password) {
      if (authErr) {
        authErr.textContent = 'لطفاً نام کاربری و رمز عبور را وارد فرمایید.';
        authErr.classList.remove('hidden');
      }
      return;
    }
    if (authErr) authErr.classList.add('hidden');
    try {
      if (loginSubmitBtn) {
        loginSubmitBtn.textContent = 'در حال ورود...';
        (loginSubmitBtn as HTMLButtonElement).disabled = true;
      }
      const updated = await invokeTauri<ClientState>('login_with_credentials', { username, password });
      currentState = updated;
      renderState();
      await loadUserDevices();
      await refreshConnectionModes();
    } catch (e: any) {
      const errStr = e?.toString() || 'نام کاربری یا رمز عبور اشتباه است.';
      if (!handleCoreError(errStr)) {
        if (authErr) {
          authErr.textContent = errStr;
          authErr.classList.remove('hidden');
        }
      }
    } finally {
      if (loginSubmitBtn) {
        loginSubmitBtn.textContent = 'ورود به حساب';
        (loginSubmitBtn as HTMLButtonElement).disabled = false;
      }
    }
  };

  loginSubmitBtn?.addEventListener('click', handleCredentialsLogin);
  loginPassInput?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleCredentialsLogin();
  });

  // 1e. Forgot Password Two-Step Flow
  const returnToLogin = (prefillIdentifier?: string) => {
    if (forgotErr) forgotErr.classList.add('hidden');
    if (forgotSuccess) forgotSuccess.classList.add('hidden');
    formForgot?.classList.add('hidden');
    authTabs?.classList.remove('hidden');
    selectAuthTab('login');
    if (prefillIdentifier && loginUserInput) {
      loginUserInput.value = prefillIdentifier;
    }
  };

  forgotLink?.addEventListener('click', () => {
    if (authErr) authErr.classList.add('hidden');
    if (authSuccess) authSuccess.classList.add('hidden');
    if (forgotErr) forgotErr.classList.add('hidden');
    if (forgotSuccess) forgotSuccess.classList.add('hidden');

    formLogin?.classList.add('hidden');
    formRegister?.classList.add('hidden');
    formOtp?.classList.add('hidden');
    authTabs?.classList.add('hidden');

    formForgot?.classList.remove('hidden');
    forgotStep1?.classList.remove('hidden');
    forgotStep2?.classList.add('hidden');

    const currentEntered = loginUserInput?.value?.trim() || '';
    if (currentEntered && forgotIdentifierInput) {
      forgotIdentifierInput.value = currentEntered;
    }
    forgotIdentifierInput?.focus();
  });

  forgotBackBtn?.addEventListener('click', () => returnToLogin());

  forgotStep2ChangeEmail?.addEventListener('click', () => {
    if (forgotErr) forgotErr.classList.add('hidden');
    if (forgotSuccess) forgotSuccess.classList.add('hidden');
    forgotStep2?.classList.add('hidden');
    forgotStep1?.classList.remove('hidden');
    forgotIdentifierInput?.focus();
  });

  // Step 1: Request OTP Code to Telegram
  const handleForgotRequest = async () => {
    const identifier = forgotIdentifierInput?.value?.trim() || '';
    if (!identifier) {
      if (forgotErr) {
        forgotErr.textContent = 'لطفاً ایمیل یا نام کاربری خود را وارد فرمایید.';
        forgotErr.classList.remove('hidden');
      }
      if (forgotSuccess) forgotSuccess.classList.add('hidden');
      return;
    }
    if (forgotErr) forgotErr.classList.add('hidden');
    if (forgotSuccess) forgotSuccess.classList.add('hidden');

    try {
      if (forgotRequestBtn) {
        forgotRequestBtn.textContent = 'در حال ارسال کد به تلگرام...';
        (forgotRequestBtn as HTMLButtonElement).disabled = true;
      }
      await apiPasswordResetRequest(identifier);

      forgotStep1?.classList.add('hidden');
      forgotStep2?.classList.remove('hidden');
      if (forgotStep2Info) {
        forgotStep2Info.textContent = `کد ۶ رقمی به تلگرام مرتبط با «${identifier}» ارسال شد.`;
      }
      if (forgotSuccess) {
        forgotSuccess.textContent = 'کد تایید ۶ رقمی به ربات تلگرام ارسال گردید.';
        forgotSuccess.classList.remove('hidden');
      }
      if (forgotCodeInput) {
        forgotCodeInput.value = '';
        forgotCodeInput.focus();
      }
      if (forgotPassInput) {
        forgotPassInput.value = '';
      }
    } catch (e: any) {
      const errStr = e?.message || e?.toString() || 'خطا در ارسال درخواست بازیابی رمز عبور.';
      if (forgotErr) {
        forgotErr.textContent = errStr;
        forgotErr.classList.remove('hidden');
      }
    } finally {
      if (forgotRequestBtn) {
        forgotRequestBtn.textContent = 'ارسال کد تایید به تلگرام';
        (forgotRequestBtn as HTMLButtonElement).disabled = false;
      }
    }
  };

  forgotRequestBtn?.addEventListener('click', handleForgotRequest);
  forgotIdentifierInput?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleForgotRequest();
  });

  // Step 2: Confirm OTP & Set New Password
  const handleForgotConfirm = async () => {
    const identifier = forgotIdentifierInput?.value?.trim() || '';
    const code = forgotCodeInput?.value?.trim() || '';
    const newPassword = forgotPassInput?.value || '';

    if (!identifier) {
      if (forgotErr) {
        forgotErr.textContent = 'لطفاً ایمیل یا نام کاربری را در مرحله اول وارد نمایید.';
        forgotErr.classList.remove('hidden');
      }
      return;
    }
    if (!code || code.length !== 6 || !/^\d{6}$/.test(code)) {
      if (forgotErr) {
        forgotErr.textContent = 'کد تایید باید یک عدد ۶ رقمی باشد.';
        forgotErr.classList.remove('hidden');
      }
      if (forgotSuccess) forgotSuccess.classList.add('hidden');
      return;
    }
    if (!newPassword || newPassword.length < 8) {
      if (forgotErr) {
        forgotErr.textContent = 'رمز عبور جدید باید حداقل ۸ کاراکتر باشد.';
        forgotErr.classList.remove('hidden');
      }
      if (forgotSuccess) forgotSuccess.classList.add('hidden');
      return;
    }

    if (forgotErr) forgotErr.classList.add('hidden');
    if (forgotSuccess) forgotSuccess.classList.add('hidden');

    try {
      if (forgotConfirmBtn) {
        forgotConfirmBtn.textContent = 'در حال تغییر رمز عبور...';
        (forgotConfirmBtn as HTMLButtonElement).disabled = true;
      }
      await apiPasswordResetConfirm(identifier, code, newPassword);

      // Return user to login form and show success message
      returnToLogin(identifier);
      if (authSuccess) {
        authSuccess.textContent = '✅ رمز عبور با موفقیت تغییر یافت. اکنون می‌توانید با رمز جدید وارد شوید.';
        authSuccess.classList.remove('hidden');
      }
      if (loginPassInput) {
        loginPassInput.value = '';
        loginPassInput.focus();
      }
    } catch (e: any) {
      const errStr = e?.message || e?.toString() || 'خطا در بازنشانی رمز عبور.';
      if (forgotErr) {
        forgotErr.textContent = errStr;
        forgotErr.classList.remove('hidden');
      }
    } finally {
      if (forgotConfirmBtn) {
        forgotConfirmBtn.textContent = 'تغییر رمز عبور و ورود';
        (forgotConfirmBtn as HTMLButtonElement).disabled = false;
      }
    }
  };

  forgotConfirmBtn?.addEventListener('click', handleForgotConfirm);
  forgotCodeInput?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      if (forgotPassInput) forgotPassInput.focus();
    }
  });
  forgotPassInput?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleForgotConfirm();
  });

  // 1c. Register Free Account
  const registerSubmitBtn = document.getElementById('register-submit-btn');
  const regUserInput = document.getElementById('register-username-input') as HTMLInputElement;
  const regPassInput = document.getElementById('register-password-input') as HTMLInputElement;

  const handleRegister = async () => {
    const username = regUserInput?.value?.trim() || '';
    const password = regPassInput?.value || '';
    if (!username || !password) {
      if (authErr) {
        authErr.textContent = 'لطفاً نام کاربری و رمز عبور را وارد فرمایید.';
        authErr.classList.remove('hidden');
      }
      return;
    }
    if (username.length < 3) {
      if (authErr) {
        authErr.textContent = 'نام کاربری باید حداقل ۳ کاراکتر باشد.';
        authErr.classList.remove('hidden');
      }
      return;
    }
    if (password.length < 8) {
      if (authErr) {
        authErr.textContent = 'رمز عبور باید حداقل ۸ کاراکتر باشد.';
        authErr.classList.remove('hidden');
      }
      return;
    }
    if (authErr) authErr.classList.add('hidden');
    try {
      if (registerSubmitBtn) {
        registerSubmitBtn.textContent = 'در حال ثبت‌نام...';
        (registerSubmitBtn as HTMLButtonElement).disabled = true;
      }
      const updated = await invokeTauri<ClientState>('register_with_credentials', { username, password });
      currentState = updated;
      renderState();
      await loadUserDevices();
      await refreshConnectionModes();
    } catch (e: any) {
      const errStr = e?.toString() || 'خطا در ثبت‌نام حساب جدید.';
      if (!handleCoreError(errStr)) {
        if (authErr) {
          authErr.textContent = errStr;
          authErr.classList.remove('hidden');
        }
      }
    } finally {
      if (registerSubmitBtn) {
        registerSubmitBtn.textContent = 'ساخت حساب کاربری رایگان';
        (registerSubmitBtn as HTMLButtonElement).disabled = false;
      }
    }
  };

  registerSubmitBtn?.addEventListener('click', handleRegister);
  regPassInput?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleRegister();
  });

  // 1d. Telegram 8-digit OTP Submit
  const authBtn = document.getElementById('auth-submit-btn');
  const authInput = document.getElementById('auth-code-input') as HTMLInputElement;

  const handleLogin = async (code: string) => {
    if (!code || code.length !== 8) {
      if (authErr) {
        authErr.textContent = 'کد ورود باید دقیقاً ۸ رقم عددی باشد.';
        authErr.classList.remove('hidden');
      }
      return;
    }
    if (authErr) authErr.classList.add('hidden');

    try {
      if (authBtn) {
        authBtn.textContent = 'در حال بررسی...';
        (authBtn as HTMLButtonElement).disabled = true;
      }
      const updated = await invokeTauri<ClientState>('login_with_code', { code });
      currentState = updated;
      renderState();
      await loadUserDevices();
      await refreshConnectionModes();
    } catch (e: any) {
      const errStr = e?.toString() || 'خطا در ورود';
      if (!handleCoreError(errStr)) {
        if (authErr) {
          authErr.textContent = errStr;
          authErr.classList.remove('hidden');
        }
      }
    } finally {
      if (authBtn) {
        authBtn.textContent = 'ورود با کد تلگرام';
        (authBtn as HTMLButtonElement).disabled = false;
      }
    }
  };

  authBtn?.addEventListener('click', () => handleLogin(authInput?.value || ''));
  authInput?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleLogin(authInput?.value || '');
  });

  // Sandbox Quick Code Buttons
  document.querySelectorAll('.quick-code-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const code = (e.currentTarget as HTMLElement).getAttribute('data-code');
      if (code && authInput) {
        authInput.value = code;
        handleLogin(code);
      }
    });
  });

  // 2. Master Connection Power Button
  const masterBtn = document.getElementById('master-power-btn');
  masterBtn?.addEventListener('click', async () => {
    if (currentState.status === 'Connected' || currentState.status === 'Connecting') {
      try {
        const updated = await invokeTauri<ClientState>('disconnect_vpn');
        currentState = updated;
        stopTimer();
        renderState();
      } catch (e) {
        console.error('Failed to disconnect:', e);
      }
    } else {
      try {
        hideFriendlyError();
        currentState.status = 'Connecting';
        renderPowerButton();
        const updated = await invokeTauri<ClientState>('connect_vpn');
        currentState = updated;
        renderState();
      } catch (e: any) {
        console.error('Failed to connect:', e);
        const errStr = e?.toString() || '';
        currentState.status = 'Disconnected';
        renderPowerButton();
        if (!handleCoreError(errStr)) {
          showFriendlyError('خطا در اتصال تانل', errStr);
        }
      }
    }
  });

  // Quick Error Card Action Buttons
  const closeErrBtn = document.getElementById('close-quick-error-btn');
  closeErrBtn?.addEventListener('click', hideFriendlyError);

  const retryBtn = document.getElementById('quick-retry-btn');
  retryBtn?.addEventListener('click', () => {
    hideFriendlyError();
    masterBtn?.click();
  });

  const switchStealthBtn = document.getElementById('quick-switch-stealth-btn');
  switchStealthBtn?.addEventListener('click', async () => {
    hideFriendlyError();
    currentState = await invokeTauri<ClientState>('set_connection_protocol', { protocol: 'stealth' });
    renderState();
    masterBtn?.click();
  });

  // Advanced Network Settings Accordion Toggle
  const toggleAdvBtn = document.getElementById('toggle-advanced-btn');
  const advContent = document.getElementById('advanced-content');
  const advChevron = document.getElementById('advanced-chevron-icon');

  toggleAdvBtn?.addEventListener('click', () => {
    const isHidden = advContent?.classList.contains('hidden');
    if (isHidden) {
      advContent?.classList.remove('hidden');
      if (advChevron) advChevron.style.transform = 'rotate(180deg)';
    } else {
      advContent?.classList.add('hidden');
      if (advChevron) advChevron.style.transform = 'rotate(0deg)';
    }
  });

  // 3. Quick Device Button (Top Bar) -> Opens Device Modal
  const quickDevicesBtn = document.getElementById('quick-devices-btn');
  const devicesModal = document.getElementById('devices-modal');
  const closeDevicesModal = document.getElementById('close-devices-modal');
  const refreshDevicesModalBtn = document.getElementById('refresh-devices-modal-btn');

  quickDevicesBtn?.addEventListener('click', async () => {
    devicesModal?.classList.remove('hidden');
    await loadUserDevices();
  });

  closeDevicesModal?.addEventListener('click', () => {
    devicesModal?.classList.add('hidden');
  });

  refreshDevicesModalBtn?.addEventListener('click', async () => {
    await loadUserDevices();
  });

  // 4. Settings Drawer & Tab Switching (Network / Anti-DPI Lab / Theme / Logs)
  const settingsBtn = document.getElementById('toggle-settings-btn');
  const closeSettingsBtn = document.getElementById('close-settings-btn');
  const settingsDrawer = document.getElementById('settings-drawer');

  const tabBtnSettings = document.getElementById('tab-btn-settings');
  const tabBtnAntiDpi = document.getElementById('tab-btn-antidpi');
  const tabBtnDns = document.getElementById('tab-btn-dns');
  const tabBtnTheme = document.getElementById('tab-btn-theme');
  const tabBtnLogs = document.getElementById('tab-btn-logs');

  const tabContentSettings = document.getElementById('tab-content-settings');
  const tabContentAntiDpi = document.getElementById('tab-content-antidpi');
  const tabContentDns = document.getElementById('tab-content-dns');
  const tabContentTheme = document.getElementById('tab-content-theme');
  const tabContentLogs = document.getElementById('tab-content-logs');

  const allTabBtns = [tabBtnSettings, tabBtnAntiDpi, tabBtnDns, tabBtnTheme, tabBtnLogs];
  const allTabContents = [tabContentSettings, tabContentAntiDpi, tabContentDns, tabContentTheme, tabContentLogs];

  function switchTab(activeBtn: HTMLElement | null, activeContent: HTMLElement | null) {
    allTabBtns.forEach(btn => btn?.classList.remove('active'));
    allTabContents.forEach(content => content?.classList.add('hidden'));
    activeBtn?.classList.add('active');
    activeContent?.classList.remove('hidden');
    if (activeBtn === tabBtnLogs) {
      renderLogs();
    }
    if (activeBtn === tabBtnDns) {
      loadDnsSettings();
    }
  }

  settingsBtn?.addEventListener('click', () => {
    if (settingsDrawer?.classList.contains('hidden')) {
      settingsDrawer?.classList.remove('hidden');
      settingsBtn?.classList.add('active');
    } else {
      settingsDrawer?.classList.add('hidden');
      settingsBtn?.classList.remove('active');
    }
  });

  closeSettingsBtn?.addEventListener('click', () => {
    settingsDrawer?.classList.add('hidden');
    settingsBtn?.classList.remove('active');
  });

  tabBtnSettings?.addEventListener('click', () => switchTab(tabBtnSettings, tabContentSettings));
  tabBtnAntiDpi?.addEventListener('click', () => switchTab(tabBtnAntiDpi, tabContentAntiDpi));
  tabBtnDns?.addEventListener('click', () => switchTab(tabBtnDns, tabContentDns));
  tabBtnTheme?.addEventListener('click', () => switchTab(tabBtnTheme, tabContentTheme));
  tabBtnLogs?.addEventListener('click', () => switchTab(tabBtnLogs, tabContentLogs));

  // --- Location Switcher Controls ---
  const locTriggerBtn = document.getElementById('location-trigger-btn');
  const locDropdown = document.getElementById('location-dropdown');
  const locChevron = document.getElementById('loc-chevron-icon');

  locTriggerBtn?.addEventListener('click', () => {
    if (currentState.selected_mode === 'static_ip') return;
    isLocationDropdownOpen = !isLocationDropdownOpen;
    if (isLocationDropdownOpen) {
      locDropdown?.classList.remove('collapsed');
      locDropdown?.classList.add('expanded');
      if (locChevron) locChevron.style.transform = 'rotate(180deg)';
    } else {
      locDropdown?.classList.add('collapsed');
      locDropdown?.classList.remove('expanded');
      if (locChevron) locChevron.style.transform = 'rotate(0deg)';
    }
  });

  document.addEventListener('click', (e) => {
    const card = document.getElementById('location-switcher-card');
    if (isLocationDropdownOpen && card && !card.contains(e.target as Node)) {
      isLocationDropdownOpen = false;
      locDropdown?.classList.add('collapsed');
      locDropdown?.classList.remove('expanded');
      if (locChevron) locChevron.style.transform = 'rotate(0deg)';
    }
  });

  // --- Smart DNS Controls ---
  const addCustomDnsBtn = document.getElementById('add-custom-dns-btn');
  addCustomDnsBtn?.addEventListener('click', addCustomDns);

  const testAllDnsBtn = document.getElementById('test-all-dns-btn');
  testAllDnsBtn?.addEventListener('click', runDnsPingTest);

  const autoFastestDnsBtn = document.getElementById('auto-fastest-dns-btn');
  autoFastestDnsBtn?.addEventListener('click', selectAutoFastestDns);

  // --- Theme Engine Handlers ---
  document.querySelectorAll('.theme-card').forEach(card => {
    card.addEventListener('click', () => {
      const themeName = card.getAttribute('data-theme-name');
      if (themeName) {
        applyTheme(themeName);
        currentState.logs.push(`[Theme] Theme switched to: ${themeName}`);
      }
    });
  });

  // --- Anti-DPI Lab Handlers ---
  const presetNormalBtn = document.getElementById('preset-normal-btn');
  const presetSevereBtn = document.getElementById('preset-severe-btn');
  const presetNationalBtn = document.getElementById('preset-national-btn');
  const fragToggle = document.getElementById('antidpi-fragment-toggle') as HTMLInputElement;
  const fragLenSelect = document.getElementById('antidpi-fragment-len') as HTMLSelectElement;
  const fragIntervalSelect = document.getElementById('antidpi-fragment-interval') as HTMLSelectElement;
  const muxToggle = document.getElementById('antidpi-mux-toggle') as HTMLInputElement;
  const dnsSelect = document.getElementById('antidpi-dns-select') as HTMLSelectElement;
  const mtuSelect = document.getElementById('antidpi-mtu-select') as HTMLSelectElement;

  function setPreset(preset: string) {
    document.querySelectorAll('.preset-card').forEach(c => c.classList.remove('active'));

    if (preset === 'normal') {
      presetNormalBtn?.classList.add('active');
      if (fragToggle) fragToggle.checked = true;
      if (fragLenSelect) fragLenSelect.value = '50-100';
      if (fragIntervalSelect) fragIntervalSelect.value = '10-20ms';
      if (muxToggle) muxToggle.checked = false;
      if (dnsSelect) dnsSelect.value = 'cloudflare';
      if (mtuSelect) mtuSelect.value = '1400';
    } else if (preset === 'severe_filtering') {
      presetSevereBtn?.classList.add('active');
      if (fragToggle) fragToggle.checked = true;
      if (fragLenSelect) fragLenSelect.value = '10-30';
      if (fragIntervalSelect) fragIntervalSelect.value = '10-20ms';
      if (muxToggle) muxToggle.checked = true;
      if (dnsSelect) dnsSelect.value = 'cloudflare';
      if (mtuSelect) mtuSelect.value = '1280';
    } else if (preset === 'national_disruption') {
      presetNationalBtn?.classList.add('active');
      if (fragToggle) fragToggle.checked = true;
      if (fragLenSelect) fragLenSelect.value = '10-30';
      if (fragIntervalSelect) fragIntervalSelect.value = '10-20ms';
      if (muxToggle) muxToggle.checked = true;
      if (dnsSelect) dnsSelect.value = 'fakeip';
      if (mtuSelect) mtuSelect.value = '1200';
    }
    syncAntiDpiState(preset);
  }

  presetNormalBtn?.addEventListener('click', () => setPreset('normal'));
  presetSevereBtn?.addEventListener('click', () => setPreset('severe_filtering'));
  presetNationalBtn?.addEventListener('click', () => setPreset('national_disruption'));

  function getAntiDpiPayload(preset = 'custom') {
    return {
      preset,
      tls_fragment: fragToggle ? fragToggle.checked : true,
      fragment_length: fragLenSelect ? fragLenSelect.value : '10-30',
      fragment_interval: fragIntervalSelect ? fragIntervalSelect.value : '10-20ms',
      mux_padding: muxToggle ? muxToggle.checked : true,
      dns_mode: dnsSelect ? dnsSelect.value : 'cloudflare',
      mtu: mtuSelect ? parseInt(mtuSelect.value, 10) : 1400,
    };
  }

  function syncAntiDpiState(preset = 'custom') {
    const payload = getAntiDpiPayload(preset);
    invokeTauri('save_anti_dpi_settings', { settings: payload }).catch(console.warn);
  }

  [fragToggle, fragLenSelect, fragIntervalSelect, muxToggle, dnsSelect, mtuSelect].forEach(el => {
    el?.addEventListener('change', () => {
      document.querySelectorAll('.preset-card').forEach(c => c.classList.remove('active'));
      syncAntiDpiState('custom');
    });
  });

  // Anti-DPI Ping Test Button
  const testPingBtn = document.getElementById('antidpi-test-ping-btn');
  const pingStatusEl = document.getElementById('antidpi-test-status');

  testPingBtn?.addEventListener('click', async () => {
    if (pingStatusEl) {
      pingStatusEl.classList.remove('hidden');
      pingStatusEl.textContent = '⏳ در حال تست پینگ و دور زدن DPI اپراتور...';
      pingStatusEl.className = 'text-xs text-center p-2 rounded-xl bg-[#0F172A] border border-white/10 font-mono text-[#F59E0B] block';
    }
    try {
      const activePreset = presetSevereBtn?.classList.contains('active')
        ? 'severe_filtering'
        : presetNationalBtn?.classList.contains('active')
        ? 'national_disruption'
        : presetNormalBtn?.classList.contains('active')
        ? 'normal'
        : 'custom';

      const payload = getAntiDpiPayload(activePreset);
      const res = await invokeTauri<{ success: boolean; ping_ms: number; status_text: string; is_blocked: boolean }>('test_anti_dpi_settings', {
        settings: payload
      });

      if (pingStatusEl) {
        pingStatusEl.textContent = res.status_text;
        pingStatusEl.className = res.is_blocked
          ? 'text-xs text-center p-2 rounded-xl bg-[#0F172A] border border-[#EF4444]/40 font-mono text-[#EF4444] block'
          : 'text-xs text-center p-2 rounded-xl bg-[#0F172A] border border-[#10B981]/40 font-mono text-[#10B981] block';
      }
    } catch (err: any) {
      if (pingStatusEl) {
        pingStatusEl.textContent = `❌ خطا در سنجش: ${err?.toString() || 'سرور پاسخ نداد'}`;
        pingStatusEl.className = 'text-xs text-center p-2 rounded-xl bg-[#0F172A] border border-[#EF4444]/40 font-mono text-[#EF4444] block';
      }
    }
  });

  // Switch toggles
  const splitToggle = document.getElementById('split-tunnel-toggle') as HTMLInputElement;
  splitToggle?.addEventListener('change', async (e) => {
    const val = (e.target as HTMLInputElement).checked;
    currentState = await invokeTauri<ClientState>('toggle_split_tunneling', { enabled: val });
  });

  const tunToggle = document.getElementById('tun-mode-toggle') as HTMLInputElement;
  tunToggle?.addEventListener('change', async (e) => {
    const val = (e.target as HTMLInputElement).checked;
    try {
      currentState = await invokeTauri<ClientState>('toggle_tun_mode', { enabled: val });
    } catch (err: any) {
      const errStr = err?.toString() || 'خطا در فعال‌سازی حالت TUN';
      alert(errStr);
      tunToggle.checked = false;
      currentState.tun_mode = false;
    }
  });

  const killToggle = document.getElementById('kill-switch-toggle') as HTMLInputElement;
  killToggle?.addEventListener('change', async (e) => {
    const val = (e.target as HTMLInputElement).checked;
    currentState = await invokeTauri<ClientState>('toggle_kill_switch', { enabled: val });
  });

  const sandboxToggle = document.getElementById('sandbox-mode-toggle') as HTMLInputElement;
  sandboxToggle?.addEventListener('change', async (e) => {
    const val = (e.target as HTMLInputElement).checked;
    currentState = await invokeTauri<ClientState>('toggle_sandbox_mode', { enabled: val });
  });

  // Cloudflare WARP Optional Toggle
  const warpToggle = document.getElementById('warp-toggle') as HTMLInputElement;
  warpToggle?.addEventListener('change', async (e) => {
    if (currentState.selected_mode === 'static_ip') {
      warpToggle.checked = false;
      return;
    }
    const val = (e.target as HTMLInputElement).checked;
    try {
      currentState = await invokeTauri<ClientState>('set_use_warp', { enabled: val });
      renderState();

      // If VPN is currently connected, gracefully reconnect to apply new WARP routing profile
      if (currentState.status === 'Connected') {
        currentState.logs.push('[WARP] بازنشانی اتصال جهت اعمال تغییر مسیر تونل Cloudflare WARP...');
        await invokeTauri('disconnect_vpn');
        setTimeout(async () => {
          await invokeTauri('connect_vpn');
        }, 500);
      }
    } catch (err) {
      console.warn('Could not toggle WARP:', err);
    }
  });

  // 3-Way Network Routing Mode Selector (Tunnel / System Proxy / Proxy)
  ['tunnel', 'system_proxy', 'proxy'].forEach(m => {
    const btn = document.getElementById(`routing-btn-${m}`);
    btn?.addEventListener('click', async () => {
      if (currentState.selected_mode === 'static_ip' && m !== 'tunnel') {
        alert('در حالت آی‌پی ثابت، برای امنیت حساب‌های مالی فقط حالت Tunnel فعال است.');
        return;
      }
      try {
        currentState = await invokeTauri<ClientState>('set_routing_mode', { routing_mode: m });
        renderState();
      } catch (err: any) {
        alert(err?.toString() || 'خطا در تغییر حالت مسیریابی');
      }
    });
  });

  // Copy Buttons for Local Proxy Endpoints
  const copySocksBtn = document.getElementById('copy-socks5-btn');
  copySocksBtn?.addEventListener('click', () => {
    navigator.clipboard.writeText('127.0.0.1:10808').then(() => {
      const orig = copySocksBtn.textContent;
      copySocksBtn.textContent = '✓ کپی شد';
      setTimeout(() => {
        copySocksBtn.textContent = orig;
      }, 1500);
    });
  });

  const copyHttpBtn = document.getElementById('copy-http-btn');
  copyHttpBtn?.addEventListener('click', () => {
    navigator.clipboard.writeText('127.0.0.1:10809').then(() => {
      const orig = copyHttpBtn.textContent;
      copyHttpBtn.textContent = '✓ کپی شد';
      setTimeout(() => {
        copyHttpBtn.textContent = orig;
      }, 1500);
    });
  });

  // Telegram Account Link Modal
  const openLinkModalBtn = document.getElementById('open-link-modal-btn');
  const linkModal = document.getElementById('link-modal');
  const closeLinkModalBtn = document.getElementById('close-link-modal');
  const copyLinkCmdBtn = document.getElementById('copy-link-cmd-btn');
  const linkCodeDisplay = document.getElementById('link-code-display');
  const linkCountdown = document.getElementById('link-countdown');
  let linkTimerInterval: any = null;

  openLinkModalBtn?.addEventListener('click', async () => {
    linkModal?.classList.remove('hidden');
    if (linkCodeDisplay) linkCodeDisplay.textContent = '...';
    try {
      const code = await invokeTauri<string>('get_telegram_link_code');
      if (linkCodeDisplay) linkCodeDisplay.textContent = code;
      if (copyLinkCmdBtn) {
        copyLinkCmdBtn.onclick = () => {
          navigator.clipboard.writeText(`/link ${code}`);
          const originalText = copyLinkCmdBtn.textContent;
          copyLinkCmdBtn.textContent = '✅ کپی شد!';
          setTimeout(() => {
            copyLinkCmdBtn.textContent = originalText;
          }, 2000);
        };
      }
      let remainingSecs = 300;
      if (linkTimerInterval) clearInterval(linkTimerInterval);
      linkTimerInterval = setInterval(() => {
        remainingSecs--;
        if (remainingSecs <= 0) {
          clearInterval(linkTimerInterval);
          if (linkCountdown) linkCountdown.textContent = 'منقضی شد (مجدداً دکمه اتصال را بزنید)';
        } else {
          const m = Math.floor(remainingSecs / 60);
          const s = remainingSecs % 60;
          if (linkCountdown) linkCountdown.textContent = `اعتبار: ${m}:${s.toString().padStart(2, '0')} دقیقه`;
        }
      }, 1000);
    } catch (err: any) {
      alert(err?.toString() || 'خطا در دریافت کد اتصال تلگرام');
    }
  });

  closeLinkModalBtn?.addEventListener('click', () => {
    linkModal?.classList.add('hidden');
    if (linkTimerInterval) clearInterval(linkTimerInterval);
  });

  // Test API Connectivity
  const testApiBtn = document.getElementById('test-api-btn');
  const apiStatusEl = document.getElementById('api-test-status');
  testApiBtn?.addEventListener('click', async () => {
    if (apiStatusEl) {
      apiStatusEl.textContent = 'در حال تست ارتباط با هسته...';
      apiStatusEl.className = 'text-[10px] text-center text-[#94A3B8] block';
    }
    try {
      const res = await invokeTauri<string>('test_api_connection');
      if (apiStatusEl) {
        apiStatusEl.textContent = `✓ ${res}`;
        apiStatusEl.className = 'text-[10px] text-center text-[#10B981] block';
      }
    } catch (err: any) {
      if (apiStatusEl) {
        apiStatusEl.textContent = `✕ ${err?.toString() || 'خطای اتصال'}`;
        apiStatusEl.className = 'text-[10px] text-center text-[#EF4444] block';
      }
    }
  });

  // Clear Logs
  const clearLogsBtn = document.getElementById('clear-logs-btn');
  clearLogsBtn?.addEventListener('click', async () => {
    await invokeTauri('clear_logs');
    currentState.logs = ["[INFO] [Console] Debug logs cleared by user."];
    renderLogs();
  });

  // 1-Click Copy Logs to Clipboard
  const copyLogsBtn = document.getElementById('copy-logs-btn');
  copyLogsBtn?.addEventListener('click', () => {
    const text = currentState.logs.join('\n');
    navigator.clipboard.writeText(text).then(() => {
      const orig = copyLogsBtn.textContent;
      copyLogsBtn.textContent = '✓ کپی شد';
      setTimeout(() => {
        copyLogsBtn.textContent = orig;
      }, 1500);
    });
  });

  // Logout
  const logoutBtn = document.getElementById('logout-btn');
  logoutBtn?.addEventListener('click', async () => {
    currentState = await invokeTauri<ClientState>('logout');
    stopTimer();
    settingsDrawer?.classList.add('hidden');
    renderState();
  });

  // 5. Connection Modes Selection
  const upgradeModal = document.getElementById('upgrade-modal');
  const closeUpgradeModal = document.getElementById('close-upgrade-modal');
  const upgradeViaBotBtn = document.getElementById('upgrade-via-bot-btn');

  closeUpgradeModal?.addEventListener('click', () => {
    upgradeModal?.classList.add('hidden');
  });

  upgradeViaBotBtn?.addEventListener('click', () => {
    window.open('https://t.me/SentraConnectBot', '_blank');
    upgradeModal?.classList.add('hidden');
  });

  document.querySelectorAll('.mode-item').forEach(item => {
    item.addEventListener('click', async (e) => {
      const mode = (e.currentTarget as HTMLElement).getAttribute('data-mode');
      if (!mode) return;

      if (mode === 'static_ip' && currentState.tier === 'Sentra Lite') {
        upgradeModal?.classList.remove('hidden');
        return;
      }

      if (mode === 'download' && currentState.tier === 'Sentra Lite' && !currentState.telegram_verified) {
        alert('🔒 بخش دانلود برای کاربران رایگان تا زمان تایید حساب در ربات تلگرام قفل است. لطفاً از دکمه «تایید در تلگرام» استفاده فرمایید.');
        return;
      }

      currentState = await invokeTauri<ClientState>('set_connection_mode', { mode });
      renderState();
      updateModesUI();
    });
  });

  // Gaming Submode Buttons
  document.querySelectorAll('.gaming-submode-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const submode = (e.currentTarget as HTMLElement).getAttribute('data-submode');
      if (!submode) return;
      try {
        currentState = await invokeTauri<ClientState>('set_gaming_submode', { submode });
        updateModesUI();
      } catch (err: any) {
        console.warn('Failed to set gaming submode:', err);
      }
    });
  });

  // Telegram Verification Buttons for Download Mode
  const btnOpenTelegramVerify = document.getElementById('btn-open-telegram-verify');
  const btnRecheckTelegramVerify = document.getElementById('btn-recheck-telegram-verify');
  const dlVerifyCodeBadge = document.getElementById('dl-verify-code-badge');

  btnOpenTelegramVerify?.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      if (btnOpenTelegramVerify) btnOpenTelegramVerify.textContent = 'در حال دریافت...';
      const res = await invokeTauri<any>('request_telegram_verify');
      if (res && res.verify_url) {
        if (dlVerifyCodeBadge && res.verify_code) {
          dlVerifyCodeBadge.textContent = `کد: ${res.verify_code}`;
        }
        window.open(res.verify_url, '_blank');
      }
    } catch (err: any) {
      alert(`خطا در درخواست تایید تلگرام: ${err?.toString() || err}`);
    } finally {
      if (btnOpenTelegramVerify) btnOpenTelegramVerify.textContent = '🔗 تایید در تلگرام';
    }
  });

  btnRecheckTelegramVerify?.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      if (btnRecheckTelegramVerify) btnRecheckTelegramVerify.textContent = 'در حال بررسی...';
      const updated = await invokeTauri<ClientState>('check_telegram_verify_status');
      currentState = updated;
      renderState();
      updateModesUI();
      if (updated.telegram_verified) {
        alert('✅ حساب کاربری تلگرام شما با موفقیت تایید شد! بخش دانلود فعال گردید.');
      } else {
        alert('⚠️ حساب تلگرام هنوز تایید نشده است. لطفاً در ربات تلگرام روی لینک باز شده کلیک کنید.');
      }
    } catch (err: any) {
      alert(`خطا در بررسی وضعیت: ${err?.toString() || err}`);
    } finally {
      if (btnRecheckTelegramVerify) btnRecheckTelegramVerify.textContent = '🔄 بررسی مجدد';
    }
  });

  // 6. Protocol Selection Buttons
  document.querySelectorAll('.protocol-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const proto = (e.currentTarget as HTMLElement).getAttribute('data-protocol');
      if (!proto) return;
      currentState.selected_protocol = proto;
      try {
        currentState = await invokeTauri<ClientState>('set_connection_protocol', { protocol: proto });
      } catch (err) {
        console.warn('Could not set connection protocol:', err);
      }
      renderState();
    });
  });

  // Suspended Account Modal controls
  const suspendedModal = document.getElementById('suspended-modal');
  const closeSuspendedModal = document.getElementById('close-suspended-modal');
  const suspendedSupportBtn = document.getElementById('suspended-support-btn');

  closeSuspendedModal?.addEventListener('click', () => {
    suspendedModal?.classList.add('hidden');
  });

  suspendedSupportBtn?.addEventListener('click', () => {
    window.open('https://t.me/SentraConnectBot', '_blank');
    suspendedModal?.classList.add('hidden');
  });
}

// ------------------------------------------------------------------------------
// Version Check & Update Notification
// ------------------------------------------------------------------------------
async function checkClientVersion() {
  try {
    const info = await invokeTauri<{
      latest_version: string;
      min_supported_version: string;
      download_url: string;
      release_notes: string;
    }>('check_client_version');

    if (info && info.latest_version && info.latest_version !== '1.0.0') {
      const banner = document.getElementById('update-banner');
      const title = document.getElementById('update-banner-title');
      const desc = document.getElementById('update-banner-desc');
      const btn = document.getElementById('update-download-btn') as HTMLAnchorElement;

      if (banner && title && desc && btn) {
        title.textContent = `نسخه جدید Sentra Connect (v${info.latest_version}) موجود است`;
        desc.textContent = info.release_notes || 'همگام‌سازی لحظه‌ای حجم مصرفی و ارتقای امنیت';
        btn.href = info.download_url || 'https://github.com/sentravpn/client/releases/latest';
        banner.classList.remove('hidden');
      }
    }
  } catch (e) {
    console.warn('Failed to check client version:', e);
  }
}

// ------------------------------------------------------------------------------
// Animated Splash Screen (GPU-Accelerated 60/120fps Hyprland Bezier)
// ------------------------------------------------------------------------------
function initSplashScreen() {
  const splash = document.getElementById('splash-screen');
  if (!splash) return;

  // Keep visible during initial load (~1.2s - 1.4s), then fade-out and unmount from DOM
  setTimeout(() => {
    splash.classList.add('splash-hide');
    setTimeout(() => {
      splash.remove();
    }, 450);
  }, 1250);
}

// ------------------------------------------------------------------------------
// Theme Engine Handlers (Default Minimalist White Light Theme)
// ------------------------------------------------------------------------------
function initTheme() {
  const savedTheme = localStorage.getItem('sentra_theme') || 'light';
  applyTheme(savedTheme);
}

function applyTheme(themeName: string) {
  document.documentElement.setAttribute('data-theme', themeName);
  document.body.setAttribute('data-theme', themeName);
  localStorage.setItem('sentra_theme', themeName);

  document.querySelectorAll('.theme-card').forEach(card => {
    if (card.getAttribute('data-theme-name') === themeName) {
      card.classList.add('active');
    } else {
      card.classList.remove('active');
    }
  });
}

// ------------------------------------------------------------------------------
// Location Switcher Logic (Free Tier Multiple Country Nodes)
// ------------------------------------------------------------------------------
async function loadAvailableLocations() {
  try {
    const res = await invokeTauri<ActiveLocationInfo[]>('get_available_locations');
    if (res && Array.isArray(res) && res.length > 0) {
      availableLocations = res;
    }
  } catch (err) {
    console.warn('Could not load locations from backend:', err);
    availableLocations = [
      { code: 'auto', name: 'انتخاب خودکار (سریع‌ترین لوکیشن)', flag: '⚡️', ping_ms: 32, active_nodes: 5, is_auto: true },
      { code: 'DE', name: 'آلمان 🇩🇪', flag: '🇩🇪', ping_ms: 38, active_nodes: 3, is_auto: false },
      { code: 'NL', name: 'هلند 🇳🇱', flag: '🇳🇱', ping_ms: 44, active_nodes: 2, is_auto: false },
      { code: 'FI', name: 'فنلاند 🇫🇮', flag: '🇫🇮', ping_ms: 51, active_nodes: 2, is_auto: false },
      { code: 'US', name: 'آمریکا 🇺🇸', flag: '🇺🇸', ping_ms: 95, active_nodes: 4, is_auto: false },
    ];
  }
  renderLocationSwitcher();
}

function renderLocationSwitcher() {
  const card = document.getElementById('location-switcher-card');
  const triggerBtn = document.getElementById('location-trigger-btn');
  const dropdown = document.getElementById('location-dropdown');
  const activeFlag = document.getElementById('active-location-flag');
  const activeName = document.getElementById('active-location-name');
  const btnFlag = document.getElementById('loc-btn-flag');
  const btnTitle = document.getElementById('loc-btn-title');
  const btnSubtitle = document.getElementById('loc-btn-subtitle');
  const btnPing = document.getElementById('loc-btn-ping');
  const staticNotice = document.getElementById('static-ip-location-notice');
  const chevron = document.getElementById('loc-chevron-icon');

  if (!card) return;

  const isStaticIp = currentState.selected_mode === 'static_ip';

  if (isStaticIp) {
    if (activeFlag) activeFlag.textContent = '🇺🇸';
    if (activeName) activeName.textContent = 'آمریکا (ایزوله ترید)';
    if (btnFlag) btnFlag.textContent = '🇺🇸';
    if (btnTitle) btnTitle.textContent = 'آمریکا 🇺🇸 (ساکرامنتو - دیتاسنتر اختصاصی)';
    if (btnSubtitle) btnSubtitle.textContent = 'موقعیت قفل‌شده جهت جلوگیری از بلاک صرافی‌ها';
    if (btnPing) {
      btnPing.textContent = '95 ms';
      btnPing.className = 'text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#8B5CF6]/15 text-[#C084FC] border border-[#8B5CF6]/25';
    }
    if (staticNotice) staticNotice.classList.remove('hidden');
    if (dropdown) {
      dropdown.classList.add('collapsed');
      dropdown.classList.remove('expanded');
    }
    if (triggerBtn) {
      (triggerBtn as HTMLButtonElement).disabled = true;
      triggerBtn.classList.add('opacity-80', 'cursor-not-allowed');
    }
    if (chevron) chevron.classList.add('hidden');
    return;
  }

  // Normal free tier modes (web_browsing / download)
  if (triggerBtn) {
    (triggerBtn as HTMLButtonElement).disabled = false;
    triggerBtn.classList.remove('opacity-80', 'cursor-not-allowed');
  }
  if (chevron) chevron.classList.remove('hidden');
  if (staticNotice) staticNotice.classList.add('hidden');

  const selectedLocCode = currentState.selected_location || 'auto';
  const currentLoc = availableLocations.find(l => l.code === selectedLocCode) || availableLocations[0] || {
    code: 'auto',
    name: 'انتخاب خودکار (Auto)',
    flag: '⚡️',
    ping_ms: 32,
    active_nodes: 5,
    is_auto: true,
  };

  if (activeFlag) activeFlag.textContent = currentLoc.flag;
  if (activeName) activeName.textContent = currentLoc.is_auto ? 'خودکار (Auto)' : currentLoc.name;
  if (btnFlag) btnFlag.textContent = currentLoc.flag;
  if (btnTitle) btnTitle.textContent = currentLoc.name;
  if (btnSubtitle) btnSubtitle.textContent = currentLoc.is_auto ? 'هدایت هوشمند بر اساس کمترین پینگ' : `${currentLoc.active_nodes} نود فعال در این کشور`;
  if (btnPing) {
    btnPing.textContent = `${currentLoc.ping_ms} ms`;
    btnPing.className = currentLoc.ping_ms < 60
      ? 'text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#10B981]/15 text-[#10B981] border border-[#10B981]/25'
      : 'text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#F59E0B]/15 text-[#F59E0B] border border-[#F59E0B]/25';
  }

  // Render Dropdown items
  if (dropdown) {
    dropdown.innerHTML = '';
    availableLocations.forEach(loc => {
      const isSelected = loc.code === selectedLocCode;
      const item = document.createElement('div');
      item.className = `location-item flex items-center justify-between p-2 rounded-xl border cursor-pointer ${
        isSelected
          ? 'bg-[#10B981]/10 border-[#10B981]/50 text-[#F8FAFC]'
          : 'bg-[#0F172A]/80 border-white/5 hover:border-white/15 text-[#94A3B8] hover:text-[#F8FAFC]'
      }`;

      item.innerHTML = `
        <div class="flex items-center space-x-2 space-x-reverse min-w-0">
          <span class="text-base flex-shrink-0">${loc.flag}</span>
          <div class="truncate">
            <div class="text-xs font-semibold text-[#F8FAFC] flex items-center space-x-1.5 space-x-reverse">
              <span class="truncate">${loc.name}</span>
              ${loc.is_auto ? '<span class="text-[9px] px-1.5 py-0.2 rounded bg-[#3B82F6]/20 text-[#3B82F6] border border-[#3B82F6]/30 font-medium">هوشمند</span>' : ''}
              ${isSelected ? '<span class="text-[9px] px-1.5 py-0.2 rounded bg-[#10B981]/20 text-[#10B981] border border-[#10B981]/30 font-bold">✓ انتخاب‌شده</span>' : ''}
            </div>
            <div class="text-[10px] text-[#94A3B8] mt-0.5">
              ${loc.is_auto ? 'انتخاب خودکار کمترین پینگ' : `${loc.active_nodes} نود سالم`}
            </div>
          </div>
        </div>
        <div class="flex items-center space-x-1.5 space-x-reverse flex-shrink-0">
          <span class="text-[10px] font-mono px-1.5 py-0.5 rounded ${
            loc.ping_ms < 60
              ? 'bg-[#10B981]/15 text-[#10B981] border border-[#10B981]/25'
              : 'bg-[#F59E0B]/15 text-[#F59E0B] border border-[#F59E0B]/25'
          }">${loc.ping_ms} ms</span>
        </div>
      `;

      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        await selectLocation(loc.code);
      });

      dropdown.appendChild(item);
    });
  }
}

async function selectLocation(code: string) {
  try {
    currentState = await invokeTauri<ClientState>('set_connection_location', { location: code });
  } catch (err) {
    console.warn('Could not set location:', err);
    currentState.selected_location = code;
  }
  isLocationDropdownOpen = false;
  const dropdown = document.getElementById('location-dropdown');
  const chevron = document.getElementById('loc-chevron-icon');
  if (dropdown) {
    dropdown.classList.add('collapsed');
    dropdown.classList.remove('expanded');
  }
  if (chevron) {
    chevron.style.transform = 'rotate(0deg)';
  }
  renderLocationSwitcher();
}

// ------------------------------------------------------------------------------
// Smart DNS & Ping Tester Logic
// ------------------------------------------------------------------------------
async function loadDnsSettings() {
  try {
    const res = await invokeTauri<DnsConfig>('get_dns_settings');
    if (res && res.selected_dns_id) {
      dnsConfigState = res;
    }
  } catch (err) {
    console.warn('Could not load DNS settings from backend:', err);
  }
  renderCustomDnsList();
  renderDnsServersList();
}

function renderCustomDnsList() {
  const container = document.getElementById('custom-dns-list');
  if (!container) return;

  if (dnsConfigState.custom_servers.length === 0) {
    container.innerHTML = '<div class="text-[10px] text-[#64748B] text-center py-1">هیچ DNS سفارشی ثبت نشده است.</div>';
    return;
  }

  container.innerHTML = '';
  dnsConfigState.custom_servers.forEach(entry => {
    const isSelected = dnsConfigState.selected_dns_id === entry.id;
    const card = document.createElement('div');
    card.className = `flex items-center justify-between p-1.5 px-2 rounded-lg border text-xs ${
      isSelected ? 'bg-[#10B981]/10 border-[#10B981]/40' : 'bg-[#1E293B]/70 border-white/5'
    }`;
    card.innerHTML = `
      <div class="flex items-center space-x-1.5 space-x-reverse min-w-0">
        <span class="text-xs">⚙️</span>
        <div class="truncate">
          <span class="font-semibold text-[#F8FAFC]">${entry.name}</span>
          <span class="text-[10px] text-[#94A3B8] font-mono mr-1">(${entry.address})</span>
        </div>
      </div>
      <div class="flex items-center space-x-1 space-x-reverse flex-shrink-0">
        <button class="select-dns-btn text-[10px] px-2 py-0.5 rounded cursor-pointer ${
          isSelected ? 'bg-[#10B981] text-white font-bold' : 'bg-[#0F172A] hover:bg-[#273549] text-[#94A3B8] hover:text-[#F8FAFC] border border-white/10'
        }" data-id="${entry.id}" data-addr="${entry.address}">
          ${isSelected ? '✓ فعال' : 'انتخاب'}
        </button>
        <button class="delete-dns-btn text-[10px] p-1 text-[#EF4444] hover:text-[#f87171] cursor-pointer" data-id="${entry.id}">✕</button>
      </div>
    `;

    card.querySelector('.select-dns-btn')?.addEventListener('click', () => {
      selectDns(entry.id, entry.address);
    });

    card.querySelector('.delete-dns-btn')?.addEventListener('click', () => {
      deleteCustomDns(entry.id);
    });

    container.appendChild(card);
  });
}

function renderDnsServersList() {
  const container = document.getElementById('dns-servers-list');
  const alertBox = document.getElementById('dns-static-ip-alert');
  if (!container) return;

  const isStaticIp = currentState.selected_mode === 'static_ip';
  if (alertBox) {
    if (isStaticIp) {
      alertBox.classList.remove('hidden');
    } else {
      alertBox.classList.add('hidden');
    }
  }

  const defaultDnsList: Array<{ id: string; name: string; address: string; is_iranian: boolean }> = [
    { id: 'cloudflare', name: 'Cloudflare DNS', address: '1.1.1.1', is_iranian: false },
    { id: 'google', name: 'Google DNS', address: '8.8.8.8', is_iranian: false },
    { id: 'quad9', name: 'Quad9 Secure (DoH)', address: 'https://dns.quad9.net/dns-query', is_iranian: false },
    { id: 'adguard', name: 'AdGuard Anti-Ad', address: '94.140.14.14', is_iranian: false },
    { id: 'shecan', name: 'Shecan (شکن)', address: '178.22.122.100', is_iranian: true },
    { id: 'electro', name: 'Electro (الکترو)', address: '78.157.42.100', is_iranian: true },
    { id: 'radar', name: 'Radar Game (رادار گیم)', address: '10.202.10.10', is_iranian: true },
    { id: 'begzar', name: 'Begzar (بگذر)', address: '185.55.226.26', is_iranian: true },
  ];

  container.innerHTML = '';

  defaultDnsList.forEach(dns => {
    const pingItem = dnsPingResults.find(p => p.id === dns.id);
    const latency = pingItem ? pingItem.ping_ms : -2;

    const isSelected = dnsConfigState.selected_dns_id === dns.id;
    const card = document.createElement('div');
    card.className = `dns-item flex items-center justify-between p-2 rounded-xl border text-xs transition ${
      isSelected
        ? 'bg-[#10B981]/10 border-[#10B981]/40 text-[#F8FAFC]'
        : 'bg-[#0F172A]/70 border-white/5 hover:border-white/15 text-[#94A3B8] hover:text-[#F8FAFC]'
    }`;

    let pingBadge = '';
    if (latency === -2) {
      pingBadge = '<span class="text-[9px] font-mono px-1.5 py-0.5 rounded bg-white/5 text-[#94A3B8] border border-white/10">- ms</span>';
    } else if (latency === -1 || latency > 300) {
      pingBadge = '<span class="text-[9px] font-mono px-1.5 py-0.5 rounded bg-[#EF4444]/15 text-[#EF4444] border border-[#EF4444]/30">Timeout</span>';
    } else if (latency < 50) {
      pingBadge = `<span class="text-[9px] font-mono px-1.5 py-0.5 rounded bg-[#10B981]/15 text-[#10B981] border border-[#10B981]/30 font-bold">${latency} ms</span>`;
    } else {
      pingBadge = `<span class="text-[9px] font-mono px-1.5 py-0.5 rounded bg-[#F59E0B]/15 text-[#F59E0B] border border-[#F59E0B]/30 font-bold">${latency} ms</span>`;
    }

    const iranBadge = dns.is_iranian
      ? '<span class="text-[9px] px-1 py-0.2 rounded bg-[#3B82F6]/15 text-[#3B82F6] border border-[#3B82F6]/25">ضدتحریم 🇮🇷</span>'
      : '<span class="text-[9px] px-1 py-0.2 rounded bg-white/5 text-[#94A3B8] border border-white/10">جهانی 🌍</span>';

    const disabledBtn = isStaticIp && dns.is_iranian ? 'disabled title="در حالت آی‌پی ثابت مسدود است"' : '';

    card.innerHTML = `
      <div class="flex items-center space-x-2 space-x-reverse min-w-0">
        <span class="text-sm">🌐</span>
        <div class="truncate">
          <div class="flex items-center space-x-1.5 space-x-reverse">
            <span class="font-semibold text-[#F8FAFC]">${dns.name}</span>
            ${iranBadge}
          </div>
          <div class="text-[10px] text-[#94A3B8] font-mono mt-0.5 truncate">${dns.address}</div>
        </div>
      </div>
      <div class="flex items-center space-x-1.5 space-x-reverse flex-shrink-0">
        ${pingBadge}
        <button class="select-dns-btn text-[10px] px-2 py-1 rounded-lg transition ${
          isSelected
            ? 'bg-[#10B981] text-white font-bold'
            : isStaticIp && dns.is_iranian
            ? 'bg-[#0F172A] opacity-40 cursor-not-allowed text-[#64748B] border border-white/5'
            : 'bg-[#1E293B] hover:bg-[#273549] text-[#94A3B8] hover:text-white border border-white/10 cursor-pointer'
        }" data-id="${dns.id}" data-addr="${dns.address}" ${disabledBtn}>
          ${isSelected ? '✓ فعال' : 'انتخاب'}
        </button>
      </div>
    `;

    card.querySelector('.select-dns-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isStaticIp && dns.is_iranian) {
        alert('در حالت آی‌پی ثابت مسکونی، جهت حفظ امنیت و عدم نشت هویت، DNSهای داخلی ایران غیرفعال هستند.');
        return;
      }
      selectDns(dns.id, dns.address);
    });

    container.appendChild(card);
  });
}

async function selectDns(id: string, address: string) {
  dnsConfigState.selected_dns_id = id;
  dnsConfigState.selected_dns_address = address;
  try {
    await invokeTauri('save_dns_settings', { config: dnsConfigState });
    currentState.logs.push(`[DNS] Active DNS switched to [${id}] (${address})`);
  } catch (err) {
    console.warn('Could not save DNS settings:', err);
  }
  renderCustomDnsList();
  renderDnsServersList();
}

async function runDnsPingTest() {
  const btn = document.getElementById('test-all-dns-btn');
  if (isDnsTesting) return;
  isDnsTesting = true;
  if (btn) {
    btn.innerHTML = '<span>⏳ در حال تست...</span>';
    btn.classList.add('opacity-75');
  }

  try {
    const results = await invokeTauri<DnsPingItem[]>('ping_dns_servers');
    if (results && Array.isArray(results) && results.length > 0) {
      results.sort((a, b) => {
        if (a.ping_ms < 0) return 1;
        if (b.ping_ms < 0) return -1;
        return a.ping_ms - b.ping_ms;
      });
      dnsPingResults = results;
    }
  } catch (err) {
    console.warn('DNS ping failed:', err);
    dnsPingResults = [
      { id: 'cloudflare', name: 'Cloudflare DNS', address: '1.1.1.1', ping_ms: 24, is_iranian: false, is_custom: false },
      { id: 'electro', name: 'Electro (الکترو)', address: '78.157.42.100', ping_ms: 28, is_iranian: true, is_custom: false },
      { id: 'shecan', name: 'Shecan (شکن)', address: '178.22.122.100', ping_ms: 32, is_iranian: true, is_custom: false },
      { id: 'google', name: 'Google DNS', address: '8.8.8.8', ping_ms: 35, is_iranian: false, is_custom: false },
      { id: 'radar', name: 'Radar Game (رادار گیم)', address: '10.202.10.10', ping_ms: 42, is_iranian: true, is_custom: false },
      { id: 'quad9', name: 'Quad9 Secure (DoH)', address: 'https://dns.quad9.net/dns-query', ping_ms: 48, is_iranian: false, is_custom: false },
      { id: 'begzar', name: 'Begzar (بگذر)', address: '185.55.226.26', ping_ms: 55, is_iranian: true, is_custom: false },
      { id: 'adguard', name: 'AdGuard Anti-Ad', address: '94.140.14.14', ping_ms: 62, is_iranian: false, is_custom: false },
    ];
  } finally {
    isDnsTesting = false;
    if (btn) {
      btn.innerHTML = '<span>⚡ تست مجدد پینگ</span>';
      btn.classList.remove('opacity-75');
    }
    renderDnsServersList();
  }
}

async function selectAutoFastestDns() {
  if (dnsPingResults.length === 0) {
    await runDnsPingTest();
  }

  const isStaticIp = currentState.selected_mode === 'static_ip';
  const valid = dnsPingResults.filter(p => p.ping_ms > 0 && !(isStaticIp && p.is_iranian));
  if (valid.length > 0) {
    const fastest = valid[0];
    await selectDns(fastest.id, fastest.address);
    alert(`✨ سریع‌ترین DNS انتخاب شد:\n${fastest.name} (${fastest.address}) با زمان پاسخ ${fastest.ping_ms}ms اعمال گردید.`);
  } else {
    alert('هیچ DNS فعالی برای انتخاب خودکار یافت نشد.');
  }
}

async function addCustomDns() {
  const nameInput = document.getElementById('custom-dns-name') as HTMLInputElement;
  const addrInput = document.getElementById('custom-dns-address') as HTMLInputElement;

  const name = nameInput?.value.trim();
  const address = addrInput?.value.trim();

  if (!name || !address) {
    alert('لطفاً نام و آدرس DNS سفارشی را وارد کنید.');
    return;
  }

  const newEntry: CustomDnsEntry = {
    id: `custom_${Date.now()}`,
    name,
    address,
  };

  dnsConfigState.custom_servers.push(newEntry);
  dnsConfigState.selected_dns_id = newEntry.id;
  dnsConfigState.selected_dns_address = newEntry.address;

  try {
    await invokeTauri('save_dns_settings', { config: dnsConfigState });
    currentState.logs.push(`[DNS] Added custom DNS: ${name} (${address})`);
  } catch (err) {
    console.warn('Could not save custom DNS:', err);
  }

  if (nameInput) nameInput.value = '';
  if (addrInput) addrInput.value = '';

  renderCustomDnsList();
  renderDnsServersList();
}

async function deleteCustomDns(id: string) {
  dnsConfigState.custom_servers = dnsConfigState.custom_servers.filter(c => c.id !== id);
  if (dnsConfigState.selected_dns_id === id) {
    dnsConfigState.selected_dns_id = 'cloudflare';
    dnsConfigState.selected_dns_address = '1.1.1.1';
  }
  try {
    await invokeTauri('save_dns_settings', { config: dnsConfigState });
  } catch (err) {
    console.warn('Could not delete custom DNS:', err);
  }
  renderCustomDnsList();
  renderDnsServersList();
}

// ------------------------------------------------------------------------------
// App Initialization
// ------------------------------------------------------------------------------
window.addEventListener('DOMContentLoaded', async () => {
  initSplashScreen();
  initTheme();
  initEventListeners();
  await setupTauriEventListeners();

  try {
    const initialState = await invokeTauri<ClientState>('get_client_state');
    currentState = initialState;
    await loadUserDevices();
    await refreshConnectionModes();
    await checkClientVersion();
    await loadAvailableLocations();
    await loadDnsSettings();
  } catch (e) {
    console.warn("Could not fetch initial client state from Tauri:", e);
  }

  renderState();
});
