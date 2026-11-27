use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tracing::{info, warn};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

pub const LAST_KNOWN_GOOD_CONFIG_FILE: &str = "last_known_good_config.json";
pub const CANDIDATE_CONFIG_FILE: &str = "candidate_config.json";
pub const STABILITY_WINDOW_SECS: u64 = 5;

pub struct ConfigManager;

impl ConfigManager {
    /// Fetch dynamic Sing-box v1.14+ configuration from Cloudflare Worker backend
    /// using the official `/api/v1/client/config` endpoint with `X-Sentra-Client`.
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
            .header("X-Sentra-Client", format!("SentraVPN/{}", env!("CARGO_PKG_VERSION")))
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
            Ok(resp) => {
                warn!(
                    "Backend returned status {}. Falling back to local sing-box 1.14+ template.",
                    resp.status()
                );
                Self::get_local_fallback_template()
            }
            Err(e) => {
                warn!(
                    "Failed to reach backend ({}). Utilizing local sing-box 1.14+ template.",
                    e
                );
                Self::get_local_fallback_template()
            }
        };

        // Adjust split tunneling rule if disabled by user
        if !split_tunneling {
            if let Some(rules) = config_json
                .get_mut("route")
                .and_then(|r| r.get_mut("rules"))
                .and_then(|r| r.as_array_mut())
            {
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

    /// Validates required sing-box 1.14+ top-level structure (`inbounds`, `outbounds`, `route`)
    /// and ensures at least one concrete outbound exists before launching the core.
    pub fn validate_singbox_structure(config: &Value) -> Result<(), String> {
        let obj = config
            .as_object()
            .ok_or_else(|| "ساختار کانفیگ sing-box باید یک آبجکت JSON معتبر باشد.".to_string())?;

        let inbounds = obj
            .get("inbounds")
            .and_then(|v| v.as_array())
            .ok_or_else(|| "بخش الزامی inbounds در کانفیگ sing-box یافت نشد.".to_string())?;
        if inbounds.is_empty() {
            return Err("آرایه inbounds در کانفیگ sing-box خالی است.".to_string());
        }

        let outbounds = obj
            .get("outbounds")
            .and_then(|v| v.as_array())
            .ok_or_else(|| "بخش الزامی outbounds در کانفیگ sing-box یافت نشد.".to_string())?;
        if outbounds.is_empty() {
            return Err("آرایه outbounds در کانفیگ sing-box خالی است.".to_string());
        }

        let has_usable_outbound = outbounds.iter().any(|ob| {
            ob.get("type")
                .and_then(|t| t.as_str())
                .map(|t| !matches!(t, "selector" | "urltest" | "block" | "dns"))
                .unwrap_or(false)
        });
        if !has_usable_outbound {
            return Err("هیچ نود اوتباند فعالی در کانفیگ sing-box یافت نشد.".to_string());
        }

        if !obj.get("route").map(|r| r.is_object()).unwrap_or(false) {
            return Err("بخش الزامی route در کانفیگ sing-box یافت نشد.".to_string());
        }

        Ok(())
    }

    /// Executes `sing-box check -c <config_path>` synchronously before launching the sidecar
    /// so invalid or deprecated schemas are rejected prior to tearing down connectivity.
    pub fn run_singbox_check(bin_path: &Path, config_path: &Path) -> Result<(), String> {
        let mut cmd = Command::new(bin_path);
        cmd.arg("check").arg("-c").arg(config_path);
        #[cfg(target_os = "windows")]
        {
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }

        let output = cmd
            .output()
            .map_err(|e| format!("خطا در اجرای sing-box check: {}", e))?;

        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();

        if !output.status.success() {
            let detail = if !stderr.is_empty() {
                stderr
            } else if !stdout.is_empty() {
                stdout
            } else {
                format!("exit code {:?}", output.status.code())
            };
            return Err(format!("sing-box check failed: {}", detail));
        }

        Ok(())
    }

    pub fn candidate_path(dir: &Path) -> PathBuf {
        dir.join(CANDIDATE_CONFIG_FILE)
    }

    pub fn last_known_good_path(dir: &Path) -> PathBuf {
        dir.join(LAST_KNOWN_GOOD_CONFIG_FILE)
    }

    /// Stages a newly fetched config into `candidate_config.json` without overwriting
    /// `last_known_good_config.json`.
    pub fn stage_candidate_config(dir: &Path, config: &Value) -> anyhow::Result<PathBuf> {
        let _ = fs::create_dir_all(dir);
        let path = Self::candidate_path(dir);
        Self::save_config(config, &path)?;
        Ok(path)
    }

    /// Promotes verified `candidate_config.json` to `last_known_good_config.json`
    /// ONLY after the core has started cleanly and remained stable for 5 seconds.
    pub fn promote_candidate_to_last_known_good(dir: &Path) -> anyhow::Result<PathBuf> {
        let candidate = Self::candidate_path(dir);
        let last_good = Self::last_known_good_path(dir);
        let content = fs::read_to_string(&candidate)?;
        fs::write(&last_good, content)?;
        info!("Promoted verified candidate_config.json -> {:?}", last_good);
        Ok(last_good)
    }

    /// Save configuration to client cache path
    pub fn save_config(config: &Value, path: &PathBuf) -> anyhow::Result<()> {
        let content = serde_json::to_string_pretty(config)?;
        fs::write(path, content)?;
        info!("Saved sing-box configuration to {:?}", path);
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
