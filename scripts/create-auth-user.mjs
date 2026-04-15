#!/usr/bin/env node

/**
 * create-auth-user.mjs
 *
 * One-time bootstrap for the Supabase auth user.
 * - If case.laviolette@gmail.com already exists, reports and exits 0.
 * - Otherwise creates the user with a random strong temporary password
 *   and prints the password once (to STDOUT). Case logs in with it and
 *   resets via the app's "Change password" flow or Supabase dashboard.
 *
 * Usage:
 *   npm run create-auth-user
 *
 * Reads from env:
 *   VITE_SUPABASE_URL           — project URL (for the /auth/v1 endpoint)
 *   SUPABASE_SERVICE_ROLE_KEY   — admin privileges
 */

import { randomBytes } from 'node:crypto';

const url = process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error('Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const email = 'case.laviolette@gmail.com';

function makeTempPassword() {
  // 24 bytes → 32 chars of url-safe base64. Strong enough for a throwaway first-login pw.
  return randomBytes(24).toString('base64url');
}

async function adminFetch(path, init = {}) {
  const res = await fetch(`${url}/auth/v1/admin${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

async function findUserByEmail(targetEmail) {
  const { status, body } = await adminFetch(
    `/users?page=1&per_page=200`
  );
  if (status !== 200) {
    throw new Error(`list users failed: ${status} ${JSON.stringify(body)}`);
  }
  const match = (body.users || []).find((u) => u.email?.toLowerCase() === targetEmail.toLowerCase());
  return match || null;
}

async function run() {
  const existing = await findUserByEmail(email);

  if (existing) {
    console.log(`User already exists: ${email}`);
    console.log(`  id:         ${existing.id}`);
    console.log(`  created_at: ${existing.created_at}`);
    console.log(`  confirmed:  ${existing.email_confirmed_at ? 'yes' : 'no'}`);
    console.log('');
    console.log('If you need to reset the password, use the Supabase dashboard:');
    console.log(`  ${url.replace('.supabase.co', '.supabase.com')}/project/${(new URL(url)).hostname.split('.')[0]}/auth/users`);
    return;
  }

  const password = makeTempPassword();

  const { status, body } = await adminFetch('/users', {
    method: 'POST',
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
    }),
  });

  if (status !== 200 && status !== 201) {
    console.error(`create user failed: ${status}`);
    console.error(JSON.stringify(body, null, 2));
    process.exit(1);
  }

  console.log('');
  console.log('\u2713 Auth user created.');
  console.log(`  email:    ${body.email}`);
  console.log(`  id:       ${body.id}`);
  console.log(`  password: ${password}`);
  console.log('');
  console.log('WRITE THIS PASSWORD DOWN NOW. It will not be displayed again.');
  console.log('On first login, change it via the Supabase dashboard.');
  console.log('');
}

try {
  await run();
} catch (err) {
  console.error('Fatal:', err.message);
  process.exit(1);
}
