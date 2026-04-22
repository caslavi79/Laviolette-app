# Incident Response

> **STATUS: UptimeRobot is LIVE as of 2026-04-21.** Monitor pings
> `/health` every 5 minutes. Email alert flow verified end-to-end
> (test alert arrived at `case.laviolette@gmail.com` within ~30
> seconds). Public status page:
> <https://stats.uptimerobot.com/muAd17CfnU>. Setup details in
> `docs/MONITORING_SETUP.md`.

## When you get a UptimeRobot alert email

An alert email from UptimeRobot means `/health` returned 503 or timed out.
This doc tells you what to do.

## First 30 seconds

1. Open [app.laviolette.io/incidents](https://app.laviolette.io/incidents) on
   your phone.
2. Read the **message** field on the most recent unhealthy row.
3. Identify which cron is stale (if any) or whether DLQ is the issue.

## Common causes & fixes

### `Stale: laviolette_auto_push_invoices`
Most critical. This fires invoice PaymentIntents on the business day before
the due date at 16:05 CT.

- Check last successful run in `pg_cron.job_run_details`.
- If the cron body failed, check edge function logs in the Supabase dashboard.
- Manual recovery: `supabase functions invoke auto-push-invoices`.
- If past 8 PM CT ACH cutoff: contact client, explain, offer wire or next-day
  ACH.

### `Stale: laviolette_fire_day_reminder`
Less critical. The morning email just didn't send. Auto-push at 16:05 is still
the safety net.

- Check function logs; usually a transient Resend or DB blip.
- Safe to ignore if the next day's run succeeds.

### `Stale: laviolette_retainer_invoices`
Monthly, fires on the 1st at 00:01 CT. If stale, upcoming retainers won't have
invoice rows.

- Invoke manually: `supabase functions invoke generate-retainer-invoices`.
- Verify new rows in `invoices` table for the correct month.

### `Stale: laviolette_generate_monthly_recaps`
Monthly, fires on the 1st at 08:00 CT. Non-critical to revenue; manual re-invoke
if needed.

- `supabase functions invoke generate-monthly-recaps`.
- Or hit directly with the cron key — see `scripts/deploy-edge.sh` comments.

### `Stale: laviolette_check_overdue`, `advance_contracts`, `generate_daily_rounds`
Low-priority; fix when convenient.

### `N unresolved notification failures`
Open [/notifications](https://app.laviolette.io/notifications) in the app,
retry each failure, dismiss if legitimate.

## False positives

Deploys of edge functions can cause brief 503s (<30 seconds). UptimeRobot
should be configured with a 2-check confirmation window so it doesn't page on
these. See `docs/MONITORING_SETUP.md`.

## Escalation

You're solo. There is no escalation. The alert email **is** the escalation.
Keep Gmail push notifications on.

## If the entire Supabase project is down

- Check [status.supabase.com](https://status.supabase.com).
- If Supabase status is green and your project is down specifically: open a
  support ticket.
- Clients affected: Dustin (VBTX + Velvet Leaf), any realtor / clothing brand
  clients with pending invoices.
- Communication: text them directly, don't wait.

## Where everything lives

- `/health` endpoint:
  `https://sukcufgjptllzucbneuj.supabase.co/functions/v1/health`
- `health_checks` table: every probe logged here (see `/incidents`).
- `v_health_stats_7d` view: 7-day uptime rollup (feeds Today widget).
- Cron jobs: `supabase/sql/cron-schedule.sql` + `cron.job` table.
- DLQ: `notification_failures` table (UI at `/notifications`).
