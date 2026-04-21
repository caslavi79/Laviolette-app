-- =============================================================
-- 20260422000001_invoice_bank_link_url.sql
-- Adds invoices.bank_link_url to support the unified onboarding
-- flow (feature-flagged). When ENABLE_UNIFIED_ONBOARDING=true and
-- a buildout contract is signed, contract-sign synthesizes an
-- invoice and a Stripe Checkout session for bank-linking, stores
-- the session URL here, and passes it to send-invoice so the
-- client receives ONE email with both the invoice document and a
-- "Link your bank to pay" CTA.
--
-- Retainer invoices + pre-existing rows leave this NULL. The
-- send-invoice template renders the CTA only when non-null, so
-- today's behavior is bit-for-bit unchanged until the flag flips.
--
-- No backfill. No index (low cardinality, small table, never queried
-- by this column). No RLS change (existing authenticated_all covers it).
-- =============================================================

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS bank_link_url text;

COMMENT ON COLUMN public.invoices.bank_link_url IS
  'Stripe Checkout session URL (setup mode) for the client to link their bank account. Populated by contract-sign under the unified onboarding flow when a buildout contract is signed. NULL for retainer invoices and for any invoice created before the unified flow was enabled. Stripe sessions expire 24 hours after creation; the Money tab "Regenerate bank-link" button creates a fresh session and overwrites this column when the original expires.';
