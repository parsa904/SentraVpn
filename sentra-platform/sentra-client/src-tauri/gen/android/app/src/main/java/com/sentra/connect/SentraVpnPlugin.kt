package com.sentra.connect

import android.app.Activity
import android.content.Intent
import android.net.VpnService
import android.util.Log
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class StartVpnArgs {
    var configJson: String = ""
    var mode: String = "Sentra Auto"
}

/**
 * SentraVpnPlugin: Native Android Tauri Plugin
 * Bridges the TypeScript/Rust frontend with Android VpnService & libbox.
 */
@TauriPlugin
class SentraVpnPlugin(private val activity: Activity) : Plugin(activity) {

    private var pendingInvoke: Invoke? = null
    private var pendingConfigJson: String? = null
    private var pendingMode: String = "Sentra Auto"

    companion object {
        private const val TAG = "SentraVpnPlugin"
        private const val VPN_PERMISSION_REQUEST_CODE = 20262
    }

    /**
     * start_vpn: Prepares Android VPN permissions and launches SentraVpnService
     */
    @Command
    fun startVpn(invoke: Invoke) {
        val args = try {
            invoke.parseArgs(StartVpnArgs::class.java)
        } catch (e: Exception) {
            val configRaw = invoke.getString("config_json") ?: ""
            val modeRaw = invoke.getString("mode") ?: "Sentra Auto"
            StartVpnArgs().apply {
                configJson = configRaw
                mode = modeRaw
            }
        }

        if (args.configJson.isBlank()) {
            invoke.reject("پیکربندی Sing-box (config_json) خالی است.")
            return
        }

        pendingConfigJson = args.configJson
        pendingMode = args.mode

        // Check system VPN permissions
        val prepareIntent = VpnService.prepare(activity)
        if (prepareIntent != null) {
            Log.i(TAG, "Requesting Android VPN system permission from user...")
            pendingInvoke = invoke
            activity.startActivityForResult(prepareIntent, VPN_PERMISSION_REQUEST_CODE)
        } else {
            Log.i(TAG, "VPN permission already granted. Launching SentraVpnService directly...")
            launchVpnService(args.configJson, args.mode)
            val res = JSObject().apply {
                put("success", true)
                put("status", "Connected")
                put("mode", args.mode)
            }
            invoke.resolve(res)
        }
    }

    /**
     * stop_vpn: Stops the foreground VPN service
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
     * get_vpn_stats: Exposes live connection status and throughput counters back to Tauri UI
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
                val mode = pendingMode
                launchVpnService(config, mode)

                val res = JSObject().apply {
                    put("success", true)
                    put("status", "Connected")
                    put("mode", mode)
                }
                invoke?.resolve(res)
            } else {
                Log.w(TAG, "User denied Android VPN permission.")
                invoke?.reject("مجوز اتصال VPN توسط کاربر رد شد.")
            }
        }
    }

    private fun launchVpnService(configJson: String, mode: String) {
        val intent = Intent(activity, SentraVpnService::class.java).apply {
            action = SentraVpnService.ACTION_START_VPN
            putExtra(SentraVpnService.EXTRA_CONFIG_JSON, configJson)
            putExtra(SentraVpnService.EXTRA_ACTIVE_MODE, mode)
        }
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            activity.startForegroundService(intent)
        } else {
            activity.startService(intent)
        }
    }
}
