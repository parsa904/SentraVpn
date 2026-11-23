package com.sentra.connect

import android.os.Bundle
import app.tauri.plugin.PluginManager

class MainActivity : TauriActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        
        // Register our custom native SentraVpnPlugin
        PluginManager.load(null, "sentraVpn", SentraVpnPlugin(this), "{}")
    }
}
