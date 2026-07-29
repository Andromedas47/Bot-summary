-- Monitor holds advisory gate A until harness writes unlock_gate_a.
SELECT pg_advisory_lock(9100501);
SELECT 'gate_a_held' AS status;

DO $wait$
BEGIN
  WHILE NOT EXISTS (
    SELECT 1 FROM public.p50_sync WHERE k = 'unlock_gate_a'
  ) LOOP
    PERFORM pg_sleep(0.05);
  END LOOP;
END
$wait$;

SELECT pg_advisory_unlock(9100501);
SELECT 'gate_a_released' AS status;
