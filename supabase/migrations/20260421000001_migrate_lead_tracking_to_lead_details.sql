-- =============================================================
-- 20260421000001_migrate_lead_tracking_to_lead_details.sql
--
-- Retire the thin lead-tracking columns that were added to `contacts`
-- in 20260420000001 (stage, lead_source, last_contacted_at,
-- next_touch_at, lead_notes) and migrate to the richer `lead_details`
-- table that already existed from 20260415000006_tables_pipeline.sql.
--
-- Why:  lead_details has typed enums (lead_stage / lead_source /
-- lead_temperature), a FK to contacts with ON DELETE CASCADE, and
-- additional pipeline fields (scope_summary, deck_url, quoted_amount,
-- quoted_recurring, temperature, next_step, lost_reason) that the
-- thin contacts.* columns don't express. Running two sources of
-- truth for lead lifecycle state would guarantee drift.
--
-- Preserved: the Contacts UX built in 95c740c (stage pill, stale
-- badge, filter chips, Log touch, Today stale widget) — it now
-- reads/writes lead_details instead of contacts.*.
--
-- Not changed: contacts.status (party_status enum: lead/active/past).
-- That column has legitimate non-lead uses and stays.
-- =============================================================

DO $$
DECLARE
  pre_count     int;
  post_count    int;
  inserted      int;
BEGIN
  -- Only run the backfill if the source columns still exist. On a re-
  -- run of this migration after the columns were dropped, skip cleanly.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'contacts' AND column_name = 'stage'
  ) THEN
    EXECUTE $sql$
      SELECT COUNT(*)::int FROM public.contacts
      WHERE stage IN ('lead','proposal','dead')
    $sql$ INTO pre_count;
    RAISE NOTICE 'Pre-backfill: % contacts rows in-pipeline (stage IN lead/proposal/dead)', pre_count;

    -- Backfill. ON CONFLICT DO NOTHING preserves any lead_details rows
    -- that already have richer data (Nicole James, Viktoriia Jones were
    -- populated manually 2026-04-20 with scope_summary + next_step).
    EXECUTE $sql$
      INSERT INTO public.lead_details (
        contact_id, stage, source, referred_by,
        last_contact_date, next_follow_up, notes
      )
      SELECT
        c.id AS contact_id,
        CASE c.stage
          WHEN 'lead'     THEN 'initial_contact'::lead_stage
          WHEN 'proposal' THEN 'quoted'::lead_stage
          WHEN 'dead'     THEN 'lost'::lead_stage
        END AS stage,
        CASE
          WHEN c.lead_source IS NULL THEN NULL::lead_source
          WHEN lower(trim(c.lead_source)) = 'referral'      THEN 'referral'::lead_source
          WHEN lower(trim(c.lead_source)) = 'website_form'  THEN 'website_form'::lead_source
          WHEN lower(trim(c.lead_source)) = 'cold_outreach' THEN 'cold_outreach'::lead_source
          WHEN lower(trim(c.lead_source)) = 'instagram_dm'  THEN 'instagram_dm'::lead_source
          WHEN lower(trim(c.lead_source)) = 'phone_call'    THEN 'phone_call'::lead_source
          -- Free-text with a space reads as "referral — Dustin" / a
          -- person's name. Store the prose in referred_by so it is not
          -- lost, then anchor source to 'referral'.
          WHEN position(' ' IN trim(c.lead_source)) > 0 THEN 'referral'::lead_source
          ELSE 'other'::lead_source
        END AS source,
        CASE
          WHEN c.lead_source IS NULL THEN NULL
          WHEN lower(trim(c.lead_source)) IN (
            'referral','website_form','cold_outreach','instagram_dm','phone_call'
          ) THEN NULL
          WHEN position(' ' IN trim(c.lead_source)) > 0 THEN c.lead_source
          ELSE NULL
        END AS referred_by,
        c.last_contacted_at::date AS last_contact_date,
        c.next_touch_at           AS next_follow_up,
        NULLIF(trim(c.lead_notes), '') AS notes
      FROM public.contacts c
      WHERE c.stage IN ('lead','proposal','dead')
      ON CONFLICT (contact_id) DO NOTHING
    $sql$;
    GET DIAGNOSTICS inserted = ROW_COUNT;
    RAISE NOTICE 'Inserted % new lead_details rows (others preserved via ON CONFLICT DO NOTHING)', inserted;

    SELECT COUNT(*)::int FROM public.lead_details INTO post_count;
    RAISE NOTICE 'Post-backfill: % total lead_details rows', post_count;
  ELSE
    RAISE NOTICE 'Backfill skipped: contacts.stage column not present (migration already applied).';
  END IF;
END $$;

-- ----- Drop the old view (it references columns we are about to drop) -----
DROP VIEW IF EXISTS public.v_stale_leads;

-- ----- Drop the duplicate columns + index + check constraint on contacts -----
ALTER TABLE public.contacts DROP CONSTRAINT IF EXISTS contacts_stage_check;
DROP INDEX IF EXISTS public.contacts_stage_idx;

ALTER TABLE public.contacts DROP COLUMN IF EXISTS stage;
ALTER TABLE public.contacts DROP COLUMN IF EXISTS lead_source;
ALTER TABLE public.contacts DROP COLUMN IF EXISTS last_contacted_at;
ALTER TABLE public.contacts DROP COLUMN IF EXISTS next_touch_at;
ALTER TABLE public.contacts DROP COLUMN IF EXISTS lead_notes;

-- ----- Rebuild v_stale_leads against lead_details -----
-- Stale rule:
--   lead_details.stage NOT IN ('lost','ready_to_sign') AND (
--     (next_follow_up IS NOT NULL AND next_follow_up < today)
--     OR
--     (next_follow_up IS NULL AND (last_contact_date IS NULL OR
--                                  last_contact_date < today - 14d))
--   )
--
-- 'lost'           → pipeline terminated
-- 'ready_to_sign'  → actively closing, no follow-up needed
-- Everything else is a live lead that should be surfaced if it goes
-- cold. reason is 'overdue_touch' when the scheduled follow-up date
-- is past, 'never_contacted' when no touch has ever been logged,
-- else 'no_activity' for the 14-day passive-decay case.
CREATE VIEW public.v_stale_leads
  WITH (security_invoker = true)
  AS
SELECT
  ld.contact_id,
  c.name,
  ld.stage::text AS stage,
  CASE
    WHEN ld.last_contact_date IS NULL THEN NULL
    ELSE (CURRENT_DATE - ld.last_contact_date)::int
  END AS days_since_contact,
  ld.next_follow_up,
  CASE
    WHEN ld.next_follow_up IS NOT NULL AND ld.next_follow_up < CURRENT_DATE THEN 'overdue_touch'
    WHEN ld.last_contact_date IS NULL THEN 'never_contacted'
    ELSE 'no_activity'
  END AS reason
FROM public.lead_details ld
JOIN public.contacts c ON c.id = ld.contact_id
WHERE ld.stage NOT IN ('lost','ready_to_sign')
  AND (
    (ld.next_follow_up IS NOT NULL AND ld.next_follow_up < CURRENT_DATE)
    OR (
      ld.next_follow_up IS NULL
      AND (ld.last_contact_date IS NULL OR ld.last_contact_date < CURRENT_DATE - INTERVAL '14 days')
    )
  );

GRANT SELECT ON public.v_stale_leads TO authenticated;
GRANT SELECT ON public.v_stale_leads TO service_role;

COMMENT ON VIEW public.v_stale_leads IS
  'Stale lead detector. Returns lead_details rows (joined to contacts for name) whose next_follow_up is overdue OR whose last_contact_date is unset / older than 14 days, excluding stages lost + ready_to_sign. reason is overdue_touch | never_contacted | no_activity. Consumed by the Today alerts panel and the Contacts screen sort. security_invoker honors the caller''s RLS.';
