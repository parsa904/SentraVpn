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
  status: 'Disconnected' | 'Connecting' | 'Connected' | { Error: string };
  selected_mode: string;
  selected_protocol?: string;
  selected_location: string;
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

let connectionModes: ConnectionModeInfo[] = [];
let userDevices: UserDevice[] = [];
let currentDeviceId: string = '';

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
  selected_location: "US 🇺🇸 سرور مسکونی آمریکا",
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
    return await tauri.core.invoke(cmd, args);
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

  updateModesUI();
  renderPowerButton();
  renderLogs();
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

function updateTelemetryDisplay(metrics: TelemetryMetrics) {
  const downEl = document.getElementById('down-speed');
  const upEl = document.getElementById('up-speed');
  const pingEl = document.getElementById('ping-display');
  const timerEl = document.getElementById('connection-timer');

  if (downEl) downEl.textContent = formatSpeed(metrics.download_speed_bps);
  if (upEl) upEl.textContent = formatSpeed(metrics.upload_speed_bps);
  if (pingEl) pingEl.textContent = metrics.ping_ms > 0 ? `${metrics.ping_ms} ms` : '- ms';
  if (timerEl) timerEl.textContent = formatDuration(metrics.uptime_seconds);
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
  return false;
}

// ------------------------------------------------------------------------------
// Event Listeners Initialization
// ------------------------------------------------------------------------------
function initEventListeners() {
  const authErr = document.getElementById('auth-error-msg');

  // 1a. Auth Tabs Switcher
  const tabLogin = document.getElementById('auth-tab-login');
  const tabRegister = document.getElementById('auth-tab-register');
  const tabOtp = document.getElementById('auth-tab-otp');
  const formLogin = document.getElementById('auth-form-login');
  const formRegister = document.getElementById('auth-form-register');
  const formOtp = document.getElementById('auth-form-otp');

  const selectAuthTab = (activeTab: 'login' | 'register' | 'otp') => {
    if (authErr) authErr.classList.add('hidden');
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
          alert('خطا در برقراری اتصال: ' + errStr);
        }
      }
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
  const tabBtnTheme = document.getElementById('tab-btn-theme');
  const tabBtnLogs = document.getElementById('tab-btn-logs');

  const tabContentSettings = document.getElementById('tab-content-settings');
  const tabContentAntiDpi = document.getElementById('tab-content-antidpi');
  const tabContentTheme = document.getElementById('tab-content-theme');
  const tabContentLogs = document.getElementById('tab-content-logs');

  const allTabBtns = [tabBtnSettings, tabBtnAntiDpi, tabBtnTheme, tabBtnLogs];
  const allTabContents = [tabContentSettings, tabContentAntiDpi, tabContentTheme, tabContentLogs];

  function switchTab(activeBtn: HTMLElement | null, activeContent: HTMLElement | null) {
    allTabBtns.forEach(btn => btn?.classList.remove('active'));
    allTabContents.forEach(content => content?.classList.add('hidden'));
    activeBtn?.classList.add('active');
    activeContent?.classList.remove('hidden');
    if (activeBtn === tabBtnLogs) {
      renderLogs();
    }
  }

  settingsBtn?.addEventListener('click', () => {
    settingsDrawer?.classList.remove('hidden');
  });

  closeSettingsBtn?.addEventListener('click', () => {
    settingsDrawer?.classList.add('hidden');
  });

  tabBtnSettings?.addEventListener('click', () => switchTab(tabBtnSettings, tabContentSettings));
  tabBtnAntiDpi?.addEventListener('click', () => switchTab(tabBtnAntiDpi, tabContentAntiDpi));
  tabBtnTheme?.addEventListener('click', () => switchTab(tabBtnTheme, tabContentTheme));
  tabBtnLogs?.addEventListener('click', () => switchTab(tabBtnLogs, tabContentLogs));

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

      if (mode === 'gaming') {
        alert('🎮 حالت گیمینگ (کاهش پینگ و جیتر UDP) در حال توسعه است و به‌زودی اضافه می‌شود.');
        return;
      }

      if (mode === 'static_ip' && currentState.tier === 'Sentra Lite') {
        upgradeModal?.classList.remove('hidden');
        return;
      }

      currentState = await invokeTauri<ClientState>('set_connection_mode', { mode });
      renderState();
      updateModesUI();
    });
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
// Theme Engine Handlers
// ------------------------------------------------------------------------------
function initTheme() {
  const savedTheme = localStorage.getItem('sentra_theme') || 'dark';
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
// App Initialization
// ------------------------------------------------------------------------------
window.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  initEventListeners();
  await setupTauriEventListeners();

  try {
    const initialState = await invokeTauri<ClientState>('get_client_state');
    currentState = initialState;
    await loadUserDevices();
    await refreshConnectionModes();
    await checkClientVersion();
  } catch (e) {
    console.warn("Could not fetch initial client state from Tauri:", e);
  }

  renderState();
});
