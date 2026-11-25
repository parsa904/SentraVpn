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

    // 1. Fetch active outbounds for all modes (with automatic ecosystem fallback in Repository)
    let static_outbounds = Repository::get_active_official_outbounds_for_mode(pool, "static_ip")
        .await
        .unwrap_or_default();

    let web_outbounds = Repository::get_active_outbounds_for_mode_prioritized(pool, "web_browsing")
        .await
        .unwrap_or_default();

    let dl_outbounds = Repository::get_active_outbounds_for_mode_prioritized(pool, "download")
        .await
        .unwrap_or_default();

    let gaming_outbounds = Repository::get_active_outbounds_for_mode_prioritized(pool, "gaming")
        .await
        .unwrap_or_default();

    // Also load any non-loopback active rows from the core `outbounds` table so manually added core outbounds are active on the bridge too
    let core_outbounds: Vec<crate::models::Outbound> = Repository::list_all_outbounds(pool)
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|ob| ob.is_active == 1 && ob.server_address != "127.0.0.1")
        .collect();

    let mut singbox_outbounds: Vec<Value> = Vec::new();
    let mut web_outbound_tags: Vec<String> = Vec::new();
    let mut dl_outbound_tags: Vec<String> = Vec::new();
    let mut static_outbound_tags: Vec<String> = Vec::new();
    let mut gaming_outbound_tags: Vec<String> = Vec::new();
    let mut inserted_tags: std::collections::HashSet<String> = std::collections::HashSet::new();

    // Default direct outbound fallback
    singbox_outbounds.push(json!({
        "type": "direct",
        "tag": "direct-out"
    }));
    inserted_tags.insert("direct-out".to_string());

    // Register all active web outbounds with country tags (sorted by is_official DESC, speed_score DESC, latency_ms ASC)
    for dob in &web_outbounds {
        if let Ok(mut parsed) = serde_json::from_str::<Value>(&dob.config_json) {
            let tag = format!("out-web-{}-{}", dob.country_code.to_lowercase(), dob.id);
            if inserted_tags.insert(tag.clone()) {
                if let Some(obj) = parsed.as_object_mut() {
                    obj.insert("tag".to_string(), json!(tag));
                }
                singbox_outbounds.push(parsed);
            }
            if !web_outbound_tags.contains(&tag) {
                web_outbound_tags.push(tag);
            }
        }
    }

    // Register all active download outbounds with country tags
    for dob in &dl_outbounds {
        if let Ok(mut parsed) = serde_json::from_str::<Value>(&dob.config_json) {
            let tag = format!("out-dl-{}-{}", dob.country_code.to_lowercase(), dob.id);
            if inserted_tags.insert(tag.clone()) {
                if let Some(obj) = parsed.as_object_mut() {
                    obj.insert("tag".to_string(), json!(tag));
                }
                singbox_outbounds.push(parsed);
            }
            if !dl_outbound_tags.contains(&tag) {
                dl_outbound_tags.push(tag);
            }
        }
    }

    // Register static_ip outbounds
    for dob in &static_outbounds {
        if let Ok(mut parsed) = serde_json::from_str::<Value>(&dob.config_json) {
            let tag = format!("out-static-{}-{}", dob.country_code.to_lowercase(), dob.id);
            if inserted_tags.insert(tag.clone()) {
                if let Some(obj) = parsed.as_object_mut() {
                    obj.insert("tag".to_string(), json!(tag));
                }
                singbox_outbounds.push(parsed);
            }
            if !static_outbound_tags.contains(&tag) {
                static_outbound_tags.push(tag);
            }
        }
    }

    // Register gaming outbounds (lowest-latency pool for Windows, Android & iOS WireGuard gaming exit)
    for dob in &gaming_outbounds {
        if let Ok(mut parsed) = serde_json::from_str::<Value>(&dob.config_json) {
            let tag = format!("out-game-{}-{}", dob.country_code.to_lowercase(), dob.id);
            if inserted_tags.insert(tag.clone()) {
                if let Some(obj) = parsed.as_object_mut() {
                    obj.insert("tag".to_string(), json!(tag));
                }
                singbox_outbounds.push(parsed);
            }
            if !gaming_outbound_tags.contains(&tag) {
                gaming_outbound_tags.push(tag);
            }
        }
    }

    // Register non-loopback active rows from the core `outbounds` table
    for ob in &core_outbounds {
        let tag = format!("out-core-{}-{}", ob.country_code.to_lowercase(), ob.id);
        let node_cfg = match ob.protocol.as_str() {
            "vless" => {
                let mut v = json!({
                    "type": "vless",
                    "tag": tag,
                    "server": ob.server_address,
                    "server_port": ob.server_port,
                    "uuid": ob.uuid.as_deref().unwrap_or("00000000-0000-0000-0000-000000000000"),
                    "flow": "",
                    "packet_encoding": "xudp"
                });
                if ob.tls_enabled == 1 {
                    v["tls"] = json!({
                        "enabled": true,
                        "server_name": ob.tls_sni.as_deref().unwrap_or("learn.microsoft.com"),
                        "utls": { "enabled": true, "fingerprint": "chrome" },
                        "reality": {
                            "enabled": true,
                            "public_key": ob.reality_public_key.as_deref().unwrap_or(""),
                            "short_id": ob.reality_short_id.as_deref().unwrap_or("")
                        }
                    });
                }
                v
            }
            "trojan" => json!({
                "type": "trojan",
                "tag": tag,
                "server": ob.server_address,
                "server_port": ob.server_port,
                "password": ob.password.as_deref().unwrap_or("sentra_pass")
            }),
            "hysteria2" => json!({
                "type": "hysteria2",
                "tag": tag,
                "server": ob.server_address,
                "server_port": ob.server_port,
                "password": ob.password.as_deref().unwrap_or("sentra_pass")
            }),
            "http" => json!({
                "type": "http",
                "tag": tag,
                "server": ob.server_address,
                "server_port": ob.server_port
            }),
            _ => json!({
                "type": "socks",
                "tag": tag,
                "server": ob.server_address,
                "server_port": ob.server_port,
                "version": "5"
            }),
        };

        if inserted_tags.insert(tag.clone()) {
            singbox_outbounds.push(node_cfg);
        }
        match ob.mode_category.as_str() {
            "static_ip" => {
                if !static_outbound_tags.contains(&tag) {
                    static_outbound_tags.push(tag.clone());
                }
                if !web_outbound_tags.contains(&tag) {
                    web_outbound_tags.push(tag.clone());
                }
                if !dl_outbound_tags.contains(&tag) {
                    dl_outbound_tags.push(tag);
                }
            }
            "gaming" => {
                if !gaming_outbound_tags.contains(&tag) {
                    gaming_outbound_tags.push(tag.clone());
                }
                if !web_outbound_tags.contains(&tag) {
                    web_outbound_tags.push(tag);
                }
            }
            "download" => {
                if !dl_outbound_tags.contains(&tag) {
                    dl_outbound_tags.push(tag.clone());
                }
                if !web_outbound_tags.contains(&tag) {
                    web_outbound_tags.push(tag);
                }
            }
            _ => {
                if !web_outbound_tags.contains(&tag) {
                    web_outbound_tags.push(tag.clone());
                }
                if !dl_outbound_tags.contains(&tag) {
                    dl_outbound_tags.push(tag.clone());
                }
                if !gaming_outbound_tags.contains(&tag) {
                    gaming_outbound_tags.push(tag);
                }
            }
        }
    }

    let static_target_tag = if !static_outbound_tags.is_empty() {
        if static_outbound_tags.len() > 1 {
            singbox_outbounds.push(json!({
                "type": "urltest",
                "tag": "out-static-auto",
                "outbounds": static_outbound_tags,
                "url": "https://api.binance.com/api/v3/ping",
                "interval": "5m",
                "tolerance": 30
            }));
            "out-static-auto".to_string()
        } else {
            static_outbound_tags[0].clone()
        }
    } else if !web_outbound_tags.is_empty() {
        web_outbound_tags[0].clone()
    } else {
        "direct-out".to_string()
    };

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
    } else if !dl_outbound_tags.is_empty() {
        dl_outbound_tags[0].clone()
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
    } else if !web_outbound_tags.is_empty() {
        web_outbound_tags[0].clone()
    } else {
        "direct-out".to_string()
    };

    let gaming_target_tag = if !gaming_outbound_tags.is_empty() {
        singbox_outbounds.push(json!({
            "type": "urltest",
            "tag": "out-gaming-auto",
            "outbounds": gaming_outbound_tags,
            "url": "http://cp.cloudflare.com/generate_204",
            "interval": "1m",
            "tolerance": 15
        }));
        "out-gaming-auto".to_string()
    } else if !web_outbound_tags.is_empty() {
        web_target_tag.clone()
    } else {
        "direct-out".to_string()
    };

    // 2. Fetch active Cloudflare WARP account for dual-chain routing (never applied to gaming/static)
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
        json!({
            "type": "tun",
            "tag": "tun-gaming",
            "interface_name": "tun-gaming",
            "inet4_address": "10.10.3.1/30",
            "mtu": 1280,
            "endpoint_independent_nat": true,
            "udp_timeout": "5m",
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
        json!({
            "inbound": ["tun-gaming"],
            "outbound": gaming_target_tag
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
        .unwrap_or_else(|_| {
            if Path::new("/etc/sing-box/config.json").exists() || Path::new("/etc/sing-box").exists() {
                "/etc/sing-box/config.json".to_string()
            } else {
                "/etc/sing-box/bridge-config.json".to_string()
            }
        });
    let bridge_path = Path::new(&bridge_path_str);

    if let Some(parent) = bridge_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let formatted_json = serde_json::to_string_pretty(&config)
        .map_err(|e| CoreError::Internal(format!("Failed to serialize bridge config: {}", e)))?;

    match fs::write(bridge_path, &formatted_json) {
        Ok(_) => {
            info!(
                "[BridgeSync] Successfully written bridge config to {:?}. Reloading sing-box...",
                bridge_path
            );
            // Also write mirror copy to /etc/sing-box/bridge-config.json if target was config.json
            if bridge_path_str.ends_with("config.json") {
                let _ = fs::write("/etc/sing-box/bridge-config.json", &formatted_json);
            }
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
