package io.nekohasekai.libbox

/**
 * PlatformInterface: Core integration interface for Sing-box libbox on Android.
 * Implemented by SentraVpnService.
 */
interface PlatformInterface {
    /**
     * Prevents network loop by protecting outbound sockets from entering the VPN tunnel
     */
    fun autoDetectInterfaceControl(fd: Int)

    /**
     * Opens and configures the virtual Android TUN interface
     * @return file descriptor of the created TUN interface
     */
    fun openTun(options: TunOptions): Int

    /**
     * Callback for core log messages from Sing-box
     */
    fun writeLog(message: String)

    /**
     * Indicates whether platform auto-detect interface control is supported
     */
    fun usePlatformAutoDetectInterfaceControl(): Boolean {
        return true
    }

    /**
     * Resolves application package name from Android system UID
     */
    fun packageNameByUid(uid: Int): String {
        return ""
    }

    /**
     * Resolves UID from application package name
     */
    fun uidByPackageName(packageName: String): Int {
        return 0
    }
}
