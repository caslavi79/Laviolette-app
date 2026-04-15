-- =============================================================
-- 20260415000011_storage_buckets.sql
-- Create Supabase Storage buckets: project-files, contracts,
-- receipts, logos. All private, 50 MB max file size.
-- =============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES
  ('project-files', 'project-files', false, 52428800),
  ('contracts',     'contracts',     false, 52428800),
  ('receipts',      'receipts',      false, 52428800),
  ('logos',         'logos',         false, 52428800)
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit;

-- Storage object policies: only authenticated users can read/write anything.
-- Single-user app, so a global predicate is fine.

DO $$
DECLARE
  op text;
  ops text[] := ARRAY['SELECT','INSERT','UPDATE','DELETE'];
  policy_name text;
BEGIN
  FOREACH op IN ARRAY ops LOOP
    policy_name := 'authenticated_' || lower(op);
    EXECUTE format('DROP POLICY IF EXISTS "%s" ON storage.objects', policy_name);

    IF op = 'INSERT' THEN
      EXECUTE format(
        'CREATE POLICY "%s" ON storage.objects
           FOR %s
           TO authenticated
           WITH CHECK (bucket_id IN (''project-files'',''contracts'',''receipts'',''logos''))',
        policy_name, op
      );
    ELSIF op = 'UPDATE' THEN
      EXECUTE format(
        'CREATE POLICY "%s" ON storage.objects
           FOR %s
           TO authenticated
           USING (bucket_id IN (''project-files'',''contracts'',''receipts'',''logos''))
           WITH CHECK (bucket_id IN (''project-files'',''contracts'',''receipts'',''logos''))',
        policy_name, op
      );
    ELSE
      EXECUTE format(
        'CREATE POLICY "%s" ON storage.objects
           FOR %s
           TO authenticated
           USING (bucket_id IN (''project-files'',''contracts'',''receipts'',''logos''))',
        policy_name, op
      );
    END IF;
  END LOOP;
END $$;
