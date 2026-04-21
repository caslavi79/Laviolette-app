-- =============================================================
-- 20260416000001_stripe_events_idempotency.sql
-- Adds stripe_events_processed for webhook idempotency, and a
-- period_month column on invoices for reliable retainer-invoice
-- month-idempotency (replaces the fragile due_date-in-month check).
-- =============================================================

-- ----- stripe_events_processed -----
CREATE TABLE IF NOT EXISTS public.stripe_events_processed (
  event_id       text         PRIMARY KEY,
  event_type     text         NOT NULL,
  livemode       boolean      NOT NULL DEFAULT true,
  processed_at   timestamptz  NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.stripe_events_processed IS
  'Idempotency guard for the stripe-webhook edge function. Each Stripe event.id is recorded here on first-touch so duplicate deliveries (Stripe retries) are no-op''d. Prune rows older than ~90 days periodically.';
COMMENT ON COLUMN public.stripe_events_processed.event_id IS 'Stripe event.id (evt_...). PRIMARY KEY.';
COMMENT ON COLUMN public.stripe_events_processed.event_type IS 'Stripe event.type (invoice.paid, etc).';
COMMENT ON COLUMN public.stripe_events_processed.livemode IS 'Stripe livemode boolean from the event. Default true (we run on live).';
COMMENT ON COLUMN public.stripe_events_processed.processed_at IS 'When our webhook recorded the first handle.';

CREATE INDEX IF NOT EXISTS idx_stripe_events_processed_time
  ON public.stripe_events_processed(processed_at);

-- RLS: single-user app pattern
ALTER TABLE public.stripe_events_processed ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "authenticated_all" ON public.stripe_events_processed;
CREATE POLICY "authenticated_all" ON public.stripe_events_processed
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- ----- invoices.period_month -----
-- The existing generate-retainer-invoices function tried to key idempotency off
-- `due_date falling within the current calendar month`. In practice retainers
-- have due_date = 1st of the FOLLOWING month (e.g. April run creates an invoice
-- due May 1), which breaks that check and would silently create duplicates on
-- any cron misfire. Using an explicit period_month column makes the check
-- deterministic and trivial to reason about.
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS period_month date;

COMMENT ON COLUMN public.invoices.period_month IS
  'For recurring/retainer invoices: the first day of the calendar month the invoice BELONGS to (not the due_date). E.g. the May 2026 retainer invoice has period_month=''2026-05-01''. Used as the idempotency key by generate-retainer-invoices so re-runs in the same month do not duplicate. NULL for one-off invoices.';

-- Partial unique: one retainer invoice per (project, period_month) when set
CREATE UNIQUE INDEX IF NOT EXISTS invoices_project_period_month_unique
  ON public.invoices(project_id, period_month)
  WHERE period_month IS NOT NULL;

-- Backfill period_month for existing retainer invoices based on due_date.
-- Retainer invoices in this app have due_date = 1st of the month they're FOR,
-- per the import-signed-contracts + generate-retainer-invoices conventions.
UPDATE public.invoices i
SET period_month = date_trunc('month', i.due_date::timestamptz)::date
FROM public.projects p
WHERE i.project_id = p.id
  AND p.type = 'retainer'
  AND i.period_month IS NULL;
