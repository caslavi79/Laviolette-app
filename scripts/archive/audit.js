import pg from 'pg';
import fs from 'fs';
import path from 'path';

const envPath = path.resolve('.env.local');
const envContent = fs.readFileSync(envPath, 'utf-8');
const envVars = {};
envContent.split('\n').forEach(line => {
  const match = line.match(/^([A-Z_]+)=(.+)$/);
  if (match) envVars[match[1]] = match[2];
});

const c = new pg.Client({
  host: `db.${envVars.SUPABASE_PROJECT_REF}.supabase.co`,
  port: 5432,
  user: 'postgres',
  password: envVars.SUPABASE_DB_PASSWORD,
  database: 'postgres',
  ssl: { rejectUnauthorized: false }
});

await c.connect();

const issues = [];

// 1. Row counts
console.log('=== TABLE ROW COUNTS ===');
const tables = (await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
for (const t of tables) {
  const cnt = (await c.query(`SELECT COUNT(*) as cnt FROM ${t.tablename}`)).rows[0];
  console.log(`${t.tablename}: ${cnt.cnt}`);
}
console.log();

// 2. Orphans
console.log('=== ORPHAN CHECKS ===');
const orphanClients = await c.query('SELECT id, name FROM clients WHERE NOT EXISTS (SELECT 1 FROM brands WHERE client_id=clients.id)');
if (orphanClients.rows.length > 0) {
  issues.push(`ERROR · clients without brands · ${orphanClients.rows.length} · invoicing will fail`);
  console.log(`✓ All clients have brands`);
} else {
  console.log('✓ All clients have brands');
}
console.log();

// 3. Enum check
console.log('=== ENUM CONSISTENCY ===');
const invStatuses = (await c.query('SELECT DISTINCT status FROM invoices')).rows.map(r => r.status);
console.log(`Invoice statuses: ${invStatuses.join(', ')}`);
const projTypes = (await c.query('SELECT DISTINCT type FROM projects')).rows.map(r => r.type);
console.log(`Project types: ${projTypes.join(', ')}`);
console.log();

// 4. Stripe uniqueness
console.log('=== STRIPE UNIQUENESS ===');
const dups = (await c.query('SELECT stripe_customer_id, COUNT(*) FROM clients WHERE stripe_customer_id IS NOT NULL GROUP BY stripe_customer_id HAVING COUNT(*) > 1')).rows;
if (dups.length > 0) {
  issues.push(`ERROR · stripe_customer_id duplicates · ${dups.length}`);
  console.log(`ERROR · Found duplicates`);
} else {
  console.log('✓ All stripe_customer_id unique');
}
console.log();

// 5. Period format on retainers
console.log('=== RETAINER INVOICE PERIODS ===');
const retainerInvs = (await c.query(`
  SELECT i.id, i.invoice_number, i.period_month FROM invoices i
  WHERE i.project_id IN (SELECT id FROM projects WHERE type='retainer')
`)).rows;
console.log(`Retainer invoices: ${retainerInvs.length}`);
const badPeriods = retainerInvs.filter(i => !i.period_month);
if (badPeriods.length > 0) {
  issues.push(`WARN · retainer invoices with NULL period_month · ${badPeriods.length}`);
}
retainerInvs.forEach(i => {
  const pStr = i.period_month ? i.period_month.toISOString().split('T')[0] : 'NULL';
  console.log(`  ${i.invoice_number}: period_month=${pStr}`);
});
console.log();

// 6. Paid without paid_date
console.log('=== PAID INVOICE INTEGRITY ===');
const paidNoPaid = (await c.query("SELECT id, invoice_number FROM invoices WHERE status='paid' AND paid_date IS NULL")).rows;
if (paidNoPaid.length > 0) {
  issues.push(`ERROR · paid invoices with NULL paid_date · ${paidNoPaid.length}`);
} else {
  console.log('✓ No paid invoices missing paid_date');
}
console.log();

// 7. Dual Stripe IDs
console.log('=== STRIPE ID CONFLICTS ===');
const allInvs = (await c.query('SELECT id, invoice_number, stripe_payment_intent_id, stripe_invoice_id FROM invoices')).rows;
const dualIds = allInvs.filter(i => i.stripe_payment_intent_id && i.stripe_invoice_id && i.invoice_number !== 'LV-2026-005');
if (dualIds.length > 0) {
  issues.push(`ERROR · invoices with both PI and SI IDs · ${dualIds.length} · mutually exclusive except LV-2026-005`);
  console.log(`ERROR · ${dualIds.length} invoices have both IDs`);
} else {
  console.log('✓ No dual Stripe IDs (except legacy LV-2026-005)');
}
console.log();

// 8. TEST records
console.log('=== TEST RECORDS (cleanup safe after 2026-04-23) ===');
const testRecs = (await c.query(`SELECT invoice_number, description FROM invoices WHERE description ILIKE '%test%' OR description ILIKE '%delete%'`)).rows;
if (testRecs.length > 0) {
  console.log(`INFO · Found ${testRecs.length} TEST record(s):`);
  testRecs.forEach(r => console.log(`  ${r.invoice_number}: "${r.description}"`));
} else {
  console.log('✓ No TEST records found');
}
console.log();

// 9. May invoices
console.log('=== MAY 2026 INVOICE SET (EXPECTED: 4) ===');
const mayInvs = (await c.query("SELECT invoice_number FROM invoices WHERE period_month::text LIKE '2026-05%' ORDER BY invoice_number")).rows;
const expectedNums = ['LV-2026-001', 'LV-2026-002', 'LV-2026-003', 'LV-2026-004'];
const foundNums = mayInvs.map(i => i.invoice_number);
const missingNums = expectedNums.filter(n => !foundNums.includes(n));
if (missingNums.length > 0) {
  issues.push(`ERROR · missing May invoices · ${missingNums.length} · ${missingNums.join(', ')}`);
  console.log(`ERROR · Missing: ${missingNums.join(', ')}`);
  console.log(`Found: ${foundNums.length ? foundNums.join(', ') : '(none)'}`);
} else {
  console.log(`✓ All 4 expected May invoices present`);
  foundNums.forEach(n => console.log(`  ${n}`));
}
console.log();

// 10. Retainer rates — check contracts linked to retainer projects
console.log('=== RETAINER RATE CONFIG (via contracts) ===');
const retainers = (await c.query("SELECT id, name FROM projects WHERE type='retainer'")).rows;
let noRateCount = 0;
for (const proj of retainers) {
  const contract = (await c.query(`SELECT monthly_rate FROM contracts WHERE project_id=$1`, [proj.id])).rows[0];
  const rate = contract ? contract.monthly_rate : null;
  console.log(`  ${proj.name}: monthly_rate=${rate}`);
  if (!rate || rate === 0) {
    noRateCount++;
    issues.push(`ERROR · retainer project missing monthly_rate · ${proj.name} · will break generate-retainer-invoices`);
  }
}
if (noRateCount === 0) console.log(`✓ All ${retainers.length} retainer(s) have monthly_rate configured`);

console.log('\n\n=== AUDIT SUMMARY ===\n');
if (issues.length === 0) {
  console.log('✓ All checks passed. Database is clean.');
} else {
  console.log(`Found ${issues.length} issue(s):\n`);
  issues.forEach(issue => console.log(issue));
}

await c.end();
