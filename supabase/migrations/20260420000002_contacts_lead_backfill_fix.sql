-- =============================================================
-- 20260420000002_contacts_lead_backfill_fix.sql
-- Tighten the stage='active' backfill from the previous migration.
--
-- brand.status defaults to 'active' on row creation, so ANY contact with
-- a brand shell got swept into stage='active' in 20260420000001, even if
-- the underlying client was still a lead (Cody Welch, Nicole James,
-- Viktoriia Jones all have default-active brand shells under lead
-- clients). The authoritative signals of an active engagement are:
--
--   - clients.status = 'active'                       (explicit lifecycle flip)
--   - projects.status = 'active'                      (work actively scheduled)
--   - contracts.status IN ('signed','active')         (money flowing)
--
-- Brand status='active' is NOT a reliable signal and is dropped. This
-- migration reverts over-classified contacts back to 'lead' and anchors
-- last_contacted_at so the 14-day stale rule bites.
-- =============================================================

UPDATE public.contacts c
SET stage = 'lead'
WHERE c.stage = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM public.clients cl WHERE cl.contact_id = c.id AND cl.status = 'active'
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.clients cl
    JOIN public.brands b ON b.client_id = cl.id
    JOIN public.projects p ON p.brand_id = b.id
    WHERE cl.contact_id = c.id AND p.status = 'active'
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.clients cl
    JOIN public.contracts ct ON ct.client_id = cl.id
    WHERE cl.contact_id = c.id AND ct.status IN ('signed','active')
  );

UPDATE public.contacts
SET last_contacted_at = created_at
WHERE stage = 'lead' AND last_contacted_at IS NULL;
