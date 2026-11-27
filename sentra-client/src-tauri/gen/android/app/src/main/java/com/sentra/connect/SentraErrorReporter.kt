package com.sentra.connect

import android.content.Context
import android.os.Build
import android.util.Log
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.io.PrintWriter
import java.io.StringWriter
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.ConcurrentHashMap

/**
 * SentraErrorReporter: Native Android error reporter for SentraVPN.
 * Sends standardized, secret-sanitized error reports to Cloudflare Worker
 * (`POST /api/v1/telemetry/error`) so native Kotlin/VpnService/sing-box crashes
 * appear immediately in Telegram `topic_logs_id` in AI-ready format.
 */
object SentraErrorReporter {
    private const val TAG = "SentraErrorReporter"
    private const val TELEMETRY_ENDPOINT =
        "https://sentra-core.kziepr.workers.dev/api/v1/telemetry/error"
    private const val DEDUP_WINDOW_MS = 60_000L

    private val recentFingerprints = ConcurrentHashMap<String, Long>()

    @Volatile
    private var uncaughtHandlerInstalled = false

    @Volatile
    private var cachedAppVersion: String = "1.0.0"

    private val bearerRegex = Regex("""(Bearer\s+)[^\s"',;\r\n]+""", RegexOption.IGNORE_CASE)
    private val subPathRegex = Regex("""(/(?:api/v1/)?sub/)([^/?#\s"'<>]+)""", RegexOption.IGNORE_CASE)
    private val botTokenRegex = Regex("""\b\d{6,14}:[A-Za-z0-9_-]{20,}\b""")

    private fun sanitize(input: String?): String {
        if (input.isNullOrEmpty()) return ""
        return input
            .replace(botTokenRegex, "[REDACTED]")
            .replace(bearerRegex, "$1[REDACTED]")
            .replace(subPathRegex, "$1[REDACTED]")
    }

    private fun isoTimestampNow(): String {
        val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        fmt.timeZone = TimeZone.getTimeZone("UTC")
        return fmt.format(Date())
    }

    private fun resolveAppVersion(context: Context?): String {
        if (context == null) return cachedAppVersion
        return try {
            val pInfo = context.packageManager.getPackageInfo(context.packageName, 0)
            val v = pInfo.versionName?.takeIf { it.isNotBlank() } ?: cachedAppVersion
            cachedAppVersion = v
            v
        } catch (_: Exception) {
            cachedAppVersion
        }
    }

    private fun throwableStackTrace(t: Throwable): String {
        val sw = StringWriter()
        t.printStackTrace(PrintWriter(sw))
        return sw.toString().take(3000)
    }

    fun installUncaughtExceptionHandler(context: Context) {
        if (uncaughtHandlerInstalled) return
        uncaughtHandlerInstalled = true
        resolveAppVersion(context)

        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            try {
                reportErrorBlocking(
                    context = context,
                    moduleOrFile = "android/MainActivity.kt",
                    actionOrRoute = "uncaught_exception:${thread.name}",
                    errorName = throwable.javaClass.simpleName.ifBlank { "Throwable" },
                    errorMessage = throwable.message ?: throwable.toString(),
                    stackTrace = throwableStackTrace(throwable),
                    extraContext = mapOf("thread" to thread.name),
                    timeoutMs = 2500
                )
            } catch (_: Exception) {
                // Never block OS crash reporting
            } finally {
                previous?.uncaughtException(thread, throwable)
            }
        }
    }

    fun reportError(
        context: Context?,
        moduleOrFile: String,
        actionOrRoute: String,
        throwable: Throwable? = null,
        errorName: String? = null,
        errorMessage: String? = null,
        extraContext: Map<String, Any?> = emptyMap()
    ) {
        val resolvedName = errorName ?: throwable?.javaClass?.simpleName ?: "AndroidError"
        val resolvedMsg = errorMessage ?: throwable?.message ?: throwable?.toString() ?: "Unknown Android error"
        val stack = throwable?.let { throwableStackTrace(it) }

        val thread = Thread {
            reportErrorBlocking(
                context = context,
                moduleOrFile = moduleOrFile,
                actionOrRoute = actionOrRoute,
                errorName = resolvedName,
                errorMessage = resolvedMsg,
                stackTrace = stack,
                extraContext = extraContext,
                timeoutMs = 5000
            )
        }
        thread.isDaemon = true
        thread.start()
    }

    private fun reportErrorBlocking(
        context: Context?,
        moduleOrFile: String,
        actionOrRoute: String,
        errorName: String,
        errorMessage: String,
        stackTrace: String?,
        extraContext: Map<String, Any?>,
        timeoutMs: Int
    ) {
        try {
            val cleanModule = sanitize(moduleOrFile).take(180)
            val cleanAction = sanitize(actionOrRoute).take(180)
            val cleanName = sanitize(errorName).take(120)
            val cleanMsg = sanitize(errorMessage).take(1000)

            val now = System.currentTimeMillis()
            val fp = "android|$cleanModule|$cleanName|${cleanMsg.take(120)}"
            val prev = recentFingerprints[fp]
            if (prev != null && now - prev < DEDUP_WINDOW_MS) {
                return
            }
            recentFingerprints[fp] = now

            val ctxObj = JSONObject().apply {
                put("android_release", Build.VERSION.RELEASE ?: "unknown")
                put("android_sdk", Build.VERSION.SDK_INT)
                put("device_model", "${Build.MANUFACTURER} ${Build.MODEL}".trim())
                put("runtime", "android-kotlin")
                for ((k, v) in extraContext) {
                    if (v != null) {
                        put(k, sanitize(v.toString()).take(240))
                    }
                }
            }

            val body = JSONObject().apply {
                put("platform", "android")
                put("appVersion", resolveAppVersion(context))
                put("moduleOrFile", cleanModule)
                put("actionOrRoute", cleanAction)
                put("errorName", cleanName)
                put("errorMessage", cleanMsg)
                if (!stackTrace.isNullOrBlank()) {
                    put("stackTrace", sanitize(stackTrace).take(3000))
                }
                put("context", ctxObj)
                put("timestamp", isoTimestampNow())
            }

            val conn = (URL(TELEMETRY_ENDPOINT).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("X-App-Version", resolveAppVersion(context))
            }

            try {
                OutputStreamWriter(conn.outputStream, Charsets.UTF_8).use { writer ->
                    writer.write(body.toString())
                    writer.flush()
                }
                val code = conn.responseCode
                if (code !in 200..299) {
                    Log.w(TAG, "Error report returned HTTP $code")
                }
            } finally {
                conn.disconnect()
            }
        } catch (e: Exception) {
            Log.w(TAG, "Could not transmit native Android error report: ${e.message}")
        }
    }

    /**
     * Reports a sanitized sing-box Auto-Rollback event directly to `/api/v1/logs/report`
     * with `platform: "android"` and `appVersion` (zero user tokens/secrets).
     */
    fun reportRollbackError(
        context: Context?,
        singboxError: String,
        rolledBackToGoodConfig: Boolean,
        extraContext: Map<String, Any?> = emptyMap()
    ) {
        val thread = Thread {
            try {
                val cleanMsg = sanitize(singboxError).take(1000)
                val ctxObj = JSONObject().apply {
                    put("android_release", Build.VERSION.RELEASE ?: "unknown")
                    put("android_sdk", Build.VERSION.SDK_INT)
                    put("device_model", "${Build.MANUFACTURER} ${Build.MODEL}".trim())
                    put("runtime", "android-kotlin")
                    put("rollback_performed", rolledBackToGoodConfig)
                    put("singbox_auto_rollback", true)
                    for ((k, v) in extraContext) {
                        if (v != null) {
                            put(k, sanitize(v.toString()).take(240))
                        }
                    }
                }

                val body = JSONObject().apply {
                    put("platform", "android")
                    put("appVersion", resolveAppVersion(context))
                    put("moduleOrFile", "android/SentraVpnService.kt")
                    put("actionOrRoute", "singbox_auto_rollback")
                    put("errorName", "SingboxAutoRollback")
                    put("errorMessage", cleanMsg)
                    put("context", ctxObj)
                    put("timestamp", isoTimestampNow())
                }

                val logsUrl = "https://sentra-core.kziepr.workers.dev/api/v1/logs/report"
                val conn = (URL(logsUrl).openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    connectTimeout = 5000
                    readTimeout = 5000
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json; charset=utf-8")
                    setRequestProperty("X-App-Version", resolveAppVersion(context))
                }
                try {
                    OutputStreamWriter(conn.outputStream, Charsets.UTF_8).use { writer ->
                        writer.write(body.toString())
                        writer.flush()
                    }
                    val code = conn.responseCode
                    if (code !in 200..299) {
                        Log.w(TAG, "Rollback log report returned HTTP $code")
                    }
                } finally {
                    conn.disconnect()
                }
            } catch (e: Exception) {
                Log.w(TAG, "Could not transmit Android rollback report: ${e.message}")
            }
        }
        thread.isDaemon = true
        thread.start()
    }
}
