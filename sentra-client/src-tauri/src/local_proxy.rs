// ============================================================================
// Sentra Connect - In-Process SOCKS5 & HTTP Proxy Service
// ============================================================================

use std::net::SocketAddr;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;
use tracing::{debug, info, warn};

pub struct LocalProxyService {
    shutdown_tx: broadcast::Sender<()>,
}

impl LocalProxyService {
    /// Start SOCKS5 (10808) and HTTP (10809) listeners
    pub async fn start(socks5_port: u16, http_port: u16) -> Result<Self, String> {
        let (shutdown_tx, _) = broadcast::channel(1);

        // Bind SOCKS5 listener
        let socks5_addr: SocketAddr = format!("127.0.0.1:{}", socks5_port)
            .parse()
            .map_err(|e| format!("Invalid SOCKS5 address: {}", e))?;
        let socks5_listener = TcpListener::bind(socks5_addr)
            .await
            .map_err(|e| format!("Failed to bind local SOCKS5 proxy on {}: {}", socks5_addr, e))?;

        // Bind HTTP listener
        let http_addr: SocketAddr = format!("127.0.0.1:{}", http_port)
            .parse()
            .map_err(|e| format!("Invalid HTTP address: {}", e))?;
        let http_listener = TcpListener::bind(http_addr)
            .await
            .map_err(|e| format!("Failed to bind local HTTP proxy on {}: {}", http_addr, e))?;

        info!(
            "Local proxy servers successfully bound: SOCKS5 [{}], HTTP [{}]",
            socks5_addr, http_addr
        );

        // Spawn SOCKS5 worker
        let mut rx_socks = shutdown_tx.subscribe();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    accept_res = socks5_listener.accept() => {
                        match accept_res {
                            Ok((stream, client_addr)) => {
                                debug!("New SOCKS5 client connection from: {}", client_addr);
                                tokio::spawn(handle_socks5_client(stream));
                            }
                            Err(e) => {
                                warn!("SOCKS5 accept error: {}", e);
                            }
                        }
                    }
                    _ = rx_socks.recv() => {
                        info!("Shutting down local SOCKS5 proxy listener.");
                        break;
                    }
                }
            }
        });

        // Spawn HTTP worker
        let mut rx_http = shutdown_tx.subscribe();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    accept_res = http_listener.accept() => {
                        match accept_res {
                            Ok((stream, client_addr)) => {
                                debug!("New HTTP proxy client connection from: {}", client_addr);
                                tokio::spawn(handle_http_client(stream));
                            }
                            Err(e) => {
                                warn!("HTTP proxy accept error: {}", e);
                            }
                        }
                    }
                    _ = rx_http.recv() => {
                        info!("Shutting down local HTTP proxy listener.");
                        break;
                    }
                }
            }
        });

        Ok(Self { shutdown_tx })
    }

    /// Stop all local proxy listeners
    pub fn stop(&mut self) {
        let _ = self.shutdown_tx.send(());
    }
}

impl Drop for LocalProxyService {
    fn drop(&mut self) {
        let _ = self.shutdown_tx.send(());
    }
}

// ============================================================================
// SOCKS5 Protocol Handler (RFC 1928)
// ============================================================================

async fn handle_socks5_client(mut client: TcpStream) {
    // 1. Negotiation Phase: Read version and methods
    let mut header = [0u8; 2];
    if client.read_exact(&mut header).await.is_err() {
        return;
    }
    let ver = header[0];
    let nmethods = header[1] as usize;
    if ver != 0x05 {
        return;
    }

    let mut methods = vec![0u8; nmethods];
    if client.read_exact(&mut methods).await.is_err() {
        return;
    }

    // Reply: Version 5, Method: 0x00 (NO AUTH REQUIRED)
    if client.write_all(&[0x05, 0x00]).await.is_err() {
        return;
    }

    // 2. Request Details Phase: [VER, CMD, RSV, ATYP, DST.ADDR, DST.PORT]
    let mut req_header = [0u8; 4];
    if client.read_exact(&mut req_header).await.is_err() {
        return;
    }

    let cmd = req_header[1];
    let atyp = req_header[3];

    // Only CONNECT (0x01) supported
    if cmd != 0x01 {
        let _ = client.write_all(&[0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await;
        return;
    }

    let target_dest = match atyp {
        0x01 => {
            // IPv4: 4 bytes
            let mut ip_bytes = [0u8; 4];
            if client.read_exact(&mut ip_bytes).await.is_err() {
                return;
            }
            let mut port_bytes = [0u8; 2];
            if client.read_exact(&mut port_bytes).await.is_err() {
                return;
            }
            let port = u16::from_be_bytes(port_bytes);
            let ip = std::net::Ipv4Addr::from(ip_bytes);
            format!("{}:{}", ip, port)
        }
        0x03 => {
            // Domain Name: 1 byte length + domain string
            let mut len_buf = [0u8; 1];
            if client.read_exact(&mut len_buf).await.is_err() {
                return;
            }
            let domain_len = len_buf[0] as usize;
            let mut domain_buf = vec![0u8; domain_len];
            if client.read_exact(&mut domain_buf).await.is_err() {
                return;
            }
            let mut port_bytes = [0u8; 2];
            if client.read_exact(&mut port_bytes).await.is_err() {
                return;
            }
            let port = u16::from_be_bytes(port_bytes);
            let domain = String::from_utf8_lossy(&domain_buf);
            format!("{}:{}", domain, port)
        }
        0x04 => {
            // IPv6: 16 bytes
            let mut ip_bytes = [0u8; 16];
            if client.read_exact(&mut ip_bytes).await.is_err() {
                return;
            }
            let mut port_bytes = [0u8; 2];
            if client.read_exact(&mut port_bytes).await.is_err() {
                return;
            }
            let port = u16::from_be_bytes(port_bytes);
            let ip = std::net::Ipv6Addr::from(ip_bytes);
            format!("[{}]:{}", ip, port)
        }
        _ => {
            let _ = client.write_all(&[0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await;
            return;
        }
    };

    // Connect to destination target
    match TcpStream::connect(&target_dest).await {
        Ok(mut target_stream) => {
            // Reply: Success (REP=0x00)
            let reply = [0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0];
            if client.write_all(&reply).await.is_err() {
                return;
            }

            // Bidirectional pipe
            let _ = tokio::io::copy_bidirectional(&mut client, &mut target_stream).await;
        }
        Err(e) => {
            debug!("SOCKS5 target connection to {} failed: {}", target_dest, e);
            let _ = client.write_all(&[0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await;
        }
    }
}

// ============================================================================
// HTTP / HTTPS CONNECT Proxy Handler (RFC 7231)
// ============================================================================

async fn handle_http_client(mut client: TcpStream) {
    let mut buffer = [0u8; 4096];
    let n = match client.read(&mut buffer).await {
        Ok(n) if n > 0 => n,
        _ => return,
    };

    let req_str = String::from_utf8_lossy(&buffer[..n]);
    let mut lines = req_str.lines();
    let first_line = match lines.next() {
        Some(l) => l,
        None => return,
    };

    let parts: Vec<&str> = first_line.split_whitespace().collect();
    if parts.len() < 2 {
        return;
    }

    let method = parts[0];
    let target = parts[1];

    if method.eq_ignore_ascii_case("CONNECT") {
        // HTTPS Tunneling (CONNECT host:port HTTP/1.1)
        let host_port = if target.contains(':') {
            target.to_string()
        } else {
            format!("{}:443", target)
        };

        match TcpStream::connect(&host_port).await {
            Ok(mut target_stream) => {
                let resp = b"HTTP/1.1 200 Connection Established\r\n\r\n";
                if client.write_all(resp).await.is_err() {
                    return;
                }

                // Bidirectional copy
                let _ = tokio::io::copy_bidirectional(&mut client, &mut target_stream).await;
            }
            Err(e) => {
                debug!("HTTP CONNECT to {} failed: {}", host_port, e);
                let err_resp = b"HTTP/1.1 502 Bad Gateway\r\n\r\n";
                let _ = client.write_all(err_resp).await;
            }
        }
    } else {
        // Plain HTTP Forwarding (GET http://host/path HTTP/1.1)
        let (host_port, path) = parse_http_target(target, &req_str);

        match TcpStream::connect(&host_port).await {
            Ok(mut target_stream) => {
                // Reconstruct request line with relative path if necessary
                let modified_req = if target.starts_with("http://") {
                    let mut new_req = req_str.replacen(target, &path, 1);
                    // Ensure Proxy-Connection is stripped
                    new_req = new_req.replace("Proxy-Connection:", "Connection:");
                    new_req
                } else {
                    req_str.to_string()
                };

                if target_stream.write_all(modified_req.as_bytes()).await.is_err() {
                    return;
                }

                // Bidirectional copy
                let _ = tokio::io::copy_bidirectional(&mut client, &mut target_stream).await;
            }
            Err(e) => {
                debug!("HTTP forward to {} failed: {}", host_port, e);
                let err_resp = b"HTTP/1.1 502 Bad Gateway\r\n\r\n";
                let _ = client.write_all(err_resp).await;
            }
        }
    }
}

fn parse_http_target(target: &str, full_req: &str) -> (String, String) {
    if let Some(stripped) = target.strip_prefix("http://") {
        if let Some(slash_idx) = stripped.find('/') {
            let host = &stripped[..slash_idx];
            let path = &stripped[slash_idx..];
            let host_port = if host.contains(':') {
                host.to_string()
            } else {
                format!("{}:80", host)
            };
            (host_port, path.to_string())
        } else {
            let host_port = if stripped.contains(':') {
                stripped.to_string()
            } else {
                format!("{}:80", stripped)
            };
            (host_port, "/".to_string())
        }
    } else {
        // Find Host header
        let mut host_header = "127.0.0.1:80".to_string();
        for line in full_req.lines() {
            if line.to_lowercase().starts_with("host:") {
                let h = line[5..].trim();
                host_header = if h.contains(':') {
                    h.to_string()
                } else {
                    format!("{}:80", h)
                };
                break;
            }
        }
        (host_header, target.to_string())
    }
}
