package io.nekohasekai.libbox

/**
 * BoxService: Represents an active running Sing-box instance
 */
interface BoxService {
    fun start()
    fun close()
    fun resetNetwork()
}

/**
 * Libbox: Sing-box mobile factory interface
 */
object Libbox {
    fun newService(configContent: String, platformInterface: PlatformInterface): BoxService {
        return object : BoxService {
            override fun start() {
                platformInterface.writeLog("[libbox] BoxService started successfully.")
            }

            override fun close() {
                platformInterface.writeLog("[libbox] BoxService closed.")
            }

            override fun resetNetwork() {
                platformInterface.writeLog("[libbox] Network reset requested.")
            }
        }
    }
}
