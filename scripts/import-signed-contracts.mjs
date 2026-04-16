#!/usr/bin/env node

/**
 * import-signed-contracts.mjs
 *
 * Imports the 4 signed contracts from DocuSeal envelope 6852258
 * (Dustin Batson's services agreements, signed Apr 12, 2026).
 *
 * Steps:
 *   1. Rename "Vice Bar" → "Vice Downtown Bryan" (per the public-facing name)
 *   2. Delete any existing draft contracts
 *   3. Upload each signed PDF to the contracts storage bucket
 *   4. Create a contracts row with status='active', file_path, signing details
 *
 * Run once. Idempotent for everything except the upload (uses upsert).
 */

import pg from 'pg'
import { createClient } from '@supabase/supabase-js'
import { readFileSync, existsSync } from 'node:fs'

const { Client } = pg

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const SUPABASE_PROJECT_REF = process.env.SUPABASE_PROJECT_REF
const SUPABASE_DB_PASSWORD = process.env.SUPABASE_DB_PASSWORD

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_PROJECT_REF || !SUPABASE_DB_PASSWORD) {
  console.error('Missing required env vars. Check .env.local.')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const client = new Client({
  host: `db.${SUPABASE_PROJECT_REF}.supabase.co`,
  port: 5432,
  user: 'postgres',
  password: SUPABASE_DB_PASSWORD,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
})
await client.connect()

const SIGNED_DIR = '/Users/caselaviolette/Desktop/Laviolette/signed-contracts'
const SIGNED_AT = '2026-04-12T20:00:00-06:00'  // Apr 12, 2026 8:00 PM MDT
const SIGNED_DATE = '2026-04-12'
const PROVIDER_SIGNED_DATE = '2026-04-10'
const SIGNER_IP = '146.75.164.227'
const SIGNER_NAME = 'Dustin Batson'
const SIGNER_EMAIL = 'dusty.batson@gmail.com'

try {
  // 1. Rename Vice Bar → Vice Downtown Bryan
  const renameRes = await client.query("UPDATE brands SET name = 'Vice Downtown Bryan' WHERE name = 'Vice Bar' RETURNING id")
  if (renameRes.rowCount > 0) {
    console.log('✓ Renamed brand: Vice Bar → Vice Downtown Bryan')
  } else {
    console.log('  Brand already renamed (or doesn\'t exist as "Vice Bar")')
  }

  // 2. Get IDs
  const { rows: brands } = await client.query('SELECT id, name FROM brands ORDER BY name')
  const { rows: projects } = await client.query('SELECT id, name, type, brand_id FROM projects ORDER BY name')
  const vbtxClientId = (await client.query("SELECT id FROM clients WHERE name ILIKE '%vbtx%' LIMIT 1")).rows[0].id
  const velvetClientId = (await client.query("SELECT id FROM clients WHERE name ILIKE '%velvet%' LIMIT 1")).rows[0].id

  console.log('')
  console.log('Brands:'); brands.forEach(b => console.log('  ' + b.name + ' → ' + b.id.slice(0, 8)))
  console.log('Projects:'); projects.forEach(p => console.log('  ' + p.name + ' [' + p.type + '] → ' + p.id.slice(0, 8)))

  const findBrand = (name) => brands.find(b => b.name.toLowerCase().includes(name.toLowerCase())).id
  const findProject = (brandId, type) => projects.find(p => p.brand_id === brandId && p.type === type).id

  // 3. Delete existing draft contracts
  const { rowCount: deletedDrafts } = await client.query("DELETE FROM contracts WHERE status = 'draft'")
  console.log('')
  console.log(`✓ Deleted ${deletedDrafts} draft contract(s)`)

  // 4. Define the 4 signed contracts
  const contracts = [
    {
      file: 'Contract_Citrus_and_Salt_REVISED_UPDATED.pdf',
      name: 'Citrus and Salt Tequila Bar — Partnership Services Agreement',
      type: 'retainer',
      client_id: vbtxClientId,
      brand_id: findBrand('Citrus'),
      project_id: findProject(findBrand('Citrus'), 'retainer'),
      monthly_rate: 1200, total_fee: null, termination_fee: 1200,
      effective_date: '2026-05-01', end_date: '2026-07-31',
      payment_terms: 'Automatic ACH on the 1st of each month',
    },
    {
      file: 'Contract_Vice_Downtown_Bryan_REVISED_UPDATED.pdf',
      name: 'Vice Downtown Bryan — Partnership Services Agreement',
      type: 'retainer',
      client_id: vbtxClientId,
      brand_id: findBrand('Vice'),
      project_id: findProject(findBrand('Vice'), 'retainer'),
      monthly_rate: 1200, total_fee: null, termination_fee: 1200,
      effective_date: '2026-05-01', end_date: '2026-07-31',
      payment_terms: 'Automatic ACH on the 1st of each month',
    },
    {
      file: 'Contract_West_End_Elixir_REVISED_UPDATED.pdf',
      name: 'West End Elixir Company — Partnership Services Agreement',
      type: 'retainer',
      client_id: velvetClientId,
      brand_id: findBrand('West End'),
      project_id: findProject(findBrand('West End'), 'retainer'),
      monthly_rate: 1200, total_fee: null, termination_fee: 1200,
      effective_date: '2026-05-01', end_date: '2026-07-31',
      payment_terms: 'Automatic ACH on the 1st of each month',
    },
    {
      file: 'Buildout_Citrus_and_Salt_UPDATED.pdf',
      name: 'Citrus and Salt Tequila Bar — Build-Out Services Agreement',
      type: 'buildout',
      client_id: vbtxClientId,
      brand_id: findBrand('Citrus'),
      project_id: findProject(findBrand('Citrus'), 'buildout'),
      monthly_rate: null, total_fee: 1100, termination_fee: 1100,
      effective_date: '2026-05-01', end_date: null,
      payment_terms: 'Due in full on May 1, 2026 via ACH',
    },
  ]

  // 5. Upload PDFs and create contract rows
  console.log('')
  console.log('Importing 4 signed contracts...')
  let imported = 0
  for (const c of contracts) {
    const filePath = `${SIGNED_DIR}/${c.file}`
    if (!existsSync(filePath)) {
      console.log(`✗ File not found: ${filePath}`)
      continue
    }
    const pdfBuffer = readFileSync(filePath)
    const storagePath = `${c.client_id}/signed/${c.file}`

    const { error: uploadErr } = await supabase.storage
      .from('contracts')
      .upload(storagePath, pdfBuffer, { contentType: 'application/pdf', upsert: true })
    if (uploadErr) {
      console.log(`✗ Upload failed for ${c.file}: ${uploadErr.message}`)
      continue
    }

    const { rows: [inserted] } = await client.query(`
      INSERT INTO contracts (
        client_id, brand_id, project_id,
        name, type, status,
        effective_date, signing_date, end_date,
        monthly_rate, total_fee, termination_fee,
        payment_terms, auto_renew, renewal_notice_days,
        file_path,
        signer_name, signer_email,
        signed_at, signer_ip,
        notes
      ) VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, $9, $10, $11, $12, false, 30, $13, $14, $15, $16, $17, $18)
      RETURNING id, name
    `, [
      c.client_id, c.brand_id, c.project_id,
      c.name, c.type,
      c.effective_date, SIGNED_DATE, c.end_date,
      c.monthly_rate, c.total_fee, c.termination_fee,
      c.payment_terms,
      storagePath,
      SIGNER_NAME, SIGNER_EMAIL,
      SIGNED_AT, SIGNER_IP,
      `Imported from DocuSeal envelope 6852258. Provider signed ${PROVIDER_SIGNED_DATE}, client signed ${SIGNED_DATE}. Original PDF stored at file_path.`,
    ])
    console.log(`✓ ${inserted.name}`)
    imported++
  }

  console.log('')
  console.log(`Summary: ${imported}/${contracts.length} contracts imported.`)
  console.log('All marked status=active, signed Apr 12, 2026 by Dustin Batson.')
  console.log('Original PDFs stored in the contracts bucket.')
  console.log('')
  console.log('Open https://app.laviolette.io/contracts to review.')

} catch (err) {
  console.error('Error:', err.message)
  process.exit(1)
} finally {
  await client.end()
}
