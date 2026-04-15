-- =============================================================
-- 20260415000010_rls.sql
-- Row-level security: single-user app — any authenticated session
-- can do anything; anon sessions can do nothing.
-- =============================================================

DO $$
DECLARE
  t text;
  app_tables text[] := ARRAY[
    'contacts','clients','brands',
    'projects','deliverables','retainer_services','retainer_tasks','project_files',
    'schedule_template','schedule_overrides','daily_rounds',
    'contracts','invoices','expenses',
    'lead_details'
  ];
BEGIN
  FOREACH t IN ARRAY app_tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    -- Drop any existing policy with our name so re-runs are clean
    EXECUTE format('DROP POLICY IF EXISTS "authenticated_all" ON public.%I', t);

    EXECUTE format(
      'CREATE POLICY "authenticated_all" ON public.%I
         FOR ALL
         TO authenticated
         USING (true)
         WITH CHECK (true)',
      t
    );
  END LOOP;
END $$;

-- Migration tracking table: also RLS-protected so anon can't peek.
ALTER TABLE public._claude_migrations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "authenticated_all" ON public._claude_migrations;
CREATE POLICY "authenticated_all" ON public._claude_migrations
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);
