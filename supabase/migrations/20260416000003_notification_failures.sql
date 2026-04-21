-- notification_failures: dead-letter for Resend email failures.
--
-- The stripe-webhook notifyCase() helper, contract-sign's confirmation emails,
-- and auto-push-invoices' client notifications all fire fire-and-forget: a
-- Resend outage or bad address is logged to Deno console and then lost. For a
-- solo operator, "check the function logs" isn't a realistic UX. This table
-- gives Case a queryable backstop — missed notifications accumulate here until
-- he dismisses them or retries.

CREATE TABLE IF NOT EXISTS public.notification_failures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('internal', 'client', 'contract_sign_confirmation')),
  context text NOT NULL,
  subject text,
  to_email text,
  error text NOT NULL,
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolution text CHECK (resolution IN ('retried', 'dismissed'))
);

CREATE INDEX IF NOT EXISTS notification_failures_unresolved_idx
  ON public.notification_failures (created_at DESC)
  WHERE resolved_at IS NULL;

-- Single-user app — authenticated_all policy matches every other table.
ALTER TABLE public.notification_failures ENABLE ROW LEVEL SECURITY;
CREATE POLICY authenticated_all ON public.notification_failures
  FOR ALL TO authenticated
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE public.notification_failures IS
  'Dead-letter queue for failed Resend sends. Rows accumulate when Resend is unreachable, bad address, rate-limited, etc. Case reviews/dismisses via app.';
COMMENT ON COLUMN public.notification_failures.kind IS
  'internal = notifyCase HQ alert. client = invoice/receipt/paid email to client. contract_sign_confirmation = signer/case confirmation on signed contract.';
COMMENT ON COLUMN public.notification_failures.context IS
  'Caller-supplied tag identifying the specific event (e.g. stripe-webhook:notify-case:paid:LV-2026-003). Useful for dedupe.';
COMMENT ON COLUMN public.notification_failures.payload IS
  'Full params (from, subject, html, to, reply_to) for manual replay via the Resend API.';
COMMENT ON COLUMN public.notification_failures.resolved_at IS
  'Set when Case dismisses or retries successfully. Null = unresolved. Partial index above only covers unresolved rows.';
COMMENT ON COLUMN public.notification_failures.resolution IS
  'How the row was resolved: retried (re-sent and delivered) or dismissed (ignored).';
