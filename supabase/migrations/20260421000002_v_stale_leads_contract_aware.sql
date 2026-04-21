-- =============================================================
-- 20260421000002_v_stale_leads_contract_aware.sql
--
-- Fix: `v_stale_leads` was surfacing Nicole James as "never-contacted
-- stale lead" hours after she signed a contract + paid $1,700. Root
-- cause: the view reads `lead_details` in isolation and the
-- `lead_stage` enum has no "won/converted" terminal state — only
-- 'lost' for dead, and 'ready_to_sign' for imminent-close. Once a
-- lead actually converts (signs a contract), the `lead_details` row
-- becomes historical but still matches the stale predicate forever.
--
-- This migration replaces the view with a contract-aware version
-- that excludes any `lead_details` row whose underlying contact has
-- any client with a signed/active/complete contract. Non-destructive
-- `CREATE OR REPLACE VIEW` — fully reversible. No impact on
-- `lead_details` rows, no enum changes, no touch to contracts /
-- invoices / payment flow.
--
-- Stale rule (unchanged):
--   stage NOT IN ('lost','ready_to_sign') AND (
--     (next_follow_up IS NOT NULL AND next_follow_up < today)
--     OR
--     (next_follow_up IS NULL AND (last_contact_date IS NULL OR
--                                  last_contact_date < today - 14d))
--   )
--
-- New predicate (the fix):
--   AND NOT EXISTS (contact has ANY signed/active/complete contract)
-- =============================================================

CREATE OR REPLACE VIEW public.v_stale_leads
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
  AND NOT EXISTS (
    -- Exclude contacts who have already converted. Any contract past
    -- the pre-sign states ('draft','sent') means the lead
    -- converted at some point — they're a current or former client,
    -- not an open lead. Covers signed, active, expired, terminated.
    -- This lets the view stay correct without requiring a
    -- "won/converted" value on the lead_stage enum.
    SELECT 1
    FROM public.clients cl
    JOIN public.contracts ct ON ct.client_id = cl.id
    WHERE cl.contact_id = ld.contact_id
      AND ct.status NOT IN ('draft','sent')
  )
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
  'Stale lead detector (contract-aware as of 20260421000002). Returns lead_details rows for contacts who (a) have stage not-lost and not-ready-to-sign, (b) have NO signed/active/complete contract — i.e. have not converted, and (c) match the stale predicate (overdue next_follow_up OR 14+ days since last contact). security_invoker honors the caller''s RLS.';
