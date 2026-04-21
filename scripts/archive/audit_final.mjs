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

    // Check CHECK constraints on notification_failures
    console.log('--- CHECK Constraints on notification_failures ---');
    const constraints = await client.query(`
      SELECT con.conname as constraint_name, 
             pg_get_constraintdef(con.oid) as definition
      FROM pg_constraint con
      JOIN pg_class rel ON con.conrelid = rel.oid
      JOIN pg_namespace nsp ON rel.relnamespace = nsp.oid
      WHERE nsp.nspname='public' AND rel.relname='notification_failures' AND con.contype='c'
    `);
    if (constraints.rows.length === 0) {
      console.log('ERROR: No CHECK constraints found!');
    } else {
      constraints.rows.forEach(c => console.log(`  ${c.constraint_name}: ${c.definition}`));
    }

    // Sample check: verify kind constraint is correct
    console.log('\n--- Constraint Validation ---');
    try {
      await client.query(`INSERT INTO notification_failures(kind, context, error) VALUES('invalid', 'test', 'err')`);
      console.log('ERROR: Invalid kind value was accepted! Constraint missing.');
      await client.query(`DELETE FROM notification_failures WHERE context='test'`);
    } catch (e) {
      if (e.message.includes('new row')) {
        console.log('✓ kind CHECK constraint properly restricts invalid values');
      }
    }

    // Check if the unique index on invoices.period_month is truly unique (not just partial)
    console.log('\n--- Unique Index Definition ---');
    const uniqueIdx = await client.query(`
      SELECT indexname, indexdef, is_unique
      FROM pg_indexes 
      WHERE schemaname='public' AND indexname='invoices_project_period_month_unique'
    `);
    if (uniqueIdx.rows.length > 0) {
      const idx = uniqueIdx.rows[0];
      console.log(`  ${idx.indexname} - UNIQUE: ${idx.is_unique}`);
      console.log(`  Definition: ${idx.indexdef}`);
    }

    // Verify no cascading deletes that shouldn't exist
    console.log('\n--- Foreign Key Checks ---');
    const fks = await client.query(`
      SELECT
        constraint_name,
        table_name,
        column_name,
        foreign_table_name,
        foreign_column_name,
        (SELECT confdeltype FROM information_schema.referential_constraints rc 
         WHERE rc.constraint_name=kcu.constraint_name) as delete_rule
      FROM information_schema.key_column_usage kcu
      WHERE table_schema='public' 
      AND (table_name IN ('stripe_events_processed', 'notification_failures', 'invoices') 
           OR foreign_table_name IN ('stripe_events_processed', 'notification_failures'))
      LIMIT 20
    `);
    if (fks.rows.length === 0) {
      console.log('  ✓ No foreign keys on new tables (expected for idempotency/DLQ)');
    } else {
      fks.rows.forEach(fk => console.log(`  ${fk.table_name} -> ${fk.foreign_table_name}: ${fk.delete_rule}`));
    }

    // Check if all column comments exist
    console.log('\n--- Column Comments ---');
    const colComments = await client.query(`
      SELECT column_name, col_description(attrelid, attnum) as comment
      FROM pg_attribute
      JOIN pg_class ON pg_class.oid = attrelid
      JOIN pg_namespace ON pg_namespace.oid = relnamespace
      WHERE nspname='public' AND relname='notification_failures'
      AND attnum > 0
    `);
    const withoutComments = colComments.rows.filter(r => !r.comment);
    if (withoutComments.length > 0) {
      console.log('⚠ MISSING COMMENTS on:');
      withoutComments.forEach(r => console.log(`  notification_failures.${r.column_name}`));
    } else {
      console.log('  ✓ All columns have comments');
    }

  } catch (e) {
    console.error('Error:', e.message, e.detail);
  } finally {
    await client.end();
  }
}

audit();
