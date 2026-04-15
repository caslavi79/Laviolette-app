# Laviolette App

Personal business management app for Case Laviolette (Laviolette LLC). Single-user SPA running at **app.laviolette.io**.

- **Frontend:** React + Vite + TypeScript + Tailwind + shadcn/ui
- **Backend:** Supabase (Postgres, Auth, Storage, Edge Functions)
- **Email:** Resend (Phase 4)
- **Payments:** Stripe ACH, managed in Stripe dashboard; app only tracks status
- **Deploy:** GitHub Pages via GitHub Actions

## Quick start

```bash
# Install
npm install

# Run local dev server (needs .env.local)
npm run dev

# Build for production
npm run build
```

## Environment

Copy `.env.example` → `.env.local` and fill in real values. Never commit `.env.local`.

| Variable | Where it's used |
|---|---|
| `VITE_SUPABASE_URL` | Frontend (Supabase client) |
| `VITE_SUPABASE_ANON_KEY` | Frontend (RLS-protected) |
| `SUPABASE_SERVICE_ROLE_KEY` | Local admin scripts only |
| `SUPABASE_DB_PASSWORD` | `psql` / migration scripts |
| `STRIPE_SECRET_KEY` | `scripts/stripe-setup.js` (local only; prod uses Supabase Edge Function secret) |
| `RESEND_API_KEY` | Reminder emails (Phase 4) |

## Repo layout

```
Laviolette-app/
├── scripts/              # Node admin scripts (auth user creation, Stripe CLI)
├── supabase/
│   ├── config.toml       # Supabase CLI config
│   ├── migrations/       # Versioned SQL migrations
│   └── functions/        # Deno Edge Functions
├── src/                  # React app
├── public/               # Static assets (favicon, etc.)
├── .github/workflows/    # CI/CD
└── CNAME                 # Custom domain for GitHub Pages
```

## Deploy

- **Trigger:** push to `main` runs `.github/workflows/deploy.yml`.
- **GitHub Pages:** serves `dist/` at `app.laviolette.io`.
- **DNS:** CNAME record pre-configured for `app.laviolette.io`.
- **Supabase:** migrations deploy via `supabase db push`; Edge Functions via `supabase functions deploy <name>`.

## Scripts

- `scripts/stripe-setup.js` — generate a Stripe Checkout Session for a client to connect their bank. See [scripts/README.md](scripts/README.md).
- `scripts/create-auth-user.mjs` — one-time bootstrap to create `case.laviolette@gmail.com` in Supabase Auth.

## Design spec

Full design spec (not in this repo, kept in the parent `Desktop/Laviolette/app/` folder) is the source of truth for screen layouts, table schemas, and automation logic.
