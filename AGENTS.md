# AGENTS.md — read this first

Instructions for any AI agent (v0, Vercel Agent, etc.) importing or booting this repo.

## This app CANNOT boot without env vars — set them BEFORE `pnpm dev`

`proxy.ts` runs on every request and creates a Supabase client. With no
Supabase env, the dev server returns **HTTP 500** on every route with:

> Error: Your project's URL and Key are required to create a Supabase client!

**A 500 or a "VM start failed" here is almost always missing env — NOT a bug in
`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, or `--frozen-lockfile`.**
Do not debug the install/lockfile. Set env, then restart.

## Correct boot order — do NOT ask for every env var up front

Only the **STEP 1** block in `.env.example` is needed to boot. Do not prompt for
Vercel / Kapso / Fleet-secret vars during import — those come later, mostly from
inside the app.

1. **Connect the Supabase integration** (this auto-fills the STEP 1 vars:
   `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
   `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `DATABASE_URL`, `DIRECT_URL`,
   `SUPABASE_SECRET_KEY`). Then set `FLEET_OPERATOR_EMAIL` and `APP_URL`.
2. `pnpm install`
3. `pnpm exec drizzle-kit push` — creates the DB schema (uses `DIRECT_URL`).
4. `pnpm dev`
5. Create the operator login: Supabase → Authentication → Users → Add user, with
   the email that matches `FLEET_OPERATOR_EMAIL`. It's the only account the gate allows.

**Everything in STEP 2 of `.env.example` is optional** — leave it blank to run
locally. Add it only when you Deploy an agent (`VERCEL_TOKEN`, `VERCEL_TEAM_ID`,
the Fleet secrets) or wire up a channel (Kapso). Blank STEP 2 does not break dev.

Full architecture + where to get each credential: **[`CLAUDE.md`](./CLAUDE.md)**.
