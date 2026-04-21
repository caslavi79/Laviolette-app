#!/usr/bin/env bash
# Deploy all Supabase Edge Functions for Laviolette.
#
# ALWAYS uses --no-verify-jwt because:
#   - contract-sign: public signing page (no user auth token)
#   - send-reminders, generators: invoked by pg_cron (no user auth)
#   - stripe-webhook: invoked by Stripe (signature-verified, not JWT)
# Without this flag, Supabase silently returns 401 and nothing works.
#
# Requires:
#   - supabase CLI logged in with an account that has access to the
#     Laviolette project. Run `supabase projects list` first to verify.
#   - `supabase link --project-ref sukcufgjptllzucbneuj`
#
# Secrets must be set first (one-time, via dashboard or CLI):
#   npx supabase secrets set \
#     RESEND_API_KEY=re_xxx \
#     STRIPE_SECRET_KEY=sk_live_xxx \
#     STRIPE_WEBHOOK_SECRET=whsec_xxx \
#     BRAND_NAME="Laviolette LLC" \
#     BRAND_FROM_EMAIL=noreply@laviolette.io \
#     BRAND_REPLY_TO=case.laviolette@gmail.com \
#     BRAND_COLOR=#B8845A \
#     BRAND_BG=#12100D \
#     BRAND_INK=#F4F0E8 \
#     BRAND_LOGO_URL=https://laviolette.io/favicon.png \
#     SIGNING_BASE_URL=https://app.laviolette.io/sign \
#     STRIPE_SUCCESS_URL=https://app.laviolette.io/setup-success \
#     STRIPE_CANCEL_URL=https://app.laviolette.io/setup-cancel \
#     CASE_NOTIFY_EMAIL=case.laviolette@gmail.com \
#     APP_URL=https://app.laviolette.io \
#     REMINDERS_SECRET=<long random string>

set -euo pipefail

PROJECT_REF="sukcufgjptllzucbneuj"

FUNCTIONS=(
  contract-send
  contract-sign
  create-setup-session
  create-stripe-invoice
  stripe-webhook
  send-reminders
  generate-retainer-invoices
  generate-daily-rounds
  check-overdue-invoices
  advance-contract-status
  auto-push-invoices
  generate-monthly-recaps
  send-monthly-recap
)

echo "════════════════════════════════════════════"
echo " Deploying edge functions to Laviolette"
echo " Project: $PROJECT_REF"
echo "════════════════════════════════════════════"

i=0
total=${#FUNCTIONS[@]}
for fn in "${FUNCTIONS[@]}"; do
  i=$((i + 1))
  echo ""
  echo "  [$i/$total] Deploying $fn …"
  npx supabase functions deploy "$fn" \
    --project-ref "$PROJECT_REF" \
    --no-verify-jwt
done

echo ""
echo "✓ All $total functions deployed."
echo ""
echo "Next: schedule cron jobs with supabase/sql/cron-schedule.sql"
echo "      (apply via psql or Supabase SQL Editor)"
