-- =============================================================
-- 20260420000003_work_log.sql
-- Activity log for retainer work. Case logs what he did per brand
-- (and optionally per service) so a future monthly-recap feature
-- can aggregate it into client-facing emails. The spec named the
-- service FK target `services(id)`; the actual table is
-- `retainer_services` and that's what we reference — no separate
-- `services` table exists.
-- =============================================================

CREATE TABLE IF NOT EXISTS public.work_log (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id      uuid         NOT NULL REFERENCES public.brands(id) ON DELETE CASCADE,
  service_id    uuid         REFERENCES public.retainer_services(id) ON DELETE SET NULL,
  title         text         NOT NULL CHECK (length(trim(title)) > 0 AND length(title) <= 200),
  notes         text         CHECK (notes IS NULL OR length(notes) <= 2000),
  link_url      text,
  performed_at  timestamptz  NOT NULL DEFAULT now(),
  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now(),
  -- Clients' and Case's clocks can drift — allow a small future skew
  -- so a phone with a fast clock doesn't silently reject entries.
  CHECK (performed_at <= now() + INTERVAL '1 hour')
);

CREATE INDEX IF NOT EXISTS idx_work_log_brand_performed
  ON public.work_log (brand_id, performed_at DESC);

CREATE INDEX IF NOT EXISTS idx_work_log_service_performed
  ON public.work_log (service_id, performed_at DESC)
  WHERE service_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_work_log_performed
  ON public.work_log (performed_at DESC);

-- Single-user app — matches every other table's policy.
ALTER TABLE public.work_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS work_log_authenticated_all ON public.work_log;
CREATE POLICY work_log_authenticated_all ON public.work_log
  FOR ALL TO authenticated
  USING (true)
  WITH CHECK (true);

-- Reuse the shared update_updated_at() function attached to every
-- other updated_at-bearing table (defined in migration
-- 20260415000009_functions_triggers.sql).
DROP TRIGGER IF EXISTS trg_work_log_set_updated_at ON public.work_log;
CREATE TRIGGER trg_work_log_set_updated_at
  BEFORE UPDATE ON public.work_log
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

COMMENT ON TABLE public.work_log IS
  'Activity log: one row per piece of retainer work Case performed. Foundation for the monthly client-recap feature. Mobile-first quick-log from the Today screen populates this table.';
COMMENT ON COLUMN public.work_log.brand_id IS
  'Required. Every entry is scoped to a brand so recaps can be generated per-brand without joins through project hierarchy.';
COMMENT ON COLUMN public.work_log.service_id IS
  'Optional FK to retainer_services. Entries without a service are classified as "General" in the recap. Uses ON DELETE SET NULL so entries survive when a service is retired.';
COMMENT ON COLUMN public.work_log.title IS
  'Short human-readable description. Max 200 chars. Example titles: "Published 2 GBP posts", "Responded to 3 new reviews".';
COMMENT ON COLUMN public.work_log.notes IS
  'Optional longer-form notes. Max 2000 chars.';
COMMENT ON COLUMN public.work_log.link_url IS
  'Optional URL for a related artifact (post, review, page). UI validates http/https prefix; malformed URLs are stripped on save rather than blocking.';
COMMENT ON COLUMN public.work_log.performed_at IS
  'When the work was done (not when the log entry was created). Defaults to now(). Used for monthly grouping.';

-- ----- v_work_log_monthly view -----
-- Aggregation surface for the monthly-recap feature. security_invoker
-- means the caller's RLS on work_log applies.
DROP VIEW IF EXISTS public.v_work_log_monthly;

CREATE VIEW public.v_work_log_monthly
  WITH (security_invoker = true)
  AS
SELECT
  brand_id,
  service_id,
  date_trunc('month', performed_at)  AS month,
  count(*)                           AS entry_count,
  min(performed_at)                  AS first_entry_at,
  max(performed_at)                  AS last_entry_at
FROM public.work_log
GROUP BY brand_id, service_id, date_trunc('month', performed_at);

GRANT SELECT ON public.v_work_log_monthly TO authenticated;
GRANT SELECT ON public.v_work_log_monthly TO service_role;

COMMENT ON VIEW public.v_work_log_monthly IS
  'Monthly aggregation of work_log entries, grouped by brand + service + month. Feeds the client-facing monthly recap email. Null service_id groups under "General" at the UI layer.';
