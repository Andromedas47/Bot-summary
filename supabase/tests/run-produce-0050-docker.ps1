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
Start-Sleep -Seconds 1

function Run-Sql([string]$Label, [string]$File) {
  Write-Host "==> $Label"
  docker cp (Resolve-Path $File).Path "${Container}:/tmp/run.sql"
  docker exec $Container psql -v ON_ERROR_STOP=1 -U postgres -d verify -f /tmp/run.sql
  if ($LASTEXITCODE -ne 0) { throw "SQL failed: $Label" }
}

function Copy-Sql([string]$File, [string]$Dest) {
  docker cp (Resolve-Path $File).Path "${Container}:${Dest}"
}

function Invoke-Psql([string]$Sql) {
  $tmp = [System.IO.Path]::GetTempFileName() + ".sql"
  [System.IO.File]::WriteAllText($tmp, $Sql)
  docker cp $tmp "${Container}:/tmp/probe.sql"
  Remove-Item $tmp -Force
  docker exec $Container psql -v ON_ERROR_STOP=1 -U postgres -d verify -tA -f /tmp/probe.sql
}

function Wait-Until([scriptblock]$Probe, [string]$Label, [int]$TimeoutSec = 30) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  do {
    $result = & $Probe
    if ("$result".Trim() -eq "t" -or "$result".Trim() -eq "1") { return }
    Start-Sleep -Milliseconds 50
  } while ((Get-Date) -lt $deadline)
  throw "timeout waiting for $Label (last='$result')"
}

function Start-DockerPsql([string]$RemoteSql, [string]$OutFile, [string]$ErrFile) {
  return Start-Process -FilePath "docker" -ArgumentList @(
    "exec", $Container, "psql", "-v", "ON_ERROR_STOP=1",
    "-U", "postgres", "-d", "verify", "-f", $RemoteSql
  ) -NoNewWindow -PassThru -RedirectStandardOutput $OutFile -RedirectStandardError $ErrFile
}

function Await-Proc($Proc, [string]$Label, [int]$TimeoutSec = 60, [string]$OutFile = $null, [string]$ErrFile = $null) {
  if (-not $Proc.HasExited) {
    Wait-Process -Id $Proc.Id -Timeout $TimeoutSec
  }
  for ($i = 0; $i -lt 20 -and $null -eq $Proc.ExitCode; $i++) {
    Start-Sleep -Milliseconds 50
    $Proc.Refresh()
  }
  $code = $Proc.ExitCode
  if ($null -eq $code) { $code = 0 }
  if ($code -ne 0) {
    $detail = ""
    if ($OutFile -and (Test-Path $OutFile)) { $detail += Get-Content $OutFile -Raw }
    if ($ErrFile -and (Test-Path $ErrFile)) { $detail += Get-Content $ErrFile -Raw }
    throw "$Label failed with exit $code : $detail"
  }
}

Run-Sql "bootstrap (0042-era baseline)" (Join-Path $Root "supabase/tests/produce_0049_bootstrap.sql")
Run-Sql "apply 0048" (Join-Path $Root "supabase/migrations/0048_pending_session_function_parity.sql")
Run-Sql "apply 0049" (Join-Path $Root "supabase/migrations/0049_produce_structured_session_foundation.sql")
Run-Sql "apply candidate 0050" (Join-Path $Root "supabase/migrations/0050_produce_finalization_hold.sql")
Run-Sql "0050 behavioural verification" (Join-Path $Root "supabase/tests/produce_0050_verification.sql")
Run-Sql "0050 crash recovery (fresh connection)" (Join-Path $Root "supabase/tests/produce_0050_crash_recovery.sql")

Write-Host "==> 0050 deterministic two-connection concurrency"
@(
  @{ src = "produce_0050_concurrency_setup.sql"; dst = "/tmp/p50_setup.sql" },
  @{ src = "produce_0050_concurrency_gate_a.sql"; dst = "/tmp/p50_gate_a.sql" },
  @{ src = "produce_0050_concurrency_gate_b.sql"; dst = "/tmp/p50_gate_b.sql" },
  @{ src = "produce_0050_concurrency_fin_first_a.sql"; dst = "/tmp/p50_fin_a.sql" },
  @{ src = "produce_0050_concurrency_fin_first_b.sql"; dst = "/tmp/p50_fin_b.sql" },
  @{ src = "produce_0050_concurrency_confirm_first_a.sql"; dst = "/tmp/p50_cfm_a.sql" },
  @{ src = "produce_0050_concurrency_confirm_first_b.sql"; dst = "/tmp/p50_cfm_b.sql" },
  @{ src = "produce_0050_concurrency_finalize.sql"; dst = "/tmp/p50_finalize.sql" },
  @{ src = "produce_0050_concurrency_assert.sql"; dst = "/tmp/p50_assert.sql" }
) | ForEach-Object {
  Copy-Sql (Join-Path $Root "supabase/tests/$($_.src)") $_.dst
}

docker exec $Container psql -v ON_ERROR_STOP=1 -U postgres -d verify -f /tmp/p50_setup.sql
if ($LASTEXITCODE -ne 0) { throw "SQL failed: concurrency setup" }

# ── Ordering A: try_finalize lock first, confirm waits ───────────────────────
$gateAOut = Join-Path $env:TEMP "p50-gate-a-$PID.out"
$gateAErr = Join-Path $env:TEMP "p50-gate-a-$PID.err"
$gateA = Start-DockerPsql "/tmp/p50_gate_a.sql" $gateAOut $gateAErr
Wait-Until {
  Invoke-Psql "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=9100501 AND granted)"
} "gate A held"

$finAOut = Join-Path $env:TEMP "p50-fin-a-$PID.out"
$finAErr = Join-Path $env:TEMP "p50-fin-a-$PID.err"
$procA = Start-DockerPsql "/tmp/p50_fin_a.sql" $finAOut $finAErr

# A finished try_finalize and is waiting on advisory 9100501 while still holding the row lock.
Wait-Until {
  if ($procA.HasExited -and $procA.ExitCode -ne 0) {
    throw "fin-first A exited early: $(Get-Content $finAErr -Raw)$(Get-Content $finAOut -Raw)"
  }
  Invoke-Psql @"
SELECT EXISTS (
  SELECT 1 FROM pg_stat_activity
  WHERE datname = 'verify'
    AND wait_event_type = 'Lock'
    AND query ILIKE '%pg_advisory_lock(9100501)%'
)
"@
} "finalizer waiting on advisory after row lock"

$finBOut = Join-Path $env:TEMP "p50-fin-b-$PID.out"
$finBErr = Join-Path $env:TEMP "p50-fin-b-$PID.err"
$procB = Start-DockerPsql "/tmp/p50_fin_b.sql" $finBOut $finBErr

Wait-Until {
  Invoke-Psql @"
SELECT EXISTS (
  SELECT 1 FROM pg_stat_activity
  WHERE datname = 'verify'
    AND wait_event_type = 'Lock'
    AND query ILIKE '%confirm_produce_structured_finalization%'
)
"@
} "confirm blocked behind finalizer"

Invoke-Psql "INSERT INTO public.p50_sync(k,v) VALUES ('fin_first_blocker_observed','1') ON CONFLICT (k) DO UPDATE SET v=excluded.v"
Invoke-Psql "INSERT INTO public.p50_sync(k,v) VALUES ('unlock_gate_a','1') ON CONFLICT (k) DO UPDATE SET v=excluded.v"

Await-Proc $procA "fin-first A" 60 $finAOut $finAErr
Await-Proc $procB "fin-first B" 60 $finBOut $finBErr
Await-Proc $gateA "gate A" 60 $gateAOut $gateAErr
Write-Host "fin-first A:`n$(Get-Content $finAOut -Raw)`n$(Get-Content $finAErr -Raw)"
Write-Host "fin-first B:`n$(Get-Content $finBOut -Raw)`n$(Get-Content $finBErr -Raw)"

# ── Ordering B: confirm lock first, finalize waits ───────────────────────────
$gateBOut = Join-Path $env:TEMP "p50-gate-b-$PID.out"
$gateBErr = Join-Path $env:TEMP "p50-gate-b-$PID.err"
$gateB = Start-DockerPsql "/tmp/p50_gate_b.sql" $gateBOut $gateBErr
Wait-Until {
  Invoke-Psql "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=9100502 AND granted)"
} "gate B held"

$cfmAOut = Join-Path $env:TEMP "p50-cfm-a-$PID.out"
$cfmAErr = Join-Path $env:TEMP "p50-cfm-a-$PID.err"
$procC = Start-DockerPsql "/tmp/p50_cfm_a.sql" $cfmAOut $cfmAErr

Wait-Until {
  if ($procC.HasExited -and $procC.ExitCode -ne 0) {
    throw "confirm-first A exited early: $(Get-Content $cfmAErr -Raw)$(Get-Content $cfmAOut -Raw)"
  }
  Invoke-Psql @"
SELECT EXISTS (
  SELECT 1 FROM pg_stat_activity
  WHERE datname = 'verify'
    AND wait_event_type = 'Lock'
    AND query ILIKE '%pg_advisory_lock(9100502)%'
)
"@
} "confirm waiting on advisory after row lock"

$cfmBOut = Join-Path $env:TEMP "p50-cfm-b-$PID.out"
$cfmBErr = Join-Path $env:TEMP "p50-cfm-b-$PID.err"
$procD = Start-DockerPsql "/tmp/p50_cfm_b.sql" $cfmBOut $cfmBErr

Wait-Until {
  Invoke-Psql @"
SELECT EXISTS (
  SELECT 1 FROM pg_stat_activity
  WHERE datname = 'verify'
    AND wait_event_type = 'Lock'
    AND (
      query ILIKE '%try_finalize_pending_generation%'
      OR query ILIKE '%FOR UPDATE%'
    )
)
"@
} "finalize blocked behind confirm"

Invoke-Psql "INSERT INTO public.p50_sync(k,v) VALUES ('confirm_first_blocker_observed','1') ON CONFLICT (k) DO UPDATE SET v=excluded.v"
Invoke-Psql "INSERT INTO public.p50_sync(k,v) VALUES ('unlock_gate_b','1') ON CONFLICT (k) DO UPDATE SET v=excluded.v"

Await-Proc $procC "confirm-first A" 60 $cfmAOut $cfmAErr
Await-Proc $procD "confirm-first B" 60 $cfmBOut $cfmBErr
Await-Proc $gateB "gate B" 60 $gateBOut $gateBErr
Write-Host "confirm-first A:`n$(Get-Content $cfmAOut -Raw)`n$(Get-Content $cfmAErr -Raw)"
Write-Host "confirm-first B:`n$(Get-Content $cfmBOut -Raw)`n$(Get-Content $cfmBErr -Raw)"

# ── Twin finalize race on already-confirmed session ──────────────────────────
$logFA = Join-Path $env:TEMP "p50-finz-a-$PID.out"
$errFA = Join-Path $env:TEMP "p50-finz-a-$PID.err"
$logFB = Join-Path $env:TEMP "p50-finz-b-$PID.out"
$errFB = Join-Path $env:TEMP "p50-finz-b-$PID.err"
$finTwinA = Start-DockerPsql "/tmp/p50_finalize.sql" $logFA $errFA
$finTwinB = Start-DockerPsql "/tmp/p50_finalize.sql" $logFB $errFB
Await-Proc $finTwinA "finalize A" 60 $logFA $errFA
Await-Proc $finTwinB "finalize B" 60 $logFB $errFB
Write-Host "finalize A:`n$(Get-Content $logFA -Raw)`n$(Get-Content $errFA -Raw)"
Write-Host "finalize B:`n$(Get-Content $logFB -Raw)`n$(Get-Content $errFB -Raw)"

docker exec $Container psql -v ON_ERROR_STOP=1 -U postgres -d verify -f /tmp/p50_assert.sql
if ($LASTEXITCODE -ne 0) { throw "SQL failed: concurrency assert" }

Write-Host "==> produce_0050: OK"
Cleanup
