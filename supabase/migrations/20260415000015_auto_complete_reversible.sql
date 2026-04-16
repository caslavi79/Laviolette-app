-- Make auto_complete_project() reversible: revert project status to 'active'
-- when a deliverable is unchecked and the project was previously 'complete'.

CREATE OR REPLACE FUNCTION public.auto_complete_project()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_project_id uuid;
  v_all_complete boolean;
  v_type project_type;
  v_current_status project_status;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_project_id := OLD.project_id;
  ELSE
    v_project_id := NEW.project_id;
  END IF;

  SELECT type, status INTO v_type, v_current_status FROM public.projects WHERE id = v_project_id;
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
  ELSIF v_current_status = 'complete' THEN
    -- Reverse: if project was complete but a deliverable was unchecked, revert to active
    UPDATE public.projects
    SET status = 'active'
    WHERE id = v_project_id AND status = 'complete';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION public.auto_complete_project IS
  'Trigger on deliverables: auto-completes buildout projects when all deliverables are done, and reverts to active if any deliverable is unchecked.';
