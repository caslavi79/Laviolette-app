import { Client } from 'pg';
import fs from 'fs';

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
    console.log('=== DETAILED AUDIT ===\n');

    // Check RLS properly
    const rls = await client.query(`
      SELECT schemaname, tablename, 
             (SELECT relrowsecurity FROM pg_class WHERE relnamespace=(SELECT oid FROM pg_namespace WHERE nspname=schemaname) AND relname=tablename) as rls_enabled
      FROM pg_tables 
      WHERE tablename IN ('stripe_events_processed', 'notification_failures')
    `);
    console.log('RLS Status:');
    rls.rows.forEach(r => console.log(`  ${r.tablename}: ${r.rls_enabled ? 'ENABLED' : 'DISABLED'}`));

    // Check index definitions (what they cover)
    console.log('\n--- Index Definitions ---');
    const indexes = await client.query(`
      SELECT indexname, indexdef 
      FROM pg_indexes 
      WHERE schemaname='public' 
      AND indexname IN (
        'invoices_stripe_payment_intent_id_idx',
        'invoices_stripe_payment_intent_id_unique',
        'invoices_stripe_invoice_id_idx',
        'clients_stripe_customer_id_idx'
      )
    `);
    indexes.rows.forEach(idx => {
      console.log(`\n${idx.indexname}:`);
      console.log(`  ${idx.indexdef}`);
    });

    // Check CHECK constraints on notification_failures
    console.log('\n--- CHECK Constraints ---');
    const constraints = await client.query(`
      SELECT constraint_name, check_clause
      FROM information_schema.table_constraints tc
      JOIN information_schema.check_constraints cc 
        ON tc.constraint_name = cc.constraint_name
      WHERE tc.table_schema='public' AND tc.table_name='notification_failures'
    `);
    constraints.rows.forEach(c => console.log(`  ${c.constraint_name}: ${c.check_clause}`));

    // Check column defaults and types
    console.log('\n--- notification_failures Columns ---');
    const cols = await client.query(`
      SELECT column_name, data_type, column_default, is_nullable
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name='notification_failures'
      ORDER BY ordinal_position
    `);
    cols.rows.forEach(col => {
      const def = col.column_default ? ` DEFAULT ${col.column_default}` : '';
      console.log(`  ${col.column_name}: ${col.data_type}${def} (nullable: ${col.is_nullable})`);
    });

    // Check invoices.period_month column details
    console.log('\n--- invoices.period_month Column ---');
    const period = await client.query(`
      SELECT column_name, data_type, column_default, is_nullable
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name='invoices' AND column_name='period_month'
    `);
    if (period.rows.length > 0) {
      const col = period.rows[0];
      console.log(`  Type: ${col.data_type}`);
      console.log(`  Nullable: ${col.is_nullable}`);
      console.log(`  Default: ${col.column_default || 'none'}`);
    }

  } catch (e) {
    console.error('Error:', e.message);
  } finally {
    await client.end();
  }
}

audit();
