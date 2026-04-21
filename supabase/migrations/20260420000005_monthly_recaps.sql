-- =============================================================
-- 20260420000005_monthly_recaps.sql
-- Client-facing monthly recap artifacts, one row per retainer
-- project per month. Generated as `draft` by the cron, edited by
-- Case in the app, flipped to `sent` when emailed, or `skipped`
-- if Case decides not to send a given month.
-- =============================================================

CREATE TABLE IF NOT EXISTS public.monthly_recaps (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid         NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  brand_id        uuid         NOT NULL REFERENCES public.brands(id) ON DELETE CASCADE,
  -- First day of the month the recap covers, e.g. 2026-05-01 for May.
  month           date         NOT NULL CHECK (date_trunc('month', month) = month),
  status          text         NOT NULL DEFAULT 'draft'
                               CHECK (status IN ('draft','approved','sent','skipped')),
  generated_at    timestamptz  NOT NULL DEFAULT now(),
  approved_at     timestamptz,
  sent_at         timestamptz,
  sent_to_email   text,
  subject         text         NOT NULL CHECK (length(trim(subject)) > 0),
  html_body       text         NOT NULL,
  summary_json    jsonb        NOT NULL,
  notes_internal  text,
  UNIQUE (project_id, month)
);

CREATE INDEX IF NOT EXISTS idx_monthly_recaps_status
  ON public.monthly_recaps (status, month DESC);

CREATE INDEX IF NOT EXISTS idx_monthly_recaps_project_month
  ON public.monthly_recaps (project_id, month DESC);

-- Single-user app — same policy shape as every other table.
ALTER TABLE public.monthly_recaps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS monthly_recaps_authenticated_all ON public.monthly_recaps;
CREATE POLICY monthly_recaps_authenticated_all ON public.monthly_recaps
  FOR ALL TO authenticated
  USING (true)
  WITH CHECK (true);

-- No updated_at column on this table — status transitions are
-- captured by approved_at / sent_at timestamps, which double as
-- the audit trail. An updated_at would just mirror whichever one
-- was most recently set.

COMMENT ON TABLE public.monthly_recaps IS
  'Client-facing monthly recap artifacts. One row per retainer project per month. Lifecycle: draft (auto-generated) → approved (optional) → sent (emailed to client) OR skipped (Case chose not to send).';
COMMENT ON COLUMN public.monthly_recaps.month IS
  'First day of the covered month (always 2026-05-01 style). CHECK constraint enforces alignment so unique (project_id, month) prevents duplicate recaps for the same calendar month.';
COMMENT ON COLUMN public.monthly_recaps.status IS
  'Lifecycle. draft = auto-generated, needs review. approved = Case OKed it, not yet sent. sent = emailed to client (immutable). skipped = Case chose not to send.';
COMMENT ON COLUMN public.monthly_recaps.subject IS
  'Email subject line. Editable by Case before send. Default format: "<Brand> — <Month> recap".';
COMMENT ON COLUMN public.monthly_recaps.html_body IS
  'Rendered HTML email body. Editable by Case before send. Script tags are stripped by send-monthly-recap before transmit.';
COMMENT ON COLUMN public.monthly_recaps.summary_json IS
  'Structured aggregation used to render the email + support regenerate-from-log. Shape: { brand_name, month_label, total_entries, total_count, services: [{service_id, service_name, total_count, entry_count, highlights: [{title, performed_at, link_url}]}], general: {...}, zero_activity: bool }.';
COMMENT ON COLUMN public.monthly_recaps.notes_internal IS
  'Private notes, never included in the email. For Case to track context ("client was unhappy in May — be thorough").';
COMMENT ON COLUMN public.monthly_recaps.sent_to_email IS
  'The email address the recap was delivered to. Captured at send time for audit — the client contact record may change later.';
