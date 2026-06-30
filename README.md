# agent-army

[![CI](https://github.com/MatiSolina/agent-army/actions/workflows/ci.yml/badge.svg)](https://github.com/MatiSolina/agent-army/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

A control-plane to define AI agents and deploy each one as its **own [Eve](https://github.com/vercel/eve) project on Vercel**, with its own runtime. Multiple agents means multiple independent deployments: a fleet.

## How it works

- **Your Supabase config is the agent's definition (the source).** You edit it in the dashboard.
- **"Deploy" compiles that config into a real Eve project and ships it** via the Vercel REST API. The deployed Eve app is the **production runtime**.
- A Deploy is a **snapshot**: editing config does not change a deployed agent until you re-Deploy. Each Deploy is a real Vercel project.
- The dashboard's own playground / `generateAgentReply` is **Test/preview only**, not a production runtime.

## Stack

Next.js 16 (App Router) · React 19 · AI SDK v6 (`ai` + `@ai-sdk/mcp`) · drizzle-orm + pg (Supabase Postgres) · Supabase Auth · base-ui + Tailwind v4 (dark-only, Midday aesthetic) · pnpm · vitest.

Single-tenant data behind a Supabase Auth access gate: only `FLEET_OPERATOR_EMAIL` gets past the login.

## Getting started

Requires **Node 22+** (Node 24 to run the `eve` CLI locally) and **pnpm**.

```bash
pnpm install
cp .env.example .env.local   # then fill in the values
pnpm dev
```

See [`.env.example`](./.env.example) for the required environment variables. At minimum you need a Supabase project (`DATABASE_URL` plus the `SUPABASE_*` keys), `FLEET_OPERATOR_EMAIL`, and, for the Deploy button, `VERCEL_TOKEN` and `VERCEL_TEAM_ID`.

### Database

Migrations are additive, idempotent scripts:

```bash
node --env-file=.env.local scripts/migrate-<name>.mjs
```

## Verify

```bash
pnpm test            # vitest
pnpm exec tsc --noEmit
pnpm lint
pnpm build
```

## Key modules

| Path | Role |
| --- | --- |
| `lib/eve/generate.ts` | `buildEveAgent(...)` → the Eve agent files (instructions, skills, connections, channels, schedules). |
| `lib/eve/project.ts` | Wraps the agent files into a full Eve project (package.json/tsconfig). |
| `app/actions/deploy.ts` | `deployAgent(id)`: ensure Vercel project → push secrets → deploy → poll READY. |
| `lib/vercel/client.ts` | Vercel REST: deploy + project/env management. |
| `lib/eve/env-spec.ts` | Which env keys each agent needs. |

New here? **[`CLAUDE.md`](./CLAUDE.md)** is the full onboarding + architecture guide — setup, where to get every credential, and how deploys work.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Security issues: [SECURITY.md](./SECURITY.md).

## License

[Apache 2.0](./LICENSE) © 2026 Matías Solina.
