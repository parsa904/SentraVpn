use crate::db::{DbPool, Repository};
use crate::error::CoreError;
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::path::Path;
use tracing::{info, warn};

/// Synchronizes server-side sing-box bridge configuration file (/etc/sing-box/bridge-config.json)
/// and gracefully triggers sing-box reload without dropping active connections.
pub async fn sync_server_bridge_config(pool: &DbPool) -> Result<(), CoreError> {
    info!("[BridgeSync] Synchronizing server sing-box bridge configuration...");

    // 1. Fetch active outbounds for the 3 modes
    // Static IP: strictly official only
    let static_outbounds = Repository::get_active_official_outbounds_for_mode(pool, "static_ip")
        .await
        .unwrap_or_default();

    // Web Browsing: prioritized official then donated
    let web_outbounds = Repository::get_active_outbounds_for_mode_prioritized(pool, "web_browsing")
        .await
        .unwrap_or_default();

    // Download: prioritized official then donated
    let dl_outbounds = Repository::get_active_outbounds_for_mode_prioritized(pool, "download")
        .await
        .unwrap_or_default();

    let mut singbox_outbounds: Vec<Value> = Vec::new();
    let mut web_outbound_tags: Vec<String> = Vec::new();
    let mut dl_outbound_tags: Vec<String> = Vec::new();
    let mut static_target_tag = "direct-out".to_string();

    // Default direct outbound fallback
    singbox_outbounds.push(json!({
        "type": "direct",
        "tag": "direct-out"
    }));

    // Register all active web outbounds with country tags
    for dob in &web_outbounds {
        if let Ok(mut parsed) = serde_json::from_str::<Value>(&dob.config_json) {
            let tag = format!("out-web-{}-{}", dob.country_code.to_lowercase(), dob.id);
            if let Some(obj) = parsed.as_object_mut() {
                obj.insert("tag".to_string(), json!(tag));
            }
            singbox_outbounds.push(parsed);
            web_outbound_tags.push(tag);
        }
    }

    // Register all active download outbounds with country tags
    for dob in &dl_outbounds {
        if let Ok(mut parsed) = serde_json::from_str::<Value>(&dob.config_json) {
            let tag = format!("out-dl-{}-{}", dob.country_code.to_lowercase(), dob.id);
            if let Some(obj) = parsed.as_object_mut() {
                obj.insert("tag".to_string(), json!(tag));
            }
            singbox_outbounds.push(parsed);
            dl_outbound_tags.push(tag);
        }
    }

    // Register static_ip outbound
    if let Some(dob) = static_outbounds.first() {
        if let Ok(mut parsed) = serde_json::from_str::<Value>(&dob.config_json) {
            let tag = format!("out-static-{}", dob.id);
            if let Some(obj) = parsed.as_object_mut() {
                obj.insert("tag".to_string(), json!(tag));
            }
            singbox_outbounds.push(parsed);
            static_target_tag = tag;
        }
    }

    // Create urltest Auto groups for web and download
    let web_target_tag = if !web_outbound_tags.is_empty() {
        singbox_outbounds.push(json!({
            "type": "urltest",
            "tag": "out-web-auto",
            "outbounds": web_outbound_tags,
            "url": "http://cp.cloudflare.com/generate_204",
            "interval": "3m",
            "tolerance": 50
        }));
        "out-web-auto".to_string()
    } else {
        "direct-out".to_string()
    };

    let dl_target_tag = if !dl_outbound_tags.is_empty() {
        singbox_outbounds.push(json!({
            "type": "urltest",
            "tag": "out-dl-auto",
            "outbounds": dl_outbound_tags,
            "url": "http://cp.cloudflare.com/generate_204",
            "interval": "3m",
            "tolerance": 50
        }));
        "out-dl-auto".to_string()
    } else {
        "direct-out".to_string()
    };

    // 2. Fetch active Cloudflare WARP account for dual-chain routing
    let warp_opt = Repository::get_active_warp_account(pool).await.unwrap_or(None);

    let mut inbounds = vec![
        json!({
            "type": "tun",
            "tag": "tun-web",
            "interface_name": "tun-web",
            "inet4_address": "10.10.0.1/30",
            "auto_route": false,
            "strict_route": false,
            "stack": "system"
        }),
        json!({
            "type": "tun",
            "tag": "tun-dl",
            "interface_name": "tun-dl",
            "inet4_address": "10.10.1.1/30",
            "auto_route": false,
            "strict_route": false,
            "stack": "system"
        }),
        json!({
            "type": "tun",
            "tag": "tun-static",
            "interface_name": "tun-static",
            "inet4_address": "10.10.2.1/30",
            "auto_route": false,
            "strict_route": false,
            "stack": "system"
        }),
    ];

    let mut route_rules = vec![
        json!({
            "inbound": ["tun-web"],
            "outbound": web_target_tag
        }),
        json!({
            "inbound": ["tun-dl"],
            "outbound": dl_target_tag
        }),
        json!({
            "inbound": ["tun-static"],
            "outbound": static_target_tag
        }),
    ];

    if let Some(warp) = warp_opt {
        let reserved_val: Value = serde_json::from_str(&warp.reserved).unwrap_or_else(|_| json!([0, 0, 0]));

        // WARP chained outbound for Web Browsing (detour -> out-web-auto)
        singbox_outbounds.push(json!({
            "type": "wireguard",
            "tag": "out-web-warp",
            "server": "162.159.192.1",
            "server_port": 2408,
            "local_address": [
                format!("{}/32", warp.address_v4),
                format!("{}/128", warp.address_v6)
            ],
            "private_key": warp.private_key,
            "peer_public_key": "bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=",
            "reserved": reserved_val,
            "mtu": 1280,
            "detour": web_target_tag
        }));

        // WARP chained outbound for Download (detour -> out-dl-auto)
        singbox_outbounds.push(json!({
            "type": "wireguard",
            "tag": "out-dl-warp",
            "server": "162.159.192.1",
            "server_port": 2408,
            "local_address": [
                format!("{}/32", warp.address_v4),
                format!("{}/128", warp.address_v6)
            ],
            "private_key": warp.private_key,
            "peer_public_key": "bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=",
            "reserved": reserved_val,
            "mtu": 1280,
            "detour": dl_target_tag
        }));

        // Add dedicated TUN inbounds for WARP traffic
        inbounds.push(json!({
            "type": "tun",
            "tag": "tun-web-warp",
            "interface_name": "tun-web-warp",
            "inet4_address": "10.10.10.1/30",
            "auto_route": false,
            "strict_route": false,
            "stack": "system"
        }));
        inbounds.push(json!({
            "type": "tun",
            "tag": "tun-dl-warp",
            "interface_name": "tun-dl-warp",
            "inet4_address": "10.10.11.1/30",
            "auto_route": false,
            "strict_route": false,
            "stack": "system"
        }));

        // Direct WARP inbounds through chained wireguard outbounds
        route_rules.insert(0, json!({
            "inbound": ["tun-web-warp"],
            "outbound": "out-web-warp"
        }));
        route_rules.insert(1, json!({
            "inbound": ["tun-dl-warp"],
            "outbound": "out-dl-warp"
        }));
    }

    let config = json!({
        "log": {
            "level": "warn",
            "timestamp": true
        },
        "inbounds": inbounds,
        "outbounds": singbox_outbounds,
        "route": {
            "rules": route_rules,
            "final": "direct-out"
        }
    });

    let bridge_path_str = env::var("SINGBOX_BRIDGE_PATH")
        .unwrap_or_else(|_| "/etc/sing-box/bridge-config.json".to_string());
    let bridge_path = Path::new(&bridge_path_str);

    if let Some(parent) = bridge_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let formatted_json = serde_json::to_string_pretty(&config)
        .map_err(|e| CoreError::Internal(format!("Failed to serialize bridge config: {}", e)))?;

    match fs::write(bridge_path, formatted_json) {
        Ok(_) => {
            info!(
                "[BridgeSync] Successfully written bridge config to {:?}. Reloading sing-box...",
                bridge_path
            );
            reload_singbox_service();
        }
        Err(e) => {
            warn!(
                "[BridgeSync] Could not write to {:?} ({}). Saving to local fallback .sentra/bridge-config.json",
                bridge_path, e
            );
            let local_fallback = Path::new(".sentra/bridge-config.json");
            if let Some(p) = local_fallback.parent() {
                let _ = fs::create_dir_all(p);
            }
            if let Ok(c) = serde_json::to_string_pretty(&config) {
                let _ = fs::write(local_fallback, c);
            }
        }
    }

    Ok(())
}

fn reload_singbox_service() {
    #[cfg(unix)]
    {
        use std::process::Command;
        info!("[BridgeSync] Executing systemctl reload sing-box...");
        let status = Command::new("systemctl")
            .args(["reload", "sing-box"])
            .status();

        match status {
            Ok(s) if s.success() => {
                info!("[BridgeSync] sing-box reloaded successfully via systemctl.");
            }
            _ => {
                warn!("[BridgeSync] systemctl reload failed. Attempting SIGHUP killall -HUP sing-box...");
                let _ = Command::new("killall")
                    .args(["-HUP", "sing-box"])
                    .status();
            }
        }
    }

    #[cfg(not(unix))]
    {
        info!("[BridgeSync] Non-unix platform detected. Reload signal simulated for sing-box bridge.");
    }
}
