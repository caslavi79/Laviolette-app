-- =============================================================
-- 20260422000004_project_status_scheduled_backfill.sql
-- Companion to 20260422000003 (which adds the 'scheduled' value).
-- Flips signed-but-future-start projects from 'active' → 'scheduled'
-- to match the new lifecycle semantics.
--
-- Predicate scope:
--   * status = 'active' — only rows that got the over-eager Batch D
--     (commit aae3f52) flip on contract-sign; don't touch draft,
--     paused, complete, cancelled.
--   * start_date > current_date — future-start only; projects with
--     start_date <= today stay 'active' (they're correctly active).
--   * start_date IS NOT NULL — null-start projects can't be decided
--     without operator input; leave them alone.
--
-- Affected rows (as of 2026-04-21):
--   3 — Dustin's 3 retainers: Citrus and Salt Retainer, Vice Downtown
--   Bryan Retainer, West End Elixir Retainer (all start_date=2026-05-01).
--   Citrus and Salt Buildout has start_date=2026-04-15 (already past),
--   so the `>` comparison excludes it — correctly stays 'active' (the
--   engagement started Apr 15; only its invoice LV-2026-001 is pending,
--   fire_date 2026-04-30, which is a separate concern from project status).
--   Nicole + Viktoriia projects have start_date=today; the `>` comparison
--   excludes them — they correctly stay 'active'.
--   Exodus 1414 is status='draft' with null start_date — untouched.
-- =============================================================

UPDATE public.projects
   SET status = 'scheduled',
       updated_at = now()
 WHERE status = 'active'
   AND start_date IS NOT NULL
   AND start_date > current_date;

-- Sanity report (visible in apply-migrations output if anyone's watching):
DO $$
DECLARE
  v_scheduled_count int;
  v_active_count    int;
  v_draft_count     int;
BEGIN
  SELECT COUNT(*) INTO v_scheduled_count FROM public.projects WHERE status = 'scheduled';
  SELECT COUNT(*) INTO v_active_count    FROM public.projects WHERE status = 'active';
  SELECT COUNT(*) INTO v_draft_count     FROM public.projects WHERE status = 'draft';
  RAISE NOTICE 'project_status counts after backfill: scheduled=%, active=%, draft=%', v_scheduled_count, v_active_count, v_draft_count;
END $$;
