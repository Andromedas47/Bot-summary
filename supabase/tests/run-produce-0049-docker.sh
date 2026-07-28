#!/usr/bin/env bash
# Executable verification of migration 0049 against a disposable Docker
# PostgreSQL container.
#
# It NEVER connects to, reads from, or resets Production: the only connection
# string used is the throwaway container started below, and the container is
# removed on exit whether the run passes or fails.
#
#   ./supabase/tests/run-produce-0049-docker.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONTAINER="produce-0049-verify-$$"
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
  docker exec -i "$CONTAINER" \
    psql -v ON_ERROR_STOP=1 -U postgres -d verify -f - < "$file"
}

run_sql "bootstrap (0042-era baseline, absent from version control)" \
  "$ROOT/supabase/tests/produce_0049_bootstrap.sql"
run_sql "apply committed 0048" \
  "$ROOT/supabase/migrations/0048_pending_session_function_parity.sql"
run_sql "apply candidate 0049" \
  "$ROOT/supabase/migrations/0049_produce_structured_session_foundation.sql"
run_sql "behavioural verification" \
  "$ROOT/supabase/tests/produce_0049_verification.sql"

echo "==> produce_0049: OK"
