use crate::models::*;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "com.sentra.connect";

pub fn init<R: Runtime, C: serde::de::DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> Result<SentraVpn<R>, Box<dyn std::error::Error>> {
    #[cfg(target_os = "android")]
    {
        let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "SentraVpnPlugin")?;
        Ok(SentraVpn(handle))
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = api;
        Err("Mobile VPN plugin is only available on Android platform".into())
    }
}

pub struct SentraVpn<R: Runtime>(
    #[cfg(target_os = "android")]
    PluginHandle<R>,
    #[cfg(not(target_os = "android"))]
    std::marker::PhantomData<R>,
);

impl<R: Runtime> SentraVpn<R> {
    pub fn connect(&self, config_json: String, split_tunnel_ir: bool) -> Result<ConnectResponse, String> {
        #[cfg(target_os = "android")]
        {
            self.0
                .run_mobile_plugin("startVpn", ConnectRequest { config_json, split_tunnel_ir })
                .map_err(|e| e.to_string())
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = (config_json, split_tunnel_ir);
            Err("Mobile VPN plugin is only supported on Android".to_string())
        }
    }

    pub fn disconnect(&self) -> Result<DisconnectResponse, String> {
        #[cfg(target_os = "android")]
        {
            self.0
                .run_mobile_plugin("stopVpn", ())
                .map_err(|e| e.to_string())
        }
        #[cfg(not(target_os = "android"))]
        {
            Err("Mobile VPN plugin is only supported on Android".to_string())
        }
    }

    pub fn get_status(&self) -> Result<VpnStatusResponse, String> {
        #[cfg(target_os = "android")]
        {
            self.0
                .run_mobile_plugin("getVpnStats", ())
                .map_err(|e| e.to_string())
        }
        #[cfg(not(target_os = "android"))]
        {
            Err("Mobile VPN plugin is only supported on Android".to_string())
        }
    }

    pub fn save_session(&self, payload: String) -> Result<SessionSaveResponse, String> {
        #[cfg(target_os = "android")]
        {
            self.0
                .run_mobile_plugin("saveSession", SessionPayloadRequest { payload })
                .map_err(|e| e.to_string())
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = payload;
            Err("Android secure storage is only available on mobile".to_string())
        }
    }

    pub fn load_session(&self) -> Result<SessionLoadResponse, String> {
        #[cfg(target_os = "android")]
        {
            self.0
                .run_mobile_plugin("loadSession", ())
                .map_err(|e| e.to_string())
        }
        #[cfg(not(target_os = "android"))]
        {
            Err("Android secure storage is only available on mobile".to_string())
        }
    }

    pub fn clear_session(&self) -> Result<SessionSaveResponse, String> {
        #[cfg(target_os = "android")]
        {
            self.0
                .run_mobile_plugin("clearSession", ())
                .map_err(|e| e.to_string())
        }
        #[cfg(not(target_os = "android"))]
        {
            Err("Android secure storage is only available on mobile".to_string())
        }
    }
}
