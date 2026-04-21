const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

// Load env
const env = {};
const envLocal = fs.readFileSync('.env.local', 'utf-8');
envLocal.split('\n').forEach(line => {
  const [key, ...rest] = line.split('=');
  if (key && !key.startsWith('#')) env[key.trim()] = rest.join('=').trim();
});

const client = new Client({
  host: `db.${env.SUPABASE_PROJECT_REF}.supabase.co`,
  port: 5432,
  user: 'postgres',
  password: env.SUPABASE_DB_PASSWORD,
  database: 'postgres',
  ssl: { rejectUnauthorized: false }
});

async function audit() {
  try {
    await client.connect();
    console.log('Connected to live database\n');

    const checks = [
      // Migration 1 checks
      ["stripe_events_processed table", "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='stripe_events_processed' AND table_schema='public')"],
      ["stripe_events_processed RLS enabled", "SELECT rowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname='stripe_events_processed' AND n.nspname='public'"],
      ["idx_stripe_events_processed_time", "SELECT COUNT(*)>0 FROM pg_indexes WHERE schemaname='public' AND tablename='stripe_events_processed' AND indexname='idx_stripe_events_processed_time'"],
      ["invoices.period_month column", "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='invoices' AND column_name='period_month' AND table_schema='public')"],
      ["invoices_project_period_month_unique index", "SELECT COUNT(*)>0 FROM pg_indexes WHERE schemaname='public' AND tablename='invoices' AND indexname='invoices_project_period_month_unique'"],
      
      // Migration 2 checks
      ["invoices_stripe_payment_intent_id_idx", "SELECT COUNT(*)>0 FROM pg_indexes WHERE schemaname='public' AND tablename='invoices' AND indexname='invoices_stripe_payment_intent_id_idx'"],
      ["invoices_stripe_payment_intent_id_unique", "SELECT COUNT(*)>0 FROM pg_indexes WHERE schemaname='public' AND tablename='invoices' AND indexname='invoices_stripe_payment_intent_id_unique'"],
      ["invoices_stripe_invoice_id_idx", "SELECT COUNT(*)>0 FROM pg_indexes WHERE schemaname='public' AND tablename='invoices' AND indexname='invoices_stripe_invoice_id_idx'"],
      ["clients_stripe_customer_id_idx", "SELECT COUNT(*)>0 FROM pg_indexes WHERE schemaname='public' AND tablename='clients' AND indexname='clients_stripe_customer_id_idx'"],
      
      // Migration 3 checks
      ["notification_failures table", "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='notification_failures' AND table_schema='public')"],
      ["notification_failures RLS enabled", "SELECT rowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname='notification_failures' AND n.nspname='public'"],
      ["notification_failures_unresolved_idx", "SELECT COUNT(*)>0 FROM pg_indexes WHERE schemaname='public' AND tablename='notification_failures' AND indexname='notification_failures_unresolved_idx'"],
      
      // Data counts
      ["stripe_events_processed row count", "SELECT COUNT(*) FROM stripe_events_processed"],
      ["notification_failures row count", "SELECT COUNT(*) FROM notification_failures"],
      
      // Extension checks
      ["pgcrypto extension enabled", "SELECT COUNT(*)>0 FROM pg_extension WHERE extname='pgcrypto'"],
      
      // Backfill check
      ["retainer invoices have period_month", "SELECT (COUNT(CASE WHEN period_month IS NOT NULL THEN 1 END) > 0 OR COUNT(*)=0) FROM invoices i JOIN projects p ON i.project_id=p.id WHERE p.type='retainer'"],
    ];

    for (const [name, sql] of checks) {
      try {
        const res = await client.query(sql);
        const value = res.rows[0]?.[Object.keys(res.rows[0])[0]];
        console.log(`✓ ${name}: ${value}`);
      } catch (e) {
        console.log(`✗ ${name}: ERROR - ${e.message}`);
      }
    }

    // Check for COMMENTs
    console.log('\n--- Comments ---');
    const comments = await client.query(`
      SELECT obj_description(relfilenode, 'pg_class') as comment, relname
      FROM pg_class WHERE relname IN ('stripe_events_processed', 'notification_failures')
    `);
    console.log('stripe_events_processed comment:', comments.rows.find(r => r.relname === 'stripe_events_processed')?.comment ? 'YES' : 'MISSING');
    console.log('notification_failures comment:', comments.rows.find(r => r.relname === 'notification_failures')?.comment ? 'YES' : 'MISSING');

    // Check for RLS policies
    console.log('\n--- RLS Policies ---');
    const policies = await client.query(`
      SELECT schemaname, tablename, policyname 
      FROM pg_policies 
      WHERE schemaname='public' AND tablename IN ('stripe_events_processed', 'notification_failures', 'invoices')
      ORDER BY tablename
    `);
    policies.rows.forEach(p => console.log(`${p.tablename}: ${p.policyname}`));

    // Check for CHECK constraints
    console.log('\n--- CHECK Constraints ---');
    const checks_db = await client.query(`
      SELECT table_name, constraint_name, check_clause
      FROM information_schema.check_constraints
      WHERE constraint_schema='public' AND table_name='notification_failures'
    `);
    checks_db.rows.forEach(c => console.log(`${c.table_name}.${c.constraint_name}: ${c.check_clause}`));

  } catch (e) {
    console.error('Connection error:', e.message);
  } finally {
    await client.end();
  }
}

audit();
