# Update release token: swaps the GitHub token OL Premiere publishes its updates with, then checks
# it can still publish. He runs it by double clicking "Update release token.cmd" in this folder
# after pressing "Regenerate token" on GitHub. The token is saved only in .env.release (gitignored)
# and never shown on screen.
#
# Why it exists, 2026-09-28: the token "olpremiere-release" was pasted into a chat on 2026-07-26 and
# ended up in the notes backup's history. Regenerating it makes the old value dead; this puts the new
# one where the release reads it (scripts/lib.mjs, GH_TOKEN in .env.release), so shipping keeps working.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env.release'

Write-Host ''
Write-Host '  Update the token OL Premiere publishes its updates with' -ForegroundColor Cyan
Write-Host ''
Write-Host '  On GitHub: open the token "olpremiere-release", press Regenerate token, copy the new one.'
Write-Host '  It is saved only on this PC. Nobody else sees it.'
Write-Host ''
$secure = Read-Host '  Paste the new token' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $token = ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)).Trim() }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }

if (-not $token) {
  Write-Host ''
  Write-Host '  Nothing saved: no token was pasted.' -ForegroundColor Yellow
  Read-Host '  Press Enter to close'
  exit 1
}

Write-Host ''
Write-Host '  Checking it with GitHub...'
$ok = $false
try {
  $repo = Invoke-RestMethod -Uri 'https://api.github.com/repos/dluxpixel/olpremiere' -Headers @{ Authorization = "Bearer $token"; 'User-Agent' = 'olp-release-token' }
  $ok = [bool]$repo.permissions.push
} catch { $ok = $false }

if (-not $ok) {
  $token = $null
  Write-Host ''
  Write-Host '  GitHub did not accept it for OL Premiere. Nothing was changed; the old one still works.' -ForegroundColor Yellow
  Write-Host '  Check you copied the whole new token, and that it can write to olpremiere.'
  Read-Host '  Press Enter to close'
  exit 1
}

$lines = @()
if (Test-Path $envFile) { $lines = @(Get-Content $envFile | Where-Object { $_ -notmatch '^\s*GH_TOKEN\s*=' }) }
$lines += "GH_TOKEN=$token"
[IO.File]::WriteAllLines($envFile, [string[]]$lines)
$token = $null

Write-Host ''
Write-Host '  Works. OL Premiere updates will publish with the new token.' -ForegroundColor Green
Write-Host ''
Read-Host '  Press Enter to close'
