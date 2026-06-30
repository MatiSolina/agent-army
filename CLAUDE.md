# CLAUDE.md — agent-army

Onboarding + architecture for anyone (human or AI assistant) working in a fork of this repo. Read this first.

## What this is

A **control-plane** to define AI agents and deploy each one as its **own [Eve](https://github.com/vercel/eve) project on Vercel** — its own runtime. Many agents = many independent Vercel deployments (a fleet). You manage them from one dashboard.

## Core mental model (read this before touching code)

- **Your Supabase config is the agent's definition (the source).** You edit it in the dashboard; it lives in Postgres.
- **"Deploy" compiles that config into a real Eve project and ships it** to Vercel via the REST API. The deployed Eve app is the **production runtime**.
- A Deploy is a **snapshot**: editing config does *not* change a deployed agent until you re-Deploy. Each Deploy is a real Vercel project (counts against your Vercel quota).
- The dashboard's own playground / `generateAgentReply` is **Test/preview only** — never the production runtime.
- **Single-tenant data behind an auth gate.** `getUserId()` returns a fixed demo owner (no per-user data boundary). Login is real (Supabase Auth) but only `FLEET_OPERATOR_EMAIL` gets past the gate, enforced by `proxy.ts` on every route. Don't turn this into multi-tenancy unless you actually need it.

## Quickstart (fresh fork → running locally)

Prerequisites: **Node 22+**, **pnpm**. (Node 24+ only if you want to run the `eve` CLI locally; deploys build remotely so you don't strictly need it.)

```bash
pnpm install
cp .env.example .env.local      # then fill it in — see "Where to get each value" below
pnpm exec drizzle-kit push      # create the DB schema in your Supabase project
pnpm dev                        # http://localhost:3000
```

Then create your operator login (one-time): in the Supabase dashboard → **Authentication → Users → Add user**, create a user whose email matches `FLEET_OPERATOR_EMAIL`. That's the only account allowed in.

### Verify your setup

```bash
pnpm test               # vitest
pnpm exec tsc --noEmit
pnpm lint
pnpm build
```

## Where to get each value (`.env.local`)

You need a **Supabase project** (free tier is fine). Everything else is optional until you want to actually deploy agents.

### Required to run the dashboard

| Variable | Where to get it |
| --- | --- |
| `DATABASE_URL` | Supabase → Project Settings → **Database → Connection string** → *Transaction pooler* (port 6543). Used at runtime. |
| `DIRECT_URL` | Same page → *Session pooler* (port 5432). Used for DDL / `drizzle-kit push` (DDL doesn't run over the transaction pooler). |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → **API → Project URL**. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → API → **anon/public key**. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase → API → publishable key (newer projects). |
| `SUPABASE_PROJECT_ID` | The `xxxx` in your project URL `https://xxxx.supabase.co`. |
| `SUPABASE_SECRET_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | Supabase → API → **service_role / secret key**. Server-side only — never expose. |
| `FLEET_OPERATOR_EMAIL` | The single email allowed past the login gate. Use your own. |
| `APP_URL` / `NEXT_PUBLIC_APP_URL` | `http://localhost:3000` locally; your deployed URL in production. |

### Required to use the **Deploy** button (ship agents to Vercel)

| Variable | Where to get it |
| --- | --- |
| `VERCEL_TOKEN` / `VERCEL_ACCESS_TOKEN` | Vercel → **Account Settings → Tokens** → create a token. |
| `VERCEL_TEAM_ID` | Vercel → Team Settings → **General**, the `team_...` id (or your personal account id). |
| `VERCEL_TEAM_SLUG` | *(optional)* Your team's URL slug — only used to build the "Open in Vercel" deep-link. |
| `AI_GATEWAY_API_KEY` | Vercel **AI Gateway** key (for the dashboard's Test/playground). On Vercel this is OIDC-injected automatically; set it locally. |

### Fleet runtime secrets (generate your own)

```bash
openssl rand -base64 32   # run once per secret below
```

| Variable | Purpose |
| --- | --- |
| `FLEET_ENCRYPTION_KEY` | Signs/encrypts fleet artifacts. |
| `EVE_API_SECRET` | Shared secret the control-plane uses to call into a deployed agent's channel. |
| `FM_AGENT_KEY` | HMAC key for per-agent agent→control-plane tokens. **Never** bake this into an agent project. |

### Optional — WhatsApp via Kapso

`KAPSO_API_KEY`, `KAPSO_PLATFORM_API_KEY`, `KAPSO_BASE_URL`, `KAPSO_PHONE_NUMBER_ID`, `KAPSO_WEBHOOK_SECRET` — only needed if you wire up the Kapso/WhatsApp channel, and you need a real Kapso number to verify end-to-end.

## How deploying an agent works

`deployAgent(agentId)` in `app/actions/deploy.ts`:
1. **Ensure** a Vercel project exists for the agent (`lib/vercel/client.ts → ensureProject`).
2. **Compile** the Supabase config into Eve files (`lib/eve/generate.ts → buildEveAgent`) wrapped into a full project (`lib/eve/project.ts → buildEveProject`).
3. **Push** the agent's secrets to its Vercel project env (encrypted), then **deploy** via REST and poll until `READY`.

`lib/eve/env-spec.ts` (`buildAgentEnvSpec`) is the pure function deciding which env keys a given agent's project needs.

## Database

- Source of truth: `lib/db/schema.ts` (drizzle-orm). Apply it with `pnpm exec drizzle-kit push`.
- The `scripts/migrate-*.mjs` files are **historical, additive, idempotent** migrations for already-deployed databases (each is an `ADD COLUMN IF NOT EXISTS`-style script run via `node --env-file=.env.local scripts/migrate-*.mjs`). A fresh fork does **not** need them — `drizzle-kit push` already reflects the current schema.

## Key modules

| Path | Role |
| --- | --- |
| `lib/eve/generate.ts` | `buildEveAgent(agent, {connections})` → the Eve agent files (instructions, skills, connections w/ OAuth, subagents, schedules, channels). Injection-safe. |
| `lib/eve/project.ts` | Wraps the above into a full Eve project (package.json/tsconfig). |
| `app/actions/deploy.ts` | `deployAgent(id)`: ensure project → push secrets → deploy → poll READY. |
| `lib/vercel/client.ts` | Vercel REST: deploy + `ensureProject`/`upsertProjectEnv`. |
| `lib/eve/env-spec.ts` | Which env keys each agent needs (pure). |
| `lib/session.ts` | `getUserId()` (fixed owner) + `getSessionUser()` (the auth gate). |
| `proxy.ts` | Route-level enforcement of the operator gate (Next 16's renamed middleware). |
| `lib/agent.ts`, `lib/playground.ts` | Test/preview only — not a production runtime. |

## Conventions

- **TDD, strict**: write the failing test in its own commit (red, verified with `pnpm test`) *before* the implementation commit (green). Separate commits.
- **English only** in code, UI, comments.
- **Dark-only** UI, [Midday](https://github.com/midday-ai/midday) aesthetic. `base-ui` + Tailwind v4.
- `base-ui` `Select` needs an `items` prop (else it renders the raw value) and `className="w-full"` in forms.
- Generators that emit code **must escape interpolated values** (`q()` = `JSON.stringify`) — no string/comment/command/path injection.
- DB migrations are **additive** and idempotent — no destructive drops without a deliberate migration.
- Don't run two agents/workflows editing the same files concurrently.

## Stack

Next.js 16 (App Router) · React 19 · AI SDK v6 (`ai` + `@ai-sdk/mcp`) · drizzle-orm + pg (Supabase Postgres) · Supabase Auth · base-ui + Tailwind v4 · pnpm · vitest.

## Secrets model

**Vercel project env is the source of truth** for a deployed agent's secrets (`type: "encrypted"`) — not Supabase plaintext. The per-agent Secrets UI sets them once and pushes them to the agent's Vercel project, where they persist across deploys. Agent tools come from **MCP connections** only.
