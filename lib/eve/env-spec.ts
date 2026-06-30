/**
 * Pure builder for the env vars that must exist on an agent's OWN Vercel project
 * so its deployed Eve runtime has the credentials it reads from process.env.
 *
 * No I/O: no DB, no fetch, no env reads. Single source of truth for "what env
 * vars the agent's project needs", consumed by the deploy + save-secrets actions.
 *
 * SECURITY: this module shuttles secret VALUES from DB rows into {key,value}
 * specs for upload to Vercel. It NEVER logs them. Callers must never log or
 * return the values either.
 */

import type { Agent, Connection } from "@/lib/db/schema"
import {
  slug,
  tokenEnvVar,
  classifyConnectionAuth,
} from "@/lib/eve/generate"
import {
  kapsoEnvFromChannel,
  telegramEnvFromChannel,
  discordEnvFromChannel,
} from "@/lib/eve/deploy-helpers"

const KAPSO_KEYS = [
  "KAPSO_API_KEY",
  "KAPSO_PHONE_NUMBER_ID",
  "KAPSO_WEBHOOK_SECRET",
] as const

const TELEGRAM_KEYS = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET_TOKEN",
] as const

const DISCORD_KEYS = [
  "DISCORD_BOT_TOKEN",
  "DISCORD_APPLICATION_ID",
  "DISCORD_PUBLIC_KEY",
] as const

export type EnvVarSpec = { key: string; value: string }

/**
 * The env var name eve reads for a static-token connection, derived from the
 * connection NAME. Mirrors generate.ts exactly (underscore separator, lowercase
 * → UPPER), so the pushed key always matches what `emitConnection` references.
 */
export function connectionTokenEnvKey(connName: string): string {
  return tokenEnvVar(slug(connName, "connection"))
}

function isNonEmpty(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0
}

/**
 * Build the full env-var spec for an agent's Vercel project from its assigned
 * token connections + (optionally) its assigned Kapso channel.
 *
 * Rules:
 *  - MCP token connection (assigned, non-stdio, non-empty token) →
 *    { key: <SLUG>_TOKEN, value: token }. OAuth/none connections emit nothing
 *    (they auth via Vercel Connect, no env secret).
 *  - Kapso channel → KAPSO_API_KEY / KAPSO_PHONE_NUMBER_ID / KAPSO_WEBHOOK_SECRET
 *    (blanks omitted; null channel → none).
 *  - Empty/whitespace values are dropped; de-dup by key (last wins).
 */
export function buildAgentEnvSpec(args: {
  agent: Agent
  connections: Connection[]
  channel: {
    /** Channel discriminator. Absent → treated as 'kapso' (legacy default). */
    type?: string
    kapsoApiKey: string | null
    kapsoPhoneNumberId: string | null
    kapsoWebhookSecret: string | null
    telegramBotToken?: string | null
    telegramWebhookSecretToken?: string | null
    discordBotToken?: string | null
    discordApplicationId?: string | null
    discordPublicKey?: string | null
  } | null
  /** Fleet Manager's AI Gateway key, propagated so the agent's runtime can call models. */
  aiGatewayApiKey?: string | null
  /** Shared secret the agent's eve channel checks to authenticate the Fleet Manager proxy. */
  eveApiSecret?: string | null
  /**
   * Per-agent M2M token HMAC(FM_AGENT_KEY, agent.id), the agent->FM callback
   * credential (runtime-config + token broker). NEVER the FM_AGENT_KEY itself.
   */
  perAgentToken?: string | null
  /**
   * Base URL of the Fleet Manager, so an OAuth connection's generated getToken
   * can fetch the FM token broker (`${FM_BASE_URL}/api/mcp/token`).
   */
  fmBaseUrl?: string | null
}): EnvVarSpec[] {
  // FM_AGENT_KEY is FM-only and must NEVER be emitted into an agent project.
  const { agent, connections, channel, aiGatewayApiKey, eveApiSecret, perAgentToken, fmBaseUrl } =
    args
  const byKey = new Map<string, string>()

  // The agent's Eve runtime needs the AI Gateway key to call its model.
  if (isNonEmpty(aiGatewayApiKey)) byKey.set("AI_GATEWAY_API_KEY", aiGatewayApiKey)
  // Shared secret so the agent's eve channel authorizes the Fleet Manager proxy
  // (the FM->agent direction; still shared, intentionally).
  if (isNonEmpty(eveApiSecret)) byKey.set("EVE_API_SECRET", eveApiSecret)
  // Per-agent token for the agent->FM callback direction (runtime-config + broker).
  if (isNonEmpty(perAgentToken)) byKey.set("EVE_AGENT_TOKEN", perAgentToken)
  // FM base URL so an OAuth connection's getToken can reach the token broker.
  if (isNonEmpty(fmBaseUrl)) byKey.set("FM_BASE_URL", fmBaseUrl)

  // Connection tokens (mirrors classifyConnectionAuth "token" branch + the
  // buildEveAgent assignment/transport filters).
  const assigned = new Set(agent.connectionIds)
  for (const conn of connections) {
    if (!assigned.has(conn.id)) continue
    if (conn.transport === "stdio") continue
    if (!isNonEmpty(conn.token)) continue
    byKey.set(connectionTokenEnvKey(conn.name), conn.token)
  }

  // Channel creds. A Telegram channel pushes its two static secrets; a Kapso
  // channel pushes the KAPSO_* mapping; a Slack channel gets its creds from
  // Vercel Connect and pushes NO env vars.
  if (channel?.type === "discord") {
    const dc = discordEnvFromChannel({
      discordBotToken: channel.discordBotToken ?? null,
      discordApplicationId: channel.discordApplicationId ?? null,
      discordPublicKey: channel.discordPublicKey ?? null,
    })
    for (const [key, value] of Object.entries(dc)) {
      if (isNonEmpty(value)) byKey.set(key, value)
    }
  } else if (channel?.type === "telegram") {
    const tg = telegramEnvFromChannel({
      telegramBotToken: channel.telegramBotToken ?? null,
      telegramWebhookSecretToken: channel.telegramWebhookSecretToken ?? null,
    })
    for (const [key, value] of Object.entries(tg)) {
      if (isNonEmpty(value)) byKey.set(key, value)
    }
  } else if (channel && channel.type !== "slack") {
    const kapso = kapsoEnvFromChannel(channel)
    for (const [key, value] of Object.entries(kapso)) {
      if (isNonEmpty(value)) byKey.set(key, value)
    }
  }

  const out = [...byKey.entries()].map(([key, value]) => ({ key, value }))
  // Hard guard: the FM-only HMAC key must never be baked into an agent project.
  if (out.some((e) => e.key === "FM_AGENT_KEY")) {
    throw new Error("FM_AGENT_KEY must never be baked into an agent project")
  }
  return out
}

/**
 * The env keys the Secrets tab should render as configurable for an agent — the
 * exact set `buildAgentEnvSpec` is capable of pushing, regardless of whether a
 * value is currently stored. Returned KEYS ONLY; never any value.
 *
 * Rules (mirror buildAgentEnvSpec + emitConnection):
 *  - One <SLUG>_TOKEN per assigned, non-stdio, TOKEN-auth connection. OAuth/none
 *    connections emit no env secret, so they contribute no key (this is the fix
 *    for the prior over-broadening that showed a phantom token field for them).
 *  - The three KAPSO_* keys when a channel is assigned (shown even when blank so
 *    the user can set them).
 */
export function expectedEnvKeys(args: {
  agent: Agent
  connections: Connection[]
  /** Assigned channel's type, or null when no channel is assigned. Only a
   *  'kapso' channel contributes KAPSO_* keys; 'slack' uses Vercel Connect. */
  channelType: string | null
}): string[] {
  const { agent, connections, channelType } = args
  const keys = new Set<string>()

  const assigned = new Set(agent.connectionIds)
  for (const conn of connections) {
    if (!assigned.has(conn.id)) continue
    if (conn.transport === "stdio") continue
    if (classifyConnectionAuth(conn) !== "token") continue
    keys.add(connectionTokenEnvKey(conn.name))
  }

  // Legacy rows have no explicit type but are Kapso; treat null type as kapso
  // only when a channel exists. null channelType = no channel → no keys.
  if (channelType === "kapso") {
    for (const k of KAPSO_KEYS) keys.add(k)
  }
  if (channelType === "telegram") {
    for (const k of TELEGRAM_KEYS) keys.add(k)
  }
  if (channelType === "discord") {
    for (const k of DISCORD_KEYS) keys.add(k)
  }

  return [...keys]
}
