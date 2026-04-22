-- 20260422000005_backfill_comments_and_cron_active.sql
--
-- Three repair items from audit 2026-04-22:
--
-- 1. Backfill 11 missing COMMENTs on columns of recent tables
--    (health_checks, monthly_recaps, work_log). Case's `\d+`-driven
--    inspection expects every column to have a COMMENT; migrations
--    20260420000003/5/6 shipped partial coverage. Audit A10 HIGH.
--
-- 2. Update projects.status COMMENT to reflect the `scheduled` enum
--    value added in 20260422000003. Previous text described the
--    pre-scheduled lifecycle; kept working but misleading to
--    readers inspecting the schema. Audit A10 HIGH + A3 LOW.
--
-- 3. Update health_checks.source COMMENT to drop the `"self"` value
--    that was documented but never emitted (health/index.ts
--    detectSource only returns 'uptimerobot' or 'manual'). Audit
--    A7 MEDIUM.
--
-- 4. Extend public.get_last_cron_runs() to expose `active` so
--    /health can skip deactivated jobs when computing stale_crons.
--    Rolls in the auto-push deactivation (Commit 64dd603) cleanly —
--    without this, the two disabled auto-push crons would be
--    incorrectly flagged stale 25h after their last run. Audit
--    2026-04-22 follow-up flagged in Commit 3405d1a commit message.
--
-- Idempotent — COMMENT ON COLUMN and CREATE OR REPLACE FUNCTION
-- both accept re-application without state change.

BEGIN;

-- ====================================================================
-- (1) Backfill 11 missing column COMMENTs
-- ====================================================================

COMMENT ON COLUMN public.health_checks.id IS
  'UUID primary key. Auto-generated via gen_random_uuid().';
COMMENT ON COLUMN public.health_checks.checked_at IS
  'Timestamp of the probe. Set by the /health edge function at request time (not the default now()) so the recorded value matches the response body.';

COMMENT ON COLUMN public.monthly_recaps.id IS
  'UUID primary key. Auto-generated via gen_random_uuid().';
COMMENT ON COLUMN public.monthly_recaps.project_id IS
  'FK → projects(id). Retainer projects only — buildouts never generate recaps. ON DELETE CASCADE removes draft/sent recaps if the project is deleted.';
COMMENT ON COLUMN public.monthly_recaps.brand_id IS
  'FK → brands(id). Denormalized for easy filtering (e.g. "all recaps for Citrus and Salt"); enforced consistent with project.brand_id.';
COMMENT ON COLUMN public.monthly_recaps.generated_at IS
  'Timestamp the generate-monthly-recaps edge function inserted the row. Null only for legacy/manually-crafted rows; normal flow always stamps this.';
COMMENT ON COLUMN public.monthly_recaps.approved_at IS
  'Timestamp Case clicked "Approve" in the Recaps tab. NULL until approval. Set atomically with status=''approved''. send-monthly-recap also stamps this on direct send from draft (skip-approve path).';
COMMENT ON COLUMN public.monthly_recaps.sent_at IS
  'Timestamp send-monthly-recap fired. NULL until sent. Set atomically with status=''sent'' + sent_to_email. 409 is returned on re-send attempts.';

COMMENT ON COLUMN public.work_log.id IS
  'UUID primary key. Auto-generated via gen_random_uuid().';
COMMENT ON COLUMN public.work_log.created_at IS
  'Row insertion timestamp. Distinct from performed_at (which is the work timestamp; created_at is the logging timestamp).';
COMMENT ON COLUMN public.work_log.updated_at IS
  'Updated by trg_work_log_updated_at BEFORE UPDATE trigger on any mutation.';

-- ====================================================================
-- (2) Refresh projects.status COMMENT for the scheduled enum addition
-- ====================================================================

COMMENT ON COLUMN public.projects.status IS
  'Lifecycle: draft → scheduled → active → paused | complete | cancelled. ''scheduled'' = signed but start_date > today; flipped to ''active'' by advance-contract-status cron when start_date arrives. contract-sign routes new signs to scheduled vs active based on start_date comparison in CT.';

-- ====================================================================
-- (3) Correct health_checks.source enum COMMENT
-- ====================================================================

COMMENT ON COLUMN public.health_checks.source IS
  'Source of the probe — either ''uptimerobot'' (User-Agent contains that substring) or ''manual'' (curl, dashboard, deploy scripts). No other values are emitted — the health/index.ts detectSource function over-returns ''manual'' rather than guess for unknown UAs.';

-- ====================================================================
-- (4) Extend get_last_cron_runs to expose `active` for /health filtering
-- ====================================================================

-- DROP + CREATE (not CREATE OR REPLACE) because the return TABLE
-- signature changed (new `active` column). Postgres rejects
-- CREATE OR REPLACE for signature changes.
DROP FUNCTION IF EXISTS public.get_last_cron_runs();

CREATE FUNCTION public.get_last_cron_runs()
 RETURNS TABLE(jobname text, last_run timestamp with time zone, last_status text, last_return_message text, active boolean)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'cron', 'pg_catalog'
AS $function$
  SELECT DISTINCT ON (j.jobname)
    j.jobname,
    jrd.end_time AS last_run,
    jrd.status AS last_status,
    jrd.return_message AS last_return_message,
    j.active
  FROM cron.job j
  LEFT JOIN cron.job_run_details jrd ON jrd.jobid = j.jobid
  WHERE j.jobname LIKE 'laviolette_%'
  ORDER BY j.jobname, jrd.end_time DESC NULLS LAST;
$function$;

COMMENT ON FUNCTION public.get_last_cron_runs() IS
  'Returns last-run info for every laviolette_* cron job. `active` column (added 2026-04-22 migration 20260422000005) lets /health skip deactivated jobs when computing stale_crons — prevents false-positive staleness alerts for jobs intentionally turned off via cron.alter_job.';

COMMIT;
