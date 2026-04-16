#!/usr/bin/env node

/**
 * generate-contract.mjs
 *
 * Generates a complete HTML contract from a project ID and inserts it
 * into the contracts table as a draft. Designed to be called by Claude
 * Code after Case describes what he wants in natural language.
 *
 * Usage:
 *   node scripts/generate-contract.mjs <project-id> [--toggle key=true/false] [--set key=value] [--dry-run]
 *
 * Examples:
 *   # Generate a retainer contract from the Vice Bar project
 *   node scripts/generate-contract.mjs abc123
 *
 *   # Generate with remote_systems disabled and custom governing law
 *   node scripts/generate-contract.mjs abc123 --toggle remote_systems=false --set governing_state=Colorado --set governing_county="El Paso County"
 *
 *   # Preview without saving
 *   node scripts/generate-contract.mjs abc123 --dry-run
 *
 * Reads SUPABASE_PROJECT_REF and SUPABASE_DB_PASSWORD from .env.local.
 * The npm script wrapper passes --env-file-if-exists=.env.local.
 */

import pg from 'pg'
import { generateRetainerHTML, buildServicesTable } from '../app/src/templates/retainer.js'
import { generateBuildoutHTML, buildDeliverablesTable } from '../app/src/templates/buildout.js'
import { buildVariables } from '../app/src/templates/index.js'

const { Client } = pg

// Parse CLI args
const args = process.argv.slice(2)
const projectId = args.find((a) => !a.startsWith('--'))
const dryRun = args.includes('--dry-run')
const toggleOverrides = {}
const setOverrides = {}

args.forEach((arg, i) => {
  if (arg === '--toggle' && args[i + 1]) {
    const [k, v] = args[i + 1].split('=')
    toggleOverrides[k] = v !== 'false'
  }
  if (arg === '--set' && args[i + 1]) {
    const [k, ...rest] = args[i + 1].split('=')
    setOverrides[k] = rest.join('=')
  }
})

if (!projectId || projectId.startsWith('--')) {
  console.error('Usage: node scripts/generate-contract.mjs <project-id> [options]')
  console.error('')
  console.error('Options:')
  console.error('  --toggle key=true/false   Override a section toggle')
  console.error('  --set key=value           Override a variable field')
  console.error('  --dry-run                 Preview without saving to DB')
  console.error('')
  console.error('Or: Claude Code can import buildVariables + generate*HTML directly.')
  process.exit(1)
}

const ref = process.env.SUPABASE_PROJECT_REF
const password = process.env.SUPABASE_DB_PASSWORD
if (!ref || !password) {
  console.error('Missing SUPABASE_PROJECT_REF or SUPABASE_DB_PASSWORD in environment.')
  process.exit(1)
}

const client = new Client({
  host: `db.${ref}.supabase.co`,
  port: 5432,
  user: 'postgres',
  password,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
})

try {
  await client.connect()

  // Load project with all related data
  const { rows: [project] } = await client.query(`
    SELECT p.*,
           b.name AS brand_name, b.color AS brand_color, b.id AS _brand_id, b.client_id AS _client_id,
           c.name AS client_name, c.legal_name, c.billing_email, c.payment_method, c.stripe_customer_id,
           ct.name AS contact_name, ct.email AS contact_email, ct.phone AS contact_phone, ct.id AS _contact_id
    FROM projects p
    JOIN brands b ON b.id = p.brand_id
    JOIN clients c ON c.id = b.client_id
    JOIN contacts ct ON ct.id = c.contact_id
    WHERE p.id = $1
  `, [projectId])

  if (!project) {
    console.error(`Project not found: ${projectId}`)
    process.exit(1)
  }

  // Load services or deliverables
  let services = []
  let deliverables = []

  if (project.type === 'retainer') {
    const { rows } = await client.query(
      'SELECT * FROM retainer_services WHERE project_id = $1 AND active = true ORDER BY number',
      [projectId]
    )
    services = rows
  } else {
    const { rows } = await client.query(
      'SELECT * FROM deliverables WHERE project_id = $1 ORDER BY number',
      [projectId]
    )
    deliverables = rows
  }

  // Convert Date objects to ISO date strings (pg returns Date objects for date columns)
  for (const key of ['start_date', 'end_date', 'intro_term_end']) {
    if (project[key] instanceof Date) project[key] = project[key].toISOString().slice(0, 10)
  }

  // Build variables
  const brand = { name: project.brand_name, color: project.brand_color }
  const clientObj = {
    id: project._client_id,
    name: project.client_name,
    legal_name: project.legal_name,
    billing_email: project.billing_email,
    payment_method: project.payment_method,
    stripe_customer_id: project.stripe_customer_id,
  }
  const contact = { name: project.contact_name, email: project.contact_email, phone: project.contact_phone }

  const vars = {
    ...buildVariables(project, { brand, client: clientObj, contact, services, deliverables }),
    ...setOverrides,
  }

  // Determine template and toggles
  const isRetainer = project.type === 'retainer'
  const defaultToggles = isRetainer
    ? { remote_systems: true, reporting: true, late_fees: true, rate_adjustments: true, pre_effective_termination: true }
    : { late_fees: true, revisions: true, post_engagement: true }
  const toggles = { ...defaultToggles, ...toggleOverrides }

  // Generate HTML
  const html = isRetainer
    ? generateRetainerHTML(vars, toggles)
    : generateBuildoutHTML(vars, toggles)

  console.log('')
  console.log(`✓ Generated ${isRetainer ? 'Partnership Services Agreement' : 'Build-Out Services Agreement'}`)
  console.log(`  Brand:    ${vars.brand_name}`)
  console.log(`  Client:   ${vars.client_name}`)
  console.log(`  Fee:      $${isRetainer ? vars.monthly_rate + '/mo' : vars.total_fee}`)
  console.log(`  Effective: ${vars.effective_date}`)
  if (isRetainer) {
    console.log(`  Intro:    ${vars.intro_term_months} months → ${vars.intro_term_end}`)
    console.log(`  Services: ${vars.service_count} (${services.length} rows)`)
  } else {
    console.log(`  Timeline: ${vars.timeline}`)
    console.log(`  Deliverables: ${vars.deliverable_count} (${deliverables.length} rows)`)
  }
  console.log(`  HTML size: ${(html.length / 1024).toFixed(1)} KB`)
  console.log('')

  if (dryRun) {
    console.log('Dry run — not saving. HTML preview:')
    console.log('─'.repeat(60))
    // Print first 2000 chars as a preview
    console.log(html.replace(/<[^>]*>/g, '').slice(0, 2000))
    console.log('...')
    console.log('─'.repeat(60))
    console.log('Run without --dry-run to save as a draft contract.')
  } else {
    const agreementType = isRetainer ? 'Partnership Services Agreement' : 'Build-Out Services Agreement'
    const contractName = `${vars.brand_name} ${agreementType}`
    const terminationFee = isRetainer ? project.total_fee : project.total_fee

    const { rows: [inserted] } = await client.query(`
      INSERT INTO contracts (
        client_id, brand_id, project_id,
        name, type, status,
        effective_date, end_date,
        monthly_rate, total_fee, termination_fee,
        payment_terms, auto_renew, renewal_notice_days,
        filled_html,
        signer_name, signer_email,
        field_values,
        notes
      ) VALUES (
        $1, $2, $3,
        $4, $5, 'draft',
        $6, $7,
        $8, $9, $10,
        $11, false, 30,
        $12,
        $13, $14,
        $15,
        'Generated by Claude Code via generate-contract.mjs'
      ) RETURNING id, name
    `, [
      project._client_id,
      project._brand_id || project.brand_id,
      project.id,
      contractName,
      project.type,
      project.start_date,
      project.intro_term_end || project.end_date,
      isRetainer ? project.total_fee : null,
      isRetainer ? null : project.total_fee,
      terminationFee,
      vars.payment_method,
      html,
      vars.client_name,
      vars.client_email,
      JSON.stringify({ templateId: project.type, vars, toggles }),
    ])

    console.log(`✓ Saved as draft: "${inserted.name}"`)
    console.log(`  Contract ID: ${inserted.id}`)
    console.log(`  Review at: https://app.laviolette.io/contracts`)
    console.log('')
    console.log('Next: open the app, review the contract, then "Send for signing".')
  }
} catch (err) {
  console.error('Error:', err.message)
  process.exit(1)
} finally {
  await client.end()
}
