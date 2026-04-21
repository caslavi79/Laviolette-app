-- =============================================================
-- 20260420000006_health_checks.sql
-- Time-series log of /health invocations. Populated by the /health
-- edge function fire-and-forget on every hit. Surfaces uptime +
-- incident history on the Today widget and the /incidents route.
--
-- Retention: no automatic cleanup in v1. At 5-minute UptimeRobot
-- ping cadence this grows ~288 rows/day / ~105K rows/year — still
-- trivially fast to query on the indexes below. Revisit if it ever
-- crosses 1M rows.
-- =============================================================

CREATE TABLE IF NOT EXISTS public.health_checks (
  id                     uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  checked_at             timestamptz  NOT NULL DEFAULT now(),
  http_status            integer      NOT NULL,
  healthy                boolean      NOT NULL,
  stale_crons            jsonb,
  unresolved_dlq_count   integer,
  response_ms            integer,
  source                 text
);

CREATE INDEX IF NOT EXISTS idx_health_checks_checked_at
  ON public.health_checks (checked_at DESC);

-- Partial index for fast "last incident" + unhealthy-only filtering.
CREATE INDEX IF NOT EXISTS idx_health_checks_unhealthy
  ON public.health_checks (checked_at DESC)
  WHERE NOT healthy;

ALTER TABLE public.health_checks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS health_checks_authenticated_all ON public.health_checks;
CREATE POLICY health_checks_authenticated_all ON public.health_checks
  FOR ALL TO authenticated
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE public.health_checks IS
  'Append-only log of /health invocations. One row per probe (UptimeRobot, manual curl, self). Feeds the Today "System health" widget + /incidents route.';
COMMENT ON COLUMN public.health_checks.http_status IS
  '200 if healthy, 503 if unhealthy. Matches the status code /health returned for this probe.';
COMMENT ON COLUMN public.health_checks.healthy IS
  'Boolean duplicate of (http_status = 200). Indexed partial-not-healthy for fast incident filtering.';
COMMENT ON COLUMN public.health_checks.stale_crons IS
  'JSONB array of { jobname, last_run, hours_ago } for any cron past its max-gap at check time. Null when probe errored before cron lookup.';
COMMENT ON COLUMN public.health_checks.unresolved_dlq_count IS
  'Count of notification_failures rows with resolved_at IS NULL at check time.';
COMMENT ON COLUMN public.health_checks.response_ms IS
  'Total /health function execution time in milliseconds. Watch for creep — DB queries dominate.';
COMMENT ON COLUMN public.health_checks.source IS
  'Who pinged: "uptimerobot" (User-Agent match), "self" (monitors invoked from cron), or "manual" (everything else — curl, dashboard, etc).';

-- ----- v_health_stats_7d -----
-- Rollup for the Today widget. 7-day rolling window so the value
-- reflects operator-relevant reliability, not a stale long-horizon
-- average.

DROP VIEW IF EXISTS public.v_health_stats_7d;

CREATE VIEW public.v_health_stats_7d
  WITH (security_invoker = true)
  AS
SELECT
  count(*)                                               AS total_checks,
  count(*) FILTER (WHERE healthy)                        AS healthy_checks,
  count(*) FILTER (WHERE NOT healthy)                    AS unhealthy_checks,
  round(100.0 * count(*) FILTER (WHERE healthy) / NULLIF(count(*), 0), 2) AS uptime_pct,
  max(checked_at) FILTER (WHERE NOT healthy)             AS last_incident_at,
  min(checked_at)                                        AS first_check_at
FROM public.health_checks
WHERE checked_at > NOW() - INTERVAL '7 days';

GRANT SELECT ON public.v_health_stats_7d TO authenticated;
GRANT SELECT ON public.v_health_stats_7d TO service_role;

COMMENT ON VIEW public.v_health_stats_7d IS
  '7-day rollup of health_checks for the Today widget. uptime_pct is NULL when there are zero checks in the window (empty state in UI).';
