-- =============================================================
-- 20260415000006_tables_pipeline.sql
-- Lead pipeline — one lead_details record per prospective contact.
-- =============================================================

CREATE TABLE IF NOT EXISTS public.lead_details (
  id                  uuid                PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id          uuid                NOT NULL UNIQUE REFERENCES public.contacts(id) ON DELETE CASCADE,
  source              lead_source,
  referred_by         text,
  scope_summary       text,
  deck_url            text,
  quoted_amount       numeric(10,2),
  quoted_recurring    numeric(10,2),
  temperature         lead_temperature    NOT NULL DEFAULT 'warm',
  stage               lead_stage          NOT NULL DEFAULT 'initial_contact',
  next_step           text,
  next_follow_up      date,
  last_contact_date   date,
  lost_reason         text,
  notes               text,
  created_at          timestamptz         NOT NULL DEFAULT now(),
  updated_at          timestamptz         NOT NULL DEFAULT now(),
  CHECK (stage != 'lost' OR lost_reason IS NOT NULL OR lost_reason IS NULL)  -- soft hint; enforced in app
);
