# PowerShell harness for migration 0051 (Windows). Never touches Production.
$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$Container = "guided-menu-0051-verify-$PID"
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
    # Process may exit between HasExited and Wait-Process on fast paths.
    Wait-Process -Id $Proc.Id -Timeout $TimeoutSec -ErrorAction SilentlyContinue
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

Run-Sql "bootstrap (0051 minimal stub)" (Join-Path $Root "supabase/tests/guided_menu_0051_bootstrap.sql")
Run-Sql "apply candidate 0051" (Join-Path $Root "supabase/migrations/20260729074617_guided_menu_identity_and_state.sql")
Run-Sql "0051 behavioural verification" (Join-Path $Root "supabase/tests/guided_menu_0051_verification.sql")

Write-Host "==> 0051 deterministic two-connection consume race"
@(
  @{ src = "guided_menu_0051_concurrency_setup.sql"; dst = "/tmp/gm51_setup.sql" },
  @{ src = "guided_menu_0051_concurrency_consume_a.sql"; dst = "/tmp/gm51_consume_a.sql" },
  @{ src = "guided_menu_0051_concurrency_consume_b.sql"; dst = "/tmp/gm51_consume_b.sql" },
  @{ src = "guided_menu_0051_concurrency_assert.sql"; dst = "/tmp/gm51_assert.sql" }
) | ForEach-Object {
  Copy-Sql (Join-Path $Root "supabase/tests/$($_.src)") $_.dst
}

$gateSql = @"
SELECT pg_advisory_lock(9100511);
DO `$wait`$
BEGIN
  WHILE NOT EXISTS (SELECT 1 FROM public.gm51_sync WHERE k = 'unlock_gate') LOOP
    PERFORM pg_sleep(0.05);
  END LOOP;
END
`$wait`$;
SELECT pg_advisory_unlock(9100511);
"@
$gateTmp = [System.IO.Path]::GetTempFileName() + ".sql"
[System.IO.File]::WriteAllText($gateTmp, $gateSql)
docker cp $gateTmp "${Container}:/tmp/gm51_gate.sql"
Remove-Item $gateTmp -Force

docker exec $Container psql -v ON_ERROR_STOP=1 -U postgres -d verify -f /tmp/gm51_setup.sql
if ($LASTEXITCODE -ne 0) { throw "SQL failed: concurrency setup" }

$gateOut = Join-Path $env:TEMP "gm51-gate-$PID.out"
$gateErr = Join-Path $env:TEMP "gm51-gate-$PID.err"
$gate = Start-DockerPsql "/tmp/gm51_gate.sql" $gateOut $gateErr
Wait-Until {
  Invoke-Psql "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=9100511 AND granted)"
} "gate held"

$consAOut = Join-Path $env:TEMP "gm51-consume-a-$PID.out"
$consAErr = Join-Path $env:TEMP "gm51-consume-a-$PID.err"
$procA = Start-DockerPsql "/tmp/gm51_consume_a.sql" $consAOut $consAErr

Wait-Until {
  if ($procA.HasExited -and $procA.ExitCode -ne 0) {
    throw "consume A exited early: $(Get-Content $consAErr -Raw)$(Get-Content $consAOut -Raw)"
  }
  Invoke-Psql @"
SELECT EXISTS (
  SELECT 1 FROM pg_stat_activity
  WHERE datname = 'verify'
    AND wait_event_type = 'Lock'
    AND query ILIKE '%pg_advisory_lock(9100511)%'
)
"@
} "consume A waiting on advisory after row lock"

$consBOut = Join-Path $env:TEMP "gm51-consume-b-$PID.out"
$consBErr = Join-Path $env:TEMP "gm51-consume-b-$PID.err"
$procB = Start-DockerPsql "/tmp/gm51_consume_b.sql" $consBOut $consBErr

Wait-Until {
  Invoke-Psql @"
SELECT EXISTS (
  SELECT 1 FROM pg_stat_activity
  WHERE datname = 'verify'
    AND wait_event_type = 'Lock'
    AND query ILIKE '%consume_line_menu_state%'
    AND pid <> pg_backend_pid()
)
"@
} "consume B blocked behind A"

Invoke-Psql "INSERT INTO public.gm51_sync(k,v) VALUES ('race_blocker_observed','1') ON CONFLICT (k) DO UPDATE SET v=excluded.v"
Invoke-Psql "INSERT INTO public.gm51_sync(k,v) VALUES ('unlock_gate','1') ON CONFLICT (k) DO UPDATE SET v=excluded.v"

Await-Proc $procA "consume A" 60 $consAOut $consAErr
Await-Proc $procB "consume B" 60 $consBOut $consBErr
Await-Proc $gate "gate" 60 $gateOut $gateErr
Write-Host "consume A:`n$(Get-Content $consAOut -Raw)`n$(Get-Content $consAErr -Raw)"
Write-Host "consume B:`n$(Get-Content $consBOut -Raw)`n$(Get-Content $consBErr -Raw)"

docker exec $Container psql -v ON_ERROR_STOP=1 -U postgres -d verify -f /tmp/gm51_assert.sql
if ($LASTEXITCODE -ne 0) { throw "SQL failed: concurrency assert" }

function Invoke-TwoConnectionRace {
  param(
    [string]$Label,
    [int]$LockId,
    [string]$SetupSrc,
    [string]$ASrc,
    [string]$BSrc,
    [string]$AssertSrc,
    [string]$UnlockKey,
    [string]$BlockerKey,
    [string]$AWaitPattern,
    [string]$BWaitPattern
  )

  Write-Host "==> 0051 deterministic two-connection $Label"
  Copy-Sql (Join-Path $Root "supabase/tests/$SetupSrc") "/tmp/gm51_r_setup.sql"
  Copy-Sql (Join-Path $Root "supabase/tests/$ASrc") "/tmp/gm51_r_a.sql"
  Copy-Sql (Join-Path $Root "supabase/tests/$BSrc") "/tmp/gm51_r_b.sql"
  Copy-Sql (Join-Path $Root "supabase/tests/$AssertSrc") "/tmp/gm51_r_assert.sql"

  $gateSql = @"
SELECT pg_advisory_lock($LockId);
DO `$wait`$
BEGIN
  WHILE NOT EXISTS (SELECT 1 FROM public.gm51_sync WHERE k = '$UnlockKey') LOOP
    PERFORM pg_sleep(0.05);
  END LOOP;
END
`$wait`$;
SELECT pg_advisory_unlock($LockId);
"@
  $gateTmp = [System.IO.Path]::GetTempFileName() + ".sql"
  [System.IO.File]::WriteAllText($gateTmp, $gateSql)
  docker cp $gateTmp "${Container}:/tmp/gm51_r_gate.sql"
  Remove-Item $gateTmp -Force

  docker exec $Container psql -v ON_ERROR_STOP=1 -U postgres -d verify -f /tmp/gm51_r_setup.sql
  if ($LASTEXITCODE -ne 0) { throw "SQL failed: $Label setup" }

  $gateOut = Join-Path $env:TEMP "gm51-$Label-gate-$PID.out"
  $gateErr = Join-Path $env:TEMP "gm51-$Label-gate-$PID.err"
  $gate = Start-DockerPsql "/tmp/gm51_r_gate.sql" $gateOut $gateErr
  Wait-Until {
    Invoke-Psql "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=$LockId AND granted)"
  } "$Label gate held"

  $aOut = Join-Path $env:TEMP "gm51-$Label-a-$PID.out"
  $aErr = Join-Path $env:TEMP "gm51-$Label-a-$PID.err"
  $procA = Start-DockerPsql "/tmp/gm51_r_a.sql" $aOut $aErr

  Wait-Until {
    if ($procA.HasExited -and $procA.ExitCode -ne 0) {
      throw "$Label A exited early: $(Get-Content $aErr -Raw)$(Get-Content $aOut -Raw)"
    }
    Invoke-Psql @"
SELECT EXISTS (
  SELECT 1 FROM pg_stat_activity
  WHERE datname = 'verify'
    AND wait_event_type = 'Lock'
    AND query ILIKE '%$AWaitPattern%'
)
"@
  } "$Label A waiting"

  $bOut = Join-Path $env:TEMP "gm51-$Label-b-$PID.out"
  $bErr = Join-Path $env:TEMP "gm51-$Label-b-$PID.err"
  $procB = Start-DockerPsql "/tmp/gm51_r_b.sql" $bOut $bErr

  Wait-Until {
    Invoke-Psql @"
SELECT EXISTS (
  SELECT 1 FROM pg_stat_activity
  WHERE datname = 'verify'
    AND wait_event_type = 'Lock'
    AND query ILIKE '%$BWaitPattern%'
    AND pid <> pg_backend_pid()
)
"@
  } "$Label B blocked"

  Invoke-Psql "INSERT INTO public.gm51_sync(k,v) VALUES ('$BlockerKey','1') ON CONFLICT (k) DO UPDATE SET v=excluded.v"
  Invoke-Psql "INSERT INTO public.gm51_sync(k,v) VALUES ('$UnlockKey','1') ON CONFLICT (k) DO UPDATE SET v=excluded.v"

  Await-Proc $procA "$Label A" 60 $aOut $aErr
  Await-Proc $procB "$Label B" 60 $bOut $bErr
  Await-Proc $gate "$Label gate" 60 $gateOut $gateErr
  Write-Host "$Label A:`n$(Get-Content $aOut -Raw)`n$(Get-Content $aErr -Raw)"
  Write-Host "$Label B:`n$(Get-Content $bOut -Raw)`n$(Get-Content $bErr -Raw)"

  docker exec $Container psql -v ON_ERROR_STOP=1 -U postgres -d verify -f /tmp/gm51_r_assert.sql
  if ($LASTEXITCODE -ne 0) { throw "SQL failed: $Label assert" }
}

Invoke-TwoConnectionRace `
  -Label "result-same" `
  -LockId 9100512 `
  -SetupSrc "guided_menu_0051_result_same_setup.sql" `
  -ASrc "guided_menu_0051_result_same_a.sql" `
  -BSrc "guided_menu_0051_result_same_b.sql" `
  -AssertSrc "guided_menu_0051_result_same_assert.sql" `
  -UnlockKey "unlock_result_same" `
  -BlockerKey "result_same_blocker_observed" `
  -AWaitPattern "pg_advisory_lock(9100512)" `
  -BWaitPattern "record_line_menu_state_result"

Invoke-TwoConnectionRace `
  -Label "result-conflict" `
  -LockId 9100513 `
  -SetupSrc "guided_menu_0051_result_conflict_setup.sql" `
  -ASrc "guided_menu_0051_result_conflict_a.sql" `
  -BSrc "guided_menu_0051_result_conflict_b.sql" `
  -AssertSrc "guided_menu_0051_result_conflict_assert.sql" `
  -UnlockKey "unlock_result_conflict" `
  -BlockerKey "result_conflict_blocker_observed" `
  -AWaitPattern "pg_advisory_lock(9100513)" `
  -BWaitPattern "record_line_menu_state_result"

Write-Host "==> guided_menu_0051: OK"
Cleanup
