-- =============================================================
-- cron-schedule.sql
-- Schedules Edge Functions via pg_cron. Apply once after deploying
-- the functions. Uses pg_net.http_post to invoke.
--
-- Prerequisites:
--   1. pg_cron extension enabled (Studio → Database → Extensions)
--   2. pg_net extension enabled (same place)
--   3. REMINDERS_SECRET set as a Supabase Vault secret OR inlined below
--   4. All edge functions deployed
--
-- Timezone note: pg_cron runs in UTC. The specific schedules below
-- are set for America/Chicago (Central Time) since all current clients
-- are in Austin, TX. Shift offsets if you move TZ or serve other regions.
-- =============================================================

-- Drop existing schedules if re-running
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname LIKE 'laviolette_%';

-- Helper to read REMINDERS_SECRET from Vault (set via dashboard Vault section).
-- If you don't use Vault, substitute the literal string below.
DO $$
DECLARE
  v_secret text := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'REMINDERS_SECRET' LIMIT 1);
  v_base   text := 'https://sukcufgjptllzucbneuj.supabase.co/functions/v1';
  v_key    text;
BEGIN
  IF v_secret IS NULL THEN
    RAISE NOTICE 'REMINDERS_SECRET not found in vault; using empty string (unauthenticated).';
    v_secret := '';
  END IF;
  v_key := CASE WHEN v_secret = '' THEN '' ELSE '?key=' || v_secret END;

  -- Early morning CT — generate today's daily rounds for active retainers.
  -- Uses 06:01 UTC so it's past midnight CT in BOTH seasons:
  --   CDT (summer, UTC-5): 01:01 AM CDT ✓
  --   CST (winter, UTC-6): 00:01 AM CST ✓
  -- (The previous `1 5 * * *` fired at 11:01 PM CST the previous day — wrong.)
  PERFORM cron.schedule(
    'laviolette_generate_daily_rounds',
    '1 6 * * *',
    format($cron$SELECT net.http_post(url := '%s/generate-daily-rounds%s', headers := '{"Content-Type":"application/json"}'::jsonb)$cron$, v_base, v_key)
  );

  -- Daily at 21:05 UTC (= 4:05 PM CDT / 3:05 PM CST) — auto-push invoices whose
  -- business-day-before-due-date is today. Per Case's 2026-04-16 spec:
  -- "Fire at 4:00 PM CT on the business day before the contractual pay date."
  -- Rationale: (1) well inside Stripe's 8pm CT same-day ACH submission cutoff,
  -- (2) client's bank shows the debit on the contractual pay date, (3) minimizes
  -- client visibility of the pending debit during their morning banking check.
  -- NOTE: pg_cron runs in UTC. This schedule targets CDT (summer); in CST (winter)
  -- it fires at 3:05 PM CT, still comfortably within the cutoff. No DST handling.
  PERFORM cron.schedule(
    'laviolette_auto_push_invoices',
    '5 21 * * *',
    format($cron$SELECT net.http_post(url := '%s/auto-push-invoices%s', headers := '{"Content-Type":"application/json"}'::jsonb)$cron$, v_base, v_key)
  );

  -- Retry pass 1 hour after primary — catches any invoice that failed on first attempt
  -- (API errors, rate limits) or where the client submitted bank info between the
  -- primary fire and now. Idempotent — skips invoices that already have a PI.
  PERFORM cron.schedule(
    'laviolette_auto_push_invoices_retry',
    '5 22 * * *',
    format($cron$SELECT net.http_post(url := '%s/auto-push-invoices%s', headers := '{"Content-Type":"application/json"}'::jsonb)$cron$, v_base, v_key)
  );

  -- Daily 06:00 CT (= 11:00 UTC) — flip pending/sent invoices past due_date to 'overdue'
  PERFORM cron.schedule(
    'laviolette_check_overdue',
    '0 11 * * *',
    format($cron$SELECT net.http_post(url := '%s/check-overdue-invoices%s', headers := '{"Content-Type":"application/json"}'::jsonb)$cron$, v_base, v_key)
  );

  -- Daily 06:05 CT (= 11:05 UTC) — advance contract statuses (signed→active on effective_date, active→expired on end_date)
  PERFORM cron.schedule(
    'laviolette_advance_contracts',
    '5 11 * * *',
    format($cron$SELECT net.http_post(url := '%s/advance-contract-status%s', headers := '{"Content-Type":"application/json"}'::jsonb)$cron$, v_base, v_key)
  );

  -- Daily 09:15 CT (= 14:15 UTC) — morning reminders digest email
  PERFORM cron.schedule(
    'laviolette_send_reminders_am',
    '15 14 * * *',
    format($cron$SELECT net.http_post(url := '%s/send-reminders%s', headers := '{"Content-Type":"application/json"}'::jsonb)$cron$, v_base, v_key)
  );

  -- Weekday 09:00 CDT / 08:00 CST (= 14:00 UTC) — fire-day reminder email.
  -- Human-in-the-loop pattern: warn Case on days when invoices are eligible to
  -- fire so he can manually click "Fire now" in the app. Auto-push at 4:05 PM
  -- still runs as the safety net — any invoice Case already manually fired
  -- gets skipped by auto-push's claim predicate. Mon-Fri only because ACH
  -- doesn't settle on weekends (fire dates never fall on Sat/Sun).
  PERFORM cron.schedule(
    'laviolette_fire_day_reminder',
    '0 14 * * 1-5',
    format($cron$SELECT net.http_post(url := '%s/fire-day-reminder%s', headers := '{"Content-Type":"application/json"}'::jsonb)$cron$, v_base, v_key)
  );

  -- 1st of each month, early morning CT — generate retainer invoice drafts.
  -- Same rationale as generate_daily_rounds above: 06:01 UTC lands on day 1
  -- in both CDT (01:01 AM) and CST (00:01 AM). The previous `1 5 1 * *`
  -- fired at 11:01 PM on the last day of the previous month in winter,
  -- causing invoices to target the wrong month.
  PERFORM cron.schedule(
    'laviolette_retainer_invoices',
    '1 6 1 * *',
    format($cron$SELECT net.http_post(url := '%s/generate-retainer-invoices%s', headers := '{"Content-Type":"application/json"}'::jsonb)$cron$, v_base, v_key)
  );

  -- 1st of each month at 13:00 UTC (= 08:00 CST / 07:00 CDT) —
  -- generate draft client-facing monthly recaps. Minor DST drift is
  -- acceptable: this is a "sometime before Case's morning coffee"
  -- job, not time-critical like auto-push or fire-day-reminder.
  PERFORM cron.schedule(
    'laviolette_generate_monthly_recaps',
    '0 13 1 * *',
    format($cron$SELECT net.http_post(url := '%s/generate-monthly-recaps%s', headers := '{"Content-Type":"application/json"}'::jsonb)$cron$, v_base, v_key)
  );
END $$;

-- Verify
SELECT jobname, schedule, active FROM cron.job WHERE jobname LIKE 'laviolette_%' ORDER BY jobname;
