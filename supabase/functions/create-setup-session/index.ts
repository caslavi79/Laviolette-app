// create-setup-session
// Issues a Stripe Checkout Session in setup mode so a client can
// connect their bank via Financial Connections without being charged.
// Matches scripts/stripe-setup.js but runs server-side so the Stripe
// secret key never touches the browser. Auth-gated (Case only).

import Stripe from 'https://esm.sh/stripe@17?target=deno'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

function env(key: string): string {
  const v = Deno.env.get(key)
  if (!v) throw new Error(`Missing required env: ${key}`)
  return v
}

const SUPABASE_URL = env('SUPABASE_URL')
const SUPABASE_ANON_KEY = env('SUPABASE_ANON_KEY')
const STRIPE_SECRET_KEY = env('STRIPE_SECRET_KEY')
const SUCCESS_BASE = Deno.env.get('STRIPE_SUCCESS_URL') || 'https://app.laviolette.io/setup-success'
const CANCEL_URL = Deno.env.get('STRIPE_CANCEL_URL') || 'https://app.laviolette.io/setup-cancel'

const stripe = new Stripe(STRIPE_SECRET_KEY)

const ALLOWED_ORIGINS = [
  'https://app.laviolette.io',
  'https://laviolette.io',
  'http://localhost:5180',
  'http://localhost:5173',
]
function cors(req: Request) {
  const origin = req.headers.get('Origin') || ''
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  }
}

function json(body: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } })
}

Deno.serve(async (req: Request) => {
  const corsHeaders = cors(req)
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders })
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return json({ error: 'Unauthorized' }, 401, corsHeaders)
    }
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user }, error: authErr } = await supabase.auth.getUser()
    if (authErr || !user) return json({ error: 'Unauthorized' }, 401, corsHeaders)

    const { stripe_customer_id, client_name } = await req.json()
    if (!stripe_customer_id || typeof stripe_customer_id !== 'string' || !stripe_customer_id.startsWith('cus_')) {
      return json({ error: 'stripe_customer_id must start with "cus_"' }, 400, corsHeaders)
    }

    const session = await stripe.checkout.sessions.create({
      customer: stripe_customer_id,
      mode: 'setup',
      payment_method_types: ['us_bank_account'],
      payment_method_options: {
        us_bank_account: {
          financial_connections: { permissions: ['payment_method'] },
          verification_method: 'instant',
        },
      },
      success_url: `${SUCCESS_BASE}?client=${encodeURIComponent(client_name || '')}`,
      cancel_url: CANCEL_URL,
    })

    return json({
      url: session.url,
      client_name: client_name || '',
      session_id: session.id,
      expires_at: new Date(session.expires_at * 1000).toISOString(),
    }, 200, corsHeaders)
  } catch (err) {
    console.error('create-setup-session error:', err)
    return json({ error: String((err as Error).message || err) }, 500, corsHeaders)
  }
})
