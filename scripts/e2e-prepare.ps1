# Builds a fresh, small, seeded database for the browser end-to-end tests (medos_e2e). Windows dev helper; CI uses the same steps
# against its own PostgreSQL service. Requires the API to be built (pnpm --filter @medos/api build).
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$pg = if ($env:PG_BIN) { $env:PG_BIN } else { 'C:\Program Files\PostgreSQL\17\bin' }
# E2E_PG_PORT / E2E_SKIP_DB_UP let a machine use a PostgreSQL server it already runs (for example on another port).
$port = if ($env:E2E_PG_PORT) { [int]$env:E2E_PG_PORT } else { 54329 }
$env:PGOPTIONS = '-c client_min_messages=warning'
if (-not $env:E2E_SKIP_DB_UP) { & "$PSScriptRoot\db-up.ps1" | Out-Null }
& "$pg\psql.exe" -h 127.0.0.1 -p $port -U medos -d postgres -c "DROP DATABASE IF EXISTS medos_e2e WITH (FORCE)" | Out-Null
& "$pg\psql.exe" -h 127.0.0.1 -p $port -U medos -d postgres -c "CREATE DATABASE medos_e2e" | Out-Null
$env:DATABASE_URL = "postgresql://medos@127.0.0.1:$port/medos_e2e"
if (-not $env:PRISMA_ENGINES_CACHE_DIR) { $env:PRISMA_ENGINES_CACHE_DIR = 'D:\.cache\prisma' }
$env:JWT_ACCESS_SECRET = 'e2e-only-secret-e2e-only-secret-0001'
$env:ARGON2_MEMORY_KIB = '1024'; $env:ARGON2_PASSES = '1'
$env:SEED_PASSWORD = 'E2e-Passw0rd-2026!'
$env:SEED_PROFILE = 'small'
# The browser tests follow the flow in CLAUDE.md (register, queue, consult, then bill and pay), so the product default "consultation paid before the visit" is
# switched off for this database. The rule itself is covered by the API tests (opd-payment.spec.ts).
$env:SEED_OPD_FEE_BEFORE_VISIT = 'false'
Set-Location $root
pnpm --filter '@medos/database' migrate | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'migrations failed' }
node apps\api\dist\cli\seed.js | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'seed failed' }
Write-Host 'medos_e2e ready'
