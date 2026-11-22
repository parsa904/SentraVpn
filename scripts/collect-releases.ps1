<#
.SYNOPSIS
    Collects Windows (NSIS .exe) and Android (universal .apk) build artifacts,
    copies them into releases/ with standardized naming, and outputs verification hashes.

.OUTPUTS
    releases/Sentra-v1.0.0-Windows-Setup.exe
    releases/Sentra-v1.0.0-Android.apk
#>

$ErrorActionPreference = "Stop"

$ProjectRoot = Resolve-Path "$PSScriptRoot\.."
$ReleasesDir = Join-Path $ProjectRoot "releases"

if (-not (Test-Path $ReleasesDir)) {
    New-Item -ItemType Directory -Path $ReleasesDir -Force | Out-Null
    Write-Host "[+] Created releases directory: $ReleasesDir" -ForegroundColor Cyan
}

Write-Host "==========================================================" -ForegroundColor Green
Write-Host "   Sentra Artifact Collection & Release Packaging" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green

$WindowsTargetName = "Sentra-v1.0.0-Windows-Setup.exe"
$AndroidTargetName = "Sentra-v1.0.0-Android.apk"

$WindowsDest = Join-Path $ReleasesDir $WindowsTargetName
$AndroidDest = Join-Path $ReleasesDir $AndroidTargetName

# ----------------------------------------------------
# 1. Search for Windows NSIS Setup .exe
# ----------------------------------------------------
$WinSearchPaths = @(
    "$ProjectRoot\sentra-client\src-tauri\target\release\bundle\nsis\*setup*.exe",
    "$ProjectRoot\sentra-client\src-tauri\target\release\bundle\nsis\*.exe",
    "$ProjectRoot\target\release\bundle\nsis\*.exe"
)

$FoundWindowsExe = $null
foreach ($path in $WinSearchPaths) {
    $matches = Get-ChildItem -Path $path -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch "x86_64" -or $_.Name -match "setup" }
    if ($matches) {
        $FoundWindowsExe = $matches[0].FullName
        break
    }
}

if ($FoundWindowsExe -and (Test-Path $FoundWindowsExe)) {
    Copy-Item -Path $FoundWindowsExe -Destination $WindowsDest -Force
    $winSizeMb = [math]::Round(((Get-Item $WindowsDest).Length / 1MB), 2)
    $winHash = (Get-FileHash -Path $WindowsDest -Algorithm SHA256).Hash
    Write-Host "[+] Windows Installer Collected: $WindowsTargetName" -ForegroundColor Green
    Write-Host "    Source: $FoundWindowsExe" -ForegroundColor Gray
    Write-Host "    Size  : $winSizeMb MB" -ForegroundColor Gray
    Write-Host "    SHA256: $winHash" -ForegroundColor Yellow
} else {
    Write-Host "[!] Windows NSIS setup not found in default target paths." -ForegroundColor Yellow
    Write-Host "    Run 'npm run tauri build' inside sentra-client to build it." -ForegroundColor Gray
}

# ----------------------------------------------------
# 2. Search for Android Universal APK
# ----------------------------------------------------
$AndroidSearchPaths = @(
    "$ProjectRoot\sentra-client\src-tauri\gen\android\app\build\outputs\apk\release\*universal*.apk",
    "$ProjectRoot\sentra-client\src-tauri\gen\android\app\build\outputs\apk\release\app-release.apk",
    "$ProjectRoot\sentra-client\src-tauri\gen\android\app\build\outputs\apk\release\*.apk"
)

$FoundAndroidApk = $null
foreach ($path in $AndroidSearchPaths) {
    $matches = Get-ChildItem -Path $path -ErrorAction SilentlyContinue
    if ($matches) {
        $FoundAndroidApk = $matches[0].FullName
        break
    }
}

if ($FoundAndroidApk -and (Test-Path $FoundAndroidApk)) {
    Copy-Item -Path $FoundAndroidApk -Destination $AndroidDest -Force
    $apkSizeMb = [math]::Round(((Get-Item $AndroidDest).Length / 1MB), 2)
    $apkHash = (Get-FileHash -Path $AndroidDest -Algorithm SHA256).Hash
    Write-Host "[+] Android Universal APK Collected: $AndroidTargetName" -ForegroundColor Green
    Write-Host "    Source: $FoundAndroidApk" -ForegroundColor Gray
    Write-Host "    Size  : $apkSizeMb MB" -ForegroundColor Gray
    Write-Host "    SHA256: $apkHash" -ForegroundColor Yellow
} else {
    Write-Host "[!] Android release APK not found in default Gradle outputs." -ForegroundColor Yellow
    Write-Host "    Run 'gradlew assembleRelease' in sentra-client/src-tauri/gen/android to build it." -ForegroundColor Gray
}

Write-Host "`nRelease collection completed. Target directory: $ReleasesDir" -ForegroundColor Cyan
