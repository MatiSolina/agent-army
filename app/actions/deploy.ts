"use server"

import { db } from "@/lib/db"
import { agents } from "@/lib/db/schema"
import { requireUserId } from "@/lib/session"
import { getConnections } from "@/lib/mcp/get-connections"
import { projectName } from "@/lib/eve/project"
import { resolveLatestEve, type EveTarget } from "@/lib/eve/eve-version"
import { deployAgentCore, promoteAgentCore } from "@/lib/eve/deploy-core"
import {
  listDeployments,
  getProductionDeploymentId,
  deleteDeployment,
} from "@/lib/vercel/client"
import { sendToDeployedAgent } from "@/lib/eve/session-client"
import { truncate } from "@/lib/eve/deploy-helpers"
import { resolveVercelAuth } from "@/lib/vercel/auth"
import { and, eq } from "drizzle-orm"
import { revalidatePath } from "next/cache"

/**
 * Pick the eve pin (+ ai peer) a (re)deploy of this agent should ship. Default
 * is the fleet auto-update target (`eve.target` — pinned back for a gated bump).
 * EXCEPTION: if this agent has VERIFIED the gated candidate in a preview-test
 * (`eveVerifiedVersion === eve.latest`), ship the candidate + its own ai peer
 * (`eve.latestAiPin`). Mirrors `eveUpdateOffer`'s per-agent gate override so the
 * verified "Update to <candidate>" button actually deploys the candidate.
 */
async function resolveAgentEvePin(
  userId: string,
  agentId: string,
  eve: EveTarget,
): Promise<{ eveVersion: string; aiVersion: string }> {
  if (eve.gated) {
    const rows = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
    if (rows[0]?.eveVerifiedVersion === eve.latest) {
      return { eveVersion: eve.latest, aiVersion: eve.latestAiPin }
    }
  }
  return { eveVersion: eve.target, aiVersion: eve.aiPin }
}

/**
 * Turn a stored agent into its OWN deployed Eve Vercel project (its own
 * runtime). Thin `'use server'` wrapper over {@link deployAgentCore}: enforces
 * the auth gate (requireUserId), supplies the request-scoped connections, and
 * revalidates the path + sanitizes the error for the client. All real work
 * (build, Vercel REST, status persistence) lives in the session-free core so
 * the workflow can call it without a request.
 */
export async function deployAgent(
  agentId: string,
): Promise<{ previewUrl: string }> {
  const userId = await requireUserId()
  const connections = await getConnections()
  // Always deploy on the latest patch-compatible eve version (gated bumps keep
  // the pin); otherwise a fresh deploy would ship the stale hardcoded pin.
  const eve = await resolveLatestEve()
  // A gated bump this agent has VERIFIED in a preview-test is un-gated FOR THIS
  // AGENT: the "Update to <candidate>" button must ship the candidate (+ its ai
  // peer), not the pinned-back auto-update target. Mirrors eveUpdateOffer's
  // per-agent override. Read the row's verdict to decide.
  const evePin = await resolveAgentEvePin(userId, agentId, eve)
  try {
    const { previewUrl } = await deployAgentCore(userId, agentId, {
      connections,
      eveVersion: evePin.eveVersion,
      aiVersion: evePin.aiVersion,
    })
    revalidatePath(`/agents/${agentId}`)
    return { previewUrl }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[deployAgent] deploy failed for ${agentId}:`, message)
    revalidatePath(`/agents/${agentId}`)
    throw new Error("Deployment failed")
  }
}

/**
 * Build a fresh preview AND promote it straight to production, in one shot.
 * Used by the channel auto-redeploy: a channel change on a live agent must land
 * on production (not sit at preview_ready), otherwise the bot keeps running the
 * old build and the channel never actually activates. Promotes the build it
 * just created — never a stale one.
 */
export async function deployAndPromoteAgent(
  agentId: string,
): Promise<{ url: string }> {
  const userId = await requireUserId()
  const connections = await getConnections()
  const eve = await resolveLatestEve()
  const { previewDeploymentId } = await deployAgentCore(userId, agentId, {
    connections,
    eveVersion: eve.target,
    aiVersion: eve.aiPin,
  })
  const out = await promoteAgentCore(userId, agentId, previewDeploymentId)
  revalidatePath(`/agents/${agentId}`)
  return out
}

/**
 * Promote an already-built deployment to the agent's production runtime
 * (rollback == promote an older one). Thin wrapper over
 * {@link promoteAgentCore}; same auth/revalidate/sanitize pattern.
 */
export async function promoteAgentDeployment(
  agentId: string,
  deploymentId: string,
): Promise<{ url: string }> {
  const userId = await requireUserId()
  try {
    const out = await promoteAgentCore(userId, agentId, deploymentId)
    revalidatePath(`/agents/${agentId}`)
    return out
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[promoteAgentDeployment] promote failed for ${agentId}:`, message)
    throw new Error("Promotion failed")
  }
}

/**
 * Preview-test a GATED eve bump for one agent: deploy a preview pinned to the
 * candidate version, ping it once, and gate the per-agent Update on the result.
 *
 * The test artifact IS the deploy — same Node 24 remote build + runtime as prod
 * (maximum fidelity). The pass criterion is purely operational: the preview
 * builds + deploys + answers ONE ping with HTTP 200 and a non-empty body (no
 * response-quality judgement — that belongs to eve evals).
 *
 *   - success → set `agents.eveVerifiedVersion = candidateVersion`, clear
 *     `eveVerifyError`. The preview is LEFT staged (not promoted) so the user can
 *     promote it via the existing "Update to <v>" button (which the verdict now
 *     un-gates). `eveUpdateOffer` treats verified === latest as a gate override.
 *   - failure (build / deploy / ping / empty body) → persist a SANITIZED error in
 *     `eveVerifyError`, clear `eveVerifiedVersion`, and DELETE the pinned preview
 *     (never promoted → must not linger and consume quota).
 *
 * Returns the preview URL on success (`verdictUrl`) or `{verdictUrl:null, error}`
 * on failure (the error feeds the copy-paste handoff prompt, built client-side).
 * The prompt text itself is never stored.
 *
 * SECURITY: the persisted error is truncated; ping/deploy errors are already
 * credential-free (session-client throws status-only strings; the Vercel client
 * never leaks the token). The auth gate (requireUserId) + the safe slug inside
 * deployAgentCore are unchanged.
 */
export async function testEvePreview(
  agentId: string,
  candidateVersion: string,
): Promise<{ verdictUrl: string | null; error?: string }> {
  const userId = await requireUserId()
  const connections = await getConnections()
  // The CANDIDATE's `ai` peer pin. For a gated bump `eve.target` is pinned back
  // to the current version, so its `aiPin` is the OLD ai peer — we must use
  // `latestAiPin` (resolved against `eve.latest`, the candidate we pin here).
  const eve = await resolveLatestEve()

  let previewUrl: string | null = null
  let previewDeploymentId: string | null = null
  try {
    // previewTest mode: build a THROWAWAY preview pinned to the candidate without
    // touching the live (still-deployed) row. The verdict columns below are this
    // action's responsibility; the prod runtime is unaffected on either path.
    const preview = await deployAgentCore(userId, agentId, {
      connections,
      eveVersion: candidateVersion,
      aiVersion: eve.latestAiPin,
      previewTest: true,
    })
    previewUrl = preview.previewUrl
    previewDeploymentId = preview.previewDeploymentId

    // One ping: HTTP 200 + non-empty body proves the pinned build runs.
    const reply = await sendToDeployedAgent({ baseUrl: previewUrl, message: "ping" })
    if (!reply.text || reply.text.trim().length === 0) {
      throw new Error("Preview deployed but returned an empty response to the test ping")
    }

    // Verdict: green. Set the per-agent override + clear any stale error. Leave
    // the preview staged for the user to promote via the (now un-gated) button.
    await db
      .update(agents)
      .set({
        eveVerifiedVersion: candidateVersion,
        eveVerifyError: null,
        updatedAt: new Date(),
      })
      .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))

    revalidatePath(`/agents/${agentId}`)
    return { verdictUrl: previewUrl }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[testEvePreview] failed for ${agentId} @ ${candidateVersion}:`, message)
    const sanitized = truncate(message)

    // Verdict: red. Persist the error + clear any prior verified version.
    await db
      .update(agents)
      .set({
        eveVerifyError: sanitized,
        eveVerifiedVersion: null,
        updatedAt: new Date(),
      })
      .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))

    // Housekeeping: drop the pinned preview (it is never promoted). Best-effort —
    // a delete failure must not mask the real verdict error. Deletes ONLY this
    // deployment, never the project (which still serves prod).
    if (previewDeploymentId) {
      try {
        const { token, teamId } = await resolveVercelAuth()
        await deleteDeployment({ token, teamId }, previewDeploymentId)
      } catch (delErr) {
        console.error(
          `[testEvePreview] preview cleanup failed for ${agentId}:`,
          delErr instanceof Error ? delErr.message : String(delErr),
        )
      }
    }

    revalidatePath(`/agents/${agentId}`)
    return { verdictUrl: null, error: sanitized }
  }
}

/**
 * List the agent's recent Vercel deployments for the Deployments tab, flagging
 * which one is currently live on production. The UI lets the user promote/roll
 * back to any of these (rollback == promote an older one). Returns newest-first
 * (Vercel's default order). On any error we log server-side and return [] so the
 * UI degrades to an empty state rather than throwing.
 *
 * SECURITY: tokens never reach the client; the target slug is the injection-safe
 * projectName() value (re-asserted), never a client-supplied string.
 */
export async function getAgentDeployments(agentId: string): Promise<
  {
    id: string
    url: string
    state: string
    createdAt: number
    target: string | null
    isProduction: boolean
  }[]
> {
  const userId = await requireUserId()

  const rows = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
  const agent = rows[0]
  if (!agent) throw new Error("Agent not found")

  try {
    const { token, teamId } = await resolveVercelAuth()
    const cfg = { token, teamId }

    const slug = projectName(agent)
    if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) {
      throw new Error("Could not derive a safe project name")
    }

    const [list, productionId] = await Promise.all([
      listDeployments(cfg, slug, 20),
      getProductionDeploymentId(cfg, slug),
    ])

    return list.map((d) => ({
      ...d,
      isProduction: d.id === productionId,
    }))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[getAgentDeployments] list failed for ${agentId}:`, message)
    return []
  }
}
