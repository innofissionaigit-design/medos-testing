# Proves recovery works: backs up a database, restores it to a scratch database, and compares row counts, money totals
# and stock units. Also checks that integrity triggers survived (an append-only audit table must still reject UPDATE).
#   .\scripts\restore-test.ps1 -Source medos_dev
param([string]$Source = 'medos_dev', [int]$Port = 54329, [string]$User = 'medos', [string]$HostName = '127.0.0.1')
$ErrorActionPreference = 'Stop'
$pg = if ($env:PG_BIN) { $env:PG_BIN } else { 'C:\Program Files\PostgreSQL\17\bin' }
$scratch = "${Source}_restore_check"
$counts = Join-Path $PSScriptRoot 'sql\verify-counts.sql'
$tamperSql = Join-Path $PSScriptRoot 'sql\tamper-check.sql'
$env:PGOPTIONS = '-c client_min_messages=warning'

function Drop-Scratch { & "$pg\psql.exe" -h $HostName -p $Port -U $User -d postgres -c "DROP DATABASE IF EXISTS $scratch" | Out-Null }

$dump = & "$PSScriptRoot\backup.ps1" -Database $Source -OutDir (Join-Path (Split-Path $PSScriptRoot -Parent) '.local\restore-test') -KeepLast 3 | Select-Object -Last 1
Drop-Scratch
try {
  & "$PSScriptRoot\restore.ps1" -File $dump -Database $scratch -HostName $HostName -Port $Port -User $User | Out-Null
  $a = & "$pg\psql.exe" -h $HostName -p $Port -U $User -d $Source -tA -F '|' -f $counts
  $b = & "$pg\psql.exe" -h $HostName -p $Port -U $User -d $scratch -tA -F '|' -f $counts
  if (($a -join "`n") -ne ($b -join "`n")) { Write-Host "SOURCE:`n$($a -join "`n")`nRESTORED:`n$($b -join "`n")"; throw "Restored data does not match the source" }

  $env:PGOPTIONS = '-c client_min_messages=notice'
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $tamper = (& "$pg\psql.exe" -h $HostName -p $Port -U $User -d $scratch -v ON_ERROR_STOP=1 -f $tamperSql 2>&1 | Out-String)
  $ErrorActionPreference = $prev
  $env:PGOPTIONS = '-c client_min_messages=warning'
  if ($tamper -notmatch 'APPEND_ONLY_OK') { throw "Append-only trigger is missing after restore: $tamper" }

  # Row-level security must survive a restore: the same policies, and the restricted login able to read again (restore.ps1 re-grants).
  $rlsSql = Join-Path $PSScriptRoot 'sql/rls-state.sql'
  $ra = (& "$pg\psql.exe" -h $HostName -p $Port -U $User -d $Source -tA -f $rlsSql) -join ''
  $rb = (& "$pg\psql.exe" -h $HostName -p $Port -U $User -d $scratch -tA -f $rlsSql) -join ''
  if ($ra -ne $rb) { throw "Row-level security state differs after restore: source '$ra', restored '$rb'" }

  Write-Host "RESTORE VERIFIED: $($a.Count) checks identical; integrity triggers intact; row-level security state identical ($ra)." -ForegroundColor Green
  $a | ForEach-Object { Write-Host "  $_" }
} finally {
  Drop-Scratch
}
