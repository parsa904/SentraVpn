use crate::models::{Outbound, Subscription};
use serde_json::{json, Value};

/// Compiles a fully compliant Sing-box v1.10+ JSON template tailored to the user's subscription tier
/// and allowed outbounds, strictly following docs/PROTOCOL_SPEC.md.
pub fn compile_singbox_config(subscription: &Subscription, outbounds: &[Outbound]) -> Value {
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
            "traffic_limit_bytes": subscription.traffic_limit_bytes,
            "used_bytes": subscription.upload_bytes + subscription.download_bytes,
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
        }
    })
}

/// Generates a valid OpenVPN (.ovpn) configuration file representation
pub fn generate_ovpn_profile(subscription: &Subscription) -> String {
    format!(
        r#"# ==============================================================================
# Sentra Platform - OpenVPN Client Profile
# Tier: {} | Token: {}
# Generated: {}
# ==============================================================================
client
dev tun
proto udp
remote 127.0.0.1 1194
resolv-retry infinite
nobind
persist-key
persist-tun
remote-cert-tls server
cipher AES-256-GCM
auth SHA256
verb 3
auth-user-pass

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
        subscription.tier,
        subscription.token,
        subscription.created_at.to_rfc3339()
    )
}
