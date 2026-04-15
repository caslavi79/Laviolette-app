-- =============================================================
-- 20260415000003_tables_projects.sql
-- Projects and everything attached to them:
--   projects, deliverables (buildout), retainer_services,
--   retainer_tasks (generated weekly/monthly), project_files
-- =============================================================

-- ----- projects -----
CREATE TABLE IF NOT EXISTS public.projects (
  id                   uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id             uuid             NOT NULL REFERENCES public.brands(id) ON DELETE RESTRICT,
  name                 text             NOT NULL CHECK (length(trim(name)) > 0),
  type                 project_type     NOT NULL,
  status               project_status   NOT NULL DEFAULT 'draft',
  total_fee            numeric(10,2),
  payment_structure    text,
  start_date           date,
  end_date             date,
  timeline             text,
  intro_term_end       date,
  briefing_md          text,
  notes                text,
  created_at           timestamptz      NOT NULL DEFAULT now(),
  updated_at           timestamptz      NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);

-- ----- deliverables (buildouts) -----
CREATE TABLE IF NOT EXISTS public.deliverables (
  id              uuid                PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid                NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  number          int                 NOT NULL CHECK (number > 0),
  category        text,
  name            text                NOT NULL CHECK (length(trim(name)) > 0),
  description     text,
  status          deliverable_status  NOT NULL DEFAULT 'not_started',
  started_at      timestamptz,
  completed_at    timestamptz,
  notes           text,
  sort_order      int,
  created_at      timestamptz         NOT NULL DEFAULT now(),
  updated_at      timestamptz         NOT NULL DEFAULT now(),
  UNIQUE (project_id, number)
);

-- ----- retainer_services -----
CREATE TABLE IF NOT EXISTS public.retainer_services (
  id                    uuid              PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid              NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  number                int               NOT NULL CHECK (number > 0),
  name                  text              NOT NULL CHECK (length(trim(name)) > 0),
  description           text,
  cadence               retainer_cadence  NOT NULL,
  quantity_per_period   int               NOT NULL DEFAULT 1 CHECK (quantity_per_period >= 0),
  sla_hours             int               CHECK (sla_hours IS NULL OR sla_hours > 0),
  platforms             text[]            NOT NULL DEFAULT ARRAY[]::text[],
  active                boolean           NOT NULL DEFAULT true,
  notes                 text,
  created_at            timestamptz       NOT NULL DEFAULT now(),
  updated_at            timestamptz       NOT NULL DEFAULT now(),
  UNIQUE (project_id, number)
);

-- ----- retainer_tasks -----
-- Generated each week/month from retainer_services with weekly/monthly cadence.
CREATE TABLE IF NOT EXISTS public.retainer_tasks (
  id                   uuid                  PRIMARY KEY DEFAULT gen_random_uuid(),
  retainer_service_id  uuid                  NOT NULL REFERENCES public.retainer_services(id) ON DELETE CASCADE,
  brand_id             uuid                  NOT NULL REFERENCES public.brands(id) ON DELETE CASCADE,
  project_id           uuid                  NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  title                text                  NOT NULL,
  description          text,
  period_type          retainer_task_period  NOT NULL,
  period_start         date                  NOT NULL,
  period_end           date                  NOT NULL,
  assigned_date        date,
  status               retainer_task_status  NOT NULL DEFAULT 'pending',
  completed_at         timestamptz,
  notes                text,
  created_at           timestamptz           NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start)
);

-- ----- project_files -----
CREATE TABLE IF NOT EXISTS public.project_files (
  id                uuid            PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid            NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  name              text            NOT NULL CHECK (length(trim(name)) > 0),
  file_type         text,
  storage_path      text            NOT NULL,
  file_size_bytes   bigint          CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0),
  description       text,
  is_briefing_file  boolean         NOT NULL DEFAULT false,
  created_at        timestamptz     NOT NULL DEFAULT now()
);
