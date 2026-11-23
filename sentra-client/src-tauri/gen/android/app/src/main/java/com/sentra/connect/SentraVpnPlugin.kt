package com.sentra.connect

import android.app.Activity
import android.content.Intent
import android.content.SharedPreferences
import android.net.VpnService
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class ConnectArgs {
    var configJson: String = ""
    var splitTunnelIr: Boolean = true
    var mode: String = "Sentra Auto"
}

@InvokeArg
class SessionSaveArgs {
    var payload: String = ""
}

/**
 * SentraVpnPlugin: Native Android Tauri Plugin
 * Bridges the TypeScript/Rust frontend with Android VpnService, libbox,
 * and AES-256 EncryptedSharedPreferences for one-time persistent authentication.
 */
@TauriPlugin
class SentraVpnPlugin(private val activity: Activity) : Plugin(activity) {

    private var pendingInvoke: Invoke? = null
    private var pendingConfigJson: String? = null
    private var pendingSplitTunnel: Boolean = true
    private var pendingMode: String = "Sentra Auto"

    init {
        instance = this
    }

    private fun getSecurePrefs(): SharedPreferences {
        return try {
            val masterKey = MasterKey.Builder(activity.applicationContext)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            EncryptedSharedPreferences.create(
                activity.applicationContext,
                PREFS_NAME,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            )
        } catch (e: Exception) {
            Log.w(TAG, "EncryptedSharedPreferences fallback to MODE_PRIVATE: ${e.message}")
            activity.applicationContext.getSharedPreferences(PREFS_NAME, android.content.Context.MODE_PRIVATE)
        }
    }

    companion object {
        private const val TAG = "SentraVpnPlugin"
        private const val PREFS_NAME = "sentra_secure_auth_prefs"
        private const val KEY_SESSION_JSON = "sentra_session_json"
        private const val VPN_PERMISSION_REQUEST_CODE = 20262

        @Volatile
        private var instance: SentraVpnPlugin? = null

        fun broadcastLog(message: String) {
            instance?.let { plugin ->
                val payload = JSObject().apply {
                    put("timestamp", java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.getDefault()).format(java.util.Date()))
                    put("level", "INFO")
                    put("message", message)
                }
                plugin.trigger("telemetry-log", payload)
            }
        }

        fun broadcastSpeed(dl: Long, ul: Long, totalDl: Long, totalUl: Long, uptime: Long, pingMs: Int = 0) {
            instance?.let { plugin ->
                val payload = JSObject().apply {
                    put("download_speed_bps", dl)
                    put("upload_speed_bps", ul)
                    put("ping_ms", pingMs)
                    put("total_download_bytes", totalDl)
                    put("total_upload_bytes", totalUl)
                    put("uptime_seconds", uptime)
                }
                plugin.trigger("telemetry-speed", payload)
            }
        }

        fun broadcastStatus(status: String, mode: String) {
            instance?.let { plugin ->
                val payload = JSObject().apply {
                    put("status", status)
                    put("mode", mode)
                }
                plugin.trigger("connection-status-changed", payload)
            }
        }
    }

    /**
     * saveSession: Persists auth/session JSON in Android EncryptedSharedPreferences
     */
    @Command
    fun saveSession(invoke: Invoke) {
        val raw = try {
            invoke.parseArgs(SessionSaveArgs::class.java).payload
        } catch (_: Exception) {
            invoke.getString("payload") ?: ""
        }
        if (raw.isBlank()) {
            invoke.reject("داده نشست برای ذخیره خالی است.")
            return
        }
        getSecurePrefs().edit().putString(KEY_SESSION_JSON, raw).apply()
        val res = JSObject().apply { put("success", true) }
        invoke.resolve(res)
    }

    /**
     * loadSession: Reads persisted auth/session JSON from EncryptedSharedPreferences
     */
    @Command
    fun loadSession(invoke: Invoke) {
        val stored = getSecurePrefs().getString(KEY_SESSION_JSON, null)
        val res = JSObject().apply {
            put("found", !stored.isNullOrBlank())
            put("payload", stored ?: "")
        }
        invoke.resolve(res)
    }

    /**
     * clearSession: Clears persisted auth/session on explicit user logout or token expiry
     */
    @Command
    fun clearSession(invoke: Invoke) {
        getSecurePrefs().edit().remove(KEY_SESSION_JSON).apply()
        val res = JSObject().apply { put("success", true) }
        invoke.resolve(res)
    }

    /**
     * startVpn: Prepares Android VPN permissions and launches SentraVpnService
     */
    @Command
    fun startVpn(invoke: Invoke) {
        val args = try {
            invoke.parseArgs(ConnectArgs::class.java)
        } catch (e: Exception) {
            val configRaw = invoke.getString("config_json") ?: invoke.getString("configJson") ?: ""
            val splitRaw = invoke.getBoolean("split_tunnel_ir") ?: invoke.getBoolean("splitTunnelIr") ?: true
            val modeRaw = invoke.getString("mode") ?: "Sentra Auto"
            ConnectArgs().apply {
                configJson = configRaw
                splitTunnelIr = splitRaw
                mode = modeRaw
            }
        }

        if (args.configJson.isBlank()) {
            invoke.reject("پیکربندی Sing-box (config_json) خالی است.")
            return
        }

        pendingConfigJson = args.configJson
        pendingSplitTunnel = args.splitTunnelIr
        pendingMode = args.mode

        // Check Android system VPN permission
        val prepareIntent = VpnService.prepare(activity)
        if (prepareIntent != null) {
            Log.i(TAG, "Requesting Android system VPN permission via startActivityForResult...")
            pendingInvoke = invoke
            activity.startActivityForResult(prepareIntent, VPN_PERMISSION_REQUEST_CODE)
        } else {
            Log.i(TAG, "VPN permission already granted. Launching SentraVpnService directly...")
            launchVpnService(args.configJson, args.mode, args.splitTunnelIr)
            val res = JSObject().apply {
                put("success", true)
                put("status", "Connected")
                put("mode", args.mode)
            }
            invoke.resolve(res)
        }
    }

    /**
     * stopVpn: Stops the foreground VPN service
     */
    @Command
    fun stopVpn(invoke: Invoke) {
        Log.i(TAG, "Stopping Sentra VPN Service via Plugin invoke...")
        val intent = Intent(activity, SentraVpnService::class.java).apply {
            action = SentraVpnService.ACTION_STOP_VPN
        }
        activity.startService(intent)

        val res = JSObject().apply {
            put("success", true)
            put("status", "Disconnected")
        }
        invoke.resolve(res)
    }

    /**
     * getVpnStats: Exposes live connection status and throughput counters back to Tauri UI
     */
    @Command
    fun getVpnStats(invoke: Invoke) {
        val res = JSObject().apply {
            put("is_active", SentraVpnService.isVpnActive)
            put("mode", SentraVpnService.currentModeName)
            put("download_speed_bps", SentraVpnService.downloadSpeedBps)
            put("upload_speed_bps", SentraVpnService.uploadSpeedBps)
            put("total_down_bytes", SentraVpnService.totalDownBytes)
            put("total_up_bytes", SentraVpnService.totalUpBytes)
            put("uptime_seconds", SentraVpnService.uptimeSeconds)
        }
        invoke.resolve(res)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == VPN_PERMISSION_REQUEST_CODE) {
            val invoke = pendingInvoke
            pendingInvoke = null

            if (resultCode == Activity.RESULT_OK) {
                Log.i(TAG, "User granted Android VPN permission!")
                val config = pendingConfigJson ?: ""
                val split = pendingSplitTunnel
                val mode = pendingMode
                launchVpnService(config, mode, split)

                val res = JSObject().apply {
                    put("success", true)
                    put("status", "Connected")
                    put("mode", mode)
                }
                invoke?.resolve(res)
            } else {
                Log.w(TAG, "User denied Android VPN permission.")
                invoke?.reject("مجوز اتصال VPN توسط کاربر تایید نشد.")
            }
        }
    }

    private fun launchVpnService(configJson: String, mode: String, split: Boolean) {
        val intent = Intent(activity, SentraVpnService::class.java).apply {
            action = SentraVpnService.ACTION_START_VPN
            putExtra(SentraVpnService.EXTRA_CONFIG_JSON, configJson)
            putExtra(SentraVpnService.EXTRA_ACTIVE_MODE, mode)
            putExtra(SentraVpnService.EXTRA_SPLIT_TUNNEL_IR, split)
        }
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            activity.startForegroundService(intent)
        } else {
            activity.startService(intent)
        }
    }
}
