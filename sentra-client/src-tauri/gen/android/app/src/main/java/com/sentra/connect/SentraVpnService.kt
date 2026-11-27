package com.sentra.connect

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.Uri
import android.net.VpnService
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import androidx.core.app.NotificationCompat
import java.io.BufferedReader
import java.io.File
import java.io.FileOutputStream
import java.io.InputStreamReader
import java.lang.reflect.Proxy
import java.util.concurrent.atomic.AtomicBoolean

/**
 * SentraVpnService: Android Foreground VpnService for Sentra Connect.
 *
 * Dual-mode Sing-box 1.14+ runtime:
 *  1. If `io.nekohasekai.libbox.Libbox` (libbox.aar) is packaged in `app/libs/`,
 *     dynamically bridges PlatformInterface via reflection so compilation never breaks
 *     across libbox API updates.
 *  2. Otherwise launches the bundled native `libsingbox.so` executable from
 *     `applicationInfo.nativeLibraryDir` alongside an established Android TUN interface.
 *
 * Includes automatic reconnection on Wi-Fi <-> Cellular switches and Doze/sleep wake.
 */
class SentraVpnService : VpnService() {

    private var vpnInterface: ParcelFileDescriptor? = null
    private var isServiceRunning = AtomicBoolean(false)
    private var isReconnecting = AtomicBoolean(false)
    private var userDisconnected = AtomicBoolean(false)
    private var lostNetworkPending = AtomicBoolean(false)
    private var libboxService: Any? = null
    private var singboxProcess: Process? = null
    private var activeConfig: String? = null
    private var activeMode: String = "Sentra Auto"
    private var activeServerName: String = "Sentra Auto"
    private var splitTunnelIr: Boolean = true
    private var connectivityManager: ConnectivityManager? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var wakeReceiver: BroadcastReceiver? = null
    private var activeNetworkId: Long? = null

    @Volatile
    private var lastHeartbeatWallMs: Long = System.currentTimeMillis()
    private val mainHandler = Handler(Looper.getMainLooper())
    private var pendingReconnectRunnable: Runnable? = null

    companion object {
        private const val TAG = "SentraVpnService"
        const val NOTIFICATION_ID = 20261
        const val BATTERY_WARNING_NOTIFICATION_ID = 20262
        const val CHANNEL_ID = "sentra_vpn_status_channel"

        const val ACTION_START_VPN = "com.sentra.connect.ACTION_START_VPN"
        const val ACTION_STOP_VPN = "com.sentra.connect.ACTION_STOP_VPN"
        const val ACTION_SET_AUTO_RECONNECT = "com.sentra.connect.ACTION_SET_AUTO_RECONNECT"
        const val EXTRA_CONFIG_JSON = "EXTRA_CONFIG_JSON"
        const val EXTRA_ACTIVE_MODE = "EXTRA_ACTIVE_MODE"
        const val EXTRA_SERVER_NAME = "EXTRA_SERVER_NAME"
        const val EXTRA_SPLIT_TUNNEL_IR = "EXTRA_SPLIT_TUNNEL_IR"
        const val EXTRA_AUTO_RECONNECT = "EXTRA_AUTO_RECONNECT"

        private const val SLEEP_WAKE_GAP_MS = 15_000L
        private const val RECONNECT_DEBOUNCE_MS = 1_500L

        @Volatile
        var autoReconnectEnabled: Boolean = true

        @Volatile
        var isVpnActive: Boolean = false
            private set

        @Volatile
        var currentModeName: String = "Sentra Auto"
            private set

        @Volatile
        var downloadSpeedBps: Long = 0
            private set

        @Volatile
        var uploadSpeedBps: Long = 0
            private set

        @Volatile
        var totalDownBytes: Long = 0
            private set

        @Volatile
        var totalUpBytes: Long = 0
            private set

        @Volatile
        var uptimeSeconds: Long = 0
            private set

        // Major Iranian banking, payment, and local service apps bypassed in Split Tunneling mode
        private val IRANIAN_APPS_SPLIT = listOf(
            "ir.divar",
            "com.digikala",
            "cab.snapp.passenger",
            "cab.snapp.driver",
            "com.bale.messenger",
            "ir.sanabad.rubika",
            "ir.tejaratbank.tmobile",
            "ir.melli.bam",
            "com.mellat.mobile",
            "ir.resalat.mb",
            "ir.sep.seso",
            "ir.shaparak",
            "com.asanpardakht.app",
            "ir.torob",
            "com.farsitel.bazaar"
        )
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        Log.i(TAG, "SentraVpnService initialized.")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent == null) return START_NOT_STICKY

        when (intent.action) {
            ACTION_START_VPN -> {
                val configJson = intent.getStringExtra(EXTRA_CONFIG_JSON) ?: ""
                val mode = intent.getStringExtra(EXTRA_ACTIVE_MODE) ?: "Auto"
                val serverName = intent.getStringExtra(EXTRA_SERVER_NAME)?.takeIf { it.isNotBlank() } ?: mode
                val split = intent.getBooleanExtra(EXTRA_SPLIT_TUNNEL_IR, true)
                autoReconnectEnabled = intent.getBooleanExtra(EXTRA_AUTO_RECONNECT, autoReconnectEnabled)
                userDisconnected.set(false)
                startVpnTunnel(configJson, mode, serverName, split)
            }
            ACTION_SET_AUTO_RECONNECT -> {
                autoReconnectEnabled = intent.getBooleanExtra(EXTRA_AUTO_RECONNECT, true)
                Log.i(TAG, "Auto-Reconnect preference updated: $autoReconnectEnabled")
                if (!autoReconnectEnabled) {
                    cancelPendingReconnect()
                }
            }
            ACTION_STOP_VPN -> {
                userDisconnected.set(true)
                stopVpnTunnel()
                stopSelf()
            }
        }

        return START_NOT_STICKY
    }

    // =========================================================================
    // Android TUN & Sing-box Core Engine Bridge (libbox reflection + native binary)
    // =========================================================================

    private fun establishTunInterface(mtu: Int = 1400, detachForLibbox: Boolean): Int {
        val safeMtu = if (mtu in 1280..9000) mtu else 1400
        return try {
            val builder = Builder()
                .setSession("Sentra Connect")
                .setMtu(safeMtu)
                .addAddress("172.19.0.1", 30)
                .addDnsServer("198.18.0.1")
                .addRoute("0.0.0.0", 0)
                .setBlocking(false)

            try {
                builder.addDisallowedApplication(packageName)
            } catch (e: Exception) {
                Log.w(TAG, "Could not disallow own package: ${e.message}")
            }

            if (splitTunnelIr) {
                for (pkg in IRANIAN_APPS_SPLIT) {
                    try {
                        builder.addDisallowedApplication(pkg)
                    } catch (_: Exception) {
                        // Package not installed on this device
                    }
                }
            }

            val established = builder.establish()
            if (established == null) {
                Log.e(TAG, "VpnService.Builder.establish() returned null.")
                -1
            } else {
                vpnInterface = established
                if (detachForLibbox) {
                    val fd = established.detachFd()
                    Log.i(TAG, "TUN interface established with detached fd=$fd")
                    fd
                } else {
                    Log.i(TAG, "TUN interface established (fd=${established.fd})")
                    established.fd
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Exception creating TUN interface: ${e.message}", e)
            SentraErrorReporter.reportError(
                context = applicationContext,
                moduleOrFile = "android/SentraVpnService.kt",
                actionOrRoute = "establishTunInterface",
                throwable = e,
                extraContext = mapOf("mtu" to safeMtu, "detach_for_libbox" to detachForLibbox)
            )
            -1
        }
    }

    private fun writeCoreLog(message: String) {
        Log.i("SentraCore", message)
        SentraVpnPlugin.broadcastLog(message)
    }

    private fun tryStartLibboxEngine(configJson: String): Boolean {
        return try {
            val libboxClass = Class.forName("io.nekohasekai.libbox.Libbox")
            val platformInterfaceClass = Class.forName("io.nekohasekai.libbox.PlatformInterface")

            val proxy = Proxy.newProxyInstance(
                classLoader,
                arrayOf(platformInterfaceClass)
            ) { _, method, args ->
                when (method.name) {
                    "autoDetectInterfaceControl" -> {
                        val fd = (args?.firstOrNull() as? Number)?.toInt() ?: -1
                        if (fd >= 0 && !protect(fd)) {
                            Log.w(TAG, "Failed to protect socket fd=$fd")
                        }
                        null
                    }
                    "openTun" -> {
                        val mtu = try {
                            val opts = args?.firstOrNull()
                            val getMtu = opts?.javaClass?.methods?.firstOrNull { it.name == "getMTU" || it.name == "getMtu" }
                            (getMtu?.invoke(opts) as? Number)?.toInt() ?: 1400
                        } catch (_: Exception) {
                            1400
                        }
                        establishTunInterface(mtu, detachForLibbox = true)
                    }
                    "writeLog" -> {
                        val msg = args?.firstOrNull()?.toString() ?: ""
                        if (msg.isNotBlank()) writeCoreLog(msg)
                        null
                    }
                    "usePlatformAutoDetectInterfaceControl" -> true
                    "useProcFS" -> false
                    "underNetworkExtension" -> false
                    "includeAllNetworks" -> false
                    "findConnectionOwner" -> -1
                    "packageNameByUid" -> ""
                    "uidByPackageName" -> -1
                    else -> when (method.returnType) {
                        java.lang.Boolean.TYPE -> false
                        java.lang.Integer.TYPE -> 0
                        java.lang.Long.TYPE -> 0L
                        else -> null
                    }
                }
            }

            val newServiceMethod = libboxClass.getMethod("newService", String::class.java, platformInterfaceClass)
            val service = newServiceMethod.invoke(null, configJson, proxy)
            val startMethod = service.javaClass.getMethod("start")
            startMethod.invoke(service)
            libboxService = service
            Log.i(TAG, "Sing-box started via embedded libbox.aar PlatformInterface.")
            true
        } catch (_: ClassNotFoundException) {
            false
        } catch (e: Exception) {
            Log.w(TAG, "libbox.aar runtime unavailable (${e.message}); falling back to native sing-box binary.")
            false
        }
    }

    private fun startNativeSingboxBinary(configFile: File): Boolean {
        val nativeDir = applicationInfo.nativeLibraryDir
        val candidates = listOf(
            File(nativeDir, "libsingbox.so"),
            File(nativeDir, "sing-box")
        )
        val binary = candidates.firstOrNull { it.exists() && it.canExecute() }
            ?: candidates.firstOrNull { it.exists() }

        if (binary == null) {
            throw IllegalStateException(
                "موتور بومی sing-box در بسته اندروید یافت نشد (libsingbox.so). لطفاً آخرین نسخه رسمی را نصب کنید."
            )
        }

        if (!binary.canExecute()) {
            binary.setExecutable(true, true)
        }

        val tunFd = establishTunInterface(1400, detachForLibbox = false)
        if (tunFd < 0) {
            throw IllegalStateException("امکان ایجاد رابط شبکه مجازی TUN در اندروید وجود نداشت.")
        }

        val pb = ProcessBuilder(binary.absolutePath, "run", "-c", configFile.absolutePath)
            .directory(cacheDir)
            .redirectErrorStream(true)

        val proc = pb.start()
        singboxProcess = proc

        Thread {
            try {
                BufferedReader(InputStreamReader(proc.inputStream)).use { reader ->
                    var line: String?
                    while (reader.readLine().also { line = it } != null) {
                        line?.takeIf { it.isNotBlank() }?.let { writeCoreLog("[sing-box] $it") }
                    }
                }
            } catch (_: Exception) {
                // Process terminated normally
            }
        }.start()

        Log.i(TAG, "Native sing-box binary launched from ${binary.absolutePath}")
        return true
    }

    private fun startCoreEngine(configJson: String) {
        val configFile = File(cacheDir, "singbox_active_config.json")
        FileOutputStream(configFile).use { it.write(configJson.toByteArray(Charsets.UTF_8)) }

        if (!tryStartLibboxEngine(configJson)) {
            startNativeSingboxBinary(configFile)
        }
    }

    private fun stopCoreEngine() {
        try {
            libboxService?.let { svc ->
                val closeMethod = svc.javaClass.methods.firstOrNull { it.name == "close" && it.parameterCount == 0 }
                closeMethod?.invoke(svc)
            }
            libboxService = null
        } catch (e: Exception) {
            Log.w(TAG, "Error closing libbox service: ${e.message}")
        }

        try {
            singboxProcess?.destroy()
            singboxProcess = null
        } catch (e: Exception) {
            Log.w(TAG, "Error stopping sing-box process: ${e.message}")
        }

        try {
            vpnInterface?.close()
            vpnInterface = null
        } catch (e: Exception) {
            Log.w(TAG, "Error closing TUN interface: ${e.message}")
        }
    }

    // =========================================================================
    // VPN Lifecycle Management
    // =========================================================================

    private fun startVpnTunnel(configJson: String, mode: String, serverName: String, split: Boolean) {
        if (isServiceRunning.get()) {
            Log.w(TAG, "VPN service is already running. Refreshing notification...")
            activeServerName = serverName
            currentModeName = serverName
            updateNotification(serverName, false)
            return
        }

        Log.i(TAG, "Starting Sentra VPN Tunnel on [$serverName] in mode [$mode] (Split: $split, Auto-Reconnect: $autoReconnectEnabled)...")
        activeConfig = configJson
        activeMode = mode
        activeServerName = serverName
        splitTunnelIr = split
        currentModeName = serverName
        activeNetworkId = null
        lostNetworkPending.set(false)
        lastHeartbeatWallMs = System.currentTimeMillis()

        val notification = buildPersistentNotification(serverName, false)
        startForeground(NOTIFICATION_ID, notification)

        try {
            startCoreEngine(configJson)

            isServiceRunning.set(true)
            isVpnActive = true

            registerNetworkCallback()
            registerWakeReceiver()
            startTelemetryTicker()
            checkAndNotifyBatteryOptimization()

            SentraVpnPlugin.broadcastStatus("Connected", mode)
            writeCoreLog("[Core] Sentra Connect Android VpnService online (mode: $mode)")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start VPN tunnel: ${e.message}", e)
            writeCoreLog("[ERROR] Failed to start Android VPN tunnel: ${e.message}")
            SentraErrorReporter.reportError(
                context = applicationContext,
                moduleOrFile = "android/SentraVpnService.kt",
                actionOrRoute = "startVpnTunnel",
                throwable = e,
                extraContext = mapOf("mode" to mode, "server_name" to serverName, "split_tunnel" to split)
            )
            stopVpnTunnel()
        }
    }

    private fun startTelemetryTicker() {
        Thread {
            var counter = 0L
            var prevRx = android.net.TrafficStats.getTotalRxBytes().coerceAtLeast(0L)
            var prevTx = android.net.TrafficStats.getTotalTxBytes().coerceAtLeast(0L)
            lastHeartbeatWallMs = System.currentTimeMillis()

            while (isServiceRunning.get()) {
                try {
                    Thread.sleep(1000)
                    val nowWall = System.currentTimeMillis()
                    val wallGap = nowWall - lastHeartbeatWallMs
                    lastHeartbeatWallMs = nowWall

                    if (wallGap >= SLEEP_WAKE_GAP_MS && autoReconnectEnabled && !userDisconnected.get()) {
                        Log.i(TAG, "Detected device wake from sleep/Doze (gap=${wallGap}ms). Scheduling VPN auto-reconnect...")
                        scheduleAutoReconnect("device_wake")
                    }

                    counter++
                    uptimeSeconds = counter

                    val curRx = android.net.TrafficStats.getTotalRxBytes().coerceAtLeast(0L)
                    val curTx = android.net.TrafficStats.getTotalTxBytes().coerceAtLeast(0L)
                    val dl = (curRx - prevRx).coerceAtLeast(0L)
                    val ul = (curTx - prevTx).coerceAtLeast(0L)
                    prevRx = curRx
                    prevTx = curTx

                    downloadSpeedBps = dl
                    uploadSpeedBps = ul
                    totalDownBytes += dl
                    totalUpBytes += ul

                    SentraVpnPlugin.broadcastSpeed(dl, ul, totalDownBytes, totalUpBytes, uptimeSeconds, 0)
                } catch (_: InterruptedException) {
                    break
                }
            }
        }.start()
    }

    private fun cancelPendingReconnect() {
        pendingReconnectRunnable?.let { mainHandler.removeCallbacks(it) }
        pendingReconnectRunnable = null
    }

    private fun scheduleAutoReconnect(reason: String) {
        if (!autoReconnectEnabled || userDisconnected.get()) return
        if (activeConfig.isNullOrBlank()) return

        cancelPendingReconnect()
        val runnable = Runnable {
            performAutoReconnect(reason)
        }
        pendingReconnectRunnable = runnable
        mainHandler.postDelayed(runnable, RECONNECT_DEBOUNCE_MS)
    }

    private fun performAutoReconnect(reason: String) {
        if (!autoReconnectEnabled || userDisconnected.get()) return
        val cfg = activeConfig ?: return
        if (!isReconnecting.compareAndSet(false, true)) {
            Log.i(TAG, "Auto-reconnect already in progress; coalescing ($reason).")
            return
        }

        Thread {
            try {
                Log.i(TAG, "Auto-reconnecting VPN tunnel due to $reason...")
                writeCoreLog("[AutoReconnect] Triggered ($reason). Re-establishing VPN tunnel...")
                updateNotification(activeServerName, true)
                SentraVpnPlugin.broadcastStatus("Connecting", activeMode)

                stopCoreEngine()

                val retryDelaysMs = longArrayOf(0L, 2_000L, 4_000L)
                var reconnected = false

                for (attemptIdx in retryDelaysMs.indices) {
                    if (userDisconnected.get() || !autoReconnectEnabled) {
                        Log.i(TAG, "Auto-reconnect aborted by user.")
                        return@Thread
                    }
                    val waitMs = retryDelaysMs[attemptIdx]
                    if (waitMs > 0L) {
                        try {
                            Thread.sleep(waitMs)
                        } catch (_: InterruptedException) {
                            return@Thread
                        }
                    }
                    if (userDisconnected.get() || !autoReconnectEnabled) {
                        return@Thread
                    }

                    try {
                        Log.i(TAG, "Auto-reconnect attempt ${attemptIdx + 1}/${retryDelaysMs.size} ($reason)...")
                        startCoreEngine(cfg)
                        isServiceRunning.set(true)
                        isVpnActive = true
                        lastHeartbeatWallMs = System.currentTimeMillis()
                        updateNotification(activeServerName, false)
                        SentraVpnPlugin.broadcastStatus("Connected", activeMode)
                        writeCoreLog("[AutoReconnect] VPN tunnel re-established after $reason.")
                        reconnected = true
                        break
                    } catch (e: Exception) {
                        Log.w(TAG, "Auto-reconnect attempt ${attemptIdx + 1} failed: ${e.message}")
                        stopCoreEngine()
                    }
                }

                if (!reconnected && !userDisconnected.get()) {
                    Log.e(TAG, "Failed to auto-reconnect VPN tunnel after ${retryDelaysMs.size} attempts.")
                    writeCoreLog("[AutoReconnect] Reconnect failed after ${retryDelaysMs.size} attempts.")
                    SentraErrorReporter.reportError(
                        context = applicationContext,
                        moduleOrFile = "android/SentraVpnService.kt",
                        actionOrRoute = "performAutoReconnect($reason)",
                        errorName = "AndroidAutoReconnectFailed",
                        errorMessage = "Failed to auto-reconnect VPN tunnel after ${retryDelaysMs.size} attempts.",
                        extraContext = mapOf("reason" to reason, "mode" to activeMode)
                    )
                    isServiceRunning.set(false)
                    isVpnActive = false
                    SentraVpnPlugin.broadcastStatus("Disconnected", "None")
                }
            } finally {
                isReconnecting.set(false)
            }
        }.start()
    }

    private fun stopVpnTunnel() {
        Log.i(TAG, "Stopping Sentra VPN Tunnel...")
        cancelPendingReconnect()
        isServiceRunning.set(false)
        isVpnActive = false
        activeNetworkId = null
        lostNetworkPending.set(false)
        downloadSpeedBps = 0
        uploadSpeedBps = 0
        uptimeSeconds = 0

        unregisterNetworkCallback()
        unregisterWakeReceiver()
        stopCoreEngine()

        SentraVpnPlugin.broadcastStatus("Disconnected", "None")
        stopForeground(STOP_FOREGROUND_REMOVE)
    }

    private fun networkStableId(network: Network): Long {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            network.networkHandle
        } else {
            network.toString().hashCode().toLong()
        }
    }

    private fun registerNetworkCallback() {
        connectivityManager = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        if (connectivityManager == null) return

        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
            .build()

        networkCallback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                super.onAvailable(network)
                val netId = networkStableId(network)
                val previousId = activeNetworkId
                activeNetworkId = netId
                val recoveredFromLoss = lostNetworkPending.compareAndSet(true, false)

                if (previousId == null && !recoveredFromLoss) {
                    Log.d(TAG, "Initial underlying network recorded: $netId")
                    return
                }

                if (previousId != netId || recoveredFromLoss) {
                    Log.i(TAG, "Network transition detected (prev=$previousId -> curr=$netId, recovered=$recoveredFromLoss).")
                    if (autoReconnectEnabled && !userDisconnected.get()) {
                        scheduleAutoReconnect("network_switch")
                    }
                }
            }

            override fun onLost(network: Network) {
                super.onLost(network)
                val netId = networkStableId(network)
                Log.w(TAG, "Network connection lost: $netId")
                if (activeNetworkId == null || activeNetworkId == netId) {
                    lostNetworkPending.set(true)
                    writeCoreLog("[Network] Active network lost; awaiting next available interface...")
                }
            }
        }

        try {
            connectivityManager?.registerNetworkCallback(request, networkCallback!!)
            Log.i(TAG, "Registered ConnectivityManager.NetworkCallback for automatic network switch reconnect.")
        } catch (e: Exception) {
            Log.w(TAG, "Failed to register network callback: ${e.message}")
        }
    }

    private fun unregisterNetworkCallback() {
        try {
            networkCallback?.let { connectivityManager?.unregisterNetworkCallback(it) }
            networkCallback = null
        } catch (e: Exception) {
            Log.w(TAG, "Error unregistering network callback: ${e.message}")
        }
    }

    private fun registerWakeReceiver() {
        if (wakeReceiver != null) return
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_USER_PRESENT)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                addAction(PowerManager.ACTION_DEVICE_IDLE_MODE_CHANGED)
            }
        }

        wakeReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                val action = intent?.action ?: return
                if (!autoReconnectEnabled || userDisconnected.get()) return

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M &&
                    action == PowerManager.ACTION_DEVICE_IDLE_MODE_CHANGED
                ) {
                    val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager
                    if (pm != null && !pm.isDeviceIdleMode) {
                        Log.i(TAG, "Exited Android Doze idle mode. Scheduling VPN auto-reconnect...")
                        scheduleAutoReconnect("device_wake")
                    }
                    return
                }

                if (action == Intent.ACTION_SCREEN_ON || action == Intent.ACTION_USER_PRESENT) {
                    val gapMs = System.currentTimeMillis() - lastHeartbeatWallMs
                    if (gapMs >= SLEEP_WAKE_GAP_MS || !isVpnActive) {
                        Log.i(TAG, "Device woke from sleep ($action, gap=${gapMs}ms). Scheduling VPN auto-reconnect...")
                        scheduleAutoReconnect("device_wake")
                    }
                }
            }
        }

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                registerReceiver(wakeReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                registerReceiver(wakeReceiver, filter)
            }
            Log.i(TAG, "Registered device wake & Doze BroadcastReceiver for auto-reconnect.")
        } catch (e: Exception) {
            Log.w(TAG, "Failed to register wake BroadcastReceiver: ${e.message}")
            wakeReceiver = null
        }
    }

    private fun unregisterWakeReceiver() {
        try {
            wakeReceiver?.let { unregisterReceiver(it) }
            wakeReceiver = null
        } catch (e: Exception) {
            Log.w(TAG, "Error unregistering wake BroadcastReceiver: ${e.message}")
        }
    }

    override fun onDestroy() {
        userDisconnected.set(true)
        stopVpnTunnel()
        super.onDestroy()
        Log.i(TAG, "SentraVpnService destroyed.")
    }

    override fun onRevoke() {
        Log.w(TAG, "VPN permission was revoked by the Android OS.")
        userDisconnected.set(true)
        stopVpnTunnel()
        super.onRevoke()
    }

    // =========================================================================
    // Foreground Notification Builder
    // =========================================================================

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val name = "Sentra VPN Status"
            val descriptionText = "Displays active VPN connection status and data encryption state."
            val importance = NotificationManager.IMPORTANCE_LOW
            val channel = NotificationChannel(CHANNEL_ID, name, importance).apply {
                description = descriptionText
                setShowBadge(false)
            }
            val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            notificationManager.createNotificationChannel(channel)
        }
    }

    private fun buildPersistentNotification(serverName: String, reconnecting: Boolean): Notification {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val contentPendingIntent = PendingIntent.getActivity(
            this,
            0,
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val disconnectIntent = Intent(this, SentraVpnService::class.java).apply {
            action = ACTION_STOP_VPN
        }
        val disconnectPendingIntent = PendingIntent.getService(
            this,
            1,
            disconnectIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val label = serverName.ifBlank { "Auto" }
        val title = if (reconnecting) "Sentra · Reconnecting..." else "Sentra · Connected"
        val body = if (reconnecting) "Restoring tunnel on $label" else "Server: $label"

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(body)
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setContentIntent(contentPendingIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .addAction(
                android.R.drawable.ic_menu_close_clear_cancel,
                "Disconnect",
                disconnectPendingIntent
            )
            .build()
    }

    private fun updateNotification(serverName: String, reconnecting: Boolean) {
        val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        notificationManager.notify(NOTIFICATION_ID, buildPersistentNotification(serverName, reconnecting))
    }

    private fun isBatteryOptimizationEnabled(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return false
        val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return false
        return !pm.isIgnoringBatteryOptimizations(packageName)
    }

    private fun checkAndNotifyBatteryOptimization() {
        val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (!autoReconnectEnabled || !isBatteryOptimizationEnabled()) {
            notificationManager.cancel(BATTERY_WARNING_NOTIFICATION_ID)
            return
        }

        val settingsIntent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
        } else {
            Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:$packageName")
            ).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
        }

        val resolvedIntent = if (settingsIntent.resolveActivity(packageManager) != null) {
            settingsIntent
        } else {
            Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:$packageName")
            ).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
        }

        val settingsPendingIntent = PendingIntent.getActivity(
            this,
            2,
            resolvedIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val warningNotification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Battery optimization enabled")
            .setContentText("Disable battery optimization so Sentra can reconnect automatically.")
            .setStyle(
                NotificationCompat.BigTextStyle().bigText(
                    "Android battery optimization may interrupt background VPN reconnection. Open Settings and set Sentra to Unrestricted."
                )
            )
            .setSmallIcon(android.R.drawable.ic_dialog_alert)
            .setContentIntent(settingsPendingIntent)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .addAction(
                android.R.drawable.ic_menu_preferences,
                "Settings",
                settingsPendingIntent
            )
            .build()

        notificationManager.notify(BATTERY_WARNING_NOTIFICATION_ID, warningNotification)
        writeCoreLog("[Battery] Android battery optimization is enabled; background VPN reconnection may be restricted.")
    }
}
