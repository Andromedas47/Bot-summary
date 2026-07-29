#!/usr/bin/env bash
# Executable verification of migration 0050 against a disposable Docker
# PostgreSQL container. Never touches Production.
#
#   ./supabase/tests/run-produce-0050-docker.sh
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

run_sql() {
  local label="$1" file="$2"
  echo "==> $label"
  docker cp "$file" "${CONTAINER}:/tmp/run.sql"
  docker exec "$CONTAINER" \
    psql -v ON_ERROR_STOP=1 -U postgres -d verify -f /tmp/run.sql
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

echo "==> 0050 real two-connection concurrency"
docker cp "$ROOT/supabase/tests/produce_0050_concurrency_setup.sql" "${CONTAINER}:/tmp/p50_setup.sql"
docker cp "$ROOT/supabase/tests/produce_0050_concurrency_lock.sql" "${CONTAINER}:/tmp/p50_lock.sql"
docker cp "$ROOT/supabase/tests/produce_0050_concurrency_confirm.sql" "${CONTAINER}:/tmp/p50_confirm.sql"
docker cp "$ROOT/supabase/tests/produce_0050_concurrency_finalize.sql" "${CONTAINER}:/tmp/p50_finalize.sql"
docker cp "$ROOT/supabase/tests/produce_0050_concurrency_assert.sql" "${CONTAINER}:/tmp/p50_assert.sql"

docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d verify -f /tmp/p50_setup.sql

docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d verify -f /tmp/p50_lock.sql &
LOCK_PID=$!
sleep 0.4
CONFIRM_OUT="$(docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d verify -f /tmp/p50_confirm.sql)"
echo "$CONFIRM_OUT"
echo "$CONFIRM_OUT" | grep -Eq 'confirmed|already_confirmed'
wait "$LOCK_PID"

docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d verify -f /tmp/p50_finalize.sql &
FIN_A=$!
docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d verify -f /tmp/p50_finalize.sql &
FIN_B=$!
wait "$FIN_A"
wait "$FIN_B"

docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d verify -f /tmp/p50_assert.sql

echo "==> produce_0050: OK"
