-- cron observability helper
-- Exposes a read-only function in the `public` schema that returns the last
-- run status for each laviolette_* cron job. Used by the `health` edge function
-- so Case (or external uptime monitors) can detect stale/failed crons without
-- having to query the `cron` schema directly via pg.
--
-- SECURITY DEFINER so it can read cron.job_run_details (which requires superuser
-- or specific grants). The function is read-only and only returns job status —
-- no data mutation, no secret exposure.

CREATE OR REPLACE FUNCTION public.get_last_cron_runs()
RETURNS TABLE (
  jobname text,
  last_run timestamptz,
  last_status text,
  last_return_message text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = cron, pg_catalog
AS $$
  SELECT DISTINCT ON (j.jobname)
    j.jobname,
    jrd.end_time AS last_run,
    jrd.status AS last_status,
    jrd.return_message AS last_return_message
  FROM cron.job j
  LEFT JOIN cron.job_run_details jrd ON jrd.jobid = j.jobid
  WHERE j.jobname LIKE 'laviolette_%'
  ORDER BY j.jobname, jrd.end_time DESC NULLS LAST;
$$;

GRANT EXECUTE ON FUNCTION public.get_last_cron_runs() TO service_role;

COMMENT ON FUNCTION public.get_last_cron_runs() IS
  'Returns the most recent cron.job_run_details row per laviolette_* job. Read-only. Invoked by the health edge function for uptime monitoring.';
