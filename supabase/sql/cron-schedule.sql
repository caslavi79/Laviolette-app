-- =============================================================
-- cron-schedule.sql
-- Schedules Edge Functions via pg_cron. Apply once after deploying
-- the functions. Uses pg_net.http_post to invoke.
--
-- Prerequisites:
--   1. pg_cron extension enabled (Studio → Database → Extensions)
--   2. pg_net extension enabled (same place)
--   3. REMINDERS_SECRET set as a Supabase Vault secret OR below
--   4. All edge functions deployed
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

  -- Daily 00:01 MT = 06:01 UTC — generate today's daily rounds
  PERFORM cron.schedule(
    'laviolette_generate_daily_rounds',
    '1 6 * * *',
    format($cron$SELECT net.http_post(url := '%s/generate-daily-rounds%s', headers := '{"Content-Type":"application/json"}'::jsonb)$cron$, v_base, v_key)
  );

  -- Daily 06:00 MT = 12:00 UTC — overdue flag + status advance + morning digest
  PERFORM cron.schedule(
    'laviolette_check_overdue',
    '0 12 * * *',
    format($cron$SELECT net.http_post(url := '%s/check-overdue-invoices%s', headers := '{"Content-Type":"application/json"}'::jsonb)$cron$, v_base, v_key)
  );
  PERFORM cron.schedule(
    'laviolette_advance_contracts',
    '5 12 * * *',
    format($cron$SELECT net.http_post(url := '%s/advance-contract-status%s', headers := '{"Content-Type":"application/json"}'::jsonb)$cron$, v_base, v_key)
  );
  PERFORM cron.schedule(
    'laviolette_send_reminders_am',
    '15 15 * * *',   -- 09:15 MT
    format($cron$SELECT net.http_post(url := '%s/send-reminders%s', headers := '{"Content-Type":"application/json"}'::jsonb)$cron$, v_base, v_key)
  );

  -- 1st of each month 00:01 MT — generate retainer invoices
  PERFORM cron.schedule(
    'laviolette_retainer_invoices',
    '1 6 1 * *',
    format($cron$SELECT net.http_post(url := '%s/generate-retainer-invoices%s', headers := '{"Content-Type":"application/json"}'::jsonb)$cron$, v_base, v_key)
  );
END $$;

-- Verify
SELECT jobname, schedule, active FROM cron.job WHERE jobname LIKE 'laviolette_%' ORDER BY jobname;
