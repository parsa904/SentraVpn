package io.nekohasekai.libbox

/**
 * TunOptions: Tunnel configuration options passed by Sing-box / libbox
 */
open class TunOptions {
    var inet4Address: String = "172.19.0.1/30"
    var inet6Address: String = "fdfe:dcba:9876::1/126"
    var mtu: Int = 1400
    var autoRoute: Boolean = true
    var strictRoute: Boolean = true
    var dnsServers: List<String> = listOf("198.18.0.1")
}
