-- =============================================================
-- 20260415000005_tables_money.sql
-- Contracts, invoices, and expenses.
-- =============================================================

-- ----- contracts -----
CREATE TABLE IF NOT EXISTS public.contracts (
  id                    uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id             uuid             NOT NULL REFERENCES public.clients(id) ON DELETE RESTRICT,
  brand_id              uuid             REFERENCES public.brands(id) ON DELETE RESTRICT,
  project_id            uuid             REFERENCES public.projects(id) ON DELETE RESTRICT,
  name                  text             NOT NULL CHECK (length(trim(name)) > 0),
  type                  contract_type    NOT NULL,
  status                contract_status  NOT NULL DEFAULT 'draft',
  effective_date        date,
  signing_date          date,
  end_date              date,
  monthly_rate          numeric(10,2),
  total_fee             numeric(10,2),
  termination_fee       numeric(10,2),
  payment_terms         text,
  auto_renew            boolean          NOT NULL DEFAULT false,
  renewal_notice_days   int              NOT NULL DEFAULT 30 CHECK (renewal_notice_days >= 0),
  file_path             text,
  draft_file_path       text,
  notes                 text,
  created_at            timestamptz      NOT NULL DEFAULT now(),
  updated_at            timestamptz      NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR effective_date IS NULL OR end_date >= effective_date)
);

-- ----- invoices -----
CREATE TABLE IF NOT EXISTS public.invoices (
  id                         uuid            PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id                  uuid            NOT NULL REFERENCES public.clients(id) ON DELETE RESTRICT,
  project_id                 uuid            REFERENCES public.projects(id) ON DELETE SET NULL,
  brand_id                   uuid            REFERENCES public.brands(id) ON DELETE SET NULL,
  invoice_number             text            NOT NULL UNIQUE,
  description                text,
  line_items                 jsonb           NOT NULL DEFAULT '[]'::jsonb,
  subtotal                   numeric(10,2),
  tax                        numeric(10,2)   NOT NULL DEFAULT 0,
  total                      numeric(10,2)   NOT NULL CHECK (total >= 0),
  status                     invoice_status  NOT NULL DEFAULT 'draft',
  due_date                   date            NOT NULL,
  sent_date                  date,
  paid_date                  date,
  paid_amount                numeric(10,2)   CHECK (paid_amount IS NULL OR paid_amount >= 0),
  payment_method             payment_method,
  stripe_invoice_id          text,
  stripe_payment_intent_id   text,
  late_fee_applied           boolean         NOT NULL DEFAULT false,
  notes                      text,
  created_at                 timestamptz     NOT NULL DEFAULT now(),
  updated_at                 timestamptz     NOT NULL DEFAULT now()
);

-- ----- expenses -----
CREATE TABLE IF NOT EXISTS public.expenses (
  id                      uuid              PRIMARY KEY DEFAULT gen_random_uuid(),
  category                expense_category  NOT NULL,
  subcategory             text,
  description             text              NOT NULL CHECK (length(trim(description)) > 0),
  vendor                  text,
  amount                  numeric(10,2)     NOT NULL CHECK (amount >= 0),
  date                    date              NOT NULL,
  receipt_path            text,
  tax_deductible          boolean           NOT NULL DEFAULT true,
  deduction_percentage    int               NOT NULL DEFAULT 100 CHECK (deduction_percentage BETWEEN 0 AND 100),
  client_id               uuid              REFERENCES public.clients(id) ON DELETE SET NULL,
  brand_id                uuid              REFERENCES public.brands(id) ON DELETE SET NULL,
  is_recurring            boolean           NOT NULL DEFAULT false,
  recurring_day           int               CHECK (recurring_day IS NULL OR recurring_day BETWEEN 1 AND 31),
  notes                   text,
  created_at              timestamptz       NOT NULL DEFAULT now(),
  updated_at              timestamptz       NOT NULL DEFAULT now(),
  CHECK ((is_recurring = false) OR (recurring_day IS NOT NULL))
);
