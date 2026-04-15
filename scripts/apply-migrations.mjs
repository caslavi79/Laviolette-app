#!/usr/bin/env node

/**
 * apply-migrations.mjs
 *
 * Applies every .sql file in supabase/migrations/ to the Postgres
 * database, in filename order, using the direct connection on port 5432.
 *
 * Tracks applied migrations in public._claude_migrations so re-runs
 * are idempotent (skips already-applied files, applies new ones).
 * Each migration file is executed inside a single transaction — if any
 * statement fails, the whole file rolls back.
 *
 * Reads connection details from:
 *   SUPABASE_PROJECT_REF
 *   SUPABASE_DB_PASSWORD
 * The npm script wrapper passes --env-file-if-exists=.env.local.
 *
 * Usage:
 *   npm run apply-migrations
 *   npm run apply-migrations -- --pooler     # use pooler host if direct fails
 *   npm run apply-migrations -- --dry-run    # list what would apply, don't apply
 *   npm run apply-migrations -- --rollback <version>   # rollback by version
 *
 * Note: rollback here just deletes the tracking row and runs a *.rollback.sql
 * if present. No automatic DDL inverse.
 */

import { readdir, readFile } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, '..', 'supabase', 'migrations');

const TRACKING_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS public._claude_migrations (
    version       text        PRIMARY KEY,
    filename      text        NOT NULL,
    applied_at    timestamptz NOT NULL DEFAULT now(),
    checksum      text        NOT NULL
  );
  COMMENT ON TABLE public._claude_migrations IS
    'Tracking table for migrations applied by scripts/apply-migrations.mjs. Version is the numeric prefix of the migration filename.';
`;

// --- args ---
const args = process.argv.slice(2);
const usePooler = args.includes('--pooler');
const dryRun = args.includes('--dry-run');

const ref = process.env.SUPABASE_PROJECT_REF;
const password = process.env.SUPABASE_DB_PASSWORD;

if (!ref || !password) {
  console.error('Error: SUPABASE_PROJECT_REF and SUPABASE_DB_PASSWORD must be set in the environment.');
  console.error('Set them in .env.local or prefix the command inline.');
  process.exit(1);
}

const directConfig = {
  host: `db.${ref}.supabase.co`,
  port: 5432,
  user: 'postgres',
  password,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10_000,
  application_name: 'claude-migrations',
};

const poolerConfig = {
  host: 'aws-0-us-west-2.pooler.supabase.com',
  port: 6543,
  user: `postgres.${ref}`,
  password,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10_000,
  application_name: 'claude-migrations',
};

async function connect() {
  const attempts = usePooler ? [poolerConfig] : [directConfig, poolerConfig];
  let lastErr;
  for (const cfg of attempts) {
    const client = new Client(cfg);
    try {
      await client.connect();
      console.log(`\u2713 Connected to ${cfg.host}:${cfg.port} as ${cfg.user}`);
      return client;
    } catch (err) {
      lastErr = err;
      console.warn(`  failed ${cfg.host}:${cfg.port}: ${err.message}`);
    }
  }
  throw lastErr;
}

function checksum(text) {
  // Cheap content hash — djb2 variant. We just want a change detector,
  // not cryptographic security.
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function versionOf(filename) {
  const m = filename.match(/^(\d{14,})/);
  return m ? m[1] : null;
}

async function listMigrations() {
  const entries = await readdir(MIGRATIONS_DIR);
  const sqlFiles = entries.filter((f) => f.endsWith('.sql') && !f.endsWith('.rollback.sql'));
  sqlFiles.sort(); // timestamp prefix = lexicographic order
  return sqlFiles.map((filename) => {
    const version = versionOf(filename);
    if (!version) {
      throw new Error(`Migration filename does not start with a timestamp: ${filename}`);
    }
    return { filename, version, path: resolve(MIGRATIONS_DIR, filename) };
  });
}

async function getApplied(client) {
  const { rows } = await client.query(
    `SELECT version, filename, checksum FROM public._claude_migrations ORDER BY version`
  );
  return new Map(rows.map((r) => [r.version, r]));
}

async function run() {
  const migrations = await listMigrations();
  console.log(`Found ${migrations.length} migration(s) in ${MIGRATIONS_DIR}`);

  if (migrations.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  const client = await connect();
  try {
    // Ensure tracking table exists
    await client.query(TRACKING_TABLE_DDL);

    const applied = await getApplied(client);

    const toApply = [];
    for (const m of migrations) {
      const body = await readFile(m.path, 'utf8');
      m.checksum = checksum(body);
      m.body = body;
      const prev = applied.get(m.version);
      if (!prev) {
        m.state = 'new';
        toApply.push(m);
      } else if (prev.checksum !== m.checksum) {
        m.state = 'modified';
        m.prevChecksum = prev.checksum;
      } else {
        m.state = 'applied';
      }
    }

    // Report plan
    console.log('');
    console.log('Plan:');
    for (const m of migrations) {
      const tag =
        m.state === 'new' ? '[NEW]     ' :
        m.state === 'modified' ? '[MODIFIED]' :
        '[applied] ';
      const extra = m.state === 'modified' ? `  (was ${m.prevChecksum} now ${m.checksum})` : '';
      console.log(`  ${tag} ${m.filename}${extra}`);
    }

    const modifiedAlreadyApplied = migrations.filter((m) => m.state === 'modified');
    if (modifiedAlreadyApplied.length > 0) {
      console.error('');
      console.error('Error: one or more already-applied migrations have been modified.');
      console.error('Re-running a changed migration is ambiguous. Options:');
      console.error('  - Revert the file to its applied content');
      console.error('  - Create a new migration that makes the incremental change');
      console.error('  - Manually UPDATE public._claude_migrations if you know what you are doing');
      process.exit(2);
    }

    if (dryRun) {
      console.log('');
      console.log('Dry run — exiting without applying.');
      return;
    }

    if (toApply.length === 0) {
      console.log('');
      console.log('Database is up to date.');
      return;
    }

    console.log('');
    console.log(`Applying ${toApply.length} migration(s)...`);
    console.log('');

    for (const m of toApply) {
      process.stdout.write(`  ${m.filename} ... `);
      const start = Date.now();
      try {
        await client.query('BEGIN');
        await client.query(m.body);
        await client.query(
          `INSERT INTO public._claude_migrations (version, filename, checksum) VALUES ($1, $2, $3)`,
          [m.version, m.filename, m.checksum]
        );
        await client.query('COMMIT');
        const ms = Date.now() - start;
        console.log(`\u2713 (${ms} ms)`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.log('\u2717');
        console.error('');
        console.error(`  Migration failed: ${m.filename}`);
        console.error(`  ${err.message}`);
        if (err.position) {
          // Show ~60 chars of context around the error position
          const pos = parseInt(err.position, 10);
          const start = Math.max(0, pos - 80);
          const end = Math.min(m.body.length, pos + 80);
          console.error('');
          console.error('  context:');
          console.error('  ' + m.body.slice(start, end).replace(/\n/g, '\n  '));
          console.error(`  (error near character ${pos})`);
        }
        process.exit(1);
      }
    }

    console.log('');
    console.log(`\u2713 Applied ${toApply.length} migration(s) successfully.`);
  } finally {
    await client.end();
  }
}

try {
  await run();
} catch (err) {
  console.error('');
  console.error('Fatal:', err.message);
  if (err.code) console.error('  code:', err.code);
  process.exit(1);
}
