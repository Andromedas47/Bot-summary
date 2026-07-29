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

function Copy-Sql([string]$File, [string]$Dest) {
  docker cp (Resolve-Path $File).Path "${Container}:${Dest}"
}

Run-Sql "bootstrap (0042-era baseline)" (Join-Path $Root "supabase/tests/produce_0049_bootstrap.sql")
Run-Sql "apply 0048" (Join-Path $Root "supabase/migrations/0048_pending_session_function_parity.sql")
Run-Sql "apply 0049" (Join-Path $Root "supabase/migrations/0049_produce_structured_session_foundation.sql")
Run-Sql "apply candidate 0050" (Join-Path $Root "supabase/migrations/0050_produce_finalization_hold.sql")
Run-Sql "0050 behavioural verification" (Join-Path $Root "supabase/tests/produce_0050_verification.sql")

Write-Host "==> 0050 real two-connection concurrency"
Copy-Sql (Join-Path $Root "supabase/tests/produce_0050_concurrency_setup.sql") "/tmp/p50_setup.sql"
Copy-Sql (Join-Path $Root "supabase/tests/produce_0050_concurrency_lock.sql") "/tmp/p50_lock.sql"
Copy-Sql (Join-Path $Root "supabase/tests/produce_0050_concurrency_confirm.sql") "/tmp/p50_confirm.sql"
Copy-Sql (Join-Path $Root "supabase/tests/produce_0050_concurrency_finalize.sql") "/tmp/p50_finalize.sql"
Copy-Sql (Join-Path $Root "supabase/tests/produce_0050_concurrency_assert.sql") "/tmp/p50_assert.sql"

docker exec $Container psql -v ON_ERROR_STOP=1 -U postgres -d verify -f /tmp/p50_setup.sql
if ($LASTEXITCODE -ne 0) { throw "SQL failed: concurrency setup" }

# Race 1: Conn A holds FOR UPDATE; Conn B confirms and must wait then succeed.
$lockJob = Start-Job -ScriptBlock {
  param($Name)
  docker exec $Name psql -v ON_ERROR_STOP=1 -U postgres -d verify -f /tmp/p50_lock.sql
  if ($LASTEXITCODE -ne 0) { throw "lock connection failed" }
} -ArgumentList $Container

Start-Sleep -Milliseconds 400

$confirmOut = docker exec $Container psql -v ON_ERROR_STOP=1 -U postgres -d verify -f /tmp/p50_confirm.sql 2>&1
if ($LASTEXITCODE -ne 0) {
  Stop-Job $lockJob -ErrorAction SilentlyContinue
  throw "SQL failed: concurrent confirm: $confirmOut"
}
Write-Host $confirmOut
if ("$confirmOut" -notmatch "confirmed|already_confirmed") {
  throw "concurrent confirm did not return confirmed"
}

Wait-Job $lockJob | Out-Null
Receive-Job $lockJob | Out-Host
if ($lockJob.State -ne "Completed") { throw "lock connection did not complete cleanly" }
Remove-Job $lockJob

# Race 2: two concurrent try_finalize against a confirmed session.
$finA = Start-Job -ScriptBlock {
  param($Name)
  docker exec $Name psql -v ON_ERROR_STOP=1 -U postgres -d verify -f /tmp/p50_finalize.sql
  if ($LASTEXITCODE -ne 0) { throw "finalize A failed" }
} -ArgumentList $Container
$finB = Start-Job -ScriptBlock {
  param($Name)
  docker exec $Name psql -v ON_ERROR_STOP=1 -U postgres -d verify -f /tmp/p50_finalize.sql
  if ($LASTEXITCODE -ne 0) { throw "finalize B failed" }
} -ArgumentList $Container

Wait-Job $finA, $finB | Out-Null
$outA = Receive-Job $finA | Out-String
$outB = Receive-Job $finB | Out-String
Write-Host "finalize A:`n$outA"
Write-Host "finalize B:`n$outB"
if ($finA.State -ne "Completed" -or $finB.State -ne "Completed") {
  throw "concurrent finalize jobs failed"
}
Remove-Job $finA, $finB

docker exec $Container psql -v ON_ERROR_STOP=1 -U postgres -d verify -f /tmp/p50_assert.sql
if ($LASTEXITCODE -ne 0) { throw "SQL failed: concurrency assert" }

Write-Host "==> produce_0050: OK"
Cleanup
