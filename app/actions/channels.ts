"use server"

import { db } from "@/lib/db"
import { agents, channels } from "@/lib/db/schema"
import { requireUserId } from "@/lib/session"
import {
  toClientChannel,
  type ClientChannel,
} from "@/lib/channels/client-channel"
import {
  listKapsoPhoneNumbers,
  type KapsoPhoneNumber,
} from "@/lib/channels/kapso"
import { and, desc, eq } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { after } from "next/server"
import { randomUUID, randomBytes } from "crypto"
import { deployAndPromoteAgent } from "@/app/actions/deploy"
import { listConnectors } from "@/lib/vercel/client"
import { resolveVercelAuth } from "@/lib/vercel/auth"
import { getVercelTeamSlug } from "@/lib/vercel/team-slug"

// Auto-apply: a channel's creds are baked into the agent's Vercel project at
// DEPLOY time, so any channel change only takes effect on a redeploy. Kick a
// background redeploy of the affected agent(s) so "configure a channel" just
// works without a manual Deploy click. We deploy AND promote: a channel change
// must land on production, otherwise the build sits at preview_ready and the
// bot keeps running the old code (the channel never actually activates). Errors
// are swallowed (the core persists its own failure state); a deploy already in
// progress throws and is ignored.
//
// NOTE: do NOT pre-write deploymentStatus='deploying' here — deploy-core uses a
// CAS deploy-lock that refuses to start if the row is already 'deploying', so a
// pre-write would make the background deploy throw "already in progress" and
// leave the agent stuck deploying forever. The "show the build immediately"
// concern is handled client-side (the channels view's `busy` state).
function autoRedeploy(...agentIds: (string | null | undefined)[]) {
  const unique = [...new Set(agentIds.filter((a): a is string => !!a))]
  for (const agentId of unique) {
    after(async () => {
      try {
        await deployAndPromoteAgent(agentId)
      } catch {
        // already-in-progress / transient — the core records its own state
      }
    })
    revalidatePath(`/agents/${agentId}`)
  }
}

const MAX_NAME_LENGTH = 80
const MAX_SECRET_LENGTH = 8000
const MAX_ID_LENGTH = 128

function text(value: unknown, max: number): string {
  return (typeof value === "string" ? value : "").trim().slice(0, max)
}

// Not exported: full rows carry channel secrets (bot tokens, webhook secrets,
// API keys). Exporting from this "use server" module would publish them as
// browser-callable endpoints. UI must use getChannelsForClient() (stripped).
async function getChannels() {
  const userId = await requireUserId()
  return db
    .select()
    .from(channels)
    .where(eq(channels.userId, userId))
    .orderBy(desc(channels.createdAt))
}

export async function getChannelsForClient(): Promise<ClientChannel[]> {
  const rows = await getChannels()
  return rows.map(toClientChannel)
}

// Not exported — same secret-leak reason as getChannels above.
async function getChannel(id: string) {
  const userId = await requireUserId()
  const rows = await db
    .select()
    .from(channels)
    .where(and(eq(channels.id, id), eq(channels.userId, userId)))
  return rows[0] ?? null
}

export type ChannelInput = {
  name: string
  type?: string
  agentId?: string | null
  kapsoApiKey?: string | null
  kapsoPhoneNumberId?: string | null
  kapsoPhoneNumber?: string | null
  kapsoWebhookSecret?: string | null
  slackConnectUid?: string | null
  telegramBotToken?: string | null
  telegramWebhookSecretToken?: string | null
  telegramBotUsername?: string | null
  discordBotToken?: string | null
  discordApplicationId?: string | null
  discordPublicKey?: string | null
}

function computeStatus(input: {
  type?: string
  agentId?: string | null
  kapsoApiKey?: string | null
  kapsoPhoneNumberId?: string | null
  kapsoWebhookSecret?: string | null
  slackConnectUid?: string | null
  telegramBotToken?: string | null
  telegramWebhookSecretToken?: string | null
  discordBotToken?: string | null
  discordApplicationId?: string | null
  discordPublicKey?: string | null
}) {
  if (!input.agentId) return "disconnected"
  if (input.type === "slack") {
    return input.slackConnectUid ? "connected" : "disconnected"
  }
  if (input.type === "telegram") {
    return input.telegramBotToken && input.telegramWebhookSecretToken
      ? "connected"
      : "disconnected"
  }
  if (input.type === "discord") {
    return input.discordBotToken &&
      input.discordApplicationId &&
      input.discordPublicKey
      ? "connected"
      : "disconnected"
  }
  return input.kapsoApiKey && input.kapsoPhoneNumberId && input.kapsoWebhookSecret
    ? "connected"
    : "disconnected"
}

async function assertAgentExists(userId: string, agentId: string | null) {
  if (!agentId) return
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
    .limit(1)
  if (!rows[0]) throw new Error("Assigned agent not found")
}

/**
 * One channel per agent: reject if `agentId` already runs a channel other than
 * `exceptChannelId`. The deploy pipeline (deploy-core, env-spec, generate)
 * compiles a single assigned channel per agent, so an agent must not be the bot
 * on two surfaces at once.
 */
async function assertAgentChannelFree(
  userId: string,
  agentId: string | null,
  exceptChannelId?: string,
) {
  if (!agentId) return
  const userChannels = await db
    .select()
    .from(channels)
    .where(eq(channels.userId, userId))
  const conflict = userChannels.find(
    (c) => c.id !== exceptChannelId && c.agentId === agentId,
  )
  if (conflict) {
    throw new Error(
      `That agent already runs the "${conflict.name}" channel. An agent can run on only one channel — unassign it there first.`,
    )
  }
}

function validateChannelAssignment(input: {
  type?: string
  agentId: string | null
  kapsoApiKey: string | null
  kapsoPhoneNumberId: string | null
  kapsoWebhookSecret: string | null
  slackConnectUid: string | null
  telegramBotToken?: string | null
  telegramWebhookSecretToken?: string | null
  discordBotToken?: string | null
  discordApplicationId?: string | null
  discordPublicKey?: string | null
}) {
  if (!input.agentId) return
  if (input.type === "slack") {
    if (!input.slackConnectUid) {
      throw new Error(
        "Assigned Slack channels require a Vercel Connect connector UID",
      )
    }
    return
  }
  if (input.type === "telegram") {
    if (!input.telegramBotToken || !input.telegramWebhookSecretToken) {
      throw new Error(
        "Assigned Telegram channels require a bot token and webhook secret token",
      )
    }
    return
  }
  if (input.type === "discord") {
    if (
      !input.discordBotToken ||
      !input.discordApplicationId ||
      !input.discordPublicKey
    ) {
      throw new Error(
        "Assigned Discord channels require a bot token, application id, and public key",
      )
    }
    return
  }
  if (
    !input.kapsoApiKey ||
    !input.kapsoPhoneNumberId ||
    !input.kapsoWebhookSecret
  ) {
    throw new Error(
      "Assigned Kapso channels require API key, phone number id, and webhook secret",
    )
  }
}

function normalizeChannelInput(
  input: ChannelInput,
  existing?: typeof channels.$inferSelect,
) {
  const name = text(input.name, MAX_NAME_LENGTH)
  if (!name) throw new Error("Name is required")

  const next = {
    name,
    // Channel type is immutable after creation: keep the existing row's type on
    // update; default to 'kapso' on create when unspecified (legacy default).
    type: existing?.type ?? (text(input.type, MAX_ID_LENGTH) || "kapso"),
    agentId: text(input.agentId, MAX_ID_LENGTH) || null,
    kapsoApiKey:
      input.kapsoApiKey === undefined
        ? (existing?.kapsoApiKey ?? null)
        : text(input.kapsoApiKey, MAX_SECRET_LENGTH) || null,
    kapsoPhoneNumberId:
      input.kapsoPhoneNumberId === undefined
        ? (existing?.kapsoPhoneNumberId ?? null)
        : text(input.kapsoPhoneNumberId, MAX_SECRET_LENGTH) || null,
    kapsoPhoneNumber:
      input.kapsoPhoneNumber === undefined
        ? (existing?.kapsoPhoneNumber ?? null)
        : text(input.kapsoPhoneNumber, MAX_ID_LENGTH) || null,
    kapsoWebhookSecret:
      input.kapsoWebhookSecret === undefined
        ? (existing?.kapsoWebhookSecret ?? null)
        : text(input.kapsoWebhookSecret, MAX_SECRET_LENGTH) || null,
    slackConnectUid:
      input.slackConnectUid === undefined
        ? (existing?.slackConnectUid ?? null)
        : text(input.slackConnectUid, MAX_SECRET_LENGTH) || null,
    telegramBotToken:
      input.telegramBotToken === undefined
        ? (existing?.telegramBotToken ?? null)
        : text(input.telegramBotToken, MAX_SECRET_LENGTH) || null,
    telegramWebhookSecretToken:
      input.telegramWebhookSecretToken === undefined
        ? (existing?.telegramWebhookSecretToken ?? null)
        : text(input.telegramWebhookSecretToken, MAX_SECRET_LENGTH) || null,
    telegramBotUsername:
      input.telegramBotUsername === undefined
        ? (existing?.telegramBotUsername ?? null)
        : text(input.telegramBotUsername, MAX_ID_LENGTH) || null,
    // Discord: three static secrets, preserve-on-blank like the telegram token.
    // NOTE: unlike telegram there is NO auto-mint here — none of the three are
    // generated. The public key is issued by the Discord Developer Portal.
    discordBotToken:
      input.discordBotToken === undefined
        ? (existing?.discordBotToken ?? null)
        : text(input.discordBotToken, MAX_SECRET_LENGTH) || null,
    discordApplicationId:
      input.discordApplicationId === undefined
        ? (existing?.discordApplicationId ?? null)
        : text(input.discordApplicationId, MAX_SECRET_LENGTH) || null,
    discordPublicKey:
      input.discordPublicKey === undefined
        ? (existing?.discordPublicKey ?? null)
        : text(input.discordPublicKey, MAX_SECRET_LENGTH) || null,
  }

  // Generate the Telegram webhook secret token ONCE, at channel-create time
  // (no `existing` row), when none was provided. It is the value the deployed
  // runtime checks against the X-Telegram-Bot-Api-Secret-Token header, so it
  // must never be re-minted on update or promote (that would break the header
  // check until re-register). base64url is already Telegram-compliant
  // ([A-Za-z0-9_-], <=256 chars).
  if (!existing && next.type === "telegram" && !next.telegramWebhookSecretToken) {
    next.telegramWebhookSecretToken = randomBytes(32).toString("base64url")
  }

  // Generate the Kapso webhook signing secret ONCE at create time when none was
  // provided. Kapso's create-webhook endpoint takes a client-supplied secret_key,
  // so the control plane mints it here, bakes it into the agent
  // (KAPSO_WEBHOOK_SECRET) and registers it on promote — the operator never picks
  // or pastes a secret. Never re-mint on update (that would break the deployed
  // agent's HMAC check until the next promote re-registers).
  if (!existing && next.type === "kapso" && !next.kapsoWebhookSecret) {
    next.kapsoWebhookSecret = randomBytes(32).toString("hex")
  }

  validateChannelAssignment(next)
  return next
}

/**
 * List the team's Slack Vercel-Connect connectors for the channel form's
 * picker. Returns UID + whether it supports triggers (a connector created
 * without --triggers can't deliver Slack events, so the UI can warn). Auth/
 * config failures degrade to [] (manual entry still works).
 */
export async function getSlackConnectors(): Promise<{
  connectors: { uid: string; supportsTriggers: boolean }[]
  /** Deep-link to the Vercel Connect dashboard to create a new connector, or null. */
  createUrl: string | null
}> {
  await requireUserId()
  const slug = getVercelTeamSlug()
  // Deep-link straight to Slack connector creation (?service=slack pre-selects it
  // in the Vercel Connect dashboard) instead of the generic connector picker.
  const createUrl = slug
    ? `https://vercel.com/${encodeURIComponent(slug)}/~/connect?service=slack`
    : null
  try {
    const { token, teamId } = await resolveVercelAuth()
    const all = await listConnectors({ token, teamId })
    return {
      connectors: all
        .filter((c) => c.type === "slack")
        .map((c) => ({ uid: c.uid, supportsTriggers: c.supportsTriggers })),
      createUrl,
    }
  } catch {
    return { connectors: [], createUrl }
  }
}

/**
 * Discover the Kapso project's phone numbers for the channel form's picker, so
 * the operator never pastes a raw `phone_number_id`. Resolves the key from the
 * explicitly typed `apiKey` (new-channel case) or, failing that, from the
 * existing channel's STORED key (the client never re-sends the secret). Network/
 * auth failures degrade to an `error` string the form can show (manual entry of
 * the id still works).
 */
export async function discoverKapsoPhoneNumbers(input: {
  apiKey?: string | null
  channelId?: string | null
}): Promise<{ numbers: KapsoPhoneNumber[]; error: string | null }> {
  const userId = await requireUserId()
  let key = text(input.apiKey, MAX_SECRET_LENGTH)
  if (!key && input.channelId) {
    const rows = await db
      .select({ kapsoApiKey: channels.kapsoApiKey })
      .from(channels)
      .where(and(eq(channels.id, input.channelId), eq(channels.userId, userId)))
      .limit(1)
    key = (rows[0]?.kapsoApiKey ?? "").trim()
  }
  if (!key) return { numbers: [], error: "A Kapso API key is required" }
  try {
    return { numbers: await listKapsoPhoneNumbers(key), error: null }
  } catch (e) {
    return {
      numbers: [],
      error: e instanceof Error ? e.message : "Failed to reach Kapso",
    }
  }
}

export async function createChannel(input: ChannelInput) {
  const userId = await requireUserId()
  const next = normalizeChannelInput(input)
  await assertAgentExists(userId, next.agentId)
  await assertAgentChannelFree(userId, next.agentId)
  const id = randomUUID()
  await db.insert(channels).values({
    id,
    userId,
    name: next.name,
    type: next.type,
    agentId: next.agentId,
    kapsoApiKey: next.kapsoApiKey,
    kapsoPhoneNumberId: next.kapsoPhoneNumberId,
    kapsoPhoneNumber: next.kapsoPhoneNumber,
    kapsoWebhookSecret: next.kapsoWebhookSecret,
    slackConnectUid: next.slackConnectUid,
    telegramBotToken: next.telegramBotToken,
    telegramWebhookSecretToken: next.telegramWebhookSecretToken,
    telegramBotUsername: next.telegramBotUsername,
    discordBotToken: next.discordBotToken,
    discordApplicationId: next.discordApplicationId,
    discordPublicKey: next.discordPublicKey,
    status: computeStatus(next),
  })
  revalidatePath("/channels")
  autoRedeploy(next.agentId)
  return id
}

export async function updateChannel(id: string, input: ChannelInput) {
  const userId = await requireUserId()
  const rows = await db
    .select()
    .from(channels)
    .where(and(eq(channels.id, id), eq(channels.userId, userId)))
    .limit(1)
  const existing = rows[0]
  if (!existing) throw new Error("Channel not found")

  const next = normalizeChannelInput(input, existing)
  await assertAgentExists(userId, next.agentId)

  await db
    .update(channels)
    .set({
      ...next,
      status: computeStatus(next),
      updatedAt: new Date(),
    })
    .where(and(eq(channels.id, id), eq(channels.userId, userId)))
  revalidatePath("/channels")
  // Re-deploy the newly-assigned agent (and the previously-assigned one, to drop
  // its stale Kapso creds) so the credential change takes effect.
  autoRedeploy(existing.agentId, next.agentId)
}

export async function assignAgentToChannel(
  channelId: string,
  agentId: string | null,
) {
  const userId = await requireUserId()
  const existing = await getChannel(channelId)
  if (!existing) throw new Error("Channel not found")
  const nextAgentId = text(agentId, MAX_ID_LENGTH) || null
  await assertAgentExists(userId, nextAgentId)
  await assertAgentChannelFree(userId, nextAgentId, channelId)
  validateChannelAssignment({
    type: existing.type,
    agentId: nextAgentId,
    kapsoApiKey: existing.kapsoApiKey,
    kapsoPhoneNumberId: existing.kapsoPhoneNumberId,
    kapsoWebhookSecret: existing.kapsoWebhookSecret,
    slackConnectUid: existing.slackConnectUid,
    telegramBotToken: existing.telegramBotToken,
    telegramWebhookSecretToken: existing.telegramWebhookSecretToken,
    discordBotToken: existing.discordBotToken,
    discordApplicationId: existing.discordApplicationId,
    discordPublicKey: existing.discordPublicKey,
  })
  await db
    .update(channels)
    .set({
      agentId: nextAgentId,
      status: computeStatus({
        type: existing.type,
        agentId: nextAgentId,
        kapsoApiKey: existing.kapsoApiKey,
        kapsoPhoneNumberId: existing.kapsoPhoneNumberId,
        kapsoWebhookSecret: existing.kapsoWebhookSecret,
        slackConnectUid: existing.slackConnectUid,
        telegramBotToken: existing.telegramBotToken,
        telegramWebhookSecretToken: existing.telegramWebhookSecretToken,
        discordBotToken: existing.discordBotToken,
        discordApplicationId: existing.discordApplicationId,
        discordPublicKey: existing.discordPublicKey,
      }),
      updatedAt: new Date(),
    })
    .where(and(eq(channels.id, channelId), eq(channels.userId, userId)))
  revalidatePath("/channels")
  // Re-deploy both the new and the previously-assigned agent so the Kapso creds
  // are applied (new) and removed (old).
  autoRedeploy(existing.agentId, nextAgentId)
}

export async function deleteChannel(id: string) {
  const userId = await requireUserId()
  await db
    .delete(channels)
    .where(and(eq(channels.id, id), eq(channels.userId, userId)))
  revalidatePath("/channels")
}

/** Operator confirms they pasted the webhook URL into Kapso (manual step). */
export async function markChannelWebhookRegistered(
  channelId: string,
  registered: boolean,
) {
  const userId = await requireUserId()
  await db
    .update(channels)
    .set({
      webhookStatus: registered ? "registered" : "pending",
      updatedAt: new Date(),
    })
    .where(and(eq(channels.id, channelId), eq(channels.userId, userId)))
  revalidatePath("/channels")
}

/**
 * Verify the deployed agent's Kapso webhook endpoint: sign a synthetic
 * (message-less) `whatsapp.message.received` payload with the channel's webhook
 * secret and POST it to the agent's /kapso/webhook. A 200 proves the
 * endpoint is live AND the deployed secret matches (signature accepted) WITHOUT
 * triggering an agent turn (no inbound messages in the payload). A 401 means the
 * deployed agent's secret differs from the channel's — i.e. it needs a redeploy.
 */
export async function testChannelWebhook(
  channelId: string,
): Promise<{ ok: boolean; status: number; error?: string }> {
  const userId = await requireUserId()
  const channel = await getChannel(channelId)
  if (!channel) throw new Error("Channel not found")
  if (!channel.agentId) {
    return { ok: false, status: 0, error: "Channel is not assigned to an agent" }
  }
  if (!channel.kapsoWebhookSecret) {
    return { ok: false, status: 0, error: "Channel has no webhook secret" }
  }

  const agentRows = await db
    .select({
      deploymentUrl: agents.deploymentUrl,
      deploymentStatus: agents.deploymentStatus,
    })
    .from(agents)
    .where(and(eq(agents.id, channel.agentId), eq(agents.userId, userId)))
    .limit(1)
  const agent = agentRows[0]
  if (!agent || agent.deploymentStatus !== "deployed" || !agent.deploymentUrl) {
    return { ok: false, status: 0, error: "Assigned agent is not deployed yet" }
  }

  const { createHmac } = await import("node:crypto")
  // Message-less event: passes signature verification, parses to zero inbound
  // messages → the agent answers 200 without running a turn or sending a reply.
  const rawBody = JSON.stringify({ event: "webhook.test", data: [] })
  const signature = createHmac("sha256", channel.kapsoWebhookSecret)
    .update(rawBody)
    .digest("hex")
  const base = agent.deploymentUrl.trim().replace(/\/+$/, "")

  let status = 0
  let error: string | undefined
  try {
    const res = await fetch(`${base}/kapso/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-signature": signature,
      },
      body: rawBody,
      signal: AbortSignal.timeout(20_000),
    })
    status = res.status
    if (!res.ok) {
      error =
        res.status === 401
          ? "Signature rejected — the deployed agent's secret differs. Re-deploy the agent."
          : `Webhook returned ${res.status}`
    }
  } catch (e) {
    error = e instanceof Error ? e.message : "Request failed"
  }

  const ok = status === 200
  await db
    .update(channels)
    .set({
      webhookStatus: ok ? "verified" : "failed",
      webhookTestedAt: new Date(),
      webhookTestError: error ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(channels.id, channelId), eq(channels.userId, userId)))
  revalidatePath("/channels")
  return { ok, status, error }
}
