# OL Premiere launcher — starts the local dev server (if not already up) and
# opens the editor in a chromeless app window. Local-first: nothing leaves the
# machine. Double-clicked via the Desktop shortcut.
# NOTE: the Desktop shortcut now goes through the shared .launchers\launch-app.ps1 (unified
# with Almanac/OL Studio/etc). This standalone script is kept as a direct fallback. Port is
# 4318 — co-typer owns 4317, and sharing it made clicking one open the other.
$ErrorActionPreference = 'Stop'
$repo = 'C:\Users\skyle\Desktop\ol-premiere'
$port = 4318
$url = "http://localhost:$port/"

Set-Location $repo

function Test-Port($p) {
  try {
    $c = New-Object Net.Sockets.TcpClient
    $c.Connect('127.0.0.1', $p)
    $c.Close()
    return $true
  } catch { return $false }
}

if (-not (Test-Port $port)) {
  if (-not (Test-Path "$repo\node_modules")) {
    $env:NODE_OPTIONS = '--use-system-ca'
    npm install | Out-Null
  }
  # Start Vite dev on a fixed port, hidden; it keeps running after this exits.
  Start-Process -FilePath 'npm.cmd' `
    -ArgumentList 'run', 'dev', '--', '--port', "$port", '--strictPort' `
    -WorkingDirectory $repo -WindowStyle Hidden
  # Wait for the server to accept connections (up to ~30s).
  for ($i = 0; $i -lt 60; $i++) {
    if (Test-Port $port) { break }
    Start-Sleep -Milliseconds 500
  }
}

# Prefer a chromeless Chrome/Edge "app" window; fall back to the default browser.
$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($chrome) {
  Start-Process -FilePath $chrome -ArgumentList "--app=$url", '--new-window'
} else {
  Start-Process $url
}
