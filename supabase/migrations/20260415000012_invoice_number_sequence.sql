-- =============================================================
-- 20260415000012_invoice_number_sequence.sql
-- Helper function to generate LV-{YEAR}-{NNN} invoice numbers.
-- Sequence resets per calendar year.
-- =============================================================

CREATE OR REPLACE FUNCTION public.next_invoice_number()
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_year int := EXTRACT(YEAR FROM CURRENT_DATE)::int;
  v_next int;
BEGIN
  -- Look at the max sequence number used for this year and add 1.
  SELECT COALESCE(MAX((regexp_replace(invoice_number, '^LV-\d{4}-', ''))::int), 0) + 1
  INTO v_next
  FROM public.invoices
  WHERE invoice_number ~ ('^LV-' || v_year::text || '-\d+$');

  RETURN format('LV-%s-%s', v_year::text, LPAD(v_next::text, 3, '0'));
END;
$$;

COMMENT ON FUNCTION public.next_invoice_number IS
  'Returns the next free LV-YYYY-NNN invoice number for the current calendar year. Sequence resets each year. Small race window on concurrent inserts — fine for a single-user app.';
