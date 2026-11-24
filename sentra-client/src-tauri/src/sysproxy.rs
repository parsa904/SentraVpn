// ============================================================================
// Sentra Connect - Windows System Proxy & WinINet Manager
// ============================================================================

#[cfg(target_os = "windows")]
pub fn enable_system_proxy(proxy_addr: &str) -> Result<(), String> {
    use std::process::Command;

    tracing::info!("Configuring Windows System Proxy to: {}", proxy_addr);

    // 1. Set ProxyEnable = 1 (DWORD)
    let out1 = Command::new("reg.exe")
        .args([
            "add",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            "/v",
            "ProxyEnable",
            "/t",
            "REG_DWORD",
            "/d",
            "1",
            "/f",
        ])
        .output();

    if let Err(e) = out1 {
        tracing::error!("Failed to execute reg.exe for ProxyEnable: {}", e);
    }

    // 2. Set ProxyServer = "127.0.0.1:10809" (REG_SZ)
    let out2 = Command::new("reg.exe")
        .args([
            "add",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            "/v",
            "ProxyServer",
            "/t",
            "REG_SZ",
            "/d",
            proxy_addr,
            "/f",
        ])
        .output();

    if let Err(e) = out2 {
        tracing::error!("Failed to execute reg.exe for ProxyServer: {}", e);
    }

    // 3. Set ProxyOverride = "<local>;localhost;127.*;10.*;172.16.*;192.168.*"
    let _ = Command::new("reg.exe")
        .args([
            "add",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            "/v",
            "ProxyOverride",
            "/t",
            "REG_SZ",
            "/d",
            "<local>;localhost;127.*;10.*;172.16.*;192.168.*",
            "/f",
        ])
        .output();

    // 4. Notify WinINet system subsystem
    notify_wininet();

    Ok(())
}

#[cfg(target_os = "windows")]
pub fn disable_system_proxy() -> Result<(), String> {
    use std::process::Command;

    tracing::info!("Disabling Windows System Proxy (ProxyEnable=0)...");

    let out = Command::new("reg.exe")
        .args([
            "add",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            "/v",
            "ProxyEnable",
            "/t",
            "REG_DWORD",
            "/d",
            "0",
            "/f",
        ])
        .output();

    if let Err(e) = out {
        tracing::error!("Failed to execute reg.exe to disable ProxyEnable: {}", e);
    }

    // Clear ProxyServer if it still points to Sentra's local HTTP proxy so third-party apps never stall
    if let Ok(query_out) = Command::new("reg.exe")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            "/v",
            "ProxyServer",
        ])
        .output()
    {
        let stdout = String::from_utf8_lossy(&query_out.stdout);
        if stdout.contains("127.0.0.1:10809") {
            let _ = Command::new("reg.exe")
                .args([
                    "delete",
                    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
                    "/v",
                    "ProxyServer",
                    "/f",
                ])
                .output();
        }
    }

    // Notify WinINet system subsystem immediately
    notify_wininet();

    Ok(())
}

#[cfg(target_os = "windows")]
fn notify_wininet() {
    use std::os::raw::c_void;

    const INTERNET_OPTION_SETTINGS_CHANGED: u32 = 39;
    const INTERNET_OPTION_REFRESH: u32 = 37;

    #[link(name = "wininet")]
    extern "system" {
        fn InternetSetOptionW(
            h_internet: *mut c_void,
            dw_option: u32,
            lp_buffer: *mut c_void,
            dw_buffer_length: u32,
        ) -> i32;
    }

    unsafe {
        let res1 = InternetSetOptionW(
            std::ptr::null_mut(),
            INTERNET_OPTION_SETTINGS_CHANGED,
            std::ptr::null_mut(),
            0,
        );
        let res2 = InternetSetOptionW(
            std::ptr::null_mut(),
            INTERNET_OPTION_REFRESH,
            std::ptr::null_mut(),
            0,
        );
        tracing::debug!("WinINet refresh notifications sent: ({}, {})", res1, res2);
    }
}

#[cfg(not(target_os = "windows"))]
pub fn enable_system_proxy(_proxy_addr: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn disable_system_proxy() -> Result<(), String> {
    Ok(())
}
