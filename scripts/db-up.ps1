# Starts the project-local PostgreSQL cluster (dev + test databases) on port 54329, detached from the caller.
# First run initialises the cluster and creates medos_dev / medos_test. Windows dev convenience only;
# CI and production use Docker / managed PostgreSQL (see docs/deployment.md).
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$pg = if ($env:PG_BIN) { $env:PG_BIN } else { 'C:\Program Files\PostgreSQL\17\bin' }
$data = Join-Path $root '.local\pgdata'
$port = 54329
New-Item -ItemType Directory -Force (Join-Path $root '.local') | Out-Null
if (-not (Test-Path "$data\PG_VERSION")) {
  & "$pg\initdb.exe" -D $data -U medos -A trust -E UTF8 --locale=C | Out-Null
}
$running = $false
try { & "$pg\pg_isready.exe" -h 127.0.0.1 -p $port | Out-Null; $running = ($LASTEXITCODE -eq 0) } catch {}
if (-not $running) {
  if (Test-Path "$data\postmaster.pid") { Remove-Item "$data\postmaster.pid" -Force }
  Start-Process -FilePath "$pg\postgres.exe" -ArgumentList @('-D', $data, '-p', "$port") -WindowStyle Hidden `
    -RedirectStandardError (Join-Path $root '.local\pg.err') -RedirectStandardOutput (Join-Path $root '.local\pg.out')
  for ($i = 0; $i -lt 30; $i++) { Start-Sleep -Milliseconds 500; & "$pg\pg_isready.exe" -h 127.0.0.1 -p $port | Out-Null; if ($LASTEXITCODE -eq 0) { break } }
}
foreach ($db in 'medos_dev', 'medos_test') {
  $exists = & "$pg\psql.exe" -h 127.0.0.1 -p $port -U medos -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$db'"
  if (-not $exists) { & "$pg\psql.exe" -h 127.0.0.1 -p $port -U medos -d postgres -c "CREATE DATABASE $db" | Out-Null }
}
Write-Host "PostgreSQL ready on 127.0.0.1:$port"
