-- =============================================================
-- 20260415000007_indexes.sql
-- Performance indexes for the queries listed in the design spec.
-- =============================================================

-- Invoices: status filters, due-date scans, client rollups
CREATE INDEX IF NOT EXISTS idx_invoices_status
  ON public.invoices(status)
  WHERE status IN ('pending', 'overdue');

CREATE INDEX IF NOT EXISTS idx_invoices_due_date
  ON public.invoices(due_date);

CREATE INDEX IF NOT EXISTS idx_invoices_client
  ON public.invoices(client_id);

-- Deliverables: progress queries per project
CREATE INDEX IF NOT EXISTS idx_deliverables_project_status
  ON public.deliverables(project_id, status);

-- Retainer tasks: week/month lookups per brand
CREATE INDEX IF NOT EXISTS idx_retainer_tasks_period
  ON public.retainer_tasks(brand_id, period_start, status);

-- Daily rounds: scans by date + brand
CREATE INDEX IF NOT EXISTS idx_daily_rounds_date
  ON public.daily_rounds(date, brand_id);

-- Expenses: reporting
CREATE INDEX IF NOT EXISTS idx_expenses_date
  ON public.expenses(date);

CREATE INDEX IF NOT EXISTS idx_expenses_category
  ON public.expenses(category);

-- Projects: per-brand filters
CREATE INDEX IF NOT EXISTS idx_projects_brand_status
  ON public.projects(brand_id, status);

-- Schedule
CREATE INDEX IF NOT EXISTS idx_schedule_template_day
  ON public.schedule_template(day_of_week);

CREATE INDEX IF NOT EXISTS idx_schedule_overrides_date
  ON public.schedule_overrides(date);

-- Leads: pipeline views filter out lost
CREATE INDEX IF NOT EXISTS idx_lead_details_stage
  ON public.lead_details(stage)
  WHERE stage != 'lost';

-- Contracts: only active / signed contracts need fast lookup
CREATE INDEX IF NOT EXISTS idx_contracts_status
  ON public.contracts(status)
  WHERE status IN ('signed', 'active');
