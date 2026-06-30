/**
 * Stage -1: Eve agent DISCOVERY (PURE). The inverse of {@link buildEveAgent}.
 *
 * `discoverEveAgent` takes the `{ relativePath: contents }` map of a deployed
 * Eve project's SOURCE files (retrieved from Vercel) and reconstructs the parts
 * of an {@link Agent} that were compiled into them. It is the exact reverse of
 * the `emit*` functions in `generate.ts`.
 *
 * NO I/O. Pure string parsing, unit-testable against the literal output of the
 * generator (see discover.test.ts round-trip test, which is the regression guard
 * against the generator and this parser drifting apart).
 *
 * LOSSY BY CONSTRUCTION. The generator does not serialize everything, and some
 * values live only in the deployment's encrypted Vercel env (never in source):
 *   - UNRECOVERABLE: temperature, maxSteps, description, agents.instructions,
 *     enabled, schedule.enabled, sandbox.timeoutMs, every skill/subagent/schedule
 *     id, and ALL secret VALUES (connection tokens, the KAPSO/TELEGRAM/DISCORD
 *     channel env vars, EVE_API_SECRET, AI_GATEWAY_API_KEY).
 *   - The systemPrompt recovered here is the deploy-time FALLBACK baked into
 *     runtime.ts, NOT the live FM-resolved prompt (which is fetched per turn).
 *
 * SECURITY. The files are TRUSTED only when they came straight from this
 * generator. A hand-edited or third-party project can contain arbitrary text, so
 * this module NEVER evals/imports/executes any content: it only regex-matches a
 * literal and JSON.parses the matched string. Skill/schedule/subagent bodies are
 * treated as opaque untrusted markdown.
 */

import { HARNESS_TOOL_SLUGS } from "./generate"
import type { AgentHarness } from "@/lib/db/schema"

export type DiscoveredSkill = { name: string; description: string; content: string }
export type DiscoveredSubagent = { name: string; model: string; instructions: string }
export type DiscoveredSchedule = { name: string; cron: string; prompt: string }
export type DiscoveredConnection = { name: string; url: string; auth: ConnAuthLabel }
export type DiscoveredSandbox = {
  enabled: boolean
  runtime?: string
  setupCommands?: string
}
export type ConnAuthLabel = "connect" | "oauth" | "token" | "none"
export type DiscoveredChannel =
  | { type: "slack"; slackConnectUid: string | null }
  | { type: "telegram"; telegramBotUsername: string | null }
  | { type: "discord" }
  | { type: "kapso" }

export type DiscoveredAgent = {
  /** Best-effort display name (agent.ts comment, else de-suffixed package name). LOSSY. */
  name: string
  model: string
  /** Deploy-time FALLBACK_SYSTEM_PROMPT (snapshot, not the live FM prompt). */
  systemPrompt: string
  skills: DiscoveredSkill[]
  subagents: DiscoveredSubagent[]
  schedules: DiscoveredSchedule[]
  sandbox: DiscoveredSandbox
  harness: AgentHarness
  /** url + name + auth label. NO token (env-only). */
  connections: DiscoveredConnection[]
  channel: DiscoveredChannel | null
  eveVersion: string | null
  /** Original agent-army id baked into runtime.ts, or null. */
  sourceAgentId: string | null
  /** Per-field parse failures: the field is skipped, the rest still imports. */
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

/**
 * Match a regex whose first capture group is a JSON string LITERAL (as emitted
 * by the generator's `q()` = JSON.stringify) and return the parsed string, or
 * null if absent/invalid. Never throws.
 */
function matchJsonString(text: string, re: RegExp): string | null {
  const m = re.exec(text)
  if (!m || m[1] === undefined) return null
  try {
    const parsed: unknown = JSON.parse(m[1])
    return typeof parsed === "string" ? parsed : null
  } catch {
    return null
  }
}

/** The filename stem for `dir/<stem>.<ext>` paths (used as the lossy name). */
function stem(path: string): string {
  const base = path.split("/").pop() ?? path
  return base.replace(/\.[^.]+$/, "")
}

/** Split a `--- frontmatter --- \n\n body` document into [frontmatter, body]. */
function splitFrontmatter(md: string): { frontmatter: string; body: string } {
  // The generator always emits `---\n<fm>\n---\n\n<body>`.
  const m = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(md)
  if (!m) return { frontmatter: "", body: md }
  return { frontmatter: m[1], body: m[2] }
}

// ---------------------------------------------------------------------------
// Per-file parsers (each guarded by the caller; return null/[] on miss)
// ---------------------------------------------------------------------------

function parseModel(agentTs: string): string | null {
  return matchJsonString(agentTs, /\bmodel:\s*("(?:[^"\\]|\\.)*")/)
}

/** The `// Generated from agent "<name>" (<id>).` header comment (LOSSY name). */
function parseAgentComment(agentTs: string): { name: string | null; id: string | null } {
  const m = /\/\/ Generated from agent "(.*)" \((.*)\)\./.exec(agentTs)
  if (!m) return { name: null, id: null }
  return { name: m[1] || null, id: m[2] || null }
}

function parseConnection(file: string, fallbackName: string): DiscoveredConnection {
  const url = matchJsonString(file, /\burl:\s*("(?:[^"\\]|\\.)*")/) ?? ""
  // description is `MCP server "<name>".`; recover the original-cased name.
  const desc = matchJsonString(file, /\bdescription:\s*("(?:[^"\\]|\\.)*")/)
  const nameFromDesc = desc ? /^MCP server "(.*)"\.$/.exec(desc)?.[1] : null
  let auth: ConnAuthLabel = "none"
  if (/\bauth:\s*connect\(/.test(file)) auth = "connect"
  else if (/\/api\/mcp\/token\?conn=/.test(file)) auth = "oauth"
  else if (/process\.env\.[A-Z0-9_]+_TOKEN/.test(file)) auth = "token"
  return { name: nameFromDesc || fallbackName, url, auth }
}

function parseSandbox(sandboxTs: string): DiscoveredSandbox {
  const runtime = matchJsonString(sandboxTs, /\bruntime:\s*("(?:[^"\\]|\\.)*")/) ?? undefined
  // Every `await sandbox.run({ command: <q> })` line is one setup command.
  const cmds: string[] = []
  const re = /\bcommand:\s*("(?:[^"\\]|\\.)*")/g
  let m: RegExpExecArray | null
  while ((m = re.exec(sandboxTs)) !== null) {
    try {
      const parsed: unknown = JSON.parse(m[1])
      if (typeof parsed === "string") cmds.push(parsed)
    } catch {
      /* skip an unparseable command line */
    }
  }
  return {
    enabled: true,
    runtime,
    setupCommands: cmds.length ? cmds.join("\n") : "",
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Reconstruct a {@link DiscoveredAgent} from a deployed project's source file
 * map (keys WITHOUT any `src/` deployment prefix; the caller strips it).
 *
 * Throws "Not an Eve agent" ONLY when neither `agent/agent.ts` (with a model)
 * nor a `package.json` with an `eve` dependency is present; that is the
 * authoritative gate. Otherwise every per-file parse failure is collected into `warnings` and
 * the import proceeds with whatever was recoverable.
 */
export function discoverEveAgent(files: Record<string, string>): DiscoveredAgent {
  const warnings: string[] = []
  const get = (path: string): string | undefined => files[path]

  // ---- package.json (name + eveVersion) ----
  let pkgName: string | null = null
  let eveVersion: string | null = null
  const pkgRaw = get("package.json")
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw) as {
        name?: unknown
        dependencies?: Record<string, unknown>
      }
      if (typeof pkg.name === "string") pkgName = pkg.name
      const eve = pkg.dependencies?.eve
      if (typeof eve === "string") eveVersion = eve
    } catch {
      warnings.push("package.json could not be parsed")
    }
  }

  // ---- agent.ts (model + name/id comment) ----
  const agentTs = get("agent/agent.ts")
  const model = (agentTs && parseModel(agentTs)) || null
  const comment = agentTs ? parseAgentComment(agentTs) : { name: null, id: null }

  // Authoritative "is this an eve agent" gate.
  if (!model && !eveVersion) {
    throw new Error(
      "Not an Eve agent: no agent/agent.ts model and no eve dependency in package.json",
    )
  }
  if (!model) warnings.push("agent/agent.ts model could not be parsed; defaulting")

  // ---- runtime.ts (sourceAgentId + FALLBACK systemPrompt) ----
  const runtimeTs = get("agent/instructions/runtime.ts")
  let sourceAgentId: string | null = comment.id
  let systemPrompt = ""
  if (runtimeTs) {
    sourceAgentId =
      matchJsonString(runtimeTs, /^const AGENT_ID = (".*")$/m) ?? sourceAgentId
    systemPrompt =
      matchJsonString(runtimeTs, /^const FALLBACK_SYSTEM_PROMPT = (".*")$/m) ?? ""
    if (!systemPrompt) warnings.push("runtime.ts FALLBACK_SYSTEM_PROMPT could not be parsed")
  }

  // ---- name (prefer the exact comment; else de-suffix the project name) ----
  let name = comment.name
  if (!name && pkgName) {
    // projectName() appends `-<8charIdSuffix>`; strip it for a display name.
    name = pkgName.replace(/-[a-z0-9]{1,8}$/, "")
  }
  name = (name ?? "").trim() || "Imported agent"

  // ---- skills ----
  const skills: DiscoveredSkill[] = []
  for (const [path, content] of Object.entries(files)) {
    if (!/^agent\/skills\/[^/]+\.md$/.test(path)) continue
    const { frontmatter, body } = splitFrontmatter(content)
    const description = matchJsonString(frontmatter, /^description:\s*(".*")\s*$/m) ?? ""
    skills.push({ name: stem(path), description, content: body })
  }

  // ---- subagents (agent.ts model + instructions.md body) ----
  const subSlugs = new Set<string>()
  for (const path of Object.keys(files)) {
    const m = /^agent\/subagents\/([^/]+)\//.exec(path)
    if (m) subSlugs.add(m[1])
  }
  const subagents: DiscoveredSubagent[] = []
  for (const slug of subSlugs) {
    const cfg = get(`agent/subagents/${slug}/agent.ts`) ?? ""
    const instructions = get(`agent/subagents/${slug}/instructions.md`) ?? ""
    const subModel = parseModel(cfg)
    if (!subModel) warnings.push(`subagent "${slug}" model could not be parsed; defaulting`)
    subagents.push({ name: slug, model: subModel ?? "", instructions })
  }

  // ---- schedules ----
  const schedules: DiscoveredSchedule[] = []
  for (const [path, content] of Object.entries(files)) {
    if (!/^agent\/schedules\/[^/]+\.md$/.test(path)) continue
    const { frontmatter, body } = splitFrontmatter(content)
    const cron = matchJsonString(frontmatter, /^cron:\s*(".*")\s*$/m) ?? ""
    schedules.push({ name: stem(path), cron, prompt: body })
  }

  // ---- sandbox ----
  const sandboxTs = get("agent/sandbox.ts")
  const sandbox: DiscoveredSandbox = sandboxTs
    ? parseSandbox(sandboxTs)
    : { enabled: false }

  // ---- harness (disableTool files → flags, via the SHARED slug map) ----
  const presentTools = new Set(
    Object.keys(files)
      .map((p) => /^agent\/tools\/([^/]+)\.ts$/.exec(p)?.[1])
      .filter((s): s is string => !!s),
  )
  const harness: AgentHarness = {}
  for (const key of Object.keys(HARNESS_TOOL_SLUGS) as (keyof AgentHarness)[]) {
    // A flag is OFF if ANY of its disableTool files is present (the generator
    // emits all of them, but tolerate a hand-edited partial set).
    if (HARNESS_TOOL_SLUGS[key].some((s) => presentTools.has(s))) {
      harness[key] = false
    }
  }

  // ---- connections ----
  const connections: DiscoveredConnection[] = []
  for (const [path, content] of Object.entries(files)) {
    if (!/^agent\/connections\/[^/]+\.ts$/.test(path)) continue
    connections.push(parseConnection(content, stem(path)))
  }

  // ---- channel (exactly one inbound file, excluding eve.ts) ----
  let channel: DiscoveredChannel | null = null
  if (get("agent/channels/slack.ts")) {
    channel = {
      type: "slack",
      slackConnectUid: matchJsonString(
        get("agent/channels/slack.ts")!,
        /connectSlackCredentials\((".*")\)/,
      ),
    }
  } else if (get("agent/channels/telegram.ts")) {
    channel = {
      type: "telegram",
      telegramBotUsername: matchJsonString(
        get("agent/channels/telegram.ts")!,
        /botUsername:\s*(".*?")/,
      ),
    }
  } else if (get("agent/channels/discord.ts")) {
    channel = { type: "discord" }
  } else if (get("agent/channels/kapso.ts")) {
    channel = { type: "kapso" }
  }

  return {
    name,
    model: model ?? "",
    systemPrompt,
    skills,
    subagents,
    schedules,
    sandbox,
    harness,
    connections,
    channel,
    eveVersion,
    sourceAgentId,
    warnings,
  }
}
