/**
 * Session-free deploy/promote core.
 *
 * The bodies of the former `deployAgent` / `promoteAgentDeployment` server
 * actions, lifted out of the request context so they are callable from a
 * Vercel Workflow (which has no request session) as well as from the thin
 * `'use server'` wrappers in {@link app/actions/deploy.ts}.
 *
 * The 3 request-context deps that lived in the action are gone here:
 *   - `requireUserId()` → `userId` is a param (the workflow passes
 *     {@link DEMO_USER_ID}).
 *   - `getConnections()` (transitively called requireUserId) → connections are
 *     read session-free, or passed via `opts.connections`.
 *   - `revalidatePath()` → lives ONLY in the wrapper. This module imports
 *     neither `next/cache` nor `react`'s `cache()` — it is a plain module, safe
 *     outside a request in Next 16.
 *
 * Everything else (db, CAS deploy-lock, slug re-assert, build, env, Vercel
 * REST, status persistence, failure row, promote + prodUrl) is unchanged from
 * the action.
 */

import { db } from "@/lib/db"
import { agents, channels, connections, type Connection } from "@/lib/db/schema"
import { projectName, EVE_VERSION } from "./project"
import { buildEveProject } from "./project"
import { buildDeploymentFiles } from "@/lib/vercel/deploy"
import { agentConfigHash, agentConfigSnapshot } from "./config-drift"
import {
  createDeployment,
  pollUntilReady,
  ensureProject,
  upsertProjectEnv,
  promoteDeployment,
  attachConnectorToProject,
  attachTriggerDestination,
} from "@/lib/vercel/client"
import { vercelConnectUid } from "./generate"
import { resolveVercelAuth } from "@/lib/vercel/auth"
import { buildAgentEnvSpec } from "./env-spec"
import { agentToken } from "./agent-token"
import { claimedDeployLock, truncate } from "./deploy-helpers"
import { setTelegramWebhook } from "@/lib/telegram/set-webhook"
import { setDiscordInteractionsEndpoint } from "@/lib/discord/set-interactions-endpoint"
import { registerKapsoWebhook } from "@/lib/channels/kapso"
import { and, eq, ne, or, lt } from "drizzle-orm"

// A "deploying" row is a lease, not a permanent lock: if a deploy process dies
// mid-flight the row would otherwise stay "deploying" forever and block all
// future deploys. A row stuck deploying longer than this is treated as stale and
// can be reclaimed. Must exceed the longest healthy deploy (remote Node build +
// poll); 15 min is comfortably above that.
const STALE_DEPLOY_LOCK_MS = 15 * 60 * 1000

export type DeployAgentCoreOpts = {
  connections?: Connection[]
  /** Override the eve pin (fleet version-update target). Defaults to EVE_VERSION. */
  eveVersion?: string
  /** Override the ai pin (resolved per-eve-version from npm). */
  aiVersion?: string
  /** Rebuild from `agent.deployedConfig` (version-only update) — Task 4. */
  fromSnapshot?: boolean
  /** Skip the internal READY poll; the caller (workflow) polls via getReadyState. */
  skipPoll?: boolean
  /**
   * Gated-bump preview-test mode: build + deploy a THROWAWAY preview pinned to a
   * candidate eve version, but leave the live agent row UNTOUCHED. No CAS
   * deploy-lock (the agent stays "deployed"), no preview_ready/eveVersion/
   * previewUrl/previewDeploymentId write, no verdict-column clear. The verdict
   * (eveVerifiedVersion / eveVerifyError) is owned by the testEvePreview caller,
   * which pings this preview and deletes it on failure. Returns the handle only.
   */
  previewTest?: boolean
}

/**
 * Build + deploy a single agent's Eve project to a STAGED production deploy
 * (does NOT take the prod domain). Returns the preview deployment handle. On
 * build ERROR/timeout the throw propagates (the workflow classifies it; the
 * wrapper sanitizes it for the client).
 */
export async function deployAgentCore(
  userId: string,
  agentId: string,
  opts: DeployAgentCoreOpts = {},
): Promise<{ previewUrl: string; previewDeploymentId: string }> {
  // 1. Resolve (scoped read) — session-free.
  const rows = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
  const agent = rows[0]
  if (!agent) throw new Error("Agent not found")

  const connections_ =
    opts.connections ??
    (await db.select().from(connections).where(eq(connections.userId, userId)))

  const assignedChannels = await db
    .select()
    .from(channels)
    .where(and(eq(channels.agentId, agentId), eq(channels.userId, userId)))
  const assignedChannel = assignedChannels[0] ?? null
  if (assignedChannel) {
    if (assignedChannel.type === "slack") {
      // Slack uses Vercel Connect — no creds in our DB, just the connector UID.
      if (!assignedChannel.slackConnectUid) {
        throw new Error("Assigned Slack channel is missing its Vercel Connect connector UID")
      }
    } else if (assignedChannel.type === "telegram") {
      // Telegram pushes two static secrets to the project env (Kapso-shaped).
      if (!assignedChannel.telegramBotToken || !assignedChannel.telegramWebhookSecretToken) {
        throw new Error("Assigned Telegram channel is missing its bot token or webhook secret token")
      }
    } else if (assignedChannel.type === "discord") {
      // Discord pushes three static secrets to the project env. None are
      // auto-minted (the public key is issued by the Discord portal), so all
      // three must be present before deploy.
      if (
        !assignedChannel.discordBotToken ||
        !assignedChannel.discordApplicationId ||
        !assignedChannel.discordPublicKey
      ) {
        throw new Error(
          "Assigned Discord channel is missing its bot token, application id, or public key",
        )
      }
    } else if (
      !assignedChannel.kapsoApiKey ||
      !assignedChannel.kapsoPhoneNumberId ||
      !assignedChannel.kapsoWebhookSecret
    ) {
      throw new Error("Assigned channel is missing required Kapso credentials")
    }
  }

  // 2. CAS deploy-lock — only transition a row NOT already "deploying". Skipped
  //    in previewTest mode: a preview-test must NOT flip the live "deployed" row
  //    to "deploying" (it builds a throwaway preview, the prod runtime is
  //    untouched). It still refuses to run on a row mid-deploy to avoid racing a
  //    real deploy that owns the lock.
  if (opts.previewTest) {
    if (agent.deploymentStatus === "deploying") {
      throw new Error("A deployment for this agent is already in progress")
    }
  } else {
    const staleBefore = new Date(Date.now() - STALE_DEPLOY_LOCK_MS)
    const claimed = await db
      .update(agents)
      .set({ deploymentStatus: "deploying", deploymentError: null, updatedAt: new Date() })
      .where(
        and(
          eq(agents.id, agentId),
          eq(agents.userId, userId),
          // Claim if not currently deploying, OR if a prior deploy left the lease
          // stale (its updatedAt is older than the timeout → process died).
          or(
            ne(agents.deploymentStatus, "deploying"),
            lt(agents.updatedAt, staleBefore),
          ),
        ),
      )
      .returning({ id: agents.id })
    if (!claimedDeployLock(claimed.length)) {
      throw new Error("A deployment for this agent is already in progress")
    }
  }

  try {
    // fromSnapshot: a version-only update rebuilds from `agent.deployedConfig`
    // (the frozen snapshot), NOT the live row — otherwise "update eve" would
    // silently ship any pending config edits. The live row supplies immutable
    // id + userId; the snapshot overrides the 14 BUILD_FIELDS (incl. name →
    // same projectName → same Vercel project, not a new one). Guard: no
    // snapshot (never deployed) → fail loud, do NOT rebuild.
    if (opts.fromSnapshot && !agent.deployedConfig) {
      throw new Error("Cannot version-update an agent with no snapshot (never deployed)")
    }
    const buildAgent = opts.fromSnapshot
      ? { ...agent, ...agent.deployedConfig }
      : agent

    // 3. Safe slug + paranoid re-assert.
    const slug = projectName(buildAgent)
    if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) {
      throw new Error("Could not derive a safe project name")
    }

    // 4. Build the deployment file list (pure).
    const files = buildDeploymentFiles(
      buildEveProject(buildAgent, {
        connections: connections_,
        channel: assignedChannel
          ? {
              type: assignedChannel.type,
              slackConnectUid: assignedChannel.slackConnectUid,
              telegramBotUsername: assignedChannel.telegramBotUsername,
            }
          : null,
        eveVersion: opts.eveVersion,
        aiVersion: opts.aiVersion,
      }),
    )

    // 5. Vercel creds + REST client config.
    const { token, teamId } = await resolveVercelAuth()
    const cfg = { token, teamId }

    await ensureProject(cfg, slug)

    // 5c-i. Turn off Vercel SSO deployment protection for the agent project so
    //       the runtime is publicly reachable. No-op on failure.
    await fetch(
      `https://api.vercel.com/v9/projects/${encodeURIComponent(slug)}?teamId=${cfg.teamId}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ssoProtection: null }),
      },
    ).catch(() => {})

    // 5c-ii. Attach any Vercel-Connect-backed connectors the agent uses to this
    //        project, so its runtime OIDC can exchange for the connector token
    //        (eve `connect(uid)`). The connector lives at the team level but
    //        each consuming project must be attached. Best-effort: a failure
    //        only breaks that one connection, not the whole deploy.
    const assignedConnIds = new Set(buildAgent.connectionIds)
    const connectorUids = [
      ...new Set(
        connections_
          .filter((c) => assignedConnIds.has(c.id))
          .map(vercelConnectUid)
          .filter((u): u is string => u !== null),
      ),
    ]
    for (const uid of connectorUids) {
      await attachConnectorToProject(cfg, uid, slug).catch((err) => {
        console.error(
          `[deploy] attach connector "${uid}" to "${slug}" failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      })
    }

    // 5c-iii. A Slack channel is eve-native via Vercel Connect: attach the
    //         channel's connector to the project (token access) AND route its
    //         inbound trigger to the agent's Slack route, so Slack delivers
    //         app_mention/message.im events to /eve/v1/slack. Best-effort: a
    //         failure logs but does not abort the deploy (the connector may need
    //         a one-time browser-OAuth install before triggers resolve).
    if (assignedChannel?.type === "slack" && assignedChannel.slackConnectUid) {
      const channelUid = assignedChannel.slackConnectUid
      await attachConnectorToProject(cfg, channelUid, slug).catch((err) => {
        console.error(
          `[deploy] attach slack connector "${channelUid}" to "${slug}" failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      })
      await attachTriggerDestination(cfg, channelUid, slug, "/eve/v1/slack").catch((err) => {
        console.error(
          `[deploy] route slack trigger "${channelUid}" → "${slug}/eve/v1/slack" failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      })
    }

    if (!process.env.FM_AGENT_KEY) {
      // The FM only accepts per-agent tokens now; without FM_AGENT_KEY the agent
      // gets no usable EVE_AGENT_TOKEN and its runtime-config / token-broker calls
      // will 401 (prompt refresh degrades to the baked fallback prompt).
      console.warn(
        "[deploy] FM_AGENT_KEY unset — agent will have NO valid runtime credential",
      )
    }
    const envSpecs = buildAgentEnvSpec({
      agent,
      connections: connections_,
      channel: assignedChannel,
      aiGatewayApiKey: process.env.AI_GATEWAY_API_KEY,
      eveApiSecret: process.env.EVE_API_SECRET,
      // Per-agent callback credential (derived, not stored). Null when FM_AGENT_KEY
      // is unset → agent falls back to EVE_API_SECRET during migration.
      perAgentToken: process.env.FM_AGENT_KEY
        ? agentToken(agent.id, process.env.FM_AGENT_KEY)
        : null,
      fmBaseUrl: process.env.APP_URL,
    })
    await upsertProjectEnv(cfg, slug, envSpecs)

    // 6. Create the staged production deploy.
    const created = await createDeployment(cfg, { name: slug, files })

    // 7. Poll until READY unless the caller owns polling (workflow path).
    if (!opts.skipPoll) {
      await pollUntilReady(cfg, created.id)
    }
    const url = created.url

    // previewTest: the live row must stay exactly as it was (still "deployed" on
    // its current eve version). Skip ALL persistence here — the throwaway preview
    // handle goes back to testEvePreview, which records the verdict and deletes
    // the preview on failure. Nothing about the prod runtime changed.
    if (opts.previewTest) {
      return { previewUrl: url, previewDeploymentId: created.id }
    }

    // 8. Persist preview state. On the fromSnapshot (version-only) path do NOT
    //    re-stamp deployedConfig/Hash — that would erase pending drift and
    //    falsely mark unsaved edits as deployed. Only the pin + lastDeployedAt
    //    move. The normal deploy path keeps re-stamping from the live row.
    const driftStamp = opts.fromSnapshot
      ? {}
      : {
          deployedConfigHash: agentConfigHash(agent),
          deployedConfig: agentConfigSnapshot(agent),
          // A config (re)deploy invalidates any gated-bump preview-test verdict:
          // it was tied to the OLD config, so a stale verified version must not
          // un-gate, nor a stale error linger. Cleared here so a re-test is
          // required. (Not touched on the fromSnapshot version-only path.)
          eveVerifiedVersion: null,
          eveVerifyError: null,
        }
    await db
      .update(agents)
      .set({
        deploymentStatus: "preview_ready",
        previewUrl: url,
        previewDeploymentId: created.id,
        // The real Vercel PROJECT id (matches OTel spans' vercel.projectId), not
        // the deployment id. Fallback to deployment id only if the API omitted it.
        vercelProjectId: created.projectId ?? created.id,
        eveVersion: opts.eveVersion ?? EVE_VERSION,
        lastDeployedAt: new Date(),
        ...driftStamp,
        deploymentError: null,
        updatedAt: new Date(),
      })
      .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))

    return { previewUrl: url, previewDeploymentId: created.id }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[deployAgentCore] failed for ${agentId}:`, message)
    // previewTest: a throwaway-preview build failure must NOT mark the live
    // (still-deployed) agent as "failed". The error is captured by testEvePreview
    // as the verdict (eveVerifyError); the prod runtime is unaffected. Re-throw so
    // the caller classifies it.
    if (!opts.previewTest) {
      await db
        .update(agents)
        .set({
          deploymentStatus: "failed",
          deploymentError: truncate(message),
          updatedAt: new Date(),
        })
        .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
    }
    throw err
  }
}

/**
 * Promote an already-built deployment to the agent's production runtime
 * (Vercel's native promote — also used for rollback to an older build).
 * Session-free: takes an explicit `userId`.
 */
export async function promoteAgentCore(
  userId: string,
  agentId: string,
  deploymentId: string,
): Promise<{ url: string }> {
  const rows = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
  const agent = rows[0]
  if (!agent) throw new Error("Agent not found")

  const { token, teamId } = await resolveVercelAuth()
  const cfg = { token, teamId }

  const slug = projectName(agent)
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) {
    throw new Error("Could not derive a safe project name")
  }

  await promoteDeployment(cfg, slug, deploymentId)

  const prodUrl = `https://${slug}.vercel.app`
  await db
    .update(agents)
    .set({
      deploymentStatus: "deployed",
      deploymentUrl: prodUrl,
      lastDeployedAt: new Date(),
      deploymentError: null,
      previewUrl: null,
      previewDeploymentId: null,
      updatedAt: new Date(),
    })
    .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))

  // Telegram inbound registration. The prod URL only exists now (promote), and
  // Telegram has no Vercel Connect, so we register the webhook here via the Bot
  // API. Best-effort: a failure degrades only the inbound binding — the deploy
  // is already finalized above (deploymentStatus='deployed') and this block can
  // NEVER throw out of promote. (Mirrors the Slack attachTriggerDestination
  // catch-and-log style.)
  const assignedChannels = await db
    .select()
    .from(channels)
    .where(and(eq(channels.agentId, agentId), eq(channels.userId, userId)))
  const assignedChannel = assignedChannels[0] ?? null
  if (
    assignedChannel?.type === "telegram" &&
    assignedChannel.telegramBotToken &&
    assignedChannel.telegramWebhookSecretToken
  ) {
    const channelId = assignedChannel.id
    await setTelegramWebhook({
      botToken: assignedChannel.telegramBotToken,
      webhookSecretToken: assignedChannel.telegramWebhookSecretToken,
      url: `${prodUrl}/eve/v1/telegram`,
    })
      .then(async () => {
        try {
          await db
            .update(channels)
            .set({
              webhookStatus: "registered",
              webhookTestedAt: new Date(),
              webhookTestError: null,
              updatedAt: new Date(),
            })
            .where(and(eq(channels.id, channelId), eq(channels.userId, userId)))
        } catch (err) {
          console.error(`[promote] telegram webhookStatus(registered) write failed: ${err}`)
        }
      })
      .catch(async (err) => {
        console.error(`[promote] telegram setWebhook for "${slug}" failed: ${err}`)
        try {
          await db
            .update(channels)
            .set({
              webhookStatus: "failed",
              webhookTestError: truncate(String(err)),
              webhookTestedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(and(eq(channels.id, channelId), eq(channels.userId, userId)))
        } catch (err2) {
          console.error(`[promote] telegram webhookStatus(failed) write failed: ${err2}`)
        }
      })
  }

  // Discord inbound registration. Same best-effort shape as telegram above: the
  // prod URL only exists now (promote), Discord has no Vercel Connect, and the
  // interactions endpoint is API-settable, so we register it here via the
  // Discord REST API. A failure degrades only the inbound binding — the deploy
  // is already finalized (deploymentStatus='deployed') and this block can NEVER
  // throw out of promote. The bot token lives in the Authorization header and is
  // never logged.
  if (
    assignedChannel?.type === "discord" &&
    assignedChannel.discordBotToken &&
    assignedChannel.discordApplicationId &&
    assignedChannel.discordPublicKey
  ) {
    const channelId = assignedChannel.id
    await setDiscordInteractionsEndpoint({
      botToken: assignedChannel.discordBotToken,
      applicationId: assignedChannel.discordApplicationId,
      url: `${prodUrl}/eve/v1/discord`,
    })
      .then(async () => {
        try {
          await db
            .update(channels)
            .set({
              webhookStatus: "registered",
              webhookTestedAt: new Date(),
              webhookTestError: null,
              updatedAt: new Date(),
            })
            .where(and(eq(channels.id, channelId), eq(channels.userId, userId)))
        } catch (err) {
          console.error(`[promote] discord webhookStatus(registered) write failed: ${err}`)
        }
      })
      .catch(async (err) => {
        // Never log the bot token — only the error string (which the helper
        // guarantees is token-free).
        console.error(`[promote] discord setInteractionsEndpoint for "${slug}" failed: ${err}`)
        try {
          await db
            .update(channels)
            .set({
              webhookStatus: "failed",
              webhookTestError: truncate(String(err)),
              webhookTestedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(and(eq(channels.id, channelId), eq(channels.userId, userId)))
        } catch (err2) {
          console.error(`[promote] discord webhookStatus(failed) write failed: ${err2}`)
        }
      })
  }

  // Kapso inbound registration. Same best-effort shape as telegram/discord: the
  // prod URL only exists now (promote), and Kapso's create-webhook endpoint takes
  // a client-supplied secret_key, so we register the deployed agent's literal
  // /kapso/webhook URL here with the channel's auto-minted secret. Idempotent
  // (registerKapsoWebhook PATCHes an existing endpoint), so re-running every
  // promote never duplicates. A failure degrades only the inbound binding — the
  // deploy is already finalized (deploymentStatus='deployed') and this block can
  // NEVER throw out of promote. The api key + secret are never logged.
  if (
    assignedChannel?.type === "kapso" &&
    assignedChannel.kapsoApiKey &&
    assignedChannel.kapsoPhoneNumberId &&
    assignedChannel.kapsoWebhookSecret
  ) {
    const channelId = assignedChannel.id
    await registerKapsoWebhook({
      apiKey: assignedChannel.kapsoApiKey,
      phoneNumberId: assignedChannel.kapsoPhoneNumberId,
      secret: assignedChannel.kapsoWebhookSecret,
      url: `${prodUrl}/kapso/webhook`,
    })
      .then(async () => {
        try {
          await db
            .update(channels)
            .set({
              webhookStatus: "registered",
              webhookTestedAt: new Date(),
              webhookTestError: null,
              updatedAt: new Date(),
            })
            .where(and(eq(channels.id, channelId), eq(channels.userId, userId)))
        } catch (err) {
          console.error(`[promote] kapso webhookStatus(registered) write failed: ${err}`)
        }
      })
      .catch(async (err) => {
        // Never log the api key or secret — only the error string (which the
        // helper guarantees is credential-free).
        console.error(`[promote] kapso registerWebhook for "${slug}" failed: ${err}`)
        try {
          await db
            .update(channels)
            .set({
              webhookStatus: "failed",
              webhookTestError: truncate(String(err)),
              webhookTestedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(and(eq(channels.id, channelId), eq(channels.userId, userId)))
        } catch (err2) {
          console.error(`[promote] kapso webhookStatus(failed) write failed: ${err2}`)
        }
      })
  }

  return { url: prodUrl }
}
