# Builds a fresh, small, seeded database for the browser end-to-end tests (medos_e2e). Windows dev helper; CI uses the same steps
# against its own PostgreSQL service. Requires the API to be built (pnpm --filter @medos/api build).
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$pg = if ($env:PG_BIN) { $env:PG_BIN } else { 'C:\Program Files\PostgreSQL\17\bin' }
$port = 54329
$env:PGOPTIONS = '-c client_min_messages=warning'
& "$PSScriptRoot\db-up.ps1" | Out-Null
& "$pg\psql.exe" -h 127.0.0.1 -p $port -U medos -d postgres -c "DROP DATABASE IF EXISTS medos_e2e WITH (FORCE)" | Out-Null
& "$pg\psql.exe" -h 127.0.0.1 -p $port -U medos -d postgres -c "CREATE DATABASE medos_e2e" | Out-Null
$env:DATABASE_URL = 'postgresql://medos@127.0.0.1:54329/medos_e2e'
if (-not $env:PRISMA_ENGINES_CACHE_DIR) { $env:PRISMA_ENGINES_CACHE_DIR = 'D:\.cache\prisma' }
$env:JWT_ACCESS_SECRET = 'e2e-only-secret-e2e-only-secret-0001'
$env:ARGON2_MEMORY_KIB = '1024'; $env:ARGON2_PASSES = '1'
$env:SEED_PASSWORD = 'E2e-Passw0rd-2026!'
$env:SEED_PROFILE = 'small'
Set-Location $root
pnpm --filter '@medos/database' migrate | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'migrations failed' }
node apps\api\dist\cli\seed.js | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'seed failed' }
Write-Host 'medos_e2e ready'
