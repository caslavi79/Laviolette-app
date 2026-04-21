-- =============================================================
-- 20260420000004_work_log_count_column.sql
-- Adds a `count` column to work_log so the monthly recap can
-- aggregate quantities ("23 posts this month") rather than just
-- narrative titles. Also updates v_work_log_monthly to surface
-- SUM(count) alongside entry_count.
-- =============================================================

-- Existing rows get count=1 (one entry = one thing happened). Future
-- entries can increment for batch work ("3 GBP posts" → count=3).
ALTER TABLE public.work_log
  ADD COLUMN IF NOT EXISTS count integer NOT NULL DEFAULT 1;

ALTER TABLE public.work_log DROP CONSTRAINT IF EXISTS work_log_count_range_check;
ALTER TABLE public.work_log
  ADD CONSTRAINT work_log_count_range_check
  CHECK (count >= 1 AND count <= 1000);

COMMENT ON COLUMN public.work_log.count IS
  'Quantity scalar for batch entries. 1 for a single event ("Drafted Mothers Day promo"), N>1 for grouped events ("Responded to 5 reviews" → count=5). Sums into monthly recap totals. Range 1–1000.';

-- Rebuild v_work_log_monthly to surface SUM(count). Views can't be
-- altered with a new column in Postgres — drop + recreate. Wrapped in
-- a transaction so concurrent readers either see the old view or the
-- new one, never a gap where the name is unresolvable.
--
-- NOTE: this migration was already applied in production (2026-04-21)
-- before the transaction wrap was added. The checksum-tracking runner
-- (scripts/apply-migrations.mjs) blocks re-applying a modified file —
-- but if this ever runs against a fresh environment the BEGIN/COMMIT
-- makes it safe. Production is already correct.
BEGIN;

DROP VIEW IF EXISTS public.v_work_log_monthly;

CREATE VIEW public.v_work_log_monthly
  WITH (security_invoker = true)
  AS
SELECT
  brand_id,
  service_id,
  date_trunc('month', performed_at)  AS month,
  count(*)                           AS entry_count,
  coalesce(sum(count), 0)::bigint    AS total_count,
  min(performed_at)                  AS first_entry_at,
  max(performed_at)                  AS last_entry_at
FROM public.work_log
GROUP BY brand_id, service_id, date_trunc('month', performed_at);

COMMIT;

GRANT SELECT ON public.v_work_log_monthly TO authenticated;
GRANT SELECT ON public.v_work_log_monthly TO service_role;

COMMENT ON VIEW public.v_work_log_monthly IS
  'Monthly aggregation of work_log entries per brand + service + month. entry_count = number of rows; total_count = SUM(count) for batch-aware totals. Feeds the monthly recap generator.';
