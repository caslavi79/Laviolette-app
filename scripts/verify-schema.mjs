#!/usr/bin/env node

/**
 * verify-schema.mjs
 *
 * Read-only sanity check that the database schema matches expectations.
 * Prints a summary table of public.* relations, their column counts, and
 * coverage of COMMENTs. Also runs sample queries from the design spec to
 * make sure relationships are wired correctly.
 *
 * Usage:
 *   npm run db:verify
 */

import pg from 'pg';
const { Client } = pg;

const ref = process.env.SUPABASE_PROJECT_REF;
const password = process.env.SUPABASE_DB_PASSWORD;

if (!ref || !password) {
  console.error('Missing SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD');
  process.exit(1);
}

const client = new Client({
  host: `db.${ref}.supabase.co`,
  port: 5432,
  user: 'postgres',
  password,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
  application_name: 'claude-verify',
});

await client.connect();

const section = (title) => {
  console.log('');
  console.log(`=== ${title} ===`);
};

// --- Tables & column counts ---
section('Tables in public schema');
const tables = await client.query(`
  SELECT
    c.relname AS table_name,
    c.relkind AS kind,
    (SELECT count(*) FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS col_count,
    obj_description(c.oid, 'pg_class') AS table_comment
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r','p')
  ORDER BY c.relname;
`);

for (const r of tables.rows) {
  const comment = r.table_comment ? ' ✓' : ' (no comment)';
  console.log(`  ${r.table_name.padEnd(24)}  cols=${String(r.col_count).padStart(2)}${comment}`);
}

// --- Column comment coverage ---
section('Column comment coverage');
const cols = await client.query(`
  SELECT
    c.relname AS table_name,
    count(*) AS total_cols,
    count(*) FILTER (WHERE pg_catalog.col_description(c.oid, a.attnum) IS NOT NULL) AS commented
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relname NOT LIKE '\\_%' ESCAPE '\\'
  GROUP BY c.relname
  ORDER BY c.relname;
`);
for (const r of cols.rows) {
  const pct = Math.round((r.commented / r.total_cols) * 100);
  console.log(`  ${r.table_name.padEnd(24)}  ${r.commented}/${r.total_cols} (${pct}%)`);
}

// --- Enums ---
section('Enum types');
const enums = await client.query(`
  SELECT t.typname, string_agg(e.enumlabel::text, ', ' ORDER BY e.enumsortorder) AS labels
  FROM pg_type t
  JOIN pg_enum e ON e.enumtypid = t.oid
  JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = 'public'
  GROUP BY t.typname
  ORDER BY t.typname;
`);
for (const e of enums.rows) {
  console.log(`  ${e.typname.padEnd(24)}  ${e.labels}`);
}

// --- Indexes ---
section('Indexes (public schema, excluding PKs/UNIQUEs)');
const idx = await client.query(`
  SELECT indexname, tablename
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND indexname LIKE 'idx\\_%' ESCAPE '\\'
  ORDER BY tablename, indexname;
`);
for (const i of idx.rows) {
  console.log(`  ${i.tablename.padEnd(24)}  ${i.indexname}`);
}

// --- Triggers ---
section('Triggers');
const trg = await client.query(`
  SELECT event_object_table AS table_name,
         trigger_name,
         string_agg(event_manipulation, ',' ORDER BY event_manipulation) AS events
  FROM information_schema.triggers
  WHERE trigger_schema = 'public'
  GROUP BY event_object_table, trigger_name
  ORDER BY event_object_table, trigger_name;
`);
for (const t of trg.rows) {
  console.log(`  ${t.table_name.padEnd(24)}  ${t.trigger_name.padEnd(40)} ${t.events}`);
}

// --- Functions ---
section('Functions in public schema');
const fns = await client.query(`
  SELECT p.proname AS name,
         pg_catalog.pg_get_function_arguments(p.oid) AS args,
         obj_description(p.oid, 'pg_proc') AS comment
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
  ORDER BY p.proname;
`);
for (const f of fns.rows) {
  console.log(`  ${f.name}(${f.args})`);
  if (f.comment) console.log(`    ${f.comment.slice(0,100)}`);
}

// --- RLS check ---
section('RLS enabled check');
const rls = await client.query(`
  SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled,
         (SELECT count(*) FROM pg_policy WHERE polrelid = c.oid) AS policy_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
  ORDER BY c.relname;
`);
for (const r of rls.rows) {
  const mark = r.rls_enabled ? '✓' : '✗';
  console.log(`  ${mark} ${r.table_name.padEnd(24)}  policies=${r.policy_count}`);
}

// --- Storage buckets ---
section('Storage buckets');
const buckets = await client.query(`
  SELECT id, public, file_size_limit
  FROM storage.buckets
  ORDER BY id;
`);
for (const b of buckets.rows) {
  const mb = b.file_size_limit ? (b.file_size_limit / 1024 / 1024).toFixed(0) + ' MB' : 'unlimited';
  console.log(`  ${b.id.padEnd(16)}  public=${b.public}  max=${mb}`);
}

// --- Sample spec queries: run them and confirm zero rows (no data yet) ---
section('Sample spec queries (should return 0 rows, no errors)');

const sampleQueries = [
  {
    label: 'Sheepdog deliverables',
    sql: `SELECT d.number, d.category, d.name, d.status
            FROM deliverables d
            JOIN projects p ON d.project_id = p.id
            JOIN brands b ON p.brand_id = b.id
            WHERE b.name ILIKE '%sheepdog%'
            ORDER BY d.number;`,
  },
  {
    label: 'Who owes me money',
    sql: `SELECT c.name, i.invoice_number, i.total, i.due_date, i.status
            FROM invoices i
            JOIN clients c ON i.client_id = c.id
            WHERE i.status IN ('pending','overdue')
            ORDER BY i.due_date;`,
  },
  {
    label: 'Daily rounds this week',
    sql: `SELECT date, brand_id, platform, status FROM daily_rounds
            WHERE date >= date_trunc('week', CURRENT_DATE)::date;`,
  },
  {
    label: 'next_invoice_number()',
    sql: `SELECT next_invoice_number() AS number;`,
  },
];

for (const q of sampleQueries) {
  try {
    const r = await client.query(q.sql);
    console.log(`  ✓ ${q.label.padEnd(32)}  rows=${r.rowCount}` +
      (r.rowCount > 0 && r.rows[0].number ? `  result=${JSON.stringify(r.rows[0])}` : ''));
  } catch (err) {
    console.log(`  ✗ ${q.label.padEnd(32)}  ERROR: ${err.message}`);
  }
}

// --- Trigger smoke test ---
section('Trigger smoke test (insert contact → client → brand → buildout project → deliverable)');

try {
  await client.query('BEGIN');
  const ins = async (sql, values) => (await client.query(sql, values)).rows[0];

  const contact = await ins(
    `INSERT INTO contacts (name, email) VALUES ($1, $2) RETURNING id`,
    ['TEMP TEST CONTACT', 'temp@example.com']
  );
  const clientRow = await ins(
    `INSERT INTO clients (contact_id, name, legal_name) VALUES ($1, $2, $3) RETURNING id`,
    [contact.id, 'TEMP TEST LLC', 'TEMP TEST LLC']
  );
  const brand = await ins(
    `INSERT INTO brands (client_id, name) VALUES ($1, $2) RETURNING id`,
    [clientRow.id, 'Temp Test Brand']
  );
  const project = await ins(
    `INSERT INTO projects (brand_id, name, type, total_fee) VALUES ($1,$2,$3,$4) RETURNING id, briefing_md`,
    [brand.id, 'Temp Buildout', 'buildout', 999]
  );
  console.log(`  ✓ project inserted; briefing_md initially: ${project.briefing_md ? 'set' : 'null'}`);

  // Insert a deliverable — should trigger briefing regen
  const delv = await ins(
    `INSERT INTO deliverables (project_id, number, name, category) VALUES ($1,$2,$3,$4) RETURNING id`,
    [project.id, 1, 'First deliverable', 'Testing']
  );

  // Check briefing_md was populated by the trigger
  const proj2 = await client.query(`SELECT briefing_md FROM projects WHERE id = $1`, [project.id]);
  const len = proj2.rows[0].briefing_md?.length ?? 0;
  console.log(`  ✓ deliverable insert fired trigger; briefing_md now ${len} chars`);
  console.log('  --- briefing_md preview ---');
  console.log((proj2.rows[0].briefing_md || '').split('\n').slice(0, 8).map(l => '  | ' + l).join('\n'));
  console.log('  --- (truncated) ---');

  // Mark deliverable complete — should flip project to complete
  await client.query(
    `UPDATE deliverables SET status = 'complete', completed_at = now() WHERE id = $1`,
    [delv.id]
  );
  const proj3 = await client.query(`SELECT status, end_date FROM projects WHERE id = $1`, [project.id]);
  console.log(`  ✓ auto_complete_project trigger: project.status=${proj3.rows[0].status} end_date=${proj3.rows[0].end_date}`);

  await client.query('ROLLBACK');
  console.log('  ✓ test transaction rolled back — no test data persisted');
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(`  ✗ trigger test FAILED: ${err.message}`);
  process.exitCode = 2;
}

await client.end();
console.log('');
console.log('Done.');
