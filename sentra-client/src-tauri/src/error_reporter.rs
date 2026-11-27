use chrono::Utc;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const DEDUP_WINDOW: Duration = Duration::from_secs(60);

fn dedup_cache() -> &'static Mutex<HashMap<String, Instant>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn current_platform() -> &'static str {
    if cfg!(target_os = "android") {
        "android"
    } else {
        "windows"
    }
}

/// Redacts common bearer tokens, subscription paths, and query secrets locally
/// before transmitting an error report to the Worker.
pub fn sanitize_text(input: &str) -> String {
    let mut out = input.to_string();

    // Redact `/sub/<token>` segments
    for marker in ["/api/v1/sub/", "/sub/"] {
        while let Some(pos) = out.find(marker) {
            let start = pos + marker.len();
            let rest = &out[start..];
            if rest.starts_with("[REDACTED]") {
                break;
            }
            let end_offset = rest
                .find(|c: char| c.is_whitespace() || matches!(c, '?' | '#' | '"' | '\'' | '/' | ')'))
                .unwrap_or(rest.len());
            if end_offset == 0 {
                break;
            }
            let mut replaced = String::with_capacity(out.len());
            replaced.push_str(&out[..start]);
            replaced.push_str("[REDACTED]");
            replaced.push_str(&out[start + end_offset..]);
            out = replaced;
        }
    }

    // Redact `Bearer <token>` segments (case-sensitive common form)
    for marker in ["Bearer ", "bearer "] {
        let mut search_from = 0usize;
        while let Some(rel) = out[search_from..].find(marker) {
            let start = search_from + rel + marker.len();
            let rest = &out[start..];
            if rest.starts_with("[REDACTED]") {
                search_from = start + "[REDACTED]".len();
                continue;
            }
            let end_offset = rest
                .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | ',' | ';'))
                .unwrap_or(rest.len());
            if end_offset == 0 {
                search_from = start;
                continue;
            }
            let mut replaced = String::with_capacity(out.len());
            replaced.push_str(&out[..start]);
            replaced.push_str("[REDACTED]");
            replaced.push_str(&out[start + end_offset..]);
            out = replaced;
            search_from = start + "[REDACTED]".len();
        }
    }

    out
}

fn should_send_fingerprint(fingerprint: &str) -> bool {
    let now = Instant::now();
    if let Ok(mut guard) = dedup_cache().lock() {
        if guard.len() > 200 {
            guard.retain(|_, ts| now.duration_since(*ts) < DEDUP_WINDOW);
        }
        if let Some(prev) = guard.get(fingerprint) {
            if now.duration_since(*prev) < DEDUP_WINDOW {
                return false;
            }
        }
        guard.insert(fingerprint.to_string(), now);
        true
    } else {
        true
    }
}

/// Non-blocking native error reporter for Windows and Android Tauri Rust core.
/// Spawns an isolated background task with a 5s timeout and silently ignores failures.
pub fn report_native_error(
    module_or_file: &str,
    action_or_route: &str,
    error_name: &str,
    error_message: &str,
    stack_trace: Option<&str>,
    extra_context: Map<String, Value>,
) {
    let clean_module = sanitize_text(module_or_file);
    let clean_action = sanitize_text(action_or_route);
    let clean_name = sanitize_text(error_name);
    let clean_msg = sanitize_text(error_message);
    let clean_stack = stack_trace.map(sanitize_text);

    let fp = format!(
        "{}|{}|{}|{}",
        current_platform(),
        clean_module,
        clean_name,
        clean_msg.chars().take(120).collect::<String>()
    );
    if !should_send_fingerprint(&fp) {
        return;
    }

    let mut ctx = extra_context;
    ctx.insert("os".to_string(), json!(std::env::consts::OS));
    ctx.insert("arch".to_string(), json!(std::env::consts::ARCH));
    ctx.insert("runtime".to_string(), json!("tauri-rust"));

    let payload = json!({
        "platform": current_platform(),
        "appVersion": env!("CARGO_PKG_VERSION"),
        "moduleOrFile": clean_module,
        "actionOrRoute": clean_action,
        "errorName": clean_name,
        "errorMessage": clean_msg,
        "stackTrace": clean_stack,
        "context": Value::Object(ctx),
        "timestamp": Utc::now().to_rfc3339(),
    });

    let sub_token = crate::auth::AuthManager::load_saved_session()
        .map(|s| s.subscription_token)
        .filter(|t| !t.trim().is_empty());

    let send_future = async move {
        let client = match reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(4))
            .timeout(Duration::from_secs(5))
            .build()
        {
            Ok(c) => c,
            Err(_) => return,
        };

        for base_url in crate::auth::get_backend_urls() {
            let url = format!("{}/api/v1/telemetry/error", base_url);
            let mut req = client
                .post(&url)
                .header("Content-Type", "application/json")
                .header("X-App-Version", env!("CARGO_PKG_VERSION"))
                .json(&payload);

            if let Some(ref token) = sub_token {
                req = req.header("X-Subscription-Token", token);
            }

            if let Ok(resp) = req.send().await {
                if resp.status().is_success() || resp.status().as_u16() == 202 {
                    break;
                }
            }
        }
    };

    // Prefer existing Tokio runtime if available; otherwise spawn a short daemon thread
    if tokio::runtime::Handle::try_current().is_ok() {
        tokio::spawn(send_future);
    } else {
        std::thread::spawn(move || {
            if let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                rt.block_on(send_future);
            }
        });
    }
}

/// Installs a global Rust panic hook that reports panics to SentraVPN's unified
/// error telemetry endpoint before delegating to the default panic handler.
pub fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        let message = if let Some(s) = panic_info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = panic_info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "Rust panic occurred".to_string()
        };

        let location = panic_info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown".to_string());

        let mut ctx = Map::new();
        ctx.insert("panic_location".to_string(), json!(location));

        report_native_error(
            "sentra-client/src-tauri/src/lib.rs",
            "rust_panic_hook",
            "RustPanic",
            &message,
            Some(&location),
            ctx,
        );

        default_hook(panic_info);
    }));
}

/// Reports a sanitized sing-box Auto-Rollback event directly to `POST /api/v1/logs/report`
/// with platform and appVersion metadata (zero tokens or sensitive secrets).
pub fn report_rollback_error(singbox_error: &str, mode: &str, rolled_back: bool) {
    let clean_msg = sanitize_text(singbox_error);
    let mut ctx = Map::new();
    ctx.insert("mode".to_string(), json!(mode));
    ctx.insert("rollback_performed".to_string(), json!(rolled_back));
    ctx.insert("singbox_auto_rollback".to_string(), json!(true));
    ctx.insert("os".to_string(), json!(std::env::consts::OS));
    ctx.insert("arch".to_string(), json!(std::env::consts::ARCH));
    ctx.insert("runtime".to_string(), json!("tauri-rust"));

    let payload = json!({
        "platform": current_platform(),
        "appVersion": env!("CARGO_PKG_VERSION"),
        "moduleOrFile": "sentra-client/src-tauri/src/vpn_manager.rs",
        "actionOrRoute": "singbox_auto_rollback",
        "errorName": "SingboxAutoRollback",
        "errorMessage": clean_msg.chars().take(1000).collect::<String>(),
        "context": Value::Object(ctx),
        "timestamp": Utc::now().to_rfc3339(),
    });

    let send_future = async move {
        let client = match reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(4))
            .timeout(Duration::from_secs(5))
            .build()
        {
            Ok(c) => c,
            Err(_) => return,
        };

        for base_url in crate::auth::get_backend_urls() {
            let url = format!("{}/api/v1/logs/report", base_url);
            let req = client
                .post(&url)
                .header("Content-Type", "application/json")
                .header("X-App-Version", env!("CARGO_PKG_VERSION"))
                .json(&payload);

            if let Ok(resp) = req.send().await {
                if resp.status().is_success() || resp.status().as_u16() == 202 {
                    break;
                }
            }
        }
    };

    if tokio::runtime::Handle::try_current().is_ok() {
        tokio::spawn(send_future);
    } else {
        std::thread::spawn(move || {
            if let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                rt.block_on(send_future);
            }
        });
    }
}
