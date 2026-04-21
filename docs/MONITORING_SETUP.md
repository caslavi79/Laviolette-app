# External Monitoring Setup (UptimeRobot Free Tier)

> **STATUS: LIVE as of 2026-04-21**
> - Monitor active, pinging every 5 minutes
> - Email alerts → case.laviolette@gmail.com (verified with test alert)
> - Public status page: https://stats.uptimerobot.com/muAd17CfnU
> - Account email: case.laviolette@gmail.com (Google sign-in)
>
> The instructions below are preserved for reference / future re-setup. If you need to modify the monitor, log into uptimerobot.com with the Google account above.

UptimeRobot pings `/health` every 5 minutes and emails you on failure. Free
tier is sufficient.

## Setup steps

1. Sign up at [uptimerobot.com](https://uptimerobot.com) — free tier, no
   credit card.
2. Dashboard → **Add New Monitor**.
3. Configure monitor:
   - **Monitor Type:** HTTPS
   - **Friendly Name:** `Laviolette HQ Health`
   - **URL:**
     `https://sukcufgjptllzucbneuj.supabase.co/functions/v1/health`
   - **Monitoring Interval:** 5 minutes (free-tier minimum)
   - **Monitor Timeout:** 30 seconds
4. **Alert Contacts:**
   - Add `case.laviolette@gmail.com` as an alert contact.
   - Verify the contact via the email UptimeRobot sends.
5. Assign the alert contact to the monitor.
6. **Recommended:** enable the 2-failure confirmation window
   (Settings → "Send notification when down for at least 2 failed checks").
   This avoids false positives from brief deploy blips.

## Gmail notifications (critical)

The alert email is only useful if you see it fast. On your phone:

- **iOS:** Settings → Notifications → Gmail → Allow Notifications ON, Sounds
  ON, Badges ON, Lock Screen ON.
- **Gmail app:** Settings → Notifications → All new mail.

## Verification

Alert flow verified 2026-04-21:

- UptimeRobot dashboard → monitor → **Test Alert Contacts** triggered.
- Test email arrived in `case.laviolette@gmail.com` within ~30 seconds.
- Phone push notification received.

## Example healthy response

```bash
curl https://sukcufgjptllzucbneuj.supabase.co/functions/v1/health
```

```json
{
  "ok": true,
  "checked_at": "2026-04-20T21:00:00Z",
  "stale_crons": [],
  "unresolved_dlq_count": 0,
  "deploy_sha": "abc1234",
  "message": "All systems green.",
  "response_ms": 143
}
```

## Example unhealthy response

```json
{
  "ok": false,
  "checked_at": "2026-04-20T21:00:00Z",
  "stale_crons": [
    { "jobname": "laviolette_auto_push_invoices", "last_run": "...", "hours_ago": 26.3 }
  ],
  "unresolved_dlq_count": 0,
  "deploy_sha": "abc1234",
  "message": "Stale: laviolette_auto_push_invoices last ran 26h ago.",
  "response_ms": 156
}
```

The `message` field is what surfaces in the UptimeRobot alert email subject
preview. See `INCIDENTS.md` for what to do when you see it.

## Upgrade path (not now)

If email alerts prove too slow or you miss one in real conditions, upgrade to:

- **UptimeRobot Pro** (~$7/mo) for 1-minute intervals + SMS.
- **Better Stack** (~$18/mo) for faster SMS and richer dashboard.

Switch is a matter of adding a new monitor in a different dashboard — no app
code changes required.
