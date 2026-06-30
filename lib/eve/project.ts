import type { Agent, Connection } from "@/lib/db/schema"
import { buildEveAgent, type ChannelEmit } from "./generate"

/**
 * Stage 2 — deployable Eve PROJECT generator (PURE).
 *
 * `buildEveProject` wraps {@link buildEveAgent} (which emits the `agent/...`
 * authored surface) and adds the project scaffold around it — `package.json`,
 * `tsconfig.json`, and a hygiene `.gitignore` — so the result is a complete,
 * deployable Eve app rooted at a single directory.
 *
 * It performs NO I/O. Callers materialise the returned `{ path: contents }` map
 * to disk (see `materialize.ts`) and then deploy it with the Vercel CLI.
 *
 * CAVEAT: this runs under Node 22; Eve itself requires Node 24. We never build
 * or run Eve here — the actual `eve build` happens REMOTELY on Vercel's Node 24
 * builder during `vercel deploy`. Correctness is validated against the Eve docs
 * (`/Users/mati/.claude/skills/eve/docs`, esp. getting-started + deployment) and
 * structural unit tests, not by compiling Eve.
 */

/**
 * Eve npm version this generator targets. Bump deliberately. Pinned exactly so
 * a deploy is reproducible and never silently jumps a minor.
 */
export const EVE_VERSION = "0.16.0"

/**
 * The `ai` (Vercel AI SDK) version eve pins as a NON-optional peer dependency.
 * eve@0.16.0 peers `ai` at `^7.0.0`; we pin a concrete stable 7.x (7.0.3) for
 * reproducible deploys. Keep this in lockstep with EVE_VERSION's `ai` peer
 * (`npm view eve@<v> peerDependencies`). All of eve's other peers (next, react,
 * vite, …) are marked optional, so we do not declare them.
 *
 * NOTE: 0.16.0 is the version the agent generator (channels, connections) is
 * authored against — the local Eve docs. The custom-channel mount path
 * (/eve/v1/<stem>) and `defineChannel` API in this generator require >= 0.16.
 */
export const EVE_AI_VERSION = "7.0.3"

/**
 * `zod` range that satisfies `ai@7.0.0-beta.178` (peers `^3.25.76 || ^4.1.8`).
 */
export const EVE_ZOD_VERSION = "^3.25.76"

/**
 * `@vercel/otel` version, added to deps ONLY when a generated file imports it.
 * `agent/instrumentation.ts` (always emitted) imports `@vercel/otel`, so in
 * practice this dep is always present — but the guard keeps the generator free
 * of dead deps (dep present iff a file actually references it). Matches the
 * dashboard's own `@vercel/otel` pin. Exact, not a caret, for reproducible
 * deploys (mirrors EVE_CONNECT_VERSION).
 */
export const EVE_OTEL_VERSION = "2.1.3"

/**
 * `@vercel/connect` version, added to deps ONLY when a generated connection
 * uses Vercel Connect (`connect()` from `@vercel/connect/eve` — see
 * generate.ts `emitConnection` "connect" branch). Exact pin, not a caret, for
 * reproducible deploys (mirrors EVE_OTEL_VERSION).
 */
export const EVE_CONNECT_VERSION = "0.2.10"

/**
 * Vercel-project-name-safe slug used for the deployed project name and as the
 * package.json `name`. Canonical rule:
 *   trim -> lowercase -> every run of non-[a-z0-9] becomes a single "-" ->
 *   strip leading/trailing "-" -> append a stable id suffix -> cap at 100
 *   chars -> if empty, fall back to `agent-<id suffix>`.
 *
 * The result matches `^[a-z0-9][a-z0-9-]{0,99}$` and contains only characters
 * that are safe both as a Vercel project name AND as a single argv element. It
 * is only ever passed inside a spawn() args array (shell:false), so even a
 * bypass could not inject shell metacharacters — this is defence in depth.
 */
export function projectName(agent: Agent): string {
  const idSuffix =
    agent.id
      .toLowerCase()
      .replace(/^agent[-_]?/, "")
      .replace(/[^a-z0-9]+/g, "")
      .slice(0, 8) || "unnamed"
  const slug = agent.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

  if (!slug) return `agent-${idSuffix}`

  const maxBaseLength = 100 - idSuffix.length - 1
  const base = slug.slice(0, maxBaseLength).replace(/-+$/g, "")
  return `${base || "agent"}-${idSuffix}`
}

export function buildEveProject(
  agent: Agent,
  opts: {
    connections: Connection[]
    /** The agent's assigned inbound channel (picks kapso.ts vs slack.ts). */
    channel?: ChannelEmit | null
    /** Override the `eve` pin (e.g. a fleet version-update target). Defaults to {@link EVE_VERSION}. */
    eveVersion?: string
    /** Override the `ai` pin (resolved per-eve-version from npm). Defaults to {@link EVE_AI_VERSION}. */
    aiVersion?: string
  },
): Record<string, string> {
  // Start from the authored `agent/...` surface and add the project scaffold.
  const files: Record<string, string> = { ...buildEveAgent(agent, opts) }

  const dependencies: Record<string, string> = {
    eve: opts.eveVersion ?? EVE_VERSION,
    // Exact pin — must match eve's non-optional `ai` peer or remote
    // `npm install` fails with ERESOLVE. See EVE_AI_VERSION.
    ai: opts.aiVersion ?? EVE_AI_VERSION,
    zod: EVE_ZOD_VERSION,
  }

  // The always-emitted `agent/instrumentation.ts` imports `@vercel/otel`; add
  // the dep so the remote eve build can resolve it. Guarded identically to the
  // connect dep above so the generator never carries a dead dependency.
  if (Object.values(files).some((c) => c.includes("@vercel/otel"))) {
    dependencies["@vercel/otel"] = EVE_OTEL_VERSION
  }

  // A Vercel-Connect-backed connection imports `@vercel/connect/eve`; add the
  // dep so the remote eve build resolves it. Guarded so the generator never
  // carries a dead dependency.
  if (Object.values(files).some((c) => c.includes("@vercel/connect"))) {
    dependencies["@vercel/connect"] = EVE_CONNECT_VERSION
  }

  files["package.json"] =
    JSON.stringify(
      {
        name: projectName(agent),
        private: true,
        type: "module",
        // eve requires Node 24; pin to the 24 major (matches the eve docs and
        // avoids Vercel's "engines will auto-upgrade" warning that `>=24` emits).
        engines: { node: "24.x" },
        scripts: {
          build: "eve build",
          start: "eve start",
          dev: "eve dev",
        },
        dependencies,
      },
      null,
      2,
    ) + "\n"

  files["tsconfig.json"] =
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          skipLibCheck: true,
          esModuleInterop: true,
          types: ["node"],
        },
      },
      null,
      2,
    ) + "\n"

  // Hygiene only — the deploy directory itself is git-ignored at the repo root
  // (.eve-deploy/). No `vercel.json`: `eve build` emits its own Vercel Build
  // Output and wires Vercel Cron automatically; a vercel.json could override
  // buildCommand/outputDirectory incorrectly.
  files[".gitignore"] =
    [".eve/", ".vercel/", "node_modules/", ".output/", ".workflow-data/", ""].join(
      "\n",
    )

  return files
}
