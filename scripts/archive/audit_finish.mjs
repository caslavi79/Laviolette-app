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

    console.log('--- Unique Index Definition ---');
    const uniqueIdx = await client.query(`
      SELECT indexname, indexdef
      FROM pg_indexes 
      WHERE schemaname='public' AND indexname='invoices_project_period_month_unique'
    `);
    if (uniqueIdx.rows.length > 0) {
      const idx = uniqueIdx.rows[0];
      const isUnique = idx.indexdef.includes('UNIQUE');
      console.log(`  ${idx.indexname} - UNIQUE: ${isUnique}`);
      console.log(`  ${idx.indexdef}`);
    }

    // Check if all column comments exist
    console.log('\n--- Column Comments ---');
    const colComments = await client.query(`
      SELECT attname as column_name, col_description(attrelid, attnum) as comment
      FROM pg_attribute
      JOIN pg_class ON pg_class.oid = attrelid
      JOIN pg_namespace ON pg_namespace.oid = relnamespace
      WHERE nspname='public' AND relname IN ('notification_failures', 'stripe_events_processed')
      AND attnum > 0
      ORDER BY relname, attnum
    `);
    console.log('stripe_events_processed columns with comments:');
    colComments.rows.filter(r => r.relname === 'stripe_events_processed' || r.column_name.split('.')[0] === 'stripe_events_processed').forEach(r => {
      console.log(`  ${r.column_name}: ${r.comment ? '✓' : '✗'}`);
    });
    
    console.log('\nnotification_failures columns with comments:');
    const nfComments = colComments.rows.filter(r => {
      // Get which table by checking
      return r.column_name;
    });
    // Redo query properly
    const nfCols = await client.query(`
      SELECT attname as column_name, col_description(attrelid, attnum) as comment
      FROM pg_attribute
      JOIN pg_class ON pg_class.oid = attrelid
      JOIN pg_namespace ON pg_namespace.oid = relnamespace
      WHERE nspname='public' AND relname='notification_failures'
      AND attnum > 0
      ORDER BY attnum
    `);
    nfCols.rows.forEach(r => {
      console.log(`  ${r.column_name}: ${r.comment ? '✓' : '✗'}`);
    });

    // Check index comments
    console.log('\n--- Index Comments ---');
    const idxComments = await client.query(`
      SELECT indexname, obj_description((SELECT oid FROM pg_class WHERE relname=indexname), 'pg_class') as comment
      FROM pg_indexes 
      WHERE schemaname='public' AND indexname IN (
        'invoices_stripe_payment_intent_id_idx',
        'invoices_stripe_invoice_id_idx', 
        'clients_stripe_customer_id_idx',
        'invoices_stripe_payment_intent_id_unique',
        'notification_failures_unresolved_idx'
      )
    `);
    idxComments.rows.forEach(idx => {
      console.log(`  ${idx.indexname}: ${idx.comment ? '✓ has comment' : '✗ MISSING comment'}`);
    });

    // Double-check column ordering and types
    console.log('\n--- stripe_events_processed Columns ---');
    const sepCols = await client.query(`
      SELECT column_name, data_type, column_default, is_nullable
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name='stripe_events_processed'
      ORDER BY ordinal_position
    `);
    sepCols.rows.forEach(col => {
      const def = col.column_default ? ` DEFAULT ${col.column_default}` : '';
      console.log(`  ${col.column_name}: ${col.data_type}${def}`);
    });

  } catch (e) {
    console.error('Error:', e.message);
  } finally {
    await client.end();
  }
}

audit();
