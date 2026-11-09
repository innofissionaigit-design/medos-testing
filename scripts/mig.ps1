# Dev helper (non-interactive): generate a migration from schema changes, append hand-written SQL, apply it, verify no drift.
#   powershell -NoProfile -File scripts/mig.ps1 <name> [<path-to-extra-sql>]
# The diff is taken between the dev database (kept in sync with committed migrations) and prisma/schema.
param([Parameter(Mandatory)][string]$Name, [string]$SqlFile)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$db = Join-Path $root 'packages\database'
$env:DATABASE_URL = if ($env:DEV_DATABASE_URL) { $env:DEV_DATABASE_URL } else { 'postgresql://medos@127.0.0.1:54329/medos_dev' }
$enc = New-Object System.Text.UTF8Encoding($false)

function Invoke-Prisma([string[]]$PrismaArgs) {
  $out = Join-Path $root '.local\prisma.out'; $err = Join-Path $root '.local\prisma.err'
  $p = Start-Process -FilePath pnpm.cmd -ArgumentList (@('exec', 'prisma') + $PrismaArgs) -WorkingDirectory $db -NoNewWindow -Wait -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
  [pscustomobject]@{ Code = $p.ExitCode; Out = [IO.File]::ReadAllText($out); Err = [IO.File]::ReadAllText($err) }
}

$diff = Invoke-Prisma @('migrate', 'diff', '--from-url', $env:DATABASE_URL, '--to-schema-datamodel', 'prisma/schema', '--script')
if ($diff.Code -ne 0) { throw "diff failed: $($diff.Err)" }
$body = $diff.Out.Trim()
if ($body -match '^-- This is an empty migration') { $body = '' }
$extra = if ($SqlFile) { [IO.File]::ReadAllText($SqlFile) } else { '' }
if (-not $body -and -not $extra) { Write-Host 'Nothing to migrate.'; return }

$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmss')
$dir = Join-Path $db "prisma\schema\migrations\${stamp}_$Name"
New-Item -ItemType Directory -Force $dir | Out-Null
$sql = $body
if ($extra) { $sql += "`n`n-- ===== Hand-written invariants =====`n" + $extra }
[IO.File]::WriteAllText((Join-Path $dir 'migration.sql'), $sql + "`n", $enc)

$dep = Invoke-Prisma @('migrate', 'deploy')
if ($dep.Code -ne 0) { throw "migrate deploy failed:`n$($dep.Out)`n$($dep.Err)" }

$check = Invoke-Prisma @('migrate', 'diff', '--from-url', $env:DATABASE_URL, '--to-schema-datamodel', 'prisma/schema', '--exit-code')
if ($check.Code -ne 0) { throw "Schema drift remains after migration:`n$($check.Out)" }
Write-Host "Migration ${stamp}_$Name applied; database and schema agree."
