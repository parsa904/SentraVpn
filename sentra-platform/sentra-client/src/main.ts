// ==============================================================================
// Sentra Connect - Frontend Controller (TypeScript)
// Compatible with Tauri v2 Desktop & Android Mobile (SentraVpnPlugin)
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
  status: 'Disconnected' | 'Connecting' | 'Connected' | { Error: string };
  selected_mode: string;
  selected_location: string;
  sandbox_loopback: boolean;
  split_tunneling: boolean;
  kill_switch: boolean;
  metrics: TelemetryMetrics;
  logs: string[];
}

// ------------------------------------------------------------------------------
// Mock Browser Fallback State
// ------------------------------------------------------------------------------
let mockState: ClientState = {
  is_authenticated: false,
  auth_token: null,
  subscription_token: "token_flow_sandbox_003",
  tier: "Sentra Flow+",
  username: "کاربر تستی",
  remaining_bytes: 986768736256,
  status: 'Disconnected',
  selected_mode: "Sentra Auto",
  selected_location: "US 🇺🇸 سرور مسکونی آمریکا",
  sandbox_loopback: true,
  split_tunneling: true,
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
    "[INFO] [Core] Sentra Connect frontend loaded.",
    "[INFO] [Android] Native SentraVpnPlugin & VpnService bridge ready.",
    "[INFO] [Sandbox] Local Loopback mode ready on 127.0.0.1:10801-10804.",
  ],
};

const MAX_LOG_CONSOLE_ENTRIES = 50;
let clearedLogOffset = 0;
let mockInterval: number | null = null;

function pushMockLog(entry: string): void {
  if (mockState.logs.length >= MAX_LOG_CONSOLE_ENTRIES) {
    mockState.logs = [];
  }
  mockState.logs.push(entry);
}

// ------------------------------------------------------------------------------
// Tauri IPC Invocation Wrapper (Desktop & Android Plugin compatible)
// ------------------------------------------------------------------------------
async function invokeTauri<T>(cmd: string, args: Record<string, any> = {}): Promise<T> {
  const tauri = (window as any).__TAURI__;
  if (tauri && tauri.core && typeof tauri.core.invoke === 'function') {
    return await tauri.core.invoke(cmd, args);
  }

  // --- Browser / Android Mock Bridge ---
  console.log(`[IPC Bridge] Command: ${cmd}`, args);

  if (cmd === 'get_client_state') {
    return { ...mockState } as unknown as T;
  }
  if (cmd === 'login_with_code') {
    const code = args.code || '';
    if (code.length !== 8) throw new Error("کد ورود باید دقیقاً ۸ رقم باشد.");
    mockState.is_authenticated = true;
    mockState.username = "تستر محلی سنترا";
    mockState.tier = code === '88888888' ? "Sentra Pro" : "Sentra Flow+";
    pushMockLog(`[INFO] [Auth] Logged in with code ${code} (Tier: ${mockState.tier})`);
    return { ...mockState } as unknown as T;
  }
  if (cmd === 'start_vpn' || cmd === 'connect_vpn') {
    mockState.status = 'Connecting';
    pushMockLog(`[INFO] [Core] Requesting VpnService start in mode [${mockState.selected_mode}]...`);
    renderState();

    setTimeout(() => {
      mockState.status = 'Connected';
      pushMockLog(`[INFO] [VpnService] TUN fd established (172.19.0.1/30)`);
      pushMockLog(`[INFO] [Notification] Persistent status notification displayed`);
      pushMockLog(`[INFO] [libbox] Sing-box kernel running (FakeIP 198.18.0.0/15)`);

      if (mockInterval) clearInterval(mockInterval);
      mockInterval = window.setInterval(() => {
        if (mockState.status === 'Connected') {
          mockState.metrics.uptime_seconds += 1;
          mockState.metrics.download_speed_bps = 14_000_000 + Math.floor(Math.random() * 12_000_000);
          mockState.metrics.upload_speed_bps = 2_100_000 + Math.floor(Math.random() * 2_500_000);
          mockState.metrics.ping_ms = 35 + Math.floor(Math.random() * 12);
          mockState.remaining_bytes = Math.max(0, mockState.remaining_bytes - 15_000_000);

          if (mockState.metrics.uptime_seconds % 10 === 0) {
            pushMockLog(`[DEBUG] [Split] Route bypass active for domestic (.ir) domain`);
          }
          renderState();
        }
      }, 1000);

      renderState();
    }, 700);

    return { ...mockState } as unknown as T;
  }
  if (cmd === 'stop_vpn' || cmd === 'disconnect_vpn') {
    mockState.status = 'Disconnected';
    mockState.metrics.download_speed_bps = 0;
    mockState.metrics.upload_speed_bps = 0;
    mockState.metrics.uptime_seconds = 0;
    if (mockInterval) clearInterval(mockInterval);
    pushMockLog(`[INFO] [VpnService] Service stopped and TUN closed.`);
    return { ...mockState } as unknown as T;
  }
  if (cmd === 'get_vpn_stats') {
    return {
      is_active: mockState.status === 'Connected',
      mode: mockState.selected_mode,
      download_speed_bps: mockState.metrics.download_speed_bps,
      upload_speed_bps: mockState.metrics.upload_speed_bps,
      total_down_bytes: mockState.metrics.total_download_bytes,
      total_up_bytes: mockState.metrics.total_upload_bytes,
      uptime_seconds: mockState.metrics.uptime_seconds,
    } as unknown as T;
  }
  if (cmd === 'toggle_sandbox_mode') {
    mockState.sandbox_loopback = args.enabled;
    pushMockLog(`[CONFIG] Sandbox Loopback set to ${args.enabled}`);
    return { ...mockState } as unknown as T;
  }
  if (cmd === 'toggle_split_tunneling') {
    mockState.split_tunneling = args.enabled;
    pushMockLog(`[CONFIG] Split Tunneling set to ${args.enabled}`);
    return { ...mockState } as unknown as T;
  }
  if (cmd === 'toggle_kill_switch') {
    mockState.kill_switch = args.enabled;
    pushMockLog(`[CONFIG] Kill-Switch set to ${args.enabled}`);
    return { ...mockState } as unknown as T;
  }
  if (cmd === 'set_protocol_mode') {
    mockState.selected_mode = args.mode;
    pushMockLog(`[CONFIG] Protocol Mode switched to [${args.mode}]`);
    return { ...mockState } as unknown as T;
  }
  if (cmd === 'get_logs') {
    return mockState.logs as unknown as T;
  }
  if (cmd === 'logout') {
    mockState.is_authenticated = false;
    mockState.status = 'Disconnected';
    if (mockInterval) clearInterval(mockInterval);
    return { ...mockState } as unknown as T;
  }

  return { ...mockState } as unknown as T;
}

// ------------------------------------------------------------------------------
// UI Elements & State
// ------------------------------------------------------------------------------
let currentState: ClientState = mockState;
const sparklinePoints: number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

const authScreen = document.getElementById('auth-screen')!;
const mainScreen = document.getElementById('main-screen')!;
const authCodeInput = document.getElementById('auth-code-input') as HTMLInputElement;
const authSubmitBtn = document.getElementById('auth-submit-btn')!;
const authSandboxBtn = document.getElementById('auth-sandbox-quick-btn')!;
const authErrorMsg = document.getElementById('auth-error-msg')!;

const masterPowerBtn = document.getElementById('master-power-btn')!;
const powerIcon = document.getElementById('power-icon')!;
const statusText = document.getElementById('status-text')!;
const connectionTimer = document.getElementById('connection-timer')!;
const tierBadge = document.getElementById('tier-badge')!;

const locationSelectBtn = document.getElementById('location-select-btn')!;
const modeSelectBtn = document.getElementById('mode-select-btn')!;
const modeDisplay = document.getElementById('mode-display')!;
const locationDisplay = document.getElementById('location-display')!;

const downSpeed = document.getElementById('down-speed')!;
const upSpeed = document.getElementById('up-speed')!;
const pingDisplay = document.getElementById('ping-display')!;
const quotaDisplay = document.getElementById('quota-display')!;
const sparklinePoly = document.getElementById('sparkline-poly')!;

const toggleSettingsBtn = document.getElementById('toggle-settings-btn')!;
const toggleConsoleBtn = document.getElementById('toggle-console-btn')!;
const closeSettingsBtn = document.getElementById('close-settings-btn')!;
const settingsDrawer = document.getElementById('settings-drawer')!;
const splitTunnelToggle = document.getElementById('split-tunnel-toggle') as HTMLInputElement;
const killSwitchToggle = document.getElementById('kill-switch-toggle') as HTMLInputElement;
const sandboxModeToggle = document.getElementById('sandbox-mode-toggle') as HTMLInputElement;
const logConsole = document.getElementById('log-console')!;
const copyLogsBtn = document.getElementById('copy-logs-btn')!;
const logoutBtn = document.getElementById('logout-btn')!;

const modeModal = document.getElementById('mode-modal')!;
const closeModeModal = document.getElementById('close-mode-modal')!;
const modeList = document.getElementById('mode-list')!;

// ------------------------------------------------------------------------------
// Formatters & Sparkline
// ------------------------------------------------------------------------------
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0.0 KB/s';
  const k = 1024;
  const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function updateSparkline(currentBps: number) {
  sparklinePoints.shift();
  const maxBps = 30_000_000;
  const height = Math.min(28, Math.max(2, (currentBps / maxBps) * 28));
  sparklinePoints.push(30 - height);

  const pointsStr = sparklinePoints
    .map((y, index) => `${index * 11},${Math.round(y)}`)
    .join(' ');
  sparklinePoly.setAttribute('points', pointsStr);
}

function renderState() {
  if (!currentState.is_authenticated) {
    authScreen.classList.remove('hidden');
    mainScreen.classList.add('hidden');
    return;
  } else {
    authScreen.classList.add('hidden');
    mainScreen.classList.remove('hidden');
  }

  // Tier Badge
  tierBadge.textContent = currentState.tier;
  if (currentState.tier.includes('Flow+')) {
    tierBadge.className = "text-[10px] px-2 py-0.5 rounded-full font-medium bg-[#A371F7]/10 text-[#A371F7] border border-[#A371F7]/40";
  } else if (currentState.tier.includes('Pro')) {
    tierBadge.className = "text-[10px] px-2 py-0.5 rounded-full font-medium bg-[#58A6FF]/10 text-[#58A6FF] border border-[#58A6FF]/40";
  } else {
    tierBadge.className = "text-[10px] px-2 py-0.5 rounded-full font-medium bg-[#161B22] text-[#2EA043] border border-[#2EA043]/40";
  }

  // Power Button & Status
  masterPowerBtn.classList.remove('btn-connecting', 'btn-connected', 'border-[#2EA043]', 'border-[#D29922]', 'border-[#F85149]', 'border-[#30363D]');
  powerIcon.classList.remove('text-[#2EA043]', 'text-[#D29922]', 'text-[#F85149]', 'text-[#6E7681]');

  if (currentState.status === 'Connected') {
    masterPowerBtn.classList.add('btn-connected', 'border-[#2EA043]');
    powerIcon.classList.add('text-[#2EA043]');
    statusText.textContent = "متصل (ترافیک ایمن)";
    statusText.className = "text-sm font-semibold text-[#2EA043]";
  } else if (currentState.status === 'Connecting') {
    masterPowerBtn.classList.add('btn-connecting', 'border-[#D29922]');
    powerIcon.classList.add('text-[#D29922]');
    statusText.textContent = "در حال اتصال به سرور...";
    statusText.className = "text-sm font-semibold text-[#D29922]";
  } else if (typeof currentState.status === 'object' && 'Error' in currentState.status) {
    masterPowerBtn.classList.add('border-[#F85149]');
    powerIcon.classList.add('text-[#F85149]');
    statusText.textContent = "خطا در اتصال";
    statusText.className = "text-sm font-semibold text-[#F85149]";
  } else {
    masterPowerBtn.classList.add('border-[#30363D]');
    powerIcon.classList.add('text-[#6E7681]');
    statusText.textContent = "قطع اتصال";
    statusText.className = "text-sm font-semibold text-[#8B949E]";
  }

  connectionTimer.textContent = formatDuration(currentState.metrics.uptime_seconds);
  downSpeed.textContent = formatBytes(currentState.metrics.download_speed_bps);
  upSpeed.textContent = formatBytes(currentState.metrics.upload_speed_bps);
  pingDisplay.textContent = currentState.metrics.ping_ms > 0 ? `${currentState.metrics.ping_ms} ms` : "- ms";

  updateSparkline(currentState.metrics.download_speed_bps);

  const remainingGB = (currentState.remaining_bytes / (1024 * 1024 * 1024)).toFixed(1);
  quotaDisplay.textContent = `${remainingGB} GB باقیمانده`;

  modeDisplay.textContent = `⚡ ${currentState.selected_mode}`;
  locationDisplay.textContent = currentState.selected_location;

  splitTunnelToggle.checked = currentState.split_tunneling;
  killSwitchToggle.checked = currentState.kill_switch;
  sandboxModeToggle.checked = currentState.sandbox_loopback;

  if (currentState.logs.length < clearedLogOffset) {
    clearedLogOffset = 0;
  }
  let visibleLogs = currentState.logs.slice(clearedLogOffset);
  if (visibleLogs.length > MAX_LOG_CONSOLE_ENTRIES) {
    // Automatically clear log-console once entries exceed 50 to maintain UI performance
    clearedLogOffset = currentState.logs.length;
    if (currentState.logs === mockState.logs) {
      mockState.logs = [];
      currentState.logs = mockState.logs;
      clearedLogOffset = 0;
    }
    visibleLogs = [];
  }

  const fragment = document.createDocumentFragment();
  for (const log of visibleLogs) {
    let color = 'text-[#8B949E]';
    if (log.includes('[ERROR]')) color = 'text-[#F85149]';
    else if (log.includes('[CONFIG]')) color = 'text-[#58A6FF]';
    else if (log.includes('[INFO]')) color = 'text-[#2EA043]';
    const row = document.createElement('div');
    row.className = color;
    row.textContent = log;
    fragment.appendChild(row);
  }
  logConsole.replaceChildren(fragment);
  logConsole.scrollTop = logConsole.scrollHeight;
}

// ------------------------------------------------------------------------------
// Listeners & Lifecycle
// ------------------------------------------------------------------------------
async function init() {
  try {
    currentState = await invokeTauri<ClientState>('get_client_state');
  } catch (e) {
    console.warn("Using default state:", e);
  }
  renderState();

  setInterval(async () => {
    try {
      currentState = await invokeTauri<ClientState>('get_client_state');
      renderState();
    } catch (_) {}
  }, 1500);
}

authSubmitBtn.addEventListener('click', async () => {
  const code = authCodeInput.value.trim();
  authErrorMsg.classList.add('hidden');
  try {
    currentState = await invokeTauri<ClientState>('login_with_code', { code });
    renderState();
  } catch (err: any) {
    authErrorMsg.textContent = err.toString();
    authErrorMsg.classList.remove('hidden');
  }
});

authSandboxBtn.addEventListener('click', async () => {
  authCodeInput.value = "12345678";
  authSubmitBtn.click();
});

masterPowerBtn.addEventListener('click', async () => {
  try {
    if (currentState.status === 'Connected' || currentState.status === 'Connecting') {
      currentState = await invokeTauri<ClientState>('stop_vpn');
    } else {
      currentState = await invokeTauri<ClientState>('start_vpn', { mode: currentState.selected_mode });
    }
    renderState();
  } catch (err: any) {
    alert("خطا: " + err);
  }
});

toggleSettingsBtn.addEventListener('click', () => settingsDrawer.classList.remove('hidden'));
toggleConsoleBtn.addEventListener('click', () => settingsDrawer.classList.remove('hidden'));
closeSettingsBtn.addEventListener('click', () => settingsDrawer.classList.add('hidden'));

splitTunnelToggle.addEventListener('change', async (e) => {
  const enabled = (e.target as HTMLInputElement).checked;
  currentState = await invokeTauri<ClientState>('toggle_split_tunneling', { enabled });
  renderState();
});

killSwitchToggle.addEventListener('change', async (e) => {
  const enabled = (e.target as HTMLInputElement).checked;
  currentState = await invokeTauri<ClientState>('toggle_kill_switch', { enabled });
  renderState();
});

sandboxModeToggle.addEventListener('change', async (e) => {
  const enabled = (e.target as HTMLInputElement).checked;
  currentState = await invokeTauri<ClientState>('toggle_sandbox_mode', { enabled });
  renderState();
});

copyLogsBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(currentState.logs.slice(clearedLogOffset).join('\n'));
  copyLogsBtn.textContent = "✅ کپی شد!";
  setTimeout(() => { copyLogsBtn.textContent = "📋 کپی لاگ‌ها"; }, 1500);
});

logoutBtn.addEventListener('click', async () => {
  currentState = await invokeTauri<ClientState>('logout');
  settingsDrawer.classList.add('hidden');
  renderState();
});

modeSelectBtn.addEventListener('click', () => modeModal.classList.remove('hidden'));
closeModeModal.addEventListener('click', () => modeModal.classList.add('hidden'));

modeList.querySelectorAll('.mode-item').forEach(item => {
  item.addEventListener('click', async () => {
    const mode = item.getAttribute('data-mode') || 'Sentra Auto';
    currentState = await invokeTauri<ClientState>('set_protocol_mode', { mode });
    modeModal.classList.add('hidden');
    renderState();
  });
});

locationSelectBtn.addEventListener('click', async () => {
  const locations = [
    "US 🇺🇸 سرور مسکونی آمریکا",
    "DE 🇩🇪 آلمان (فرانکفورت)",
    "NL 🇳🇱 هلند (آمستردام)",
    "SG 🇸🇬 سنگاپور"
  ];
  const nextIdx = (locations.indexOf(currentState.selected_location) + 1) % locations.length;
  currentState = await invokeTauri<ClientState>('set_location', { location: locations[nextIdx] });
  renderState();
});

init();
