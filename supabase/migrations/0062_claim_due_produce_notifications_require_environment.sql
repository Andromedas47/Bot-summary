-- 0062: fix PostgREST RPC overload ambiguity introduced by 0061.
--
-- 0061 added claim_due_produce_notifications(p_limit integer DEFAULT 25,
-- p_environment text DEFAULT NULL). Because every parameter on that 2-arg
-- overload has a DEFAULT, a caller that supplies only p_limit is a valid
-- call for BOTH the 1-arg legacy wrapper and the 2-arg scoped function.
-- PostgREST cannot pick a "best candidate" between them and every call
-- started failing in Production with:
--   Could not choose the best candidate function between:
--   public.claim_due_produce_notifications(p_limit => integer)
--   public.claim_due_produce_notifications(p_limit => integer, p_environment => text)
--
-- Fix: p_environment must have no default, so a 1-arg call can never
-- satisfy the scoped function's required parameter and PostgREST resolves
-- unambiguously to the 1-arg legacy wrapper. Postgres requires parameters
-- without a default to precede ones that have a default, so the scoped
-- function's parameter order becomes (p_environment, p_limit). Named-arg
-- RPC calls (what PostgREST and this codebase's supabase.rpc(...) calls
-- always use) are unaffected by declaration order.
--
-- The old (integer, text) overload is dropped and replaced by a new
-- (text, integer) overload — CREATE OR REPLACE cannot do this in place
-- because the argument type order is itself part of the function's
-- identity.

DROP FUNCTION IF EXISTS public.claim_due_produce_notifications(integer, text);

CREATE FUNCTION public.claim_due_produce_notifications(
  p_environment text,
  p_limit       integer DEFAULT 25
)
RETURNS SETOF public.produce_session_notifications
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_environment IS NULL OR p_environment NOT IN ('production', 'preview', 'development') THEN
    RAISE EXCEPTION 'claim_due_produce_notifications: p_environment must be production, preview, or development, got %', p_environment;
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT n.id, n.notification_status AS previous_status
    FROM public.produce_session_notifications n
    WHERE (
      (
        n.notification_status IN ('pending', 'failed')
        AND n.notification_retryable = true
        AND n.next_notification_attempt_at <= now()
      ) OR (
        n.notification_status = 'sending'
        AND n.sending_started_at <= now() - interval '2 minutes'
      )
    )
    AND (
      CASE
        WHEN p_environment = 'production'
          THEN n.runtime_environment = 'production' OR n.runtime_environment IS NULL
        ELSE n.runtime_environment = p_environment
      END
    )
    ORDER BY COALESCE(n.next_notification_attempt_at, n.sending_started_at)
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(p_limit, 1), 100)
  ),
  claimed AS (
    UPDATE public.produce_session_notifications n
    SET notification_status = 'sending',
        notification_attempt_count = n.notification_attempt_count + 1,
        notification_cycle_attempt_count =
          n.notification_cycle_attempt_count + 1,
        last_notification_attempt_at = now(),
        sending_started_at = now(),
        next_notification_attempt_at = NULL,
        updated_at = now()
    FROM candidates c
    WHERE n.id = c.id
    RETURNING n.*
  ),
  attempts AS (
    INSERT INTO public.produce_notification_attempts (
      notification_id,
      attempt_number,
      cycle_attempt_number,
      correlation_id,
      transition_from,
      transition_to,
      attempted_at
    )
    SELECT
      c.id,
      c.notification_attempt_count,
      c.notification_cycle_attempt_count,
      c.correlation_id,
      candidates.previous_status,
      'sending',
      c.last_notification_attempt_at
    FROM claimed c
    JOIN candidates ON candidates.id = c.id
  )
  SELECT claimed.* FROM claimed;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_due_produce_notifications(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_due_produce_notifications(text, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_produce_notifications(text, integer) TO service_role;

-- Legacy 1-arg wrapper — unchanged identity (integer), reissued only because
-- its body must now call the scoped function with named arguments (the
-- scoped function's positional order changed above). Still hardcoded to
-- 'production'; still never dropped mid-rollout.
CREATE OR REPLACE FUNCTION public.claim_due_produce_notifications(
  p_limit integer DEFAULT 25
)
RETURNS SETOF public.produce_session_notifications
LANGUAGE sql
AS $$
  SELECT * FROM public.claim_due_produce_notifications(p_environment => 'production', p_limit => p_limit);
$$;

REVOKE ALL ON FUNCTION public.claim_due_produce_notifications(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_due_produce_notifications(integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_produce_notifications(integer) TO service_role;
