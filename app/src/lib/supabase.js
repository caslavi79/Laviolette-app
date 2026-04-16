import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    '[Laviolette] Missing Supabase environment variables.\n' +
    'Create app/.env with VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.\n' +
    'See app/.env.example for reference.'
  )
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
