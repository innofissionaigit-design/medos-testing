# Starts the API against the local dev database (run scripts\db-up.ps1 first; seed with `pnpm db:seed`).
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$env:PRISMA_ENGINES_CACHE_DIR = 'D:\.cache\prisma'
if (-not $env:DATABASE_URL) { $env:DATABASE_URL = 'postgresql://medos@127.0.0.1:54329/medos_dev' }
if (-not $env:JWT_ACCESS_SECRET) { $env:JWT_ACCESS_SECRET = 'dev-only-secret-dev-only-secret-0001' }
$env:PORT = '4000'
$env:CORS_ORIGINS = 'http://localhost:3000'
Set-Location $root
node apps\api\dist\main.js
