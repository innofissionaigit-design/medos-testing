# Restores a backup made by backup.ps1 into a NEW database. It refuses to overwrite an existing database.
#   .\scripts\restore.ps1 -File D:\backups\medos_dev-20261005T100000Z.dump -Database medos_restored
param(
  [Parameter(Mandatory = $true)][string]$File,
  [Parameter(Mandatory = $true)][string]$Database,
  [string]$HostName = $(if ($env:PGHOST) { $env:PGHOST } else { '127.0.0.1' }),
  [int]$Port = $(if ($env:PGPORT) { [int]$env:PGPORT } else { 54329 }),
  [string]$User = $(if ($env:PGUSER) { $env:PGUSER } else { 'medos' })
)
$ErrorActionPreference = 'Stop'
$pg = if ($env:PG_BIN) { $env:PG_BIN } else { 'C:\Program Files\PostgreSQL\17\bin' }
if (-not (Test-Path $File)) { throw "Backup file not found: $File" }
$sumFile = "$File.sha256"
if (Test-Path $sumFile) {
  $expected = ((Get-Content $sumFile -Raw).Trim() -split '\s+')[0]
  if ((Get-FileHash $File -Algorithm SHA256).Hash -ne $expected) { throw "Checksum mismatch: the backup is corrupt or was modified" }
}
$exists = & "$pg\psql.exe" -h $HostName -p $Port -U $User -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$Database'"
if ($exists) { throw "Database '$Database' already exists. Restore into a new name, then switch over deliberately." }
& "$pg\psql.exe" -h $HostName -p $Port -U $User -d postgres -c "CREATE DATABASE `"$Database`"" | Out-Null
& "$pg\pg_restore.exe" -h $HostName -p $Port -U $User -d $Database --no-owner --no-privileges --exit-on-error $File
if ($LASTEXITCODE -ne 0) { throw "pg_restore failed with exit code $LASTEXITCODE" }
# Backups are taken with --no-privileges, so a restored database has the row-level security policies but none of the grants:
# re-apply them (docs/rls.md). Without this the API's restricted login can read nothing and the login functions are open to everyone.
$grants = Join-Path $PSScriptRoot '../packages/database/ops/rls-grants.sql'
& "$pg\psql.exe" -h $HostName -p $Port -U $User -d $Database -v ON_ERROR_STOP=1 -q -f $grants | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Re-applying the row-level security privileges failed with exit code $LASTEXITCODE" }
Write-Host "Restored into database '$Database'."
