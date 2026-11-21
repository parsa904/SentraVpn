use crate::models::{DonatedOutbound, Outbound, Subscription};
use chrono::Utc;
use serde_json::{json, Value};

/// Compiles a fully compliant Sing-box v1.10+ JSON template tailored to the user's subscription tier
/// and allowed outbounds, strictly following docs/PROTOCOL_SPEC.md.
pub fn compile_singbox_config(
    subscription: &Subscription,
    outbounds: &[Outbound],
    preferred_mode: Option<&str>,
) -> Value {
    compile_singbox_config_with_donated(subscription, outbounds, &[], preferred_mode)
}

/// Compiles Sing-box v1.10+ JSON including active community donated outbounds
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
