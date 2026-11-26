use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use tracing::{info, warn};

pub struct ConfigManager;

impl ConfigManager {
    /// Fetch dynamic Sing-box v1.14+ configuration from Cloudflare Worker backend or fallback to local template
    pub async fn fetch_or_fallback(
        token: &str,
        backend_url: &str,
        split_tunneling: bool,
    ) -> anyhow::Result<Value> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(8))
            .build()?;

        let base = backend_url.trim().trim_end_matches('/');
        let config_url = format!("{}/api/v1/client/config", base);
        info!("Requesting dynamic sing-box 1.14+ configuration from {}...", config_url);

        let response = client
            .post(&config_url)
            .header("X-Subscription-Token", token)
            .json(&json!({
                "token": token,
                "device_id": "sentra-desktop-local",
                "os": if cfg!(target_os = "android") { "android" } else { "windows" }
            }))
            .send()
            .await;

        let mut config_json: Value = match response {
            Ok(resp) if resp.status().is_success() => {
                info!("Successfully fetched dynamic configuration from backend.");
                let raw: Value = resp.json().await?;
                raw.get("singbox_config")
                    .or_else(|| raw.get("config"))
                    .cloned()
                    .unwrap_or(raw)
            }
            _ => {
                let sub_url = format!("{}/sub/{}?format=singbox", base, token);
                match client.get(&sub_url).send().await {
                    Ok(sub_resp) if sub_resp.status().is_success() => {
                        info!("Successfully fetched sing-box 1.14+ configuration via /sub endpoint.");
                        sub_resp.json().await?
                    }
                    Ok(sub_resp) => {
                        warn!("Backend returned status {}. Falling back to local sing-box 1.14+ template.", sub_resp.status());
                        Self::get_local_fallback_template()
                    }
                    Err(e) => {
                        warn!("Failed to reach backend ({}). Utilizing local sing-box 1.14+ template.", e);
                        Self::get_local_fallback_template()
                    }
                }
            }
        };

        // Adjust split tunneling rule if disabled by user
        if !split_tunneling {
            if let Some(rules) = config_json.get_mut("route").and_then(|r| r.get_mut("rules")).and_then(|r| r.as_array_mut()) {
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

    /// Local embedded fallback Sing-box v1.14+ template (Zero-VPS compatible)
    fn get_local_fallback_template() -> Value {
        json!({
            "log": {
                "level": "info",
                "timestamp": true
            },
            "dns": {
                "servers": [
                    {
                        "type": "fakeip",
                        "tag": "dns-fakeip",
                        "inet4_range": "198.18.0.0/15",
                        "inet6_range": "fc00::/18"
                    },
                    {
                        "type": "https",
                        "tag": "dns-doh",
                        "server": "1.1.1.1",
                        "server_port": 443,
                        "path": "/dns-query",
                        "detour": "Sentra Select"
                    },
                    {
                        "type": "local",
                        "tag": "dns-direct"
                    }
                ],
                "rules": [
                    { "domain_suffix": [".ir", ".gov.ir", ".co.ir", "shaparak.ir", "divar.ir", "digikala.com", "snapp.ir"], "server": "dns-direct" },
                    { "clash_mode": "Direct", "server": "dns-direct" },
                    { "clash_mode": "Global", "server": "dns-fakeip" },
                    { "query_type": ["A", "AAAA"], "server": "dns-fakeip" }
                ],
                "final": "dns-doh",
                "strategy": "prefer_ipv4"
            },
            "inbounds": [
                {
                    "type": "tun",
                    "tag": "tun-in",
                    "interface_name": "sentra-tun",
                    "address": ["172.19.0.1/30", "fdfe:dcba:9876::1/126"],
                    "mtu": 9000,
                    "auto_route": true,
                    "strict_route": true,
                    "stack": "mixed"
                }
            ],
            "outbounds": [
                {
                    "type": "selector",
                    "tag": "Sentra Select",
                    "outbounds": ["direct"],
                    "default": "direct"
                },
                { "type": "direct", "tag": "direct" }
            ],
            "route": {
                "auto_detect_interface": true,
                "default_domain_resolver": "dns-direct",
                "rules": [
                    { "action": "sniff", "timeout": "300ms" },
                    { "protocol": "dns", "action": "hijack-dns" },
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
