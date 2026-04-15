-- =============================================================
-- 20260415000009_functions_triggers.sql
-- Triggers:
--   1. update_updated_at — touches updated_at on every row update
--   2. auto_complete_project — flips buildout project to 'complete' when
--      all deliverables hit 'complete'
--   3. regenerate_project_briefing — rebuilds projects.briefing_md
-- =============================================================

-- ---------- 1. update_updated_at ----------
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.update_updated_at IS
  'BEFORE UPDATE trigger: sets NEW.updated_at = now(). Attach to any table with an updated_at column.';

-- Attach to every table that has an updated_at column.
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'contacts','clients','brands',
    'projects','deliverables','retainer_services',
    'schedule_template',
    'contracts','invoices','expenses',
    'lead_details'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_%I_set_updated_at ON public.%I;
       CREATE TRIGGER trg_%I_set_updated_at
         BEFORE UPDATE ON public.%I
         FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();',
      t, t, t, t
    );
  END LOOP;
END $$;

-- ---------- 2. auto_complete_project ----------
CREATE OR REPLACE FUNCTION public.auto_complete_project()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_project_id uuid;
  v_all_complete boolean;
  v_type project_type;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_project_id := OLD.project_id;
  ELSE
    v_project_id := NEW.project_id;
  END IF;

  SELECT type INTO v_type FROM public.projects WHERE id = v_project_id;
  IF v_type IS DISTINCT FROM 'buildout' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT CASE
    WHEN COUNT(*) = 0 THEN false
    ELSE bool_and(status = 'complete')
  END
  INTO v_all_complete
  FROM public.deliverables
  WHERE project_id = v_project_id;

  IF v_all_complete THEN
    UPDATE public.projects
    SET status = 'complete',
        end_date = COALESCE(end_date, CURRENT_DATE)
    WHERE id = v_project_id AND status <> 'complete';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION public.auto_complete_project IS
  'Trigger on deliverables: when the last deliverable of a buildout flips to status=complete, auto-advance the parent project to status=complete (if not already) and stamp end_date if null.';

DROP TRIGGER IF EXISTS trg_deliverables_auto_complete ON public.deliverables;
CREATE TRIGGER trg_deliverables_auto_complete
  AFTER INSERT OR UPDATE OF status OR DELETE ON public.deliverables
  FOR EACH ROW EXECUTE FUNCTION public.auto_complete_project();

-- ---------- 3. regenerate_project_briefing ----------
CREATE OR REPLACE FUNCTION public.regenerate_project_briefing(p_project_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_project RECORD;
  v_brand RECORD;
  v_client RECORD;
  v_contact RECORD;
  v_md text := '';
  v_completed int;
  v_total int;
  v_category text;
  v_item RECORD;
BEGIN
  SELECT * INTO v_project FROM public.projects WHERE id = p_project_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT * INTO v_brand FROM public.brands WHERE id = v_project.brand_id;
  SELECT * INTO v_client FROM public.clients WHERE id = v_brand.client_id;
  SELECT * INTO v_contact FROM public.contacts WHERE id = v_client.contact_id;

  -- Header
  v_md := '# ' || v_project.name || E'\n';
  v_md := v_md || '**Client:** ' || COALESCE(v_client.legal_name, v_client.name) || E'\n';
  v_md := v_md || '**Brand:** ' || v_brand.name || E'\n';
  v_md := v_md || '**Contact:** ' || v_contact.name;
  IF v_contact.phone IS NOT NULL THEN v_md := v_md || ' · ' || v_contact.phone; END IF;
  IF v_contact.email IS NOT NULL THEN v_md := v_md || ' · ' || v_contact.email; END IF;
  v_md := v_md || E'\n';

  IF v_project.type = 'buildout' THEN
    v_md := v_md || '**Type:** Buildout' || E'\n';
    v_md := v_md || '**Fee:** $' || COALESCE(v_project.total_fee::text, 'TBD');
    IF v_project.payment_structure IS NOT NULL THEN
      v_md := v_md || ' · ' || v_project.payment_structure;
    END IF;
    v_md := v_md || E'\n';
    v_md := v_md || '**Status:** ' || v_project.status::text || E'\n';
    v_md := v_md || '**Start:** '  || COALESCE(v_project.start_date::text, 'TBD') || E'\n';
    v_md := v_md || '**Target:** ' || COALESCE(v_project.end_date::text, 'TBD') || E'\n';

    SELECT COUNT(*) FILTER (WHERE status = 'complete'), COUNT(*)
    INTO v_completed, v_total
    FROM public.deliverables WHERE project_id = p_project_id;

    v_md := v_md || '**Progress:** ' || v_completed || ' of ' || v_total;
    IF v_total > 0 THEN
      v_md := v_md || ' (' || ROUND(v_completed::numeric / v_total * 100) || '%)';
    END IF;
    v_md := v_md || E'\n\n## Deliverables\n';

    FOR v_category IN
      SELECT DISTINCT COALESCE(category, 'Uncategorized') AS cat
      FROM public.deliverables
      WHERE project_id = p_project_id
      ORDER BY cat
    LOOP
      v_md := v_md || E'\n### ' || v_category || E'\n';
      FOR v_item IN
        SELECT *
        FROM public.deliverables
        WHERE project_id = p_project_id
          AND COALESCE(category, 'Uncategorized') = v_category
        ORDER BY number
      LOOP
        IF v_item.status = 'complete' THEN
          v_md := v_md || '- [x] ' || v_item.number || '. ' || v_item.name;
          IF v_item.completed_at IS NOT NULL THEN
            v_md := v_md || ' — Completed ' || to_char(v_item.completed_at, 'Mon DD');
          END IF;
          v_md := v_md || E'\n';
        ELSE
          v_md := v_md || '- [ ] ' || v_item.number || '. ' || v_item.name;
          IF v_item.status = 'in_progress' THEN v_md := v_md || ' — In Progress'; END IF;
          v_md := v_md || E'\n';
        END IF;
        IF v_item.notes IS NOT NULL AND length(trim(v_item.notes)) > 0 THEN
          v_md := v_md || '  ' || v_item.notes || E'\n';
        END IF;
      END LOOP;
    END LOOP;

  ELSIF v_project.type = 'retainer' THEN
    v_md := v_md || '**Type:** Retainer · $' || COALESCE(v_project.total_fee::text, 'TBD') || '/month' || E'\n';
    v_md := v_md || '**Status:** ' || v_project.status::text || E'\n';
    v_md := v_md || '**Started:** ' || COALESCE(v_project.start_date::text, 'TBD') || E'\n';
    v_md := v_md || '**Intro Term Ends:** ' || COALESCE(v_project.intro_term_end::text, 'n/a') || E'\n';

    v_md := v_md || E'\n## Services\n';
    FOR v_item IN
      SELECT * FROM public.retainer_services
      WHERE project_id = p_project_id AND active = true
      ORDER BY number
    LOOP
      v_md := v_md || v_item.number || '. **' || v_item.name || '** — ' || v_item.cadence::text;
      IF v_item.quantity_per_period > 1 THEN v_md := v_md || ' (×' || v_item.quantity_per_period || ')'; END IF;
      IF v_item.sla_hours IS NOT NULL THEN v_md := v_md || ' · SLA: ' || v_item.sla_hours || 'hrs'; END IF;
      v_md := v_md || E'\n';
      IF v_item.description IS NOT NULL THEN v_md := v_md || '   ' || v_item.description || E'\n'; END IF;
    END LOOP;

    v_md := v_md || E'\n## This Week\n';
    FOR v_item IN
      SELECT *
      FROM public.retainer_tasks
      WHERE project_id = p_project_id
        AND period_type = 'weekly'
        AND period_start = date_trunc('week', CURRENT_DATE)::date
      ORDER BY assigned_date NULLS LAST, created_at
    LOOP
      v_md := v_md || '- [' || CASE WHEN v_item.status = 'complete' THEN 'x' ELSE ' ' END || '] '
              || v_item.title || ' — ' || v_item.status::text;
      IF v_item.completed_at IS NOT NULL THEN v_md := v_md || ' · ' || to_char(v_item.completed_at, 'Mon DD'); END IF;
      v_md := v_md || E'\n';
    END LOOP;

    v_md := v_md || E'\n## This Month\n';
    FOR v_item IN
      SELECT *
      FROM public.retainer_tasks
      WHERE project_id = p_project_id
        AND period_type = 'monthly'
        AND period_start = date_trunc('month', CURRENT_DATE)::date
      ORDER BY created_at
    LOOP
      v_md := v_md || '- [' || CASE WHEN v_item.status = 'complete' THEN 'x' ELSE ' ' END || '] '
              || v_item.title || ' — ' || v_item.status::text || E'\n';
    END LOOP;
  END IF;

  IF v_project.notes IS NOT NULL AND length(trim(v_project.notes)) > 0 THEN
    v_md := v_md || E'\n## Project Notes\n' || v_project.notes || E'\n';
  END IF;

  v_md := v_md || E'\n## Key Files\n';
  FOR v_item IN
    SELECT * FROM public.project_files
    WHERE project_id = p_project_id AND is_briefing_file = true
    ORDER BY created_at
  LOOP
    v_md := v_md || '- ' || v_item.name;
    IF v_item.file_type IS NOT NULL THEN v_md := v_md || ' (' || v_item.file_type || ')'; END IF;
    IF v_item.description IS NOT NULL THEN v_md := v_md || ' — ' || v_item.description; END IF;
    v_md := v_md || E'\n';
  END LOOP;

  v_md := v_md || E'\n---\nGenerated: ' || to_char(now(), 'YYYY-MM-DD HH24:MI') || E'\n';

  UPDATE public.projects SET briefing_md = v_md WHERE id = p_project_id;
END;
$$;

COMMENT ON FUNCTION public.regenerate_project_briefing(uuid) IS
  'Rebuilds projects.briefing_md from the current state of the project and its children. Called by triggers on deliverables/retainer_services/retainer_tasks/project_files, and can be called manually.';

-- Trigger function wrapper — figures out which project_id to regen from NEW/OLD.
CREATE OR REPLACE FUNCTION public.trg_regen_briefing()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_project_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'projects' THEN
    v_project_id := COALESCE(NEW.id, OLD.id);
  ELSIF TG_OP = 'DELETE' THEN
    v_project_id := OLD.project_id;
  ELSE
    v_project_id := NEW.project_id;
  END IF;

  IF v_project_id IS NOT NULL THEN
    PERFORM public.regenerate_project_briefing(v_project_id);
  END IF;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.trg_regen_briefing IS
  'Trigger function: derives project_id from NEW/OLD depending on table and calls regenerate_project_briefing.';

-- Attach to child tables
DROP TRIGGER IF EXISTS trg_deliverables_regen_briefing ON public.deliverables;
CREATE TRIGGER trg_deliverables_regen_briefing
  AFTER INSERT OR UPDATE OR DELETE ON public.deliverables
  FOR EACH ROW EXECUTE FUNCTION public.trg_regen_briefing();

DROP TRIGGER IF EXISTS trg_retainer_services_regen_briefing ON public.retainer_services;
CREATE TRIGGER trg_retainer_services_regen_briefing
  AFTER INSERT OR UPDATE OR DELETE ON public.retainer_services
  FOR EACH ROW EXECUTE FUNCTION public.trg_regen_briefing();

DROP TRIGGER IF EXISTS trg_retainer_tasks_regen_briefing ON public.retainer_tasks;
CREATE TRIGGER trg_retainer_tasks_regen_briefing
  AFTER INSERT OR UPDATE OR DELETE ON public.retainer_tasks
  FOR EACH ROW EXECUTE FUNCTION public.trg_regen_briefing();

DROP TRIGGER IF EXISTS trg_project_files_regen_briefing ON public.project_files;
CREATE TRIGGER trg_project_files_regen_briefing
  AFTER INSERT OR UPDATE OR DELETE ON public.project_files
  FOR EACH ROW EXECUTE FUNCTION public.trg_regen_briefing();

-- Projects: regen when name/notes/status/etc change (but not on briefing_md itself to avoid recursion)
DROP TRIGGER IF EXISTS trg_projects_regen_briefing ON public.projects;
CREATE TRIGGER trg_projects_regen_briefing
  AFTER UPDATE OF name, notes, status, start_date, end_date, intro_term_end,
                  total_fee, payment_structure, type ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.trg_regen_briefing();
