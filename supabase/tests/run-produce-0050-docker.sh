#!/usr/bin/env bash
# Executable verification of migration 0050 against a disposable Docker
# PostgreSQL container. Never touches Production.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONTAINER="produce-0050-verify-$$"
IMAGE="${POSTGRES_IMAGE:-postgres:16-alpine}"

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "==> starting disposable $IMAGE as $CONTAINER"
docker run -d --name "$CONTAINER" \
  -e POSTGRES_PASSWORD=verify -e POSTGRES_DB=verify \
  "$IMAGE" >/dev/null

until docker exec "$CONTAINER" pg_isready -U postgres -d verify >/dev/null 2>&1; do
  sleep 1
done
sleep 1

run_sql() {
  local label="$1" file="$2"
  echo "==> $label"
  docker cp "$file" "${CONTAINER}:/tmp/run.sql"
  docker exec "$CONTAINER" \
    psql -v ON_ERROR_STOP=1 -U postgres -d verify -f /tmp/run.sql
}

psql_t() {
  docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d verify -tA -c "$1"
}

wait_until() {
  local label="$1" sql="$2" timeout="${3:-30}"
  local deadline=$((SECONDS + timeout))
  local result=""
  while (( SECONDS < deadline )); do
    result="$(psql_t "$sql" | tr -d '[:space:]')"
    if [[ "$result" == "t" || "$result" == "1" ]]; then
      return 0
    fi
    sleep 0.05
  done
  echo "timeout waiting for $label (last='$result')" >&2
  exit 1
}

run_sql "bootstrap (0042-era baseline)" \
  "$ROOT/supabase/tests/produce_0049_bootstrap.sql"
run_sql "apply 0048" \
  "$ROOT/supabase/migrations/0048_pending_session_function_parity.sql"
run_sql "apply 0049" \
  "$ROOT/supabase/migrations/0049_produce_structured_session_foundation.sql"
run_sql "apply candidate 0050" \
  "$ROOT/supabase/migrations/0050_produce_finalization_hold.sql"
run_sql "0050 behavioural verification" \
  "$ROOT/supabase/tests/produce_0050_verification.sql"
run_sql "0050 crash recovery (fresh connection)" \
  "$ROOT/supabase/tests/produce_0050_crash_recovery.sql"

echo "==> 0050 deterministic two-connection concurrency"
for pair in \
  "produce_0050_concurrency_setup.sql:/tmp/p50_setup.sql" \
  "produce_0050_concurrency_gate_a.sql:/tmp/p50_gate_a.sql" \
  "produce_0050_concurrency_gate_b.sql:/tmp/p50_gate_b.sql" \
  "produce_0050_concurrency_fin_first_a.sql:/tmp/p50_fin_a.sql" \
  "produce_0050_concurrency_fin_first_b.sql:/tmp/p50_fin_b.sql" \
  "produce_0050_concurrency_confirm_first_a.sql:/tmp/p50_cfm_a.sql" \
  "produce_0050_concurrency_confirm_first_b.sql:/tmp/p50_cfm_b.sql" \
  "produce_0050_concurrency_finalize.sql:/tmp/p50_finalize.sql" \
  "produce_0050_concurrency_assert.sql:/tmp/p50_assert.sql"
do
  src="${pair%%:*}"
  dst="${pair##*:}"
  docker cp "$ROOT/supabase/tests/$src" "${CONTAINER}:${dst}"
done

docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d verify -f /tmp/p50_setup.sql

docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d verify -f /tmp/p50_gate_a.sql &
GATE_A=$!
wait_until "gate A held" \
  "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=9100501 AND granted)"

docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d verify -f /tmp/p50_fin_a.sql &
JOB_A=$!
wait_until "finalizer waiting on advisory after row lock" \
  "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname='verify' AND wait_event_type='Lock' AND query ILIKE '%pg_advisory_lock(9100501)%')"

docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d verify -f /tmp/p50_fin_b.sql &
JOB_B=$!
wait_until "confirm blocked behind finalizer" \
  "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname='verify' AND wait_event_type='Lock' AND query ILIKE '%confirm_produce_structured_finalization%')"

psql_t "INSERT INTO public.p50_sync(k,v) VALUES ('fin_first_blocker_observed','1') ON CONFLICT (k) DO UPDATE SET v=excluded.v"
psql_t "INSERT INTO public.p50_sync(k,v) VALUES ('unlock_gate_a','1') ON CONFLICT (k) DO UPDATE SET v=excluded.v"
wait "$JOB_A"
wait "$JOB_B"
wait "$GATE_A"

docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d verify -f /tmp/p50_gate_b.sql &
GATE_B=$!
wait_until "gate B held" \
  "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=9100502 AND granted)"

docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d verify -f /tmp/p50_cfm_a.sql &
JOB_C=$!
wait_until "confirm waiting on advisory after row lock" \
  "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname='verify' AND wait_event_type='Lock' AND query ILIKE '%pg_advisory_lock(9100502)%')"

docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d verify -f /tmp/p50_cfm_b.sql &
JOB_D=$!
wait_until "finalize blocked behind confirm" \
  "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname='verify' AND wait_event_type='Lock' AND (query ILIKE '%try_finalize_pending_generation%' OR query ILIKE '%FOR UPDATE%'))"

psql_t "INSERT INTO public.p50_sync(k,v) VALUES ('confirm_first_blocker_observed','1') ON CONFLICT (k) DO UPDATE SET v=excluded.v"
psql_t "INSERT INTO public.p50_sync(k,v) VALUES ('unlock_gate_b','1') ON CONFLICT (k) DO UPDATE SET v=excluded.v"
wait "$JOB_C"
wait "$JOB_D"
wait "$GATE_B"

docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d verify -f /tmp/p50_finalize.sql &
FIN_A=$!
docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d verify -f /tmp/p50_finalize.sql &
FIN_B=$!
wait "$FIN_A"
wait "$FIN_B"

docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d verify -f /tmp/p50_assert.sql

echo "==> produce_0050: OK"
