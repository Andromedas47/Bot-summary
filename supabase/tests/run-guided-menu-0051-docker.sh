#!/usr/bin/env bash
# Executable verification of migration 0051 against a disposable Docker
# PostgreSQL container. Never touches Production.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONTAINER="guided-menu-0051-verify-$$"
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

# Deterministic two-connection race: gate holds advisory lock; A takes row lock then
# waits on advisory; B blocks on row; unlock gate; assert.
run_two_connection_race() {
  local label="$1"
  local lock_id="$2"
  local setup_src="$3"
  local a_src="$4"
  local b_src="$5"
  local assert_src="$6"
  local unlock_key="$7"
  local blocker_key="$8"
  local a_wait_pattern="$9"
  local b_wait_pattern="${10}"

  echo "==> 0051 deterministic two-connection $label"
  docker cp "$ROOT/supabase/tests/$setup_src" "${CONTAINER}:/tmp/gm51_r_setup.sql"
  docker cp "$ROOT/supabase/tests/$a_src" "${CONTAINER}:/tmp/gm51_r_a.sql"
  docker cp "$ROOT/supabase/tests/$b_src" "${CONTAINER}:/tmp/gm51_r_b.sql"
  docker cp "$ROOT/supabase/tests/$assert_src" "${CONTAINER}:/tmp/gm51_r_assert.sql"

  cat > /tmp/gm51_r_gate.sql <<EOSQL
SELECT pg_advisory_lock($lock_id);
DO \$wait\$
BEGIN
  WHILE NOT EXISTS (SELECT 1 FROM public.gm51_sync WHERE k = '$unlock_key') LOOP
    PERFORM pg_sleep(0.05);
  END LOOP;
END
\$wait\$;
SELECT pg_advisory_unlock($lock_id);
EOSQL
  docker cp /tmp/gm51_r_gate.sql "${CONTAINER}:/tmp/gm51_r_gate.sql"

  docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d verify -f /tmp/gm51_r_setup.sql

  docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d verify -f /tmp/gm51_r_gate.sql &
  local GATE=$!
  wait_until "$label gate held" \
    "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=$lock_id AND granted)"

  docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d verify -f /tmp/gm51_r_a.sql &
  local JOB_A=$!
  wait_until "$label A waiting" \
    "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname='verify' AND wait_event_type='Lock' AND query ILIKE '%${a_wait_pattern}%')"

  docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d verify -f /tmp/gm51_r_b.sql &
  local JOB_B=$!
  wait_until "$label B blocked" \
    "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname='verify' AND wait_event_type='Lock' AND query ILIKE '%${b_wait_pattern}%' AND pid <> pg_backend_pid())"

  psql_t "INSERT INTO public.gm51_sync(k,v) VALUES ('$blocker_key','1') ON CONFLICT (k) DO UPDATE SET v=excluded.v"
  psql_t "INSERT INTO public.gm51_sync(k,v) VALUES ('$unlock_key','1') ON CONFLICT (k) DO UPDATE SET v=excluded.v"
  wait "$JOB_A"
  wait "$JOB_B"
  wait "$GATE"

  docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d verify -f /tmp/gm51_r_assert.sql
}

run_sql "bootstrap (0051 minimal stub)" \
  "$ROOT/supabase/tests/guided_menu_0051_bootstrap.sql"
run_sql "apply candidate 0051" \
  "$ROOT/supabase/migrations/0051_guided_menu_identity_and_state.sql"
run_sql "0051 behavioural verification" \
  "$ROOT/supabase/tests/guided_menu_0051_verification.sql"

echo "==> 0051 deterministic two-connection consume race"
for pair in \
  "guided_menu_0051_concurrency_setup.sql:/tmp/gm51_setup.sql" \
  "guided_menu_0051_concurrency_consume_a.sql:/tmp/gm51_consume_a.sql" \
  "guided_menu_0051_concurrency_consume_b.sql:/tmp/gm51_consume_b.sql" \
  "guided_menu_0051_concurrency_assert.sql:/tmp/gm51_assert.sql"
do
  src="${pair%%:*}"
  dst="${pair##*:}"
  docker cp "$ROOT/supabase/tests/$src" "${CONTAINER}:${dst}"
done

cat > /tmp/gm51_gate.sql <<'EOSQL'
SELECT pg_advisory_lock(9100511);
DO $wait$
BEGIN
  WHILE NOT EXISTS (SELECT 1 FROM public.gm51_sync WHERE k = 'unlock_gate') LOOP
    PERFORM pg_sleep(0.05);
  END LOOP;
END
$wait$;
SELECT pg_advisory_unlock(9100511);
EOSQL
docker cp /tmp/gm51_gate.sql "${CONTAINER}:/tmp/gm51_gate.sql"

docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d verify -f /tmp/gm51_setup.sql

docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d verify -f /tmp/gm51_gate.sql &
GATE=$!
wait_until "gate held" \
  "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=9100511 AND granted)"

docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d verify -f /tmp/gm51_consume_a.sql &
JOB_A=$!
wait_until "consume A waiting on advisory after row lock" \
  "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname='verify' AND wait_event_type='Lock' AND query ILIKE '%pg_advisory_lock(9100511)%')"

docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d verify -f /tmp/gm51_consume_b.sql &
JOB_B=$!
wait_until "consume B blocked behind A" \
  "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname='verify' AND wait_event_type='Lock' AND query ILIKE '%consume_line_menu_state%')"

psql_t "INSERT INTO public.gm51_sync(k,v) VALUES ('race_blocker_observed','1') ON CONFLICT (k) DO UPDATE SET v=excluded.v"
psql_t "INSERT INTO public.gm51_sync(k,v) VALUES ('unlock_gate','1') ON CONFLICT (k) DO UPDATE SET v=excluded.v"
wait "$JOB_A"
wait "$JOB_B"
wait "$GATE"

docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d verify -f /tmp/gm51_assert.sql

run_two_connection_race \
  "result-same" \
  9100512 \
  "guided_menu_0051_result_same_setup.sql" \
  "guided_menu_0051_result_same_a.sql" \
  "guided_menu_0051_result_same_b.sql" \
  "guided_menu_0051_result_same_assert.sql" \
  "unlock_result_same" \
  "result_same_blocker_observed" \
  "pg_advisory_lock(9100512)" \
  "record_line_menu_state_result"

run_two_connection_race \
  "result-conflict" \
  9100513 \
  "guided_menu_0051_result_conflict_setup.sql" \
  "guided_menu_0051_result_conflict_a.sql" \
  "guided_menu_0051_result_conflict_b.sql" \
  "guided_menu_0051_result_conflict_assert.sql" \
  "unlock_result_conflict" \
  "result_conflict_blocker_observed" \
  "pg_advisory_lock(9100513)" \
  "record_line_menu_state_result"

echo "==> guided_menu_0051: OK"
