use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use tracing::{info, warn};

pub struct ConfigManager;

impl ConfigManager {
    /// Fetch dynamic Sing-box v1.10+ configuration from backend or fallback to local template
    pub async fn fetch_or_fallback(
        token: &str,
        backend_url: &str,
        split_tunneling: bool,
    ) -> anyhow::Result<Value> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(3))
            .build()?;

        let connect_url = format!("{}/api/v1/client/connect", backend_url);
        info!("Requesting dynamic configuration from {}...", connect_url);

        let response = client
            .post(&connect_url)
            .json(&json!({
                "token": token,
                "device_id": "sentra-desktop-local",
                "os": "windows"
            }))
            .send()
            .await;

        let mut config_json: Value = match response {
            Ok(resp) if resp.status().is_success() => {
                info!("Successfully fetched dynamic configuration from backend.");
                resp.json().await?
            }
            Ok(resp) => {
                warn!("Backend returned status {}. Falling back to local template.", resp.status());
                Self::get_local_fallback_template()
            }
            Err(e) => {
                warn!("Failed to reach backend ({}). Utilizing local sandbox template.", e);
                Self::get_local_fallback_template()
            }
        };

        // Adjust split tunneling rule if disabled by user
        if !split_tunneling {
            if let Some(rules) = config_json.get_mut("route").and_then(|r| r.get_mut("rules")).and_then(|r| r.as_array_mut()) {
                // Remove the domain_suffix rules that direct to "direct"
                rules.retain(|rule| {
                    if let Some(outbound) = rule.get("outbound").and_then(|o| o.as_str()) {
                        if outbound == "direct" && rule.get("domain_suffix").is_some() {
                            return false;
                        }
                    }
                    true
                });
            }
        }

        Ok(config_json)
    }

    /// Save configuration to client cache path
    pub fn save_config(config: &Value, path: &PathBuf) -> anyhow::Result<()> {
        let content = serde_json::to_string_pretty(config)?;
        fs::write(path, content)?;
        info!("Saved active sing-box configuration to {:?}", path);
        Ok(())
    }

    /// Local embedded fallback Sing-box v1.10+ template
    fn get_local_fallback_template() -> Value {
        json!({
            "log": {
                "level": "info",
                "timestamp": true
            },
            "dns": {
                "servers": [
                    { "tag": "dns-fakeip", "address": "fakeip" },
                    { "tag": "dns-remote", "address": "https://1.1.1.1/dns-query", "address_resolver": "dns-direct", "strategy": "ipv4_only", "detour": "Sentra Select" },
                    { "tag": "dns-direct", "address": "local", "detour": "direct" },
                    { "tag": "dns-block", "address": "rcode://success" }
                ],
                "rules": [
                    { "outbound": "any", "server": "dns-direct" },
                    { "domain_suffix": [".ir", ".gov.ir", ".co.ir", "shaparak.ir", "divar.ir", "digikala.com", "snapp.ir"], "server": "dns-direct" },
                    { "clash_mode": "Direct", "server": "dns-direct" },
                    { "clash_mode": "Global", "server": "dns-fakeip" },
                    { "query_type": ["A", "AAAA"], "server": "dns-fakeip" }
                ],
                "fakeip": {
                    "enabled": true,
                    "inet4_range": "198.18.0.0/15",
                    "inet6_range": "fc00::/18"
                },
                "independent_cache": true
            },
            "inbounds": [
                {
                    "type": "tun",
                    "tag": "tun-in",
                    "interface_name": "sentra-tun",
                    "inet4_address": "172.19.0.1/30",
                    "inet6_address": "fdfe:dcba:9876::1/126",
                    "mtu": 9000,
                    "auto_route": true,
                    "strict_route": true,
                    "stack": "mixed",
                    "sniff": true,
                    "sniff_override_destination": true
                }
            ],
            "outbounds": [
                {
                    "type": "selector",
                    "tag": "Sentra Select",
                    "outbounds": ["Sentra Auto", "Sentra Sandbox Loopback", "Sentra Test Direct/Warp", "direct"],
                    "default": "Sentra Auto"
                },
                {
                    "type": "urltest",
                    "tag": "Sentra Auto",
                    "outbounds": ["Sentra Sandbox Loopback", "Sentra Test Direct/Warp"],
                    "url": "https://cp.cloudflare.com/generate_204",
                    "interval": "15s",
                    "tolerance": 50
                },
                {
                    "type": "socks",
                    "tag": "Sentra Sandbox Loopback",
                    "server": "127.0.0.1",
                    "server_port": 10801,
                    "version": "5"
                },
                {
                    "type": "socks",
                    "tag": "Sentra Test Direct/Warp",
                    "server": "127.0.0.1",
                    "server_port": 10804,
                    "version": "5"
                },
                { "type": "direct", "tag": "direct" },
                { "type": "block", "tag": "block" },
                { "type": "dns", "tag": "dns-out" }
            ],
            "route": {
                "auto_detect_interface": true,
                "rules": [
                    { "protocol": "dns", "outbound": "dns-out" },
                    { "ip_is_private": true, "outbound": "direct" },
                    { "domain_suffix": [".ir", ".gov.ir", ".co.ir", "shaparak.ir", "divar.ir", "digikala.com", "snapp.ir"], "outbound": "direct" },
                    { "clash_mode": "Direct", "outbound": "direct" },
                    { "clash_mode": "Global", "outbound": "Sentra Select" }
                ],
                "final": "Sentra Select"
            }
        })
    }
}
