-- =============================================================
-- 20260422000002_invoices_pending_sent_date_partial_index.sql
-- Partial index on the (status, sent_date) tuple, scoped to pending rows
-- only (the vast majority of other-status rows don't match any query that
-- uses this predicate). Supports:
--   * contract-sign's auto-send-pending-invoices loop
--   * send-invoice's sent_date IS NULL idempotency read
--   * the unified-onboarding idempotency COUNT query in contract-sign
-- Non-blocking create (small table, instant). Idempotent.
-- =============================================================

CREATE INDEX IF NOT EXISTS idx_invoices_status_sent_date_pending
  ON public.invoices (status, sent_date)
  WHERE status = 'pending';

COMMENT ON INDEX public.idx_invoices_status_sent_date_pending IS
  'Partial index supporting hot-path reads of (project_id, status=pending, sent_date IS NULL) used by contract-sign, send-invoice, and unified-onboarding idempotency checks. Partial on status=pending because other statuses do not use this predicate shape.';
