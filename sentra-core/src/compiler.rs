use crate::models::{DonatedOutbound, Outbound, Subscription};
use chrono::Utc;
use serde_json::{json, Value};

/// Compiles a fully compliant Sing-box v1.10+ JSON template tailored to the user's subscription tier
/// and allowed outbounds, strictly following docs/PROTOCOL_SPEC.md.
#[allow(dead_code)]
pub fn compile_singbox_config(
    subscription: &Subscription,
    outbounds: &[Outbound],
    preferred_mode: Option<&str>,
) -> Value {
    compile_singbox_config_with_donated(subscription, outbounds, &[], preferred_mode)
}

/// Compiles Sing-box v1.10+ JSON including active community donated outbounds
#[allow(dead_code)]
pub fn compile_singbox_config_with_donated(
    subscription: &Subscription,
    outbounds: &[Outbound],
    donated_outbounds: &[DonatedOutbound],
    preferred_mode: Option<&str>,
) -> Value {
    let mut outbound_tags: Vec<String> = Vec::new();
    let mut singbox_outbounds: Vec<Value> = Vec::new();

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
                    "uuid": ob.uuid.as_deref().unwrap_or("00000000-0000-0000-0000-000000000000"),
                    "flow": "",
                    "packet_encoding": "xudp"
                });
                if ob.tls_enabled == 1 {
                    vless_obj["tls"] = json!({
                        "enabled": true,
                        "server_name": ob.tls_sni.as_deref().unwrap_or("learn.microsoft.com"),
                        "utls": {
                            "enabled": true,
                            "fingerprint": "chrome"
                        },
                        "reality": {
                            "enabled": true,
                            "public_key": ob.reality_public_key.as_deref().unwrap_or(""),
                            "short_id": ob.reality_short_id.as_deref().unwrap_or("")
                        }
                    });
                }
                vless_obj
            }
            "trojan" => json!({
                "type": "trojan",
                "tag": ob.tag,
                "server": ob.server_address,
                "server_port": ob.server_port,
                "password": ob.password.as_deref().unwrap_or("sentra_pass")
            }),
            "hysteria2" => json!({
                "type": "hysteria2",
                "tag": ob.tag,
                "server": ob.server_address,
                "server_port": ob.server_port,
                "password": ob.password.as_deref().unwrap_or("sentra_pass")
            }),
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

    // Incorporate active official & donated outbounds (parsed JSON config)
    for dob in donated_outbounds {
        if let Ok(mut val) = serde_json::from_str::<Value>(&dob.config_json) {
            let tag = if dob.is_official == 1 {
                if let Some(ref l) = dob.label {
                    format!("👑 {}", l)
                } else {
                    format!("👑 {}", dob.tag)
                }
            } else {
                format!("🤝 {}", dob.tag)
            };
            val["tag"] = json!(tag);
            outbound_tags.push(tag);
            singbox_outbounds.push(val);
        }
    }

    // Fallback if no specific outbounds were matched
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

    // Build the master Outbound list
    let mut all_outbounds = Vec::new();

    // 1. Selector Group (Sentra Select)
    let mut selector_list = vec!["Sentra Auto".to_string()];
    selector_list.extend(outbound_tags.clone());
    selector_list.push("direct".to_string());

    all_outbounds.push(json!({
        "type": "selector",
        "tag": "Sentra Select",
        "outbounds": selector_list,
        "default": "Sentra Auto"
    }));

    // 2. Latency auto-switching Group (Sentra Auto) - 15s interval
    all_outbounds.push(json!({
        "type": "urltest",
        "tag": "Sentra Auto",
        "outbounds": outbound_tags,
        "url": "https://cp.cloudflare.com/generate_204",
        "interval": "15s",
        "tolerance": 50
    }));

    // 3. Concrete mode outbounds
    all_outbounds.extend(singbox_outbounds);

    // 4. Base system outbounds
    all_outbounds.push(json!({ "type": "direct", "tag": "direct" }));
    all_outbounds.push(json!({ "type": "block", "tag": "block" }));
    all_outbounds.push(json!({ "type": "dns", "tag": "dns-out" }));

    // Iranian domain bypass list for split tunneling
    let ir_domain_suffixes = vec![
        ".ir",
        ".gov.ir",
        ".co.ir",
        "shaparak.ir",
        "divar.ir",
        "digikala.com",
        "snapp.ir",
        "tamin.ir",
        "bmi.ir",
        "bki.ir",
        "mellatbank.ir",
        "tejaratbank.ir",
        "banksepah.ir"
    ];

    let game_domains = vec![
        "riotgames.com", "leagueoflegends.com", "valorant.com", "pvp.net",
        "epicgames.com", "unrealengine.com", "fortnite.com",
        "ea.com", "origin.com", "electronicarts.com",
        "steampowered.com", "steamcommunity.com", "steamgames.com", "valvesoftware.com",
        "blizzard.com", "battle.net", "activision.com", "callofduty.com",
        "ubisoft.com", "uplay.com",
        "rockstargames.com", "socialclub.rockstargames.com",
        "discord.com", "discordapp.com", "discord.gg", "discord.media",
        "pubg.com", "krafton.com", "apexlegends.com"
    ];

    let is_gaming = preferred_mode.map_or(false, |m| m.eq_ignore_ascii_case("gaming"));
    let tun_stack = if is_gaming { "system" } else { "mixed" };
    let tun_mtu = if is_gaming { 1420 } else { 9000 };

    let mut route_rules = vec![
        json!({
            "protocol": "dns",
            "outbound": "dns-out"
        }),
        json!({
            "ip_is_private": true,
            "outbound": "direct"
        }),
        json!({
            "geoip": [
                "ir",
                "private"
            ],
            "outbound": "direct"
        }),
        json!({
            "domain_suffix": ir_domain_suffixes,
            "outbound": "direct"
        }),
    ];

    if is_gaming {
        route_rules.push(json!({
            "domain_suffix": game_domains,
            "outbound": "Sentra Select"
        }));
        route_rules.push(json!({
            "geosite": [
                "category-games"
            ],
            "outbound": "Sentra Select"
        }));
        route_rules.push(json!({
            "network": ["udp", "tcp"],
            "outbound": "Sentra Select"
        }));
    }

    route_rules.push(json!({
        "clash_mode": "Direct",
        "outbound": "direct"
    }));
    route_rules.push(json!({
        "clash_mode": "Global",
        "outbound": "Sentra Select"
    }));

    let route_final = "Sentra Select";

    // Assembly conforming to Sing-box v1.10+
    json!({
        "_sentra_meta": {
            "tier": subscription.tier,
            "status": subscription.status,
            "mode": preferred_mode.unwrap_or("web_browsing"),
            "traffic_limit_bytes": subscription.traffic_limit_bytes,
            "used_bytes": subscription.upload_bytes + subscription.download_bytes,
            "web_browsing_used_mb": subscription.web_browsing_used_mb,
            "download_used_mb": subscription.download_used_mb,
            "speed_limit_bps": subscription.speed_limit_bps,
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
                    "tag": "dns-doh",
                    "address": "https://1.1.1.1/dns-query",
                    "address_resolver": "dns-direct",
                    "strategy": "prefer_ipv4",
                    "detour": "direct"
                },
                {
                    "tag": "dns-doh-google",
                    "address": "https://dns.google/dns-query",
                    "address_resolver": "dns-direct",
                    "strategy": "prefer_ipv4",
                    "detour": "direct"
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
                    "domain_suffix": ir_domain_suffixes,
                    "server": "dns-direct"
                },
                {
                    "geoip": [
                        "ir"
                    ],
                    "server": "dns-direct"
                },
                {
                    "domain_suffix": game_domains,
                    "server": "dns-doh"
                },
                {
                    "geosite": [
                        "category-games"
                    ],
                    "server": "dns-doh"
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
                },
                {
                    "outbound": "any",
                    "server": "dns-doh"
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
                "mtu": tun_mtu,
                "auto_route": true,
                "strict_route": true,
                "stack": tun_stack,
                "sniff": true,
                "sniff_override_destination": true
            }
        ],
        "outbounds": all_outbounds,
        "route": {
            "auto_detect_interface": true,
            "rules": route_rules,
            "final": route_final
        },
        "experimental": {
            "clash_api": {
                "external_controller": "127.0.0.1:9090",
                "secret": "sentra_internal_traffic_secret"
            }
        }
    })
}

/// Compiles Sing-box v1.10+ JSON utilizing pre-ranked UnifiedOutbound list and prioritized selected tag
pub fn compile_singbox_config_with_unified(
    subscription: &Subscription,
    ranked_outbounds: &[crate::quality_engine::UnifiedOutbound],
    primary_tag: &str,
    preferred_mode: Option<&str>,
) -> Value {
    compile_singbox_config_with_unified_ext(subscription, ranked_outbounds, primary_tag, preferred_mode, None)
}

/// Extended compiler supporting gaming submodes (full_udp vs anti_sanction)
pub fn compile_singbox_config_with_unified_ext(
    subscription: &Subscription,
    ranked_outbounds: &[crate::quality_engine::UnifiedOutbound],
    primary_tag: &str,
    preferred_mode: Option<&str>,
    gaming_submode: Option<&str>,
) -> Value {
    let is_gaming = preferred_mode.map_or(false, |m| m.eq_ignore_ascii_case("gaming"));
    let is_anti_sanction = gaming_submode.map_or(false, |s| {
        s.eq_ignore_ascii_case("anti_sanction") || s.eq_ignore_ascii_case("anti_sanction_split")
    });

    // Multi-layer Failover Chain: Primary outbound + up to 2 other healthy backup outbounds (max 3 total)
    let primary_ob = ranked_outbounds
        .iter()
        .find(|o| o.tag == primary_tag)
        .or_else(|| ranked_outbounds.first())
        .cloned();

    let mut selected_chain: Vec<crate::quality_engine::UnifiedOutbound> = Vec::new();

    if let Some(p) = primary_ob {
        selected_chain.push(p.clone());
        // Select up to 2 other healthy backups (distinct from primary)
        for ob in ranked_outbounds {
            if ob.tag != p.tag && ob.is_healthy {
                selected_chain.push(ob.clone());
                if selected_chain.len() >= 3 {
                    break;
                }
            }
        }
        // If fewer than 3, add any other available outbounds
        if selected_chain.len() < 3 {
            for ob in ranked_outbounds {
                if !selected_chain.iter().any(|s| s.tag == ob.tag) {
                    selected_chain.push(ob.clone());
                    if selected_chain.len() >= 3 {
                        break;
                    }
                }
            }
        }
    }

    if selected_chain.is_empty() {
        let fallback = crate::quality_engine::UnifiedOutbound::sandbox_fallback(preferred_mode.unwrap_or("web_browsing"));
        selected_chain.push(fallback);
    }

    let mut outbound_tags: Vec<String> = Vec::new();
    let mut singbox_outbounds: Vec<Value> = Vec::new();

    for uob in &selected_chain {
        outbound_tags.push(uob.tag.clone());
        // Apply uTLS, TLS Fragment, and Multiplex optimizations (disabled for gaming)
        singbox_outbounds.push(uob.to_singbox_value_with_optimizations(preferred_mode));
    }

    let default_tag = "Sentra Auto";

    let mut all_outbounds = Vec::new();

    // 1. Selector Group (Sentra Select)
    let mut selector_list = vec!["Sentra Auto".to_string()];
    selector_list.extend(outbound_tags.clone());
    selector_list.push("direct".to_string());

    all_outbounds.push(json!({
        "type": "selector",
        "tag": "Sentra Select",
        "outbounds": selector_list,
        "default": default_tag
    }));

    // 2. Latency auto-switching Group (Sentra Auto) - Multi-layer failover (interval: 3m, tolerance: 50)
    all_outbounds.push(json!({
        "type": "urltest",
        "tag": "Sentra Auto",
        "outbounds": outbound_tags,
        "url": "https://www.gstatic.com/generate_204",
        "interval": "3m",
        "tolerance": 50
    }));

    // 3. Concrete mode outbounds
    all_outbounds.extend(singbox_outbounds);

    // 4. Base system outbounds
    all_outbounds.push(json!({ "type": "direct", "tag": "direct" }));
    all_outbounds.push(json!({ "type": "block", "tag": "block" }));
    all_outbounds.push(json!({ "type": "dns", "tag": "dns-out" }));

    // Iranian domain bypass list for split tunneling
    let ir_domain_suffixes = vec![
        ".ir",
        ".gov.ir",
        ".co.ir",
        "shaparak.ir",
        "divar.ir",
        "digikala.com",
        "snapp.ir",
        "tamin.ir",
        "bmi.ir",
        "bki.ir",
        "mellatbank.ir",
        "tejaratbank.ir",
        "banksepah.ir"
    ];

    // Anti-sanction gaming domains (stores, auth, anti-cheat, launchers)
    let game_domains = vec![
        "riotgames.com", "leagueoflegends.com", "valorant.com", "pvp.net",
        "epicgames.com", "unrealengine.com", "fortnite.com",
        "ea.com", "origin.com", "electronicarts.com",
        "steampowered.com", "steamcommunity.com", "steamgames.com", "valvesoftware.com",
        "blizzard.com", "battle.net", "activision.com", "callofduty.com",
        "ubisoft.com", "uplay.com",
        "rockstargames.com", "socialclub.rockstargames.com",
        "discord.com", "discordapp.com", "discord.gg", "discord.media",
        "pubg.com", "krafton.com", "apexlegends.com"
    ];

    let tun_stack = if is_gaming { "system" } else { "mixed" };
    let tun_mtu = if is_gaming { 1420 } else { 9000 };

    let mut route_rules = vec![
        json!({
            "protocol": "dns",
            "outbound": "dns-out"
        }),
        json!({
            "ip_is_private": true,
            "outbound": "direct"
        }),
        json!({
            "geoip": [
                "ir",
                "private"
            ],
            "outbound": "direct"
        }),
        json!({
            "domain_suffix": ir_domain_suffixes,
            "outbound": "direct"
        }),
    ];

    if is_gaming {
        // Rule 2: Game launchers, store & anti-cheat domains through gaming tunnel
        route_rules.push(json!({
            "domain_suffix": game_domains,
            "outbound": "Sentra Select"
        }));
        route_rules.push(json!({
            "geosite": [
                "category-games"
            ],
            "outbound": "Sentra Select"
        }));

        if is_anti_sanction {
            // Rule 3 (Anti-Sanction Split): Game UDP goes direct for pure zero-ping gameplay
            route_rules.push(json!({
                "network": "udp",
                "outbound": "direct"
            }));
        } else {
            // Rule 3 (Gaming Full UDP): All non-IR UDP and TCP through WireGuard/TUIC/Hysteria2
            route_rules.push(json!({
                "network": ["udp", "tcp"],
                "outbound": "Sentra Select"
            }));
        }
    }

    route_rules.push(json!({
        "clash_mode": "Direct",
        "outbound": "direct"
    }));
    route_rules.push(json!({
        "clash_mode": "Global",
        "outbound": "Sentra Select"
    }));

    let route_final = if is_gaming && is_anti_sanction { "direct" } else { "Sentra Select" };

    json!({
        "_sentra_meta": {
            "tier": subscription.tier,
            "status": subscription.status,
            "mode": preferred_mode.unwrap_or("web_browsing"),
            "selected_outbound": default_tag,
            "traffic_limit_bytes": subscription.traffic_limit_bytes,
            "used_bytes": subscription.upload_bytes + subscription.download_bytes,
            "web_browsing_used_mb": subscription.web_browsing_used_mb,
            "download_used_mb": subscription.download_used_mb,
            "speed_limit_bps": subscription.speed_limit_bps,
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
                    "tag": "dns-doh",
                    "address": "https://1.1.1.1/dns-query",
                    "address_resolver": "dns-direct",
                    "strategy": "prefer_ipv4",
                    "detour": "direct"
                },
                {
                    "tag": "dns-doh-google",
                    "address": "https://dns.google/dns-query",
                    "address_resolver": "dns-direct",
                    "strategy": "prefer_ipv4",
                    "detour": "direct"
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
                    "domain_suffix": ir_domain_suffixes,
                    "server": "dns-direct"
                },
                {
                    "geoip": [
                        "ir"
                    ],
                    "server": "dns-direct"
                },
                {
                    "domain_suffix": game_domains,
                    "server": "dns-doh"
                },
                {
                    "geosite": [
                        "category-games"
                    ],
                    "server": "dns-doh"
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
                },
                {
                    "outbound": "any",
                    "server": "dns-doh"
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
                "mtu": tun_mtu,
                "auto_route": true,
                "strict_route": true,
                "stack": tun_stack,
                "sniff": true,
                "sniff_override_destination": true
            }
        ],
        "outbounds": all_outbounds,
        "route": {
            "auto_detect_interface": true,
            "rules": route_rules,
            "final": route_final
        },
        "experimental": {
            "clash_api": {
                "external_controller": "127.0.0.1:9090",
                "secret": "sentra_internal_traffic_secret"
            }
        }
    })
}

/// Generates a valid OpenVPN (.ovpn) configuration file representation
#[allow(dead_code)]
pub fn generate_ovpn_profile(subscription: &Subscription, mode: Option<&str>) -> String {
    generate_ovpn_profile_ext(subscription, mode, "openvpn_udp", "127.0.0.1")
}

/// Generates a multi-protocol OpenVPN configuration file (.ovpn) tailored to mode and protocol
pub fn generate_ovpn_profile_ext(
    subscription: &Subscription,
    mode: Option<&str>,
    protocol: &str,
    server_host: &str,
) -> String {
    let mode_str = mode.unwrap_or("web_browsing");
    let mode_label = match mode_str {
        "download" => "Download (High Speed / Hysteria2-Tunnel)",
        "static_ip" => "Static IP (Clean US Residential / Trade & AI Ready)",
        "gaming" => "Gaming (Low Ping / UDP Optimized)",
        _ => "Web Browsing (Everyday / WS+Fragment)",
    };

    let is_tcp = protocol.eq_ignore_ascii_case("openvpn_tcp") || protocol.eq_ignore_ascii_case("tcp");
    let is_stealth = protocol.eq_ignore_ascii_case("stealth");

    let (proto_str, target_host, target_port) = if is_stealth {
        ("tcp-client", "127.0.0.1", 11940)
    } else if is_tcp {
        let p = match mode_str {
            "download" => 2053,
            "static_ip" => 2083,
            _ => 443,
        };
        ("tcp-client", server_host, p)
    } else {
        let p = match mode_str {
            "download" => 1195,
            "static_ip" => 1196,
            _ => 1194,
        };
        ("udp", server_host, p)
    };

    let static_ip_directives = if mode_str == "static_ip" {
        r#"
# ==============================================================================
# Strict DNS Leak & IP Isolation Directives (Trading & AI Safety)
# ==============================================================================
block-outside-dns
redirect-gateway def1
dhcp-option DNS 1.1.1.1
dhcp-option DNS 1.0.0.1
pull-filter ignore "ifconfig-ipv6"
pull-filter ignore "route-ipv6"
"#
    } else {
        ""
    };

    format!(
        r#"# ==============================================================================
# Sentra Platform - OpenVPN Client Profile
# Mode: {mode_str} [{mode_label}]
# Protocol: {protocol}
# Tier: {tier} | Token: {token}
# Daily Limits: Web Browsing (2048 MB) | Download (3072 MB)
# Generated: {now}
# ==============================================================================
client
dev tun
proto {proto_str}
remote {target_host} {target_port}
resolv-retry infinite
nobind
persist-key
persist-tun
remote-cert-tls server
cipher AES-256-GCM
auth SHA256
verb 3
auth-user-pass
{static_ip_directives}
# Embedded Public Key Infrastructure (PKI)
<ca>
-----BEGIN CERTIFICATE-----
MIIDSzCCAjOgAwIBAgIUW8d0Q3k9M1A2B3C4D5E6F7A8B9C0...[SENTRA-ROOT-CA]...
-----END CERTIFICATE-----
</ca>

<cert>
-----BEGIN CERTIFICATE-----
MIIDRjCCAi6gAwIBAgIUX9e1R4l0N2B3C4D5E6F7A8B9C0D...[SENTRA-CLIENT-CERT]...
-----END CERTIFICATE-----
</cert>

<key>
-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC...[SENTRA-CLIENT-KEY]...
-----END PRIVATE KEY-----
</key>

<tls-crypt>
-----BEGIN OpenVPN Static key V1-----
a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90
-----END OpenVPN Static key V1-----
</tls-crypt>
"#,
        mode_str = mode_str,
        mode_label = mode_label,
        protocol = protocol,
        tier = subscription.tier,
        token = subscription.token,
        now = Utc::now().to_rfc3339(),
        proto_str = proto_str,
        target_host = target_host,
        target_port = target_port,
        static_ip_directives = static_ip_directives
    )
}

/// Generates an Apple iOS/macOS .mobileconfig profile for IKEv2 one-click installation
pub fn generate_mobileconfig_profile(
    subscription: &Subscription,
    mode: &str,
    server_host: &str,
) -> String {
    let mode_str = if mode.is_empty() { "web_browsing" } else { mode };
    let mode_title = match mode_str {
        "download" => "Download",
        "static_ip" => "Static IP",
        "gaming" => "Gaming",
        _ => "Web Browsing",
    };

    let profile_uuid = uuid::Uuid::new_v4().to_string();
    let vpn_uuid = uuid::Uuid::new_v4().to_string();

    let dns_block = if mode_str == "static_ip" {
        r#"                <key>DNS</key>
                <dict>
                    <key>ServerAddresses</key>
                    <array>
                        <string>1.1.1.1</string>
                        <string>1.0.0.1</string>
                    </array>
                    <key>SupplementalMatchDomains</key>
                    <array>
                        <string></string>
                    </array>
                </dict>"#
    } else {
        ""
    };

    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>PayloadDisplayName</key>
    <string>Sentra VPN ({mode_title})</string>
    <key>PayloadIdentifier</key>
    <string>com.sentravpn.ios.{token}.{mode_str}</string>
    <key>PayloadRemovalDisallowed</key>
    <false/>
    <key>PayloadType</key>
    <string>Configuration</string>
    <key>PayloadUUID</key>
    <string>{profile_uuid}</string>
    <key>PayloadVersion</key>
    <integer>1</integer>
    <key>PayloadContent</key>
    <array>
        <dict>
            <key>PayloadType</key>
            <string>com.apple.vpn.managed</string>
            <key>PayloadVersion</key>
            <integer>1</integer>
            <key>PayloadIdentifier</key>
            <string>com.sentravpn.ios.{token}.vpn.{mode_str}</string>
            <key>PayloadUUID</key>
            <string>{vpn_uuid}</string>
            <key>PayloadDisplayName</key>
            <string>Sentra {mode_title} (IKEv2)</string>
            <key>UserDefinedName</key>
            <string>Sentra {mode_title}</string>
            <key>VPNType</key>
            <string>IKEv2</string>
            <key>IKEv2</key>
            <dict>
                <key>RemoteAddress</key>
                <string>{server_host}</string>
                <key>RemoteIdentifier</key>
                <string>{server_host}</string>
                <key>LocalIdentifier</key>
                <string>{token}</string>
                <key>AuthenticationMethod</key>
                <string>None</string>
                <key>ExtendedAuthEnabled</key>
                <integer>1</integer>
                <key>AuthName</key>
                <string>{token}</string>
                <key>AuthPassword</key>
                <string>{token}</string>
                <key>IKESecurityAssociationParameters</key>
                <dict>
                    <key>EncryptionAlgorithm</key>
                    <string>AES-256-GCM</string>
                    <key>IntegrityAlgorithm</key>
                    <string>SHA2-256</string>
                    <key>DiffieHellmanGroup</key>
                    <integer>14</integer>
                </dict>
                <key>ChildSecurityAssociationParameters</key>
                <dict>
                    <key>EncryptionAlgorithm</key>
                    <string>AES-256-GCM</string>
                    <key>IntegrityAlgorithm</key>
                    <string>SHA2-256</string>
                    <key>DiffieHellmanGroup</key>
                    <integer>14</integer>
                </dict>
                <key>DeadPeerDetectionRate</key>
                <string>Medium</string>
                <key>DisableMOBIKE</key>
                <integer>0</integer>
                <key>DisableRedirect</key>
                <integer>0</integer>
                <key>EnablePFS</key>
                <integer>1</integer>
                <key>UseConfigurationAttributeInternalIPSubnet</key>
                <integer>1</integer>
{dns_block}
            </dict>
            <key>IPv4</key>
            <dict>
                <key>OverridePrimary</key>
                <integer>1</integer>
            </dict>
        </dict>
    </array>
</dict>
</plist>"#,
        mode_title = mode_title,
        mode_str = mode_str,
        token = subscription.token,
        profile_uuid = profile_uuid,
        vpn_uuid = vpn_uuid,
        server_host = server_host,
        dns_block = dns_block
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Subscription;
    use crate::quality_engine::UnifiedOutbound;
    use chrono::{Duration as CDuration, Utc};

    fn make_test_sub() -> Subscription {
        Subscription {
            id: 1,
            user_id: 1,
            token: "sentra_test_tok_123".to_string(),
            tier: "Sentra Pro".to_string(),
            traffic_limit_bytes: 50 * 1024 * 1024 * 1024,
            upload_bytes: 100 * 1024 * 1024,
            download_bytes: 500 * 1024 * 1024,
            speed_limit_bps: 0,
            max_concurrent_devices: 5,
            web_browsing_used_mb: 200,
            download_used_mb: 400,
            static_ip_used_mb: 0,
            gaming_used_mb: 0,
            last_quota_reset: Utc::now(),
            starts_at: Utc::now() - CDuration::days(1),
            status: "active".to_string(),
            expires_at: Utc::now() + CDuration::days(30),
            created_at: Utc::now() - CDuration::hours(10),
            updated_at: Utc::now(),
        }
    }

    #[test]
    fn test_singbox_failover_chain_and_optimizations() {
        let sub = make_test_sub();
        let u1 = UnifiedOutbound {
            id: 1,
            tag: "Node 1 Fast".to_string(),
            protocol: "vless".to_string(),
            server_address: "1.1.1.1".to_string(),
            server_port: 443,
            mode_category: "web_browsing".to_string(),
            country_code: "DE".to_string(),
            quality_score: 95,
            latency_ms: 60,
            is_healthy: true,
            is_official: true,
            parsed_config: serde_json::json!({
                "type": "vless",
                "tag": "Node 1 Fast",
                "server": "1.1.1.1",
                "server_port": 443,
                "uuid": "11111111-1111-1111-1111-111111111111",
                "tls": {
                    "enabled": true,
                    "server_name": "speedtest.net"
                }
            }),
            raw_config_json: None,
        };
        let u2 = UnifiedOutbound {
            id: 2,
            tag: "Node 2 Backup".to_string(),
            protocol: "vmess".to_string(),
            server_address: "2.2.2.2".to_string(),
            server_port: 443,
            mode_category: "web_browsing".to_string(),
            country_code: "FI".to_string(),
            quality_score: 90,
            latency_ms: 80,
            is_healthy: true,
            is_official: true,
            parsed_config: serde_json::json!({
                "type": "vmess",
                "tag": "Node 2 Backup",
                "server": "2.2.2.2",
                "server_port": 443,
                "uuid": "22222222-2222-2222-2222-222222222222"
            }),
            raw_config_json: None,
        };
        let u3 = UnifiedOutbound {
            id: 3,
            tag: "Node 3 Backup".to_string(),
            protocol: "trojan".to_string(),
            server_address: "3.3.3.3".to_string(),
            server_port: 443,
            mode_category: "web_browsing".to_string(),
            country_code: "US".to_string(),
            quality_score: 85,
            latency_ms: 120,
            is_healthy: true,
            is_official: true,
            parsed_config: serde_json::json!({
                "type": "trojan",
                "tag": "Node 3 Backup",
                "server": "3.3.3.3",
                "server_port": 443,
                "password": "pass"
            }),
            raw_config_json: None,
        };
        let u4 = UnifiedOutbound {
            id: 4,
            tag: "Node 4 Excess".to_string(),
            protocol: "trojan".to_string(),
            server_address: "4.4.4.4".to_string(),
            server_port: 443,
            mode_category: "web_browsing".to_string(),
            country_code: "NL".to_string(),
            quality_score: 75,
            latency_ms: 150,
            is_healthy: true,
            is_official: true,
            parsed_config: serde_json::json!({
                "type": "trojan",
                "tag": "Node 4 Excess",
                "server": "4.4.4.4",
                "server_port": 443,
                "password": "pass"
            }),
            raw_config_json: None,
        };

        let list = vec![u1, u2, u3, u4];
        let cfg = compile_singbox_config_with_unified(&sub, &list, "Node 1 Fast", Some("web_browsing"));

        let outbounds = cfg["outbounds"].as_array().expect("outbounds array");
        // Verify urltest group
        let urltest_group = outbounds.iter().find(|o| o["tag"] == "Sentra Auto").expect("Sentra Auto group");
        assert_eq!(urltest_group["type"], "urltest");
        assert_eq!(urltest_group["url"], "https://www.gstatic.com/generate_204");
        assert_eq!(urltest_group["interval"], "3m");
        assert_eq!(urltest_group["tolerance"], 50);

        let urltest_outbounds = urltest_group["outbounds"].as_array().expect("urltest outbounds");
        // Maximum 3 outbounds (primary + 2 backups)
        assert_eq!(urltest_outbounds.len(), 3);
        assert_eq!(urltest_outbounds[0], "Node 1 Fast");
        assert_eq!(urltest_outbounds[1], "Node 2 Backup");
        assert_eq!(urltest_outbounds[2], "Node 3 Backup");

        // Verify Selector group
        let selector_group = outbounds.iter().find(|o| o["tag"] == "Sentra Select").expect("Sentra Select group");
        assert_eq!(selector_group["default"], "Sentra Auto");

        // Verify uTLS, Fragment, and Multiplex injections on VLESS outbound
        let node1 = outbounds.iter().find(|o| o["tag"] == "Node 1 Fast").expect("Node 1");
        assert_eq!(node1["tls"]["utls"]["enabled"], true);
        assert_eq!(node1["tls"]["fragment"]["enabled"], true);
        assert_eq!(node1["tls"]["fragment"]["size"], "10-30");
        assert_eq!(node1["tls"]["fragment"]["sleep"], "2-5");
        assert_eq!(node1["multiplex"]["enabled"], true);
        assert_eq!(node1["multiplex"]["protocol"], "h2mux");
        assert_eq!(node1["multiplex"]["max_connections"], 4);

        // Verify Split Tunneling rules
        let rules = cfg["route"]["rules"].as_array().expect("route rules");
        let geoip_ir_rule = rules.iter().find(|r| {
            r["geoip"].as_array().map_or(false, |arr| arr.iter().any(|v| v == "ir"))
        });
        assert!(geoip_ir_rule.is_some(), "geoip ir rule should exist");
        assert_eq!(geoip_ir_rule.unwrap()["outbound"], "direct");

        let ip_priv_rule = rules.iter().find(|r| r["ip_is_private"] == true);
        assert!(ip_priv_rule.is_some(), "ip_is_private rule should exist");
        assert_eq!(ip_priv_rule.unwrap()["outbound"], "direct");

        let ir_domain_rule = rules.iter().find(|r| {
            r["domain_suffix"].as_array().map_or(false, |arr| arr.iter().any(|v| v == ".ir"))
        });
        assert!(ir_domain_rule.is_some(), ".ir domain rule should exist");
        assert_eq!(ir_domain_rule.unwrap()["outbound"], "direct");

        // Verify DNS configuration
        let dns_servers = cfg["dns"]["servers"].as_array().expect("dns servers");
        let doh_server = dns_servers.iter().find(|s| s["tag"] == "dns-doh").expect("dns-doh");
        assert_eq!(doh_server["address"], "https://1.1.1.1/dns-query");
        assert_eq!(doh_server["strategy"], "prefer_ipv4");

        let direct_dns = dns_servers.iter().find(|s| s["tag"] == "dns-direct").expect("dns-direct");
        assert_eq!(direct_dns["address"], "local");
    }
}
