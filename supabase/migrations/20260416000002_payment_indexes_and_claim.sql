-- Payment correctness: indexes + double-charge race guard
-- Batch 2 audit fixes.
--
-- 1. Indexes on stripe_payment_intent_id and stripe_invoice_id. The webhook looks
--    these up on every payment event; without indexes this is a full table scan
--    on every charge.dispute.created / payment_intent.succeeded. Also used by
--    auto-push-invoices and create-stripe-invoice in their filter predicates.
--
-- 2. Partial unique index on stripe_payment_intent_id WHERE NOT NULL. Prevents
--    two concurrent invoices from landing on the same PI ID (shouldn't happen
--    given Stripe returns unique IDs, but adds defense-in-depth).
--
-- 3. The double-charge race itself (cron + manual button racing to create a PI
--    for the same invoice) is prevented in application code via a conditional
--    UPDATE that only succeeds if stripe_payment_intent_id IS NULL — the first
--    writer wins, the second writer reads rowCount=0 and skips. No DB change
--    needed beyond the indexes; the existing `NULL` check is the lock.

CREATE INDEX IF NOT EXISTS invoices_stripe_payment_intent_id_idx
  ON invoices (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS invoices_stripe_invoice_id_idx
  ON invoices (stripe_invoice_id)
  WHERE stripe_invoice_id IS NOT NULL;

-- Webhook lookups by stripe_customer_id (checkout.session.completed, setup_intent.*)
CREATE INDEX IF NOT EXISTS clients_stripe_customer_id_idx
  ON clients (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

-- Partial uniqueness — two rows should never share the same PaymentIntent.
CREATE UNIQUE INDEX IF NOT EXISTS invoices_stripe_payment_intent_id_unique
  ON invoices (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

COMMENT ON INDEX invoices_stripe_payment_intent_id_idx IS
  'Fast webhook lookup on payment_intent.* events; partial to avoid indexing NULLs.';
COMMENT ON INDEX invoices_stripe_invoice_id_idx IS
  'Fast webhook lookup on legacy invoice.* events; partial to avoid indexing NULLs.';
COMMENT ON INDEX clients_stripe_customer_id_idx IS
  'Fast webhook lookup on bank-setup events (checkout.session.completed, setup_intent.*).';
COMMENT ON INDEX invoices_stripe_payment_intent_id_unique IS
  'Defense-in-depth: prevents two DB rows pointing at the same Stripe PaymentIntent.';
