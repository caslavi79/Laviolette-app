# Laviolette App

Personal business management app for Case Laviolette (Laviolette LLC). Single-user SPA running at **app.laviolette.io**.

- **Frontend:** React 19 + Vite + React Router 7
- **Backend:** Supabase (Postgres, Auth, Storage, Edge Functions)
- **Email:** Resend (reminder digests)
- **Payments:** Stripe (ACH bank collection + invoice creation)
- **Deploy:** GitHub Pages via `gh-pages` to a separate deploy repo

**Operations runbook:** see [OPS.md](OPS.md) for deploy commands, edge function setup, and troubleshooting.

## Quick start (local dev)

```bash
cd app
npm install          # first time only
npm run dev          # http://localhost:5180
```

Open the app, sign in with `case.laviolette@gmail.com` + the temporary password you recorded in Phase 1.

## Ship a frontend change

```bash
cd app
npm run deploy       # builds → pushes dist/ to caslavi79/Laviolette-app-deploy → live in ~45s
```

## Layout

```
Laviolette-app/
├── app/                  # React source (Vite)
│   ├── src/
│   │   ├── App.jsx, App.css, main.jsx
│   │   ├── components/   # Modal, Field, Layout, ProtectedRoute, forms/*
│   │   ├── pages/        # Today, Schedule, Contacts, Projects, Money, Contracts, Sign, Setup*
│   │   └── lib/          # supabase.js, format.js, hooks.js
│   ├── public/           # CNAME, favicon
│   └── vite.config.js
├── scripts/              # Admin scripts
│   ├── stripe-setup.js       # Stripe ACH bank link generator
│   ├── apply-migrations.mjs  # pg-based migration runner
│   ├── create-auth-user.mjs  # Supabase Auth bootstrap
│   ├── verify-schema.mjs     # DB schema sanity check
│   └── deploy-edge.sh        # Deploys all edge functions
├── supabase/
│   ├── migrations/       # 13 versioned SQL files (enums → tables → triggers → RLS)
│   ├── functions/        # 10 Deno edge functions
│   └── sql/              # cron-schedule.sql
├── OPS.md                # Operations runbook
└── package.json          # Node deps for scripts/
```

## Environment

Copy `.env.example` → `.env.local` and `app/.env.example` → `app/.env`, fill in real values. Both `.env` files are gitignored.

| Variable | File | Purpose |
|---|---|---|
| `VITE_SUPABASE_URL` | `app/.env` | Frontend Supabase client |
| `VITE_SUPABASE_ANON_KEY` | `app/.env` | Frontend (RLS-protected) |
| `SUPABASE_SERVICE_ROLE_KEY` | `.env.local` | `scripts/` admin |
| `SUPABASE_DB_PASSWORD` | `.env.local` | `apply-migrations` direct pg |
| `SUPABASE_PROJECT_REF` | `.env.local` | All scripts |
| `STRIPE_SECRET_KEY` | `.env.local` | `stripe-setup.js` local use |

Edge function secrets live in Supabase Dashboard, not in this repo. See [OPS.md](OPS.md).

## Status

| Phase | State |
|---|---|
| 0. Repo + credentials | ✅ |
| 0.5. Stripe CLI + static redirect pages | ✅ live on laviolette.io |
| 1. DB schema | ✅ 16 tables, 100% comments, triggers, RLS |
| 2. Frontend scaffold + auth | ✅ verified end-to-end |
| 3.1 Today | ✅ |
| 3.2 Contacts/Clients/Brands | ✅ three-tier CRUD verified |
| 3.3 Projects | ✅ buildouts + retainers |
| 3.4 Schedule | ✅ weekly template + overrides |
| 3.5 Money | ✅ invoices + revenue + expenses |
| 3.6 Contracts | ✅ editor + signing flow |
| 4. Edge functions | 🟡 code written, deploy pending (see OPS.md) |
| 5. Frontend deploy | ✅ live at app.laviolette.io |
