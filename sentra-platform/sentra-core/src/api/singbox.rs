use crate::db::models::{Outbound, Subscription};
use serde_json::{json, Value};

pub fn build_client_config(subscription: &Subscription, outbounds: &[Outbound]) -> Value {
    let mut outbound_tags: Vec<String> = Vec::new();
    let mut singbox_outbounds: Vec<Value> = Vec::new();

    // Build specific outbound entries from database records
    for ob in outbounds {
        outbound_tags.push(ob.tag.clone());

        let node_config = match ob.protocol.as_str() {
            "socks" => json!({
                "type": "socks",
                "tag": ob.tag,
                "server": ob.server_address,
                "server_port": ob.server_port,
                "version": "5"
            }),
            "http" => json!({
                "type": "http",
                "tag": ob.tag,
                "server": ob.server_address,
                "server_port": ob.server_port
            }),
            "vless" => {
                let mut vless_obj = json!({
                    "type": "vless",
                    "tag": ob.tag,
                    "server": ob.server_address,
                    "server_port": ob.server_port,
                    "uuid": ob.uuid.as_deref().unwrap_or("00000000-0000-0000-0000-000000000000")
                });
                if ob.tls_enabled == 1 {
                    vless_obj["tls"] = json!({
                        "enabled": true,
                        "server_name": ob.tls_sni.as_deref().unwrap_or("microsoft.com"),
                        "utls": {
                            "enabled": true,
                            "fingerprint": "chrome"
                        }
                    });
                }
                vless_obj
            }
            "direct" => json!({
                "type": "direct",
                "tag": ob.tag
            }),
            _ => json!({
                "type": "socks",
                "tag": ob.tag,
                "server": ob.server_address,
                "server_port": ob.server_port,
                "version": "5"
            }),
        };

        singbox_outbounds.push(node_config);
    }

    // Always ensure at least the loopback sandbox is present if database was empty
    if outbound_tags.is_empty() {
        outbound_tags.push("Sentra Sandbox Loopback".to_string());
        singbox_outbounds.push(json!({
            "type": "socks",
            "tag": "Sentra Sandbox Loopback",
            "server": "127.0.0.1",
            "server_port": 10801,
            "version": "5"
        }));
    }

    // Prepend the Selector and urltest groups
    let mut all_outbounds = Vec::new();

    // 1. Sentra Select (User manual selector)
    let mut selector_list = vec!["Sentra Auto".to_string()];
    selector_list.extend(outbound_tags.clone());
    selector_list.push("direct".to_string());

    all_outbounds.push(json!({
        "type": "selector",
        "tag": "Sentra Select",
        "outbounds": selector_list,
        "default": "Sentra Auto"
    }));

    // 2. Sentra Auto (urltest group with 15s interval)
    all_outbounds.push(json!({
        "type": "urltest",
        "tag": "Sentra Auto",
        "outbounds": outbound_tags,
        "url": "https://cp.cloudflare.com/generate_204",
        "interval": "15s",
        "tolerance": 50
    }));

    // 3. Concrete proxy nodes
    all_outbounds.extend(singbox_outbounds);

    // 4. Infrastructure outbounds
    all_outbounds.push(json!({ "type": "direct", "tag": "direct" }));
    all_outbounds.push(json!({ "type": "block", "tag": "block" }));
    all_outbounds.push(json!({ "type": "dns", "tag": "dns-out" }));

    // Construct full Sing-box v1.10+ JSON template
    json!({
        "_sentra_meta": {
            "tier": subscription.tier,
            "status": subscription.status,
            "traffic_limit_bytes": subscription.traffic_limit_bytes,
            "used_bytes": subscription.upload_bytes + subscription.download_bytes,
            "expires_at": subscription.expires_at.to_rfc3339()
        },
        "log": {
            "level": "info",
            "timestamp": true
        },
        "dns": {
            "servers": [
                {
                    "tag": "dns-fakeip",
                    "address": "fakeip"
                },
                {
                    "tag": "dns-remote",
                    "address": "https://1.1.1.1/dns-query",
                    "address_resolver": "dns-direct",
                    "strategy": "ipv4_only",
                    "detour": "Sentra Select"
                },
                {
                    "tag": "dns-direct",
                    "address": "local",
                    "detour": "direct"
                },
                {
                    "tag": "dns-block",
                    "address": "rcode://success"
                }
            ],
            "rules": [
                {
                    "outbound": "any",
                    "server": "dns-direct"
                },
                {
                    "domain_suffix": [
                        ".ir",
                        ".gov.ir",
                        ".co.ir",
                        "shaparak.ir",
                        "divar.ir",
                        "digikala.com",
                        "snapp.ir"
                    ],
                    "server": "dns-direct"
                },
                {
                    "clash_mode": "Direct",
                    "server": "dns-direct"
                },
                {
                    "clash_mode": "Global",
                    "server": "dns-fakeip"
                },
                {
                    "query_type": [
                        "A",
                        "AAAA"
                    ],
                    "server": "dns-fakeip"
                }
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
        "outbounds": all_outbounds,
        "route": {
            "auto_detect_interface": true,
            "rules": [
                {
                    "protocol": "dns",
                    "outbound": "dns-out"
                },
                {
                    "ip_is_private": true,
                    "outbound": "direct"
                },
                {
                    "domain_suffix": [
                        ".ir",
                        ".gov.ir",
                        ".co.ir",
                        "shaparak.ir",
                        "divar.ir",
                        "digikala.com",
                        "snapp.ir"
                    ],
                    "outbound": "direct"
                },
                {
                    "clash_mode": "Direct",
                    "outbound": "direct"
                },
                {
                    "clash_mode": "Global",
                    "outbound": "Sentra Select"
                }
            ],
            "final": "Sentra Select"
        }
    })
}
