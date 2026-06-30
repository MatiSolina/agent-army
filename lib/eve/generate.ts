import type { Agent, AgentHarness, Connection } from "@/lib/db/schema"
import { MCP_CATALOG } from "@/lib/mcp-catalog"

/**
 * Stage 1: Eve agent generator (PURE).
 *
 * `buildEveAgent` turns a stored {@link Agent} (plus the {@link Connection} rows
 * it references) into a map of `{ relativePath: fileContents }`
 * representing a complete Eve agent directory (`agent/...`).
 *
 * It performs NO I/O: it never reads or writes disk, never hits the network, and
 * never touches the DB. Callers materialise the returned map however they like
 * (zip download, write to a temp dir, push to a repo, ...).
 *
 * The shape and `define*` API follow the local Eve docs
 * (`/Users/mati/.claude/skills/eve/docs`). Identity in Eve comes from the file
 * path, so none of the generated `define*` calls carry a `name`/`id` field; the
 * filename slug is the runtime name.
 *
 * CAVEAT: this generator runs under Node 22; Eve itself requires Node 24. We do
 * not (and cannot here) compile or run the generated project. Correctness is
 * validated against the Eve docs + structural unit tests, not by building Eve.
 */

// ---------------------------------------------------------------------------
// Slug helpers
// ---------------------------------------------------------------------------

/**
 * Filesystem/runtime-safe slug: lowercase, non-alphanumerics -> single `_`.
 *
 * EXPORTED so the env-spec builder (lib/eve/env-spec.ts) can derive the exact
 * same connection slug the generated code reads from, guaranteeing the pushed
 * `<SLUG>_TOKEN` env key can never drift from what `emitConnection` emits.
 */
export function slug(name: string, fallback: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || fallback
  )
}

/**
 * Emit a SAFE JS/TS string literal for an arbitrary value. JSON.stringify
 * escapes quotes, backslashes, newlines and control chars, so the value can
 * never break out of the literal and inject code into the generated source.
 * (Also a valid YAML scalar, so it is reused in frontmatter.)
 */
function q(value: string): string {
  return JSON.stringify(value)
}

/**
 * Make an arbitrary value safe to drop into a single-line `//` comment in
 * generated source: collapse newlines (which would end the comment and let the
 * rest become code) and neutralise any block-comment terminator sequence.
 */
function lineComment(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\*\//g, "* /")
}

/** Normalise a URL for catalog matching (drop trailing slash). */
function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "")
}

// ---------------------------------------------------------------------------
// Connection auth classification
// ---------------------------------------------------------------------------

type ConnAuthKind = "connect" | "oauth" | "token" | "none"

/** The catalog entry whose URL matches this connection, if any. */
function catalogEntryFor(conn: Connection) {
  const target = normalizeUrl(conn.url)
  return MCP_CATALOG.find((e) => normalizeUrl(e.url) === target)
}

/**
 * Decide how a connection should authenticate in the generated Eve project.
 *
 * The DB row does not store an `auth` discriminator, so we infer it:
 *  1. If the connection has a static `token`, it is token-auth.
 *  2. Else, if its catalog entry has a `vercelConnect` UID, it is OAuth via
 *     Vercel Connect (eve's `connect()`, used for servers without Dynamic
 *     Client Registration, e.g. Slack).
 *  3. Else, if its catalog entry is `auth: "oauth"`, it is self-hosted DCR OAuth
 *     brokered through the Fleet Manager token endpoint.
 *  4. Else, no auth.
 *
 * A static token always wins so an explicitly-configured credential is honoured.
 */
export function classifyConnectionAuth(conn: Connection): ConnAuthKind {
  if (conn.token && conn.token.trim().length > 0) return "token"

  const entry = catalogEntryFor(conn)
  if (entry?.vercelConnect) return "connect"
  if (entry?.auth === "oauth") return "oauth"

  return "none"
}

/**
 * The Vercel Connect connector UID for a connection, or null if it is not
 * Connect-backed. EXPORTED so the deploy flow (deploy-core) can attach the
 * connector to the agent's Vercel project; eve `connect(uid)` only works once
 * the consuming project is attached.
 */
export function vercelConnectUid(conn: Connection): string | null {
  return catalogEntryFor(conn)?.vercelConnect ?? null
}

/**
 * UPPER_SNAKE env var name eve reads for a static-token connection.
 * EXPORTED + reused by lib/eve/env-spec.ts so the pushed key matches verbatim.
 */
export function tokenEnvVar(connSlug: string): string {
  return `${connSlug.toUpperCase()}_TOKEN`
}

// ---------------------------------------------------------------------------
// File emitters
// ---------------------------------------------------------------------------

function emitAgentTs(agent: Agent): string {
  // NOTE: eve's defineAgent only accepts a strict public shape. `modelOptions`
  // exposes provider-keyed `providerOptions`, NOT top-level AI SDK generation
  // settings; eve rejects an unknown `temperature` key at build time with
  // "Unknown key \"temperature\"". So we do NOT serialize the stored
  // temperature into agent.ts; it would fail `eve build`. The value (0..100,
  // here ${agent.temperature} -> ${Math.round((agent.temperature / 100) * 100) / 100} on a 0..1 scale)
  // is still used by the in-dashboard agent runner; it just isn't expressible
  // in eve@${"0.13.8"}'s agent config. Add `modelOptions.providerOptions` here
  // by hand if a future eve/provider exposes a temperature override.
  return `import { defineAgent } from "eve"

// Generated from agent "${lineComment(agent.name)}" (${lineComment(agent.id)}).
export default defineAgent({
  model: ${q(agent.model)},
})
`
}

function emitInstructionsBootstrap(): string {
  return `You are an Eve agent managed by Fleet Manager.

Runtime instructions are resolved on every turn by agent/instructions/runtime.ts. Follow those runtime instructions when they are available.
`
}

function emitRuntimeInstructions(agent: Agent): string {
  return `import { defineDynamic, defineInstructions } from "eve/instructions"

const AGENT_ID = ${q(agent.id)}
const FALLBACK_SYSTEM_PROMPT = ${q(agent.systemPrompt)}

async function loadRuntimeSystemPrompt(): Promise<string> {
  try {
    const baseUrl = process.env.FM_BASE_URL
    // Per-agent token (HMAC bound to AGENT_ID) — the FM only accepts this.
    const secret = process.env.EVE_AGENT_TOKEN
    if (!baseUrl || !secret) return FALLBACK_SYSTEM_PROMPT

    const url = new URL(
      \`/api/agents/\${encodeURIComponent(AGENT_ID)}/runtime-config\`,
      baseUrl,
    )
    const res = await fetch(url, {
      headers: { authorization: \`Bearer \${secret}\` },
      cache: "no-store",
    })
    if (!res.ok) return FALLBACK_SYSTEM_PROMPT

    const data = (await res.json()) as { systemPrompt?: unknown }
    return typeof data.systemPrompt === "string" && data.systemPrompt.trim()
      ? data.systemPrompt
      : FALLBACK_SYSTEM_PROMPT
  } catch {
    return FALLBACK_SYSTEM_PROMPT
  }
}

export default defineDynamic({
  events: {
    "turn.started": async () =>
      defineInstructions({ markdown: await loadRuntimeSystemPrompt() }),
  },
})
`
}

function emitConnection(conn: Connection, agentId: string): string {
  const connSlug = slug(conn.name, "connection")
  const kind = classifyConnectionAuth(conn)
  const desc = `MCP server "${conn.name}".`

  if (kind === "connect") {
    const uid = catalogEntryFor(conn)?.vercelConnect ?? connSlug
    return `import { connect } from "@vercel/connect/eve"
import { defineMcpClientConnection } from "eve/connections"

// OAuth via Vercel Connect: it brokers the sign-in and holds the token (the
// first call surfaces a consent URL the caller visits). Used for servers
// without Dynamic Client Registration (e.g. Slack). The deployed agent
// exchanges its Vercel OIDC for the token; the "${lineComment(uid)}" connector
// must be installed once in the team's Vercel Connect.
export default defineMcpClientConnection({
  url: ${q(conn.url)},
  description: ${q(desc)},
  auth: connect(${q(uid)}),
})
`
  }

  if (kind === "oauth") {
    return `import { defineMcpClientConnection } from "eve/connections"

// Self-hosted OAuth via the Fleet Manager (FM) token broker. The FM holds the
// OAuth flow (consent once in its UI, refresh server-side) and exposes the
// current access token at /api/mcp/token. getToken fetches it on every
// connection attempt, authenticating with this agent's per-agent token
// (EVE_AGENT_TOKEN) and passing &agent so the FM scopes the broker to THIS
// agent's own connections.
export default defineMcpClientConnection({
  url: ${q(conn.url)},
  description: ${q(desc)},
  auth: {
    getToken: async () => {
      const res = await fetch(
        \`\${process.env.FM_BASE_URL}/api/mcp/token?conn=\${encodeURIComponent(${q(conn.id)})}&agent=\${encodeURIComponent(${q(agentId)})}\`,
        { headers: { authorization: \`Bearer \${process.env.EVE_AGENT_TOKEN}\` } },
      )
      if (!res.ok) throw new Error(\`fm token broker \${res.status}\`)
      const data = await res.json()
      return data.expiresAt
        ? { token: data.token, expiresAt: data.expiresAt }
        : { token: data.token }
    },
  },
})
`
  }

  if (kind === "token") {
    const env = tokenEnvVar(connSlug)
    return `import { defineMcpClientConnection } from "eve/connections"

// Static-token auth: token minted from an env var on every connection attempt.
// Set ${env} in the deployment environment.
export default defineMcpClientConnection({
  url: ${q(conn.url)},
  description: ${q(desc)},
  auth: {
    getToken: async () => ({ token: process.env.${env}! }),
  },
})
`
  }

  // none
  return `import { defineMcpClientConnection } from "eve/connections"

// No auth — only safe for intentionally public or local-only MCP servers.
export default defineMcpClientConnection({
  url: ${q(conn.url)},
  description: ${q(desc)},
})
`
}

function emitSubagentConfig(model: string, description: string): string {
  return `import { defineAgent } from "eve"

// A declared subagent: its own identity + tool surface. \`description\` is
// required — the parent reads it to decide when to delegate.
export default defineAgent({
  model: ${q(model)},
  description: ${q(description)},
})
`
}

function emitSchedule(cron: string, prompt: string): string {
  // Markdown form: frontmatter carries `cron` and nothing else; body is the
  // fire-and-forget (task-mode) prompt. See Eve "Schedules".
  return `---
cron: ${q(cron)}
---

${prompt}
`
}

function emitSandbox(agent: Agent): string {
  const runtime = agent.sandbox.runtime ?? "node24"
  const setup = (agent.sandbox.setupCommands ?? "")
    .split("\n")
    .map((c) => c.trim())
    .filter(Boolean)

  const bootstrapBody = setup.length
    ? setup
        .map((cmd) => `    await sandbox.run({ command: ${q(cmd)} })`)
        .join("\n")
    : "    // No setup commands configured."

  // Defense in depth: with bash disabled the model has no shell to drive egress
  // from the sandbox, so close the network when the sandbox is authored. Left at
  // eve's allow-all default otherwise (omit the key entirely). Egress policy goes
  // ON the backend factory; eve's defineSandbox has no top-level networkPolicy.
  const networkPolicy =
    agent.harness?.bash === false ? `, networkPolicy: "deny-all"` : ""

  return `import { defineSandbox } from "eve/sandbox"
import { vercel } from "eve/sandbox/vercel"

// Generated from agent.sandbox. setupCommands run once at template-build time
// in \`bootstrap\`, so every later session inherits the result.
export default defineSandbox({
  backend: vercel({ runtime: ${q(runtime)}${networkPolicy} }),
  async bootstrap({ use }) {
    const sandbox = await use()
${bootstrapBody}
  },
})
`
}

// Built-in tools eve disables by a `disableTool()` file at the tool's slug. Each
// harness flag maps to the slug(s) it owns; an explicit `false` removes them.
export const HARNESS_TOOL_SLUGS: Record<keyof AgentHarness, readonly string[]> = {
  bash: ["bash"],
  files: ["read_file", "write_file", "glob", "grep"],
  webFetch: ["web_fetch"],
  webSearch: ["web_search"],
}

function emitDisableTool(): string {
  return `import { disableTool } from "eve/tools"

// Guardrail: this built-in tool is turned off for this agent. The model never
// sees it, so it cannot be invoked regardless of the prompt.
export default disableTool()
`
}

/**
 * Map the agent's harness flags to `{ "agent/tools/<slug>.ts": disableTool() }`
 * for every built-in the operator turned off. Absent/true flags emit nothing, so
 * the default harness stays intact (and existing agents are unaffected).
 */
function emitHarnessDisables(agent: Agent): Record<string, string> {
  const files: Record<string, string> = {}
  const harness = agent.harness ?? {}
  for (const key of Object.keys(HARNESS_TOOL_SLUGS) as (keyof AgentHarness)[]) {
    if (harness[key] === false) {
      for (const s of HARNESS_TOOL_SLUGS[key]) {
        files[`agent/tools/${s}.ts`] = emitDisableTool()
      }
    }
  }
  return files
}

function emitSkill(description: string, content: string): string {
  // Quote the description as a JSON/YAML string scalar so a user-controlled
  // value containing newlines, ":", or a "---" line cannot break the
  // frontmatter or inject extra YAML keys into the generated skill file.
  return `---
description: ${q(description)}
---

${content}
`
}

function emitKapsoChannel(): string {
  // Custom WhatsApp channel backed by Kapso. Eve ships no WhatsApp channel, so
  // this follows the Eve custom-channel contract (docs: channels/custom) and
  // ports the real inbound parsing + outbound send from the dashboard's former
  // runtime (lib/kapso.ts + lib/bot.ts via @kapso/chat-adapter).
  //
  // SINGLE-NUMBER-PER-DEPLOYMENT: each agent is its own Eve deployment serving
  // exactly one Kapso number from env. There is no DB phone-number routing here
  // (that was a dashboard-multiplexing concern); this channel serves one number.
  //
  // The webhook mounts at  /kapso/webhook  on the deployed agent. Eve's custom
  // defineChannel routes mount at their LITERAL path from the deployment root
  // (NOT prefixed with /eve/v1/<stem>; that prefix is only for built-in
  // channels like the canonical eve channel). Point Kapso at that URL.
  //
  // Env (pushed by the dashboard deploy from the assigned channel's creds):
  //   KAPSO_WEBHOOK_SECRET:  HMAC secret for inbound webhook verification
  //   KAPSO_API_KEY:         used to send replies back through Kapso
  //   KAPSO_PHONE_NUMBER_ID: the WhatsApp Business phone number id
  return `import { defineChannel, GET, POST } from "eve/channels"
import { createHmac, timingSafeEqual } from "node:crypto"

// Inbound message extracted from either webhook shape.
type Inbound = { from: string; text: string }

/**
 * Verify the inbound webhook signature (HMAC-SHA256 over the raw body, hex).
 * Kapso-native deliveries sign with the "x-webhook-signature" header; Meta Graph
 * deliveries use "x-hub-signature-256" (prefixed "sha256="). No secret means
 * the webhook is misconfigured, so fail closed.
 */
function verifyKapsoSignature(rawBody: string, req: Request): boolean {
  const secret = process.env.KAPSO_WEBHOOK_SECRET
  if (!secret) return false

  const raw =
    req.headers.get("x-webhook-signature") ??
    req.headers.get("x-hub-signature-256")
  if (!raw) return false
  // Meta prefixes the hex digest with "sha256=".
  const signature = raw.startsWith("sha256=") ? raw.slice("sha256=".length) : raw

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex")
  try {
    const a = Buffer.from(signature, "hex")
    const b = Buffer.from(expected, "hex")
    return a.byteLength === b.byteLength && timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/** Pull text out of a WhatsApp Cloud message object (text + interactive). */
function messageText(message: any): string {
  if (typeof message?.text?.body === "string") return message.text.body
  const ir = message?.interactive
  if (typeof ir?.button_reply?.title === "string") return ir.button_reply.title
  if (typeof ir?.list_reply?.title === "string") return ir.list_reply.title
  return ""
}

/**
 * Parse inbound messages from BOTH supported webhook shapes:
 *  - Meta Graph:   entry[].changes[].value.messages[]   (text at .text.body)
 *  - Kapso-native: { data: [ { event, message } ] } or a single { message }
 *    (header x-webhook-event: "whatsapp.message.received"); message is the same
 *    WhatsApp Cloud message object with .from and .text.body.
 * Status / delivery receipts carry no messages and yield an empty list.
 */
function parseInbound(payload: any): Inbound[] {
  const out: Inbound[] = []

  // Meta Graph shape.
  const entries = payload?.entry
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      const changes = entry?.changes
      if (!Array.isArray(changes)) continue
      for (const change of changes) {
        const messages = change?.value?.messages
        if (!Array.isArray(messages)) continue
        for (const m of messages) {
          const from = typeof m?.from === "string" ? m.from : ""
          const text = messageText(m)
          if (from && text) out.push({ from, text })
        }
      }
    }
  }

  // Kapso-native shape (batched under data[] or a single top-level event).
  const events = Array.isArray(payload?.data) ? payload.data : [payload]
  for (const event of events) {
    const m = event?.message
    if (!m) continue
    const from = typeof m?.from === "string" ? m.from : ""
    const text = messageText(m)
    if (from && text) out.push({ from, text })
  }

  return out
}

/** Continuation token: one session per remote WhatsApp number / chat. */
function kapsoContinuationToken(from: string): string {
  return from
}

/**
 * Send a WhatsApp text reply back through the Kapso proxy of the WhatsApp Cloud
 * API. Endpoint + headers + envelope mirror @kapso/whatsapp-cloud-api exactly:
 *   POST https://api.kapso.ai/meta/whatsapp/v23.0/{phoneNumberId}/messages
 *   header  X-API-Key: <KAPSO_API_KEY>
 *   body    { messaging_product:"whatsapp", recipient_type:"individual",
 *             to, type:"text", text:{ body } }
 */
async function sendKapsoMessage(to: string, text: string): Promise<void> {
  const apiKey = process.env.KAPSO_API_KEY
  const phoneNumberId = process.env.KAPSO_PHONE_NUMBER_ID
  if (!apiKey || !phoneNumberId) {
    console.error("[kapso] KAPSO_API_KEY / KAPSO_PHONE_NUMBER_ID not set; cannot send reply")
    return
  }
  const url = \`https://api.kapso.ai/meta/whatsapp/v23.0/\${phoneNumberId}/messages\`
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { body: text },
    }),
  })
  if (!res.ok) {
    console.error(\`[kapso] send failed: \${res.status} \${await res.text()}\`)
  }
}

export default defineChannel({
  routes: [
    // Meta/Kapso subscription-verification handshake. When registering the
    // webhook, Meta issues a GET with hub.mode=subscribe & hub.challenge=<nonce>
    // and expects the nonce echoed back verbatim. (Ported from the dashboard's
    // former route, which answered this before the runtime moved into Eve.)
    GET("/kapso/webhook", async (req) => {
      const url = new URL(req.url)
      const challenge = url.searchParams.get("hub.challenge")
      if (challenge) return new Response(challenge, { status: 200 })
      return new Response("ok")
    }),
    POST("/kapso/webhook", async (req, { send }) => {
      const rawBody = await req.text()

      if (!verifyKapsoSignature(rawBody, req)) {
        return new Response("invalid signature", { status: 401 })
      }

      let payload: unknown
      try {
        payload = JSON.parse(rawBody)
      } catch {
        return new Response("invalid json", { status: 400 })
      }

      const inbound = parseInbound(payload)
      if (inbound.length === 0) {
        // Status updates, delivery receipts, verification pings — nothing to do.
        return new Response("ok")
      }

      for (const { from, text } of inbound) {
        await send(text, {
          auth: {
            authenticator: "kapso",
            principalType: "user",
            principalId: from,
          },
          continuationToken: kapsoContinuationToken(from),
        })
      }

      return new Response("ok")
    }),
  ],
  events: {
    // Deliver the agent's completed reply back to WhatsApp via Kapso. message.completed
    // also fires for interim tool-call narration, so guard on finishReason. The
    // recipient is the caller that started this durable session (the WhatsApp
    // "from" set above), read from the session initiator.
    async "message.completed"(eventData: any, _channel: any, ctx: any) {
      if (eventData.finishReason === "tool-calls") return
      const text = eventData.message
      const to = ctx?.session?.auth?.initiator?.principalId
      if (to && text) await sendKapsoMessage(to, text)
    },
  },
})
`
}

// ---------------------------------------------------------------------------
// Tier-1 OpenTelemetry: agent/instrumentation.ts
// ---------------------------------------------------------------------------

/**
 * Root instrumentation file. eve auto-discovers `agent/instrumentation.ts` and
 * its mere presence implicitly enables telemetry (no `isEnabled` toggle), so we
 * emit it ALWAYS, so the deployed project's native Vercel Observability then gets
 * AI SDK spans for free.
 *
 * This is the exact vanilla shape from the eve docs (instrumentation.md): bare
 * `registerOTel` with an auto-resolved service name (eve passes the resolved
 * `agentName`), NO hardcoded name, NO `traceExporter`, NO env secret; Vercel's
 * OIDC handles export auth. No user/config string is interpolated, so there is
 * nothing to escape (and no `experimental_telemetry` on agent.ts: eve owns the
 * model-call spans; the root instrumentation file is the only injection point).
 */
function emitInstrumentation(): string {
  return `import { defineInstrumentation } from "eve/instrumentation"
import { registerOTel } from "@vercel/otel"

export default defineInstrumentation({
  setup: ({ agentName }) => registerOTel({ serviceName: agentName }),
})
`
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * The agent's `agent/channels/eve.ts` route auth. The default eve channel
 * (`[localDev(), vercelOidc()]`) only admits same-project Vercel OIDC tokens, so
 * the Fleet Manager (a DIFFERENT Vercel project) gets 401. We authenticate the
 * Fleet Manager proxy with a shared secret it holds (EVE_API_SECRET): a timing-
 * safe bearer compare. No user data is interpolated, so there is no injection
 * surface. localDev() stays for `eve dev`.
 */
/**
 * eve-native Slack channel backed by Vercel Connect (Path A). The connector UID
 * identifies this agent's Slack app/installation; Connect brokers the bot token
 * and inbound webhook verification, and resolves per-end-user credentials before
 * each turn. Slack delivers app_mention / message.im events to /eve/v1/slack on
 * this deployment, wired by the deploy's trigger-destination attach
 * (see lib/vercel/client.ts attachTriggerDestination). HITL buttons, typing
 * indicators and the ephemeral authorization-prompt delivery come for free.
 */
function emitSlackChannel(connectUid: string): string {
  return `import { slackChannel } from "eve/channels/slack"
import { connectSlackCredentials } from "@vercel/connect/eve"

// Vercel Connect holds the Slack credentials for this connector; the runtime
// resolves them per turn. Inbound events arrive at /eve/v1/slack.
export default slackChannel({
  credentials: connectSlackCredentials(${q(connectUid)}),
})
`
}

/**
 * eve-native Telegram channel. Unlike Slack (Connect-brokered) this reads its
 * two static secrets straight from env (TELEGRAM_BOT_TOKEN and
 * TELEGRAM_WEBHOOK_SECRET_TOKEN) which the dashboard deploy pushes to the
 * agent's Vercel project from the assigned channel's creds; so there is NO
 * credentials object and NO @vercel/connect import here. The channel mounts at
 * the built-in /eve/v1/telegram prefix. botUsername is optional (group @mention
 * dispatch); when absent we emit telegramChannel({}) rather than an empty
 * username. The deploy's promote step registers the webhook via setWebhook.
 */
function emitTelegramChannel(botUsername?: string | null): string {
  const arg = botUsername ? ` botUsername: ${q(botUsername)} ` : ""
  return `import { telegramChannel } from "eve/channels/telegram"

export default telegramChannel({${arg}})
`
}

/**
 * Minimal eve-native Discord channel. The three secrets
 * (DISCORD_BOT_TOKEN / DISCORD_APPLICATION_ID / DISCORD_PUBLIC_KEY) are read
 * from process.env at runtime, so no credentials object and no @vercel/connect.
 * Discord threads no structural/non-secret param, so this is a FIXED CONSTANT
 * with zero interpolation of any DB value. The channel mounts at the built-in
 * /eve/v1/discord prefix; Ed25519 verification + the 3-second ACK are built into
 * discordChannel(). The promote step registers the interactions endpoint URL.
 */
function emitDiscordChannel(): string {
  return `import { discordChannel } from "eve/channels/discord"\n\nexport default discordChannel()\n`
}

export function emitEveChannel(): string {
  return `import { eveChannel } from "eve/channels/eve"
import { extractBearerToken, localDev, type AuthFn } from "eve/channels/auth"
import { timingSafeEqual } from "node:crypto"

// Shared-secret auth: the Fleet Manager sends Authorization: Bearer EVE_API_SECRET.
function fleetManagerAuth(): AuthFn<Request> {
  return async (request) => {
    const token = extractBearerToken(request.headers.get("authorization"))
    const expected = process.env.EVE_API_SECRET
    if (!token || !expected) return null
    const a = Buffer.from(token)
    const b = Buffer.from(expected)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null
    return { authenticator: "fleet-manager", principalId: "fleet-manager", principalType: "app" }
  }
}

export default eveChannel({ auth: [localDev(), fleetManagerAuth()] })
`
}

/**
 * Minimal shape of the agent's assigned inbound channel, decoupled from the DB
 * row: only what the generator needs to pick + parameterize a channel file.
 */
export type ChannelEmit = {
  type: string
  slackConnectUid?: string | null
  telegramBotUsername?: string | null
}

export function buildEveAgent(
  agent: Agent,
  opts: { connections: Connection[]; channel?: ChannelEmit | null },
): Record<string, string> {
  const files: Record<string, string> = {}

  // agent.ts + static bootstrap + runtime-resolved instructions (always)
  files["agent/agent.ts"] = emitAgentTs(agent)
  files["agent/instructions.md"] = emitInstructionsBootstrap()
  files["agent/instructions/runtime.ts"] = emitRuntimeInstructions(agent)

  // instrumentation.ts (always): its presence implicitly enables eve telemetry.
  files["agent/instrumentation.ts"] = emitInstrumentation()

  // skills/<slug>.md
  for (const skill of agent.skills) {
    const s = slug(skill.name, skill.id)
    files[`agent/skills/${s}.md`] = emitSkill(skill.description, skill.content)
  }

  // connections/<slug>.ts (only assigned, non-stdio)
  const assignedIds = new Set(agent.connectionIds)
  for (const conn of opts.connections) {
    if (!assignedIds.has(conn.id)) continue
    if (conn.transport === "stdio") continue // not a remote MCP server, skip
    const s = slug(conn.name, conn.id)
    files[`agent/connections/${s}.ts`] = emitConnection(conn, agent.id)
  }

  // subagents/<slug>/agent.ts + instructions.md
  for (const sub of agent.subagents) {
    const s = slug(sub.name, sub.id)
    const description = sub.instructions.split("\n")[0]?.trim() || `Subagent ${sub.name}.`
    files[`agent/subagents/${s}/agent.ts`] = emitSubagentConfig(sub.model, description)
    files[`agent/subagents/${s}/instructions.md`] = sub.instructions
  }

  // schedules/<slug>.md (markdown form: cron frontmatter + prompt body)
  for (const sched of agent.schedules) {
    const s = slug(sched.name, sched.id)
    files[`agent/schedules/${s}.md`] = emitSchedule(sched.cron, sched.prompt)
  }

  // sandbox.ts (only if enabled)
  if (agent.sandbox.enabled) {
    files["agent/sandbox.ts"] = emitSandbox(agent)
  }

  // tools/<slug>.ts: disableTool() guardrails for built-ins turned off in the
  // harness config (none by default; full harness stays intact).
  Object.assign(files, emitHarnessDisables(agent))

  // NOTE: custom Tools are MCP-only now. The DB still has a `tools` table +
  // `agents.toolIds`, but we no longer compile schema-only stubs into the agent
  // (they were no-op "not implemented" bodies). Tools come from MCP connections.

  // channels/eve.ts (always): auth the Fleet Manager proxy via shared secret
  files["agent/channels/eve.ts"] = emitEveChannel()

  // Exactly ONE inbound channel, keyed by the assigned channel's type. Emitting
  // both would mount two webhooks. Default / no channel keeps the WhatsApp
  // (Kapso) surface so existing agents are unchanged.
  if (opts.channel?.type === "slack") {
    if (!opts.channel.slackConnectUid) {
      throw new Error("Slack channel requires a Vercel Connect connector UID")
    }
    files["agent/channels/slack.ts"] = emitSlackChannel(opts.channel.slackConnectUid)
  } else if (opts.channel?.type === "telegram") {
    files["agent/channels/telegram.ts"] = emitTelegramChannel(opts.channel.telegramBotUsername)
  } else if (opts.channel?.type === "discord") {
    files["agent/channels/discord.ts"] = emitDiscordChannel()
  } else {
    files["agent/channels/kapso.ts"] = emitKapsoChannel()
  }

  return files
}
