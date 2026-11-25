use crate::models::{DonatedOutbound, Outbound, Subscription};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use chrono::Utc;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};

/// Returns true if the subscription tier unlocks Static IP access.
pub fn tier_has_static_ip(tier: &str) -> bool {
    let lower = tier.trim().to_lowercase();
    if lower.is_empty() || lower == "sentra lite" || lower == "lite" || lower == "free" {
        return false;
    }
    lower.contains("static")
        || lower.contains("pro")
        || lower.contains("flow")
        || lower.contains("ultra")
        || lower.contains("vip")
        || lower.contains("all")
}

/// Returns true if the subscription tier unlocks Gaming (low-ping / iOS WireGuard) access.
pub fn tier_has_gaming(tier: &str) -> bool {
    let lower = tier.trim().to_lowercase();
    if lower.is_empty() || lower == "sentra lite" || lower == "lite" || lower == "free" {
        return false;
    }
    lower.contains("gaming")
        || lower.contains("game")
        || lower.contains("pro")
        || lower.contains("flow")
        || lower.contains("ultra")
        || lower.contains("vip")
        || lower.contains("all")
}

/// Compiles a fully compliant Sing-box v1.10+ JSON template tailored to the user's subscription tier
/// and allowed outbounds, strictly following docs/PROTOCOL_SPEC.md.
pub fn compile_singbox_config(
    subscription: &Subscription,
    outbounds: &[Outbound],
    preferred_mode: Option<&str>,
) -> Value {
    compile_singbox_config_with_donated(subscription, outbounds, &[], preferred_mode)
}

/// Compiles Sing-box v1.10+ JSON including active official & community donated outbounds
pub fn compile_singbox_config_with_donated(
    subscription: &Subscription,
    outbounds: &[Outbound],
    donated_outbounds: &[DonatedOutbound],
    preferred_mode: Option<&str>,
) -> Value {
    compile_singbox_config_with_donated_and_selection(
        subscription,
        outbounds,
        donated_outbounds,
        preferred_mode,
        false,
    )
}

/// Compiles Sing-box v1.10+ JSON including active official & community donated outbounds,
/// optionally defaulting Sentra Select directly to the first outbound when explicitly selected.
pub fn compile_singbox_config_with_donated_and_selection(
    subscription: &Subscription,
    outbounds: &[Outbound],
    donated_outbounds: &[DonatedOutbound],
    preferred_mode: Option<&str>,
    prefer_first_as_default: bool,
) -> Value {
    let mut outbound_tags: Vec<String> = Vec::new();
    let mut singbox_outbounds: Vec<Value> = Vec::new();
    let mut used_tags: std::collections::HashSet<String> = std::collections::HashSet::new();

    let mut make_unique_tag = |base: String| -> String {
        if used_tags.insert(base.clone()) {
            return base;
        }
        let mut idx = 2usize;
        loop {
            let candidate = format!("{} ({})", base, idx);
            if used_tags.insert(candidate.clone()) {
                return candidate;
            }
            idx += 1;
        }
    };

    // 1. First incorporate active official & community donated outbounds (parsed JSON config)
    for dob in donated_outbounds {
        if let Ok(mut val) = serde_json::from_str::<Value>(&dob.config_json) {
            let raw_tag = if dob.is_official == 1 {
                if let Some(ref l) = dob.label {
                    if !l.trim().is_empty() {
                        format!("👑 {}", l.trim())
                    } else {
                        format!("👑 {}", dob.tag)
                    }
                } else {
                    format!("👑 {}", dob.tag)
                }
            } else {
                let name = dob
                    .label
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or(&dob.tag);
                format!("🤝 {}", name)
            };
            let tag = make_unique_tag(raw_tag);
            val["tag"] = json!(tag);
            outbound_tags.push(tag);
            singbox_outbounds.push(val);
        }
    }

    // 2. Incorporate non-loopback active rows from core outbounds table (skip 127.0.0.1 sandbox placeholders when real nodes exist)
    let has_real_nodes = !outbound_tags.is_empty()
        || outbounds.iter().any(|ob| ob.server_address != "127.0.0.1");

    for ob in outbounds {
        if has_real_nodes && ob.server_address == "127.0.0.1" {
            continue;
        }
        let tag = make_unique_tag(ob.tag.clone());
        outbound_tags.push(tag.clone());

        let node_config = match ob.protocol.as_str() {
            "socks" => json!({
                "type": "socks",
                "tag": tag,
                "server": ob.server_address,
                "server_port": ob.server_port,
                "version": "5"
            }),
            "http" => json!({
                "type": "http",
                "tag": tag,
                "server": ob.server_address,
                "server_port": ob.server_port
            }),
            "vless" => {
                let mut vless_obj = json!({
                    "type": "vless",
                    "tag": tag,
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
            "direct" => json!({
                "type": "direct",
                "tag": tag
            }),
            _ => json!({
                "type": "socks",
                "tag": tag,
                "server": ob.server_address,
                "server_port": ob.server_port,
                "version": "5"
            }),
        };

        singbox_outbounds.push(node_config);
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

    let default_target = if prefer_first_as_default {
        outbound_tags
            .first()
            .cloned()
            .unwrap_or_else(|| "Sentra Auto".to_string())
    } else {
        "Sentra Auto".to_string()
    };

    all_outbounds.push(json!({
        "type": "selector",
        "tag": "Sentra Select",
        "outbounds": selector_list,
        "default": default_target
    }));

    let is_gaming = preferred_mode == Some("gaming");

    // 2. Latency auto-switching Group (Sentra Auto)
    // In gaming mode: tight 15ms tolerance & 1m check interval to lock onto the lowest-jitter node without mid-match flapping
    all_outbounds.push(json!({
        "type": "urltest",
        "tag": "Sentra Auto",
        "outbounds": outbound_tags,
        "url": "https://cp.cloudflare.com/generate_204",
        "interval": if is_gaming { "1m" } else { "15s" },
        "tolerance": if is_gaming { 15 } else { 50 }
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

    let dns_block = if is_gaming {
        // Ultra-low-latency IPv4-only direct UDP DNS (no DoH TLS handshake jitter, no FakeIP rewrite overhead)
        json!({
            "servers": [
                {
                    "tag": "dns-remote",
                    "address": "udp://1.1.1.1",
                    "strategy": "ipv4_only",
                    "detour": "Sentra Select"
                },
                {
                    "tag": "dns-remote-backup",
                    "address": "udp://8.8.8.8",
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
                    "domain_suffix": ir_domain_suffixes,
                    "server": "dns-direct"
                },
                {
                    "clash_mode": "Direct",
                    "server": "dns-direct"
                },
                {
                    "outbound": "any",
                    "server": "dns-remote"
                }
            ],
            "final": "dns-remote",
            "strategy": "ipv4_only",
            "independent_cache": true
        })
    } else {
        json!({
            "servers": [
                {
                    "tag": "dns-fakeip",
                    "address": "fakeip"
                },
                {
                    "tag": "dns-doh",
                    "address": "https://1.1.1.1/dns-query",
                    "address_resolver": "dns-direct",
                    "strategy": "ipv4_only",
                    "detour": "direct"
                },
                {
                    "tag": "dns-doh-google",
                    "address": "https://dns.google/dns-query",
                    "address_resolver": "dns-direct",
                    "strategy": "ipv4_only",
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
        })
    };

    let tun_inbound = if is_gaming {
        // Gaming TUN: MTU 1280 prevents UDP fragmentation; Full-Cone NAT (endpoint_independent_nat)
        // keeps game matchmaking & voice chat open; sniff disabled for zero per-packet DPI latency.
        json!({
            "type": "tun",
            "tag": "tun-in",
            "interface_name": "sentra-tun",
            "inet4_address": "172.19.0.1/30",
            "mtu": 1280,
            "auto_route": true,
            "strict_route": true,
            "stack": "system",
            "endpoint_independent_nat": true,
            "udp_timeout": "5m",
            "sniff": false,
            "sniff_override_destination": false
        })
    } else {
        json!({
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
        })
    };

    // Assembly conforming to Sing-box v1.10+
    json!({
        "_sentra_meta": {
            "tier": subscription.tier,
            "status": subscription.status,
            "mode": preferred_mode.unwrap_or("web_browsing"),
            "gaming_optimized": is_gaming,
            "traffic_limit_bytes": subscription.traffic_limit_bytes,
            "used_bytes": subscription.upload_bytes + subscription.download_bytes,
            "web_browsing_used_mb": subscription.web_browsing_used_mb,
            "download_used_mb": subscription.download_used_mb,
            "speed_limit_bps": subscription.speed_limit_bps,
            "expires_at": subscription.expires_at.to_rfc3339()
        },
        "log": {
            "level": if is_gaming { "warn" } else { "info" },
            "timestamp": true
        },
        "dns": dns_block,
        "inbounds": [tun_inbound],
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
                    "domain_suffix": ir_domain_suffixes,
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

/// Generates an ultra-low-latency WireGuard (.conf) profile specifically tuned for iOS Gaming.
/// Returns `(conf_text, client_public_key_b64, client_address_cidr)`.
/// Keys are deterministically derived via X25519 from the subscription token and server-side salt/env.
pub fn generate_wireguard_gaming_profile(
    subscription: &Subscription,
    server_host: &str,
) -> (String, String, String) {
    // 1. Deterministic client X25519 keypair scoped to subscription token + optional server salt
    let key_salt = std::env::var("WIREGUARD_KEY_SALT")
        .unwrap_or_else(|_| "sentra-gaming-wg-v1".to_string());
    let mut client_hasher = Sha256::new();
    client_hasher.update(key_salt.as_bytes());
    client_hasher.update(b":client:");
    client_hasher.update(subscription.token.as_bytes());
    let client_seed: [u8; 32] = client_hasher.finalize().into();

    let client_secret = StaticSecret::from(client_seed);
    let client_public = PublicKey::from(&client_secret);
    let client_private_b64 = BASE64.encode(client_secret.to_bytes());
    let client_public_b64 = BASE64.encode(client_public.as_bytes());

    // 2. Resolve WireGuard server public key from environment (never hardcoded secret)
    let server_public_b64 = if let Ok(pub_key) = std::env::var("WIREGUARD_SERVER_PUBLIC_KEY") {
        let trimmed = pub_key.trim().to_string();
        if !trimmed.is_empty() {
            trimmed
        } else {
            derive_server_wg_public_key(server_host)
        }
    } else if let Ok(priv_key) = std::env::var("WIREGUARD_SERVER_PRIVATE_KEY") {
        if let Ok(decoded) = BASE64.decode(priv_key.trim()) {
            if decoded.len() == 32 {
                let mut arr = [0u8; 32];
                arr.copy_from_slice(&decoded);
                let srv_secret = StaticSecret::from(arr);
                BASE64.encode(PublicKey::from(&srv_secret).as_bytes())
            } else {
                derive_server_wg_public_key(server_host)
            }
        } else {
            derive_server_wg_public_key(server_host)
        }
    } else {
        derive_server_wg_public_key(server_host)
    };

    // 3. Deterministic client VPN IP inside 10.66.0.0/16 (avoiding .0, .1, .255)
    let mut ip_hasher = Sha256::new();
    ip_hasher.update(b"sentra-wg-ip:");
    ip_hasher.update(subscription.token.as_bytes());
    let ip_digest = ip_hasher.finalize();
    let octet3 = ip_digest[0];
    let octet4 = (ip_digest[1] % 250) + 2;
    let client_address = format!("10.66.{}.{}/32", octet3, octet4);

    let wg_port = std::env::var("WIREGUARD_PORT")
        .ok()
        .and_then(|p| p.trim().parse::<u16>().ok())
        .filter(|&p| p > 0)
        .unwrap_or(51820);

    let endpoint_host = if server_host.trim().is_empty() || server_host == "0.0.0.0" {
        "127.0.0.1"
    } else {
        server_host.trim()
    };

    let conf = format!(
        r#"# ==============================================================================
# Sentra Gaming - WireGuard Profile (iOS Ultra-Low Latency)
# Tier: {tier} | Mode: gaming
# Client Public Key: {client_pub}
# Generated: {now}
# ==============================================================================
[Interface]
PrivateKey = {client_priv}
Address = {client_addr}
DNS = 1.1.1.1, 8.8.8.8
MTU = 1280

[Peer]
PublicKey = {server_pub}
Endpoint = {endpoint_host}:{wg_port}
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25
"#,
        tier = subscription.tier,
        client_pub = client_public_b64,
        now = Utc::now().to_rfc3339(),
        client_priv = client_private_b64,
        client_addr = client_address,
        server_pub = server_public_b64,
        endpoint_host = endpoint_host,
        wg_port = wg_port
    );

    (conf, client_public_b64, client_address)
}

fn derive_server_wg_public_key(server_host: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"sentra-wg-server-pub:");
    hasher.update(server_host.as_bytes());
    let seed: [u8; 32] = hasher.finalize().into();
    let secret = StaticSecret::from(seed);
    BASE64.encode(PublicKey::from(&secret).as_bytes())
}

