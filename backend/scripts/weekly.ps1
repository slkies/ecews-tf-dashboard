<#
.SYNOPSIS
  The weekly pipeline run, in one command.

.DESCRIPTION
  Rehearses by default and changes nothing. Add -Go to run for real.

      .\weekly.ps1                 # dry run - safe, changes nothing
      .\weekly.ps1 -Go             # the real thing
      .\weekly.ps1 -Go -IncludeLate

  It checks the inputs first and stops with a plain-English reason rather than
  a stack trace, then runs the pipeline and tells you what to upload.

  It deliberately does NOT pass -MigrateKeys. That was a one-time changeover;
  running it twice would issue every client a second new key and orphan
  everything already published.
#>
[CmdletBinding()]
param(
    # Do it for real. Without this nothing is written.
    [switch]$Go,

    # Also append unsuppressed results dated on or before the register's
    # cut-off that are missing from it - late facility reporting.
    [switch]$IncludeLate,

    [string]$DataDir = 'C:\Users\eesar\Downloads\Public_Health_Work\Data\TF_Dashboard Files',
    [string]$ScriptDir = 'C:\Users\eesar\Downloads\Public_Health_Work\EAC\ECEWS_TF_Monitor\backend\scripts'
)

$ErrorActionPreference = 'Stop'

function Fail($msg) { Write-Host "`n  STOPPED: $msg`n" -ForegroundColor Red; exit 1 }
function Note($msg) { Write-Host "  $msg" -ForegroundColor DarkGray }

$ini = Join-Path $DataDir 'secure.ini'
$deid = Join-Path $ScriptDir 'deidentify.py'

Write-Host "`n  ECEWS TF pipeline -- $(if ($Go) {'REAL RUN'} else {'dry run'})`n" `
    -ForegroundColor Cyan

# ---- pre-flight. Cheap checks that give a readable reason. ------------------
if (-not (Test-Path $ini))  { Fail "no secure.ini in $DataDir. Run setup_secure.py first." }
if (-not (Test-Path $deid)) { Fail "cannot find deidentify.py at $ScriptDir." }

if ((Get-Content $ini -Raw) -match 'PUT-THE-PASSWORD-HERE') {
    Fail "secure.ini still has the placeholder password. Open it and put the real one in."
}

$treat = Get-ChildItem -Path $DataDir -Filter '*Treatment*.xls*' -ErrorAction SilentlyContinue |
         Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $treat) { Fail "no treatment export in $DataDir (looking for *Treatment*.xlsx)." }

$age = [int]((Get-Date) - $treat.LastWriteTime).TotalDays
Note "treatment export : $($treat.Name)  ($age day(s) old)"
if ($age -gt 14) {
    Write-Host "  WARNING: that export is $age days old. Is it the current one?" `
        -ForegroundColor Yellow
}

$eac = @(Get-ChildItem -Path (Join-Path $DataDir 'eac') -Filter '*.xlsx' -ErrorAction SilentlyContinue)
if ($eac.Count -eq 0) { Fail "no EAC lists in $DataDir\eac." }
Note "EAC lists        : $($eac.Count)"
Note "vault            : $(if (Test-Path (Join-Path $DataDir 'SN_Key.xlsx')) {'present'} else {'MISSING'})"

# ---- run --------------------------------------------------------------------
$argv = @($deid, '--config', $ini)
if ($IncludeLate) { $argv += '--include-late' }
if (-not $Go)     { $argv += '--dry-run' }

Write-Host ''
& python @argv
if ($LASTEXITCODE -ne 0) {
    Fail "the pipeline stopped and published nothing. The reason is above, and in $DataDir\logs."
}

# ---- what to do next --------------------------------------------------------
if ($Go) {
    $out = Get-ChildItem -Path (Join-Path $DataDir 'output') -Filter '*.parquet.zip' |
           Sort-Object LastWriteTime -Descending | Select-Object -First 1
    Write-Host "`n  Upload this on the Admin tab:" -ForegroundColor Green
    Write-Host "    $($out.FullName)"
    Write-Host "    $([math]::Round($out.Length / 1MB, 1)) MB`n"
    Write-Host "  Use the 'key check' percentage above as your sanity check - it should be ~99%.`n" `
        -ForegroundColor DarkGray
} else {
    Write-Host "`n  Dry run only. Nothing was written." -ForegroundColor Green
    Write-Host "  If the numbers above look right, run it again with -Go`n"
}
