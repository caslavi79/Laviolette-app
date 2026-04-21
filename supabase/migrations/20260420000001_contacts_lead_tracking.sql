-- =============================================================
-- 20260420000001_contacts_lead_tracking.sql
-- Lead lifecycle tracking on the contacts table.
--
-- Adds a dedicated `stage` field (distinct from the existing `status`
-- party_status enum) so leads can have richer lifecycle values —
-- 'proposal' and 'dead' aren't expressible in the current enum, and
-- widening the enum would force every downstream consumer to revalidate.
-- A plain text column + CHECK is safer.
--
-- Also adds the supporting fields needed to detect stale follow-ups:
-- lead_source, last_contacted_at, next_touch_at, lead_notes.
-- v_stale_leads consolidates the stale-rule logic in one place so the
-- Today alerts panel and any future UI query the same definition.
-- =============================================================

-- ----- additive columns -----
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS stage              text        NOT NULL DEFAULT 'lead';
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS lead_source        text;
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS last_contacted_at  timestamptz;
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS next_touch_at      date;
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS lead_notes         text;

-- Named CHECK constraint so the allowed-values set is easy to evolve.
ALTER TABLE public.contacts DROP CONSTRAINT IF EXISTS contacts_stage_check;
ALTER TABLE public.contacts
  ADD CONSTRAINT contacts_stage_check
  CHECK (stage IN ('lead','proposal','active','past','dead'));

-- Index supports the Contacts screen filter chips. Cheap — table is tiny,
-- but documents the access pattern.
CREATE INDEX IF NOT EXISTS contacts_stage_idx ON public.contacts (stage);

-- ----- COMMENTs (per project convention — every column documented) -----
COMMENT ON COLUMN public.contacts.stage IS
  'Lead lifecycle stage. Separate from `status` (party_status enum) so we can express proposal + dead without widening the enum. Values: lead, proposal, active, past, dead.';
COMMENT ON COLUMN public.contacts.lead_source IS
  'Free-text provenance for how the lead arrived. Examples: "referral — Dustin", "cold DM", "walk-in". Intentionally unconstrained so Case can describe real-world origins.';
COMMENT ON COLUMN public.contacts.last_contacted_at IS
  'Timestamp of the most recent outbound or inbound touch. Used by v_stale_leads to decide whether a lead has gone cold. Bumped by the "Log touch" button in EditContactModal.';
COMMENT ON COLUMN public.contacts.next_touch_at IS
  'Optional scheduled next follow-up date. If set and in the past, lead is stale regardless of last_contacted_at.';
COMMENT ON COLUMN public.contacts.lead_notes IS
  'Lead-context notes, distinct from the general `notes` column. Kept separate so lifecycle commentary does not pollute long-term contact notes.';

-- ----- backfill -----
-- Any contact that owns an active client / brand / project / contract is
-- presumed active. Everything else is a lead, with last_contacted_at
-- anchored to created_at so the 14-day stale rule has something to bite
-- against on the very first query.

UPDATE public.contacts c
SET stage = 'active'
WHERE stage = 'lead' AND (
  EXISTS (SELECT 1 FROM public.clients cl WHERE cl.contact_id = c.id AND cl.status = 'active')
  OR EXISTS (
    SELECT 1 FROM public.clients cl
    JOIN public.brands b ON b.client_id = cl.id
    WHERE cl.contact_id = c.id AND b.status = 'active'
  )
  OR EXISTS (
    SELECT 1 FROM public.clients cl
    JOIN public.brands b ON b.client_id = cl.id
    JOIN public.projects p ON p.brand_id = b.id
    WHERE cl.contact_id = c.id AND p.status = 'active'
  )
  OR EXISTS (
    SELECT 1 FROM public.clients cl
    JOIN public.contracts ct ON ct.client_id = cl.id
    WHERE cl.contact_id = c.id AND ct.status IN ('signed','active')
  )
);

UPDATE public.contacts
SET last_contacted_at = created_at
WHERE stage = 'lead' AND last_contacted_at IS NULL;

-- ----- v_stale_leads view -----
-- Single source of truth for "which leads have gone cold?". Consumed by:
--   - Today.jsx alerts panel (the primary trigger for Case noticing)
--   - Contacts.jsx sort-by-stale
-- Stale rule:
--   stage IN ('lead','proposal') AND (
--     (next_touch_at set AND in the past)
--     OR
--     (next_touch_at unset AND last_contacted_at older than 14 days or null)
--   )

DROP VIEW IF EXISTS public.v_stale_leads;

CREATE VIEW public.v_stale_leads
  WITH (security_invoker = true)
  AS
SELECT
  c.id                                       AS contact_id,
  c.name,
  c.stage,
  c.next_touch_at,
  c.last_contacted_at,
  CASE
    WHEN c.last_contacted_at IS NULL THEN NULL
    ELSE (CURRENT_DATE - c.last_contacted_at::date)
  END                                        AS days_since_contact,
  CASE
    WHEN c.next_touch_at IS NOT NULL AND c.next_touch_at < CURRENT_DATE THEN 'overdue_touch'
    ELSE 'no_activity'
  END                                        AS reason
FROM public.contacts c
WHERE c.stage IN ('lead','proposal')
  AND (
    (c.next_touch_at IS NOT NULL AND c.next_touch_at < CURRENT_DATE)
    OR (
      c.next_touch_at IS NULL
      AND (c.last_contacted_at IS NULL OR c.last_contacted_at < (NOW() - INTERVAL '14 days'))
    )
  );

-- security_invoker = true means the view runs with the caller's rights,
-- so the existing authenticated_all RLS policy on contacts governs access.
-- Explicit GRANT is still required for PostgREST to expose the view.
GRANT SELECT ON public.v_stale_leads TO authenticated;
GRANT SELECT ON public.v_stale_leads TO service_role;

COMMENT ON VIEW public.v_stale_leads IS
  'Stale lead detector. Returns contacts in stage lead/proposal whose next_touch_at is overdue OR (no next_touch_at AND last_contacted_at older than 14 days or null). Single source of truth used by the Today alerts panel and the Contacts screen sort.';
