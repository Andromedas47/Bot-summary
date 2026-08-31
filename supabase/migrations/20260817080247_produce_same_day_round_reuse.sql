-- One seller/market/business-date is ONE accountability round, even when the
-- withdrawal is entered as several plain `เบิก` documents.
--
-- Production evidence, business date 2026-08-16
-- ---------------------------------------------
-- Operators routinely enter one withdrawal round in sections:
--
--     มิ้น-ทรัพย์พัน เบิก 16/8/2569      (3 durian rows,  3,810)
--     จบรายการเบิก
--     ... later the same day, sometimes from another LINE account ...
--     มิ้น-ทรัพย์พัน เบิก 16/8/2569      (13 dry-good rows, 4,320)
--     จบรายการเบิก
--
-- That is one seller accountability round of 16 rows / 8,130 THB. The deployed
-- contract minted a SECOND populated round for the second document, because
-- `p_is_new_round = true` went straight to INSERT. The day then had two masters,
-- and the evening `ชั่งคืน` had two rounds to choose from — which is also how
-- `ambiguous` refusals start appearing on returns that are perfectly valid.
--
-- The same shape is visible in still-open rounds for จิ้ว, ขวัญ and เมย์ on
-- 2026-08-16: an empty round from an earlier attempt beside the populated one.
--
-- What changes
-- ------------
-- Only the `p_is_new_round = true` path, and only its choice between binding and
-- creating:
--
--   0 populated open matching rounds -> create, exactly as before
--   1 populated open matching round  -> BIND to it (this is the fix)
--   > 1                              -> `ambiguous`, create nothing
--
-- "Matching" is the same business identity discovery already uses for returns:
-- source_type/source_id, business date, normalized seller, reviewed market
-- identity (`accountability_round_same_market`, never raw label equality), and
-- status = 'open'. "Populated" means the round holds at least one persisted
-- `เบิก` transaction — an empty round left behind by a failed attempt can never
-- make an otherwise unique populated round ambiguous, and can never be reused as
-- a master either.
--
-- The LINE sender is deliberately NOT part of the key. Cross-user continuation
-- is already the intended contract (migration 20260814100000); a second section
-- typed by a different staff member is the same business round.
--
-- What does NOT change
-- --------------------
--   * `เบิกเพิ่ม` stays an explicit append (`p_is_new_round = false`). Nothing
--     here weakens it.
--   * The near-match market guard (migration 20260815160000) still runs first
--     and still fails closed on an unreviewed spelling variant.
--   * Reviewed markets the catalog keeps apart (พาซิโอ้ผัก vs พาซิโอ้ผลไม้)
--     are different `market_code`s, so they never match each other here.
--   * The creator-scoped retry cleanup at the end is untouched.
--   * `prevent_accountability_round_rebind` and every other write-once
--     accountability guard are untouched. This function only ever assigns a
--     round to a pending generation that is choosing one for the first time.
--
-- Signature-preserving: same 10 parameters, same jsonb shape. The result gains
-- one additive key, `reused`, for observability. Forward-only; no historical
-- round is created, merged, cancelled or rewritten.

BEGIN;

DO $preflight$
BEGIN
  IF to_regprocedure('public.bind_plain_text_accountability_round(text,uuid,text,text,text,date,text,text,text,boolean)') IS NULL THEN
    RAISE EXCEPTION 'P4A plain-text round binding is missing (migration 20260815160000 is not applied)';
  END IF;
  IF to_regprocedure('public.accountability_round_same_market(text,text)') IS NULL
     OR to_regprocedure('public.accountability_round_market_near_match(text,text)') IS NULL THEN
    RAISE EXCEPTION 'reviewed market identity functions are missing';
  END IF;
END;
$preflight$;

-- Reissued in full from 20260815160000 — Postgres replaces a function as a whole
-- unit, not as a diff — with exactly the two changes marked below.
CREATE OR REPLACE FUNCTION public.bind_plain_text_accountability_round(
  p_session_key             text,
  p_session_generation      uuid,
  p_source_type             text,
  p_source_id               text,
  p_line_user_id            text,
  p_business_date           date,
  p_seller_label            text,
  p_market_label            text,
  p_market_label_normalized text,
  p_is_new_round            boolean
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_pending    public.pending_sessions%ROWTYPE;
  v_round      public.accountability_rounds%ROWTYPE;
  v_near       public.accountability_rounds%ROWTYPE;
  v_candidates uuid[];
  v_round_id   uuid;
  v_reused     boolean := false;
  v_seller     text := public.accountability_round_normalize(p_seller_label);
  v_market     text := public.accountability_round_normalize(p_market_label_normalized);
  v_creation_key text :=
    'plaintext:' || btrim(p_session_key) || ':' || p_session_generation::text;
BEGIN
  IF p_session_key IS NULL OR btrim(p_session_key) = ''
     OR p_session_generation IS NULL
     OR p_source_type NOT IN ('user', 'group', 'room')
     OR p_source_id IS NULL OR btrim(p_source_id) = ''
     OR p_line_user_id IS NULL OR btrim(p_line_user_id) = ''
     OR p_business_date IS NULL
     OR v_seller = '' OR v_market = '' THEN
    RAISE EXCEPTION 'P4A: invalid plain-text round binding identity';
  END IF;

  SELECT * INTO v_pending
  FROM public.pending_sessions
  WHERE session_key = p_session_key
    AND session_generation = p_session_generation
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  IF v_pending.source_id IS DISTINCT FROM btrim(p_source_id)
     OR v_pending.line_user_id IS DISTINCT FROM btrim(p_line_user_id) THEN
    RETURN jsonb_build_object('outcome', 'identity_mismatch');
  END IF;

  -- Replays trust the pending generation's explicit round, but continuations
  -- no longer require that round's creator to be the current LINE actor.
  IF v_pending.accountability_round_id IS NOT NULL THEN
    SELECT * INTO v_round
    FROM public.accountability_rounds
    WHERE id = v_pending.accountability_round_id
    FOR UPDATE;
    IF FOUND
       AND v_round.status = 'open'
       AND v_round.source_type = p_source_type
       AND v_round.source_id = btrim(p_source_id)
       AND v_round.business_date = p_business_date
       AND public.accountability_round_normalize(v_round.seller_label) = v_seller
       AND (
         -- CHANGE 1. A new-round document used to be recognised as already
         -- bound ONLY to a round it minted itself. A reused round was minted by
         -- an earlier generation, so that test can never hold for it and the
         -- replay would fall through and mint a second round after all. A round
         -- holding a persisted withdrawal master is exactly what a continuation
         -- is allowed to bind to, whichever document type asks.
         (p_is_new_round
          AND (
            (v_round.owner_line_user_id = btrim(p_line_user_id)
             AND v_round.created_line_event_id = v_creation_key)
            OR EXISTS (
              SELECT 1
              FROM public.produce_transactions t
              WHERE t.accountability_round_id = v_round.id
                AND t.base_transaction_type = 'เบิก'
            )
          ))
         OR
         (NOT p_is_new_round AND EXISTS (
           SELECT 1
           FROM public.produce_transactions t
           WHERE t.accountability_round_id = v_round.id
             AND t.base_transaction_type = 'เบิก'
         ))
       )
    THEN
      IF public.accountability_round_same_market(v_round.market_label_normalized, v_market) THEN
        RETURN jsonb_build_object(
          'outcome', 'already_bound',
          'accountability_round_id', v_round.id,
          'market_label', v_round.market_label
        );
      END IF;
      IF NOT p_is_new_round THEN
        RETURN jsonb_build_object(
          'outcome', 'market_mismatch',
          'accountability_round_id', v_round.id,
          'market_label', v_round.market_label
        );
      END IF;
    END IF;
  END IF;

  IF p_is_new_round THEN
    -- Serialize the create-or-reuse decision for this business identity.
    --
    -- Two `เบิก` documents closing seconds apart would otherwise each look for a
    -- populated round, each find none (neither has persisted its transactions
    -- yet), and each mint one. The key folds reviewed market spellings onto a
    -- single lock through `accountability_round_market_code`, so พาซีโอ้ and
    -- พาซิโอ้ contend rather than proceeding in parallel. The lock is held for
    -- the transaction, released on commit, and is taken AFTER the pending row
    -- lock above, so two racers can never form a cycle.
    PERFORM pg_advisory_xact_lock(hashtextextended(
      p_source_type || ':' || btrim(p_source_id) || ':' || p_business_date::text
        || ':' || v_seller || ':'
        || COALESCE(public.accountability_round_market_code(v_market), v_market),
      0
    ));

    -- The near-match guard, before anything is minted.
    --
    -- Skipped entirely when this generation's creation key already resolves: a
    -- replay, an out-of-order redelivery or a second close of the SAME document
    -- must stay idempotent, and re-guarding it would refuse a round this
    -- generation legitimately owns.
    IF NOT EXISTS (
      SELECT 1 FROM public.accountability_rounds
      WHERE created_line_event_id = v_creation_key
    ) THEN
      SELECT * INTO v_near
      FROM public.accountability_rounds r
      WHERE r.status = 'open'
        AND r.source_type = p_source_type
        AND r.source_id = btrim(p_source_id)
        AND r.business_date = p_business_date
        AND public.accountability_round_normalize(r.seller_label) = v_seller
        AND NOT public.accountability_round_same_market(r.market_label_normalized, v_market)
        AND public.accountability_round_market_near_match(r.market_label_normalized, v_market)
        -- Two markets the reviewed catalog knows and keeps apart are already a
        -- decided question. ต้อม runs พาซิโอ้ผัก, พาซิโอ้ผลไม้ and
        -- พาซิโอ้ทุเรียน in one group; asking him to confirm each one daily
        -- would be a confident wrong answer, not a guard.
        AND NOT (
          public.accountability_round_market_code(r.market_label_normalized) IS NOT NULL
          AND public.accountability_round_market_code(v_market) IS NOT NULL
        )
        -- Only a round holding real business content can shadow a new one. An
        -- empty round left behind by a blocked-then-retried withdrawal has
        -- nothing to protect, and the existing retry cleanup below retires it.
        AND EXISTS (
          SELECT 1
          FROM public.produce_transactions t
          WHERE t.accountability_round_id = r.id
            AND t.base_transaction_type = 'เบิก'
        )
      ORDER BY r.created_at, r.id
      LIMIT 1;

      IF FOUND THEN
        RETURN jsonb_build_object(
          'outcome', 'market_near_match',
          'accountability_round_id', v_near.id,
          'market_label', v_near.market_label
        );
      END IF;

      -- CHANGE 2. Same-day continuation.
      --
      -- A plain `เบิก` for a business identity that ALREADY has a populated open
      -- round is another section of that round, not a new one. The lookup is the
      -- same one discovery uses for returns, minus the creator: same source,
      -- business date, normalized seller, reviewed market identity, open, and
      -- holding a persisted withdrawal master.
      --
      -- More than one populated round is not a choice this function is allowed
      -- to make. It refuses, an administrator retires the round that is not the
      -- authority, and the document is re-sent.
      SELECT array_agg(r.id ORDER BY r.created_at, r.id) INTO v_candidates
      FROM public.accountability_rounds r
      WHERE r.status = 'open'
        AND r.source_type = p_source_type
        AND r.source_id = btrim(p_source_id)
        AND r.business_date = p_business_date
        AND public.accountability_round_normalize(r.seller_label) = v_seller
        AND public.accountability_round_same_market(r.market_label_normalized, v_market)
        AND EXISTS (
          SELECT 1
          FROM public.produce_transactions t
          WHERE t.accountability_round_id = r.id
            AND t.base_transaction_type = 'เบิก'
        );

      IF array_length(v_candidates, 1) > 1 THEN
        RETURN jsonb_build_object('outcome', 'ambiguous');
      END IF;

      -- Second tier, and ONLY when no populated round exists: a round that is
      -- still empty but already reserved by a live pending generation.
      --
      -- This is what closes the concurrency case. Under the advisory lock the
      -- first document has already created and bound its round even though its
      -- transactions are not committed yet, so the second one can see the
      -- reservation and join it instead of minting a rival.
      --
      -- It is deliberately the LOWER tier. Production 2026-08-16 has จิ้ว with
      -- one empty round held by a stranded generation beside the populated round
      -- carrying the day's 21 withdrawal rows; the populated round must win that
      -- comparison outright rather than making the pair ambiguous.
      IF v_candidates IS NULL OR array_length(v_candidates, 1) IS NULL THEN
        SELECT array_agg(r.id ORDER BY r.created_at, r.id) INTO v_candidates
        FROM public.accountability_rounds r
        WHERE r.status = 'open'
          AND r.source_type = p_source_type
          AND r.source_id = btrim(p_source_id)
          AND r.business_date = p_business_date
          AND public.accountability_round_normalize(r.seller_label) = v_seller
          AND public.accountability_round_same_market(r.market_label_normalized, v_market)
          AND EXISTS (
            SELECT 1
            FROM public.pending_sessions p
            WHERE p.accountability_round_id = r.id
              AND p.terminalized = false
          );

        IF array_length(v_candidates, 1) > 1 THEN
          RETURN jsonb_build_object('outcome', 'ambiguous');
        END IF;
      END IF;

      IF array_length(v_candidates, 1) = 1 THEN
        SELECT * INTO v_round
        FROM public.accountability_rounds
        WHERE id = v_candidates[1]
        FOR UPDATE;
        v_round_id := v_round.id;
        v_reused := true;
      END IF;
    END IF;

    IF v_round_id IS NULL THEN
      INSERT INTO public.accountability_rounds (
        source_type, source_id, owner_line_user_id, business_date,
        seller_label, market_label, market_label_normalized,
        created_line_event_id
      ) VALUES (
        p_source_type, btrim(p_source_id), btrim(p_line_user_id), p_business_date,
        v_seller, public.accountability_round_normalize(p_market_label), v_market,
        v_creation_key
      )
      ON CONFLICT (created_line_event_id) DO NOTHING;

      SELECT * INTO v_round
      FROM public.accountability_rounds
      WHERE created_line_event_id = v_creation_key
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'P4A: plain-text round creation key % did not resolve', v_creation_key;
      END IF;
      IF v_round.source_type IS DISTINCT FROM p_source_type
         OR v_round.source_id IS DISTINCT FROM btrim(p_source_id)
         OR v_round.owner_line_user_id IS DISTINCT FROM btrim(p_line_user_id)
         OR v_round.business_date IS DISTINCT FROM p_business_date
         OR public.accountability_round_normalize(v_round.seller_label) IS DISTINCT FROM v_seller
         OR v_round.market_label_normalized IS DISTINCT FROM v_market THEN
        RAISE EXCEPTION 'P4A: plain-text round creation key was reused with different attributes';
      END IF;
      IF v_round.status <> 'open' THEN
        RAISE EXCEPTION 'P4A: plain-text round creation key belongs to a terminal round';
      END IF;
      v_round_id := v_round.id;
    END IF;
  ELSE
    -- Discovery is business-scoped and accepts only rounds with an active
    -- withdrawal master. Creator identity is deliberately absent.
    SELECT array_agg(r.id ORDER BY r.id) INTO v_candidates
    FROM public.accountability_rounds r
    WHERE r.status = 'open'
      AND r.source_type = p_source_type
      AND r.source_id = btrim(p_source_id)
      AND r.business_date = p_business_date
      AND public.accountability_round_normalize(r.seller_label) = v_seller
      AND public.accountability_round_same_market(r.market_label_normalized, v_market)
      AND EXISTS (
        SELECT 1
        FROM public.produce_transactions t
        WHERE t.accountability_round_id = r.id
          AND t.base_transaction_type = 'เบิก'
      );

    IF v_candidates IS NULL OR array_length(v_candidates, 1) IS NULL THEN
      -- Preserve the existing actionable market-mismatch result only when one
      -- other valid withdrawal round exists for this source/seller/day.
      SELECT array_agg(r.id ORDER BY r.id) INTO v_candidates
      FROM public.accountability_rounds r
      WHERE r.status = 'open'
        AND r.source_type = p_source_type
        AND r.source_id = btrim(p_source_id)
        AND r.business_date = p_business_date
        AND public.accountability_round_normalize(r.seller_label) = v_seller
        AND EXISTS (
          SELECT 1
          FROM public.produce_transactions t
          WHERE t.accountability_round_id = r.id
            AND t.base_transaction_type = 'เบิก'
        );

      IF array_length(v_candidates, 1) = 1 THEN
        SELECT * INTO v_round
        FROM public.accountability_rounds
        WHERE id = v_candidates[1];
        RETURN jsonb_build_object(
          'outcome', 'market_mismatch',
          'accountability_round_id', v_round.id,
          'market_label', v_round.market_label
        );
      END IF;
      RETURN jsonb_build_object('outcome', 'no_round');
    END IF;
    IF array_length(v_candidates, 1) > 1 THEN
      RETURN jsonb_build_object('outcome', 'ambiguous');
    END IF;
    v_round_id := v_candidates[1];
    PERFORM 1 FROM public.accountability_rounds WHERE id = v_round_id FOR UPDATE;
  END IF;

  UPDATE public.pending_sessions
  SET accountability_round_id = v_round_id
  WHERE session_key = p_session_key
    AND session_generation = p_session_generation;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'P4A: plain-text pending generation could not be bound';
  END IF;

  -- Existing retry cleanup remains creator-scoped. It never retires another
  -- operator's round and never changes round ownership.
  IF p_is_new_round THEN
    UPDATE public.accountability_rounds o
    SET status = 'cancelled',
        closed_at = now(),
        closed_line_event_id = v_creation_key
    WHERE o.status = 'open'
      AND o.id <> v_round_id
      AND o.source_type = p_source_type
      AND o.source_id = btrim(p_source_id)
      AND o.owner_line_user_id = btrim(p_line_user_id)
      AND o.business_date = p_business_date
      AND public.accountability_round_normalize(o.seller_label) = v_seller
      AND public.accountability_round_same_market(o.market_label_normalized, v_market)
      AND starts_with(
            o.created_line_event_id,
            'plaintext:' || btrim(p_session_key) || ':'
          )
      AND o.created_line_event_id <> v_creation_key
      AND NOT EXISTS (
        SELECT 1 FROM public.produce_sessions s
        WHERE s.accountability_round_id = o.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.pending_sessions p
        WHERE p.accountability_round_id = o.id
      );
  END IF;

  RETURN jsonb_build_object(
    'outcome', 'bound',
    'reused', v_reused,
    'accountability_round_id', v_round_id,
    'market_label', (
      SELECT market_label FROM public.accountability_rounds WHERE id = v_round_id
    )
  );
END;
$$;

COMMENT ON FUNCTION public.bind_plain_text_accountability_round(
  text, uuid, text, text, text, date, text, text, text, boolean
) IS
  'Binds a plain-text pending generation by source, business date, seller and reviewed market identity. '
  'A plain เบิก opener reuses the single populated open round of that identity instead of minting a '
  'second one, creates a round only when none exists, and returns ambiguous when more than one exists. '
  'The original LINE owner remains audit metadata; continuation actors may differ. '
  'A withdrawal whose market is one character from an existing open withdrawal round of the same '
  'group/date/seller returns market_near_match and creates nothing. Reviewed catalog markets are never '
  'near-matched against each other.';

REVOKE ALL ON FUNCTION public.bind_plain_text_accountability_round(
  text, uuid, text, text, text, date, text, text, text, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bind_plain_text_accountability_round(
  text, uuid, text, text, text, date, text, text, text, boolean
) TO service_role;

COMMIT;
