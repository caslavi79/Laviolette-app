-- =============================================================
-- 20260415000013_missing_comments.sql
-- Fills in COMMENTs on the trivial id/created_at/updated_at/notes
-- columns that were skipped on seven tables in migration 08.
-- =============================================================

-- daily_rounds
COMMENT ON COLUMN public.daily_rounds.id IS 'Primary key.';
COMMENT ON COLUMN public.daily_rounds.created_at IS 'Row creation timestamp.';

-- schedule_template
COMMENT ON COLUMN public.schedule_template.id IS 'Primary key.';
COMMENT ON COLUMN public.schedule_template.created_at IS 'Row creation timestamp.';
COMMENT ON COLUMN public.schedule_template.updated_at IS 'Row last-updated timestamp.';

-- schedule_overrides
COMMENT ON COLUMN public.schedule_overrides.id IS 'Primary key.';
COMMENT ON COLUMN public.schedule_overrides.created_at IS 'Row creation timestamp.';

-- contracts
COMMENT ON COLUMN public.contracts.id IS 'Primary key.';
COMMENT ON COLUMN public.contracts.notes IS 'Freeform notes on the contract.';
COMMENT ON COLUMN public.contracts.created_at IS 'Row creation timestamp.';
COMMENT ON COLUMN public.contracts.updated_at IS 'Row last-updated timestamp.';

-- invoices
COMMENT ON COLUMN public.invoices.id IS 'Primary key.';
COMMENT ON COLUMN public.invoices.created_at IS 'Row creation timestamp.';
COMMENT ON COLUMN public.invoices.updated_at IS 'Row last-updated timestamp.';

-- expenses
COMMENT ON COLUMN public.expenses.id IS 'Primary key.';
COMMENT ON COLUMN public.expenses.notes IS 'Freeform notes on the expense.';
COMMENT ON COLUMN public.expenses.created_at IS 'Row creation timestamp.';
COMMENT ON COLUMN public.expenses.updated_at IS 'Row last-updated timestamp.';

-- lead_details
COMMENT ON COLUMN public.lead_details.id IS 'Primary key.';
COMMENT ON COLUMN public.lead_details.notes IS 'Freeform notes on the lead.';
COMMENT ON COLUMN public.lead_details.created_at IS 'Row creation timestamp.';
COMMENT ON COLUMN public.lead_details.updated_at IS 'Row last-updated timestamp.';
