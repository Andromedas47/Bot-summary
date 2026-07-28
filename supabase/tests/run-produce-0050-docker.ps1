# PowerShell harness for migration 0050 (Windows). Never touches Production.
$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$Container = "produce-0050-verify-$PID"
$Image = if ($env:POSTGRES_IMAGE) { $env:POSTGRES_IMAGE } else { "postgres:16-alpine" }

function Cleanup {
  docker rm -f $Container 2>$null | Out-Null
}
trap { Cleanup; break }

Write-Host "==> starting disposable $Image as $Container"
docker run -d --name $Container `
  -e POSTGRES_PASSWORD=verify -e POSTGRES_DB=verify `
  $Image | Out-Null

do {
  Start-Sleep -Seconds 1
  docker exec $Container pg_isready -U postgres -d verify 2>$null | Out-Null
} while ($LASTEXITCODE -ne 0)

function Run-Sql([string]$Label, [string]$File) {
  Write-Host "==> $Label"
  docker cp (Resolve-Path $File).Path "${Container}:/tmp/run.sql"
  docker exec $Container psql -v ON_ERROR_STOP=1 -U postgres -d verify -f /tmp/run.sql
  if ($LASTEXITCODE -ne 0) { throw "SQL failed: $Label" }
}

Run-Sql "bootstrap (0042-era baseline)" (Join-Path $Root "supabase/tests/produce_0049_bootstrap.sql")
Run-Sql "apply 0048" (Join-Path $Root "supabase/migrations/0048_pending_session_function_parity.sql")
Run-Sql "apply 0049" (Join-Path $Root "supabase/migrations/0049_produce_structured_session_foundation.sql")
Run-Sql "apply candidate 0050" (Join-Path $Root "supabase/migrations/0050_produce_finalization_hold.sql")
Run-Sql "0050 behavioural verification" (Join-Path $Root "supabase/tests/produce_0050_verification.sql")

Write-Host "==> produce_0050: OK"
Cleanup
