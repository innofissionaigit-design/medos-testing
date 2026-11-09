# Logical backup of a MedOS database with pg_dump (custom format, compressed, restorable with pg_restore).
#   .\scripts\backup.ps1 -Database medos_dev -OutDir D:\backups
# Connection comes from PGHOST/PGPORT/PGUSER/PGPASSWORD or the parameters. Never put a password on the command line.
# Production should add PITR (WAL archiving) and encrypt the output at rest; see docs/deployment.md.
param(
  [string]$Database = 'medos_dev',
  [string]$HostName = $(if ($env:PGHOST) { $env:PGHOST } else { '127.0.0.1' }),
  [int]$Port = $(if ($env:PGPORT) { [int]$env:PGPORT } else { 54329 }),
  [string]$User = $(if ($env:PGUSER) { $env:PGUSER } else { 'medos' }),
  [string]$OutDir = (Join-Path (Split-Path $PSScriptRoot -Parent) '.local\backups'),
  [int]$KeepLast = 14
)
$ErrorActionPreference = 'Stop'
$pg = if ($env:PG_BIN) { $env:PG_BIN } else { 'C:\Program Files\PostgreSQL\17\bin' }
New-Item -ItemType Directory -Force $OutDir | Out-Null
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$file = Join-Path $OutDir "$Database-$stamp.dump"
& "$pg\pg_dump.exe" -h $HostName -p $Port -U $User -d $Database -Fc -Z 6 --no-owner --no-privileges -f $file
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed with exit code $LASTEXITCODE" }
# A backup that cannot be read back is not a backup: list its table of contents.
& "$pg\pg_restore.exe" --list $file | Out-Null
if ($LASTEXITCODE -ne 0) { throw "backup file failed verification: $file" }
$hash = (Get-FileHash $file -Algorithm SHA256).Hash
Set-Content -Path "$file.sha256" -Value "$hash  $(Split-Path $file -Leaf)" -Encoding ascii
Get-ChildItem $OutDir -Filter "$Database-*.dump" | Sort-Object Name -Descending | Select-Object -Skip $KeepLast | ForEach-Object { Remove-Item $_.FullName, "$($_.FullName).sha256" -Force -ErrorAction SilentlyContinue }
Write-Host "Backup written: $file ($([math]::Round((Get-Item $file).Length / 1MB, 2)) MB, sha256 $($hash.Substring(0, 12))...)"
Write-Output $file
