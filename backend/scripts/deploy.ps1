<#
.SYNOPSIS
  Rebuild and restart the app, stamping the image with the commit it was built
  from.

.DESCRIPTION
      .\deploy.ps1              # rebuild and restart
      .\deploy.ps1 -Check       # just say what is running right now

  Use this rather than `docker compose up -d --build`. Both rebuild, but only
  this one passes GIT_COMMIT into the build, so /api/version and the line in
  the sidebar can say which commit is being served. Without it they read
  "unknown" - which is not wrong, just useless at the moment you need it.

  Static files are baked into the image, so a restart alone never picks up a
  frontend change. That has cost this project more time than any bug.
#>
[CmdletBinding()]
param(
    [switch]$Check,
    [string]$Url = 'http://localhost:8080'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent

function Show-Running {
    try {
        $v = Invoke-RestMethod "$Url/api/version" -TimeoutSec 5
    } catch {
        Write-Host "  could not reach $Url/api/version - is it running?" `
            -ForegroundColor Yellow
        return
    }
    Write-Host "`n  serving   : $($v.label)" -ForegroundColor Green
    Write-Host "  commit    : $($v.commit)"
    Write-Host "  index_sha : $($v.index_sha)"
    if ($v.dirty) {
        Write-Host "  NOTE: built from a modified working tree - not a tagged release" `
            -ForegroundColor Yellow
    }

    # The check that actually settles "did my change deploy?". Compare the hash
    # of the file being served against the same file in the working tree.
    $idx = Join-Path $repo 'backend\static\index.html'
    if (Test-Path $idx) {
        $bytes = [IO.File]::ReadAllBytes($idx)
        $text = [Text.Encoding]::UTF8.GetString($bytes).Replace("`r`n", "`n")
        $sha = [BitConverter]::ToString(
            [Security.Cryptography.SHA256]::Create().ComputeHash(
                [Text.Encoding]::UTF8.GetBytes($text))).Replace('-', '').ToLower()
        if ($sha.Substring(0, 12) -eq $v.index_sha) {
            Write-Host "  the page being served matches your working tree.`n" `
                -ForegroundColor Green
        } else {
            Write-Host "  STALE: the served page is NOT your working tree." `
                -ForegroundColor Red
            Write-Host "         working tree: $($sha.Substring(0,12))`n"
        }
    }
}

if ($Check) { Show-Running; exit 0 }

Push-Location $repo
try {
    $env:GIT_COMMIT = (git rev-parse --short=7 HEAD)
    $env:GIT_DIRTY = if (git status --porcelain) { 'true' } else { 'false' }

    Write-Host "`n  building $env:GIT_COMMIT" `
        -NoNewline -ForegroundColor Cyan
    if ($env:GIT_DIRTY -eq 'true') {
        Write-Host " (working tree modified)" -ForegroundColor Yellow
    } else { Write-Host '' }

    docker compose up -d --build
    if ($LASTEXITCODE -ne 0) { throw "docker compose failed" }

    # The container needs a moment before it answers. Poll rather than sleep a
    # fixed amount - it is ready when it says so.
    foreach ($i in 1..30) {
        try { Invoke-RestMethod "$Url/api/health" -TimeoutSec 2 | Out-Null; break }
        catch { Start-Sleep -Milliseconds 700 }
    }
    Show-Running
} finally {
    Pop-Location
    Remove-Item Env:\GIT_COMMIT, Env:\GIT_DIRTY -ErrorAction SilentlyContinue
}
