/**
 * Fleet auto-update workflow.
 *
 * Per-agent: capture the current production deployment (rollback target) →
 * rebuild from the frozen snapshot with the new eve/ai pin → poll READY via
 * durable `sleep` + single-shot `getReadyState` (no step blocks for minutes) →
 * promote on READY, skip on ERROR (prod untouched).
 *
 * The workflow body is a sandboxed deterministic VM: it ONLY orchestrates +
 * sleeps. Every db/network call lives in a `'use step'` function. The per-agent
 * logic is extracted into {@link updateOneAgent} so it is unit-testable without
 * the durable runtime.
 *
 * Canary-then-rest is two separate manual triggers (startFleetCanary /
 * startFleetRollout) — no pause/resume primitive needed; the human gate is just
 * two button clicks.
 */

import { sleep } from "workflow"
import { deployAgentCore, promoteAgentCore } from "./deploy-core"
import { getProductionDeploymentId, getReadyState } from "@/lib/vercel/client"
import { resolveVercelAuth } from "@/lib/vercel/auth"
import { db } from "@/lib/db"
import { agents, fleetUpdates } from "@/lib/db/schema"
import { projectName } from "./project"
import { eq } from "drizzle-orm"

export type AgentOutcome = {
  agentId: string
  outcome: "updated" | "skipped"
  rollbackTarget: string | null
}

export type FleetResult = {
  updated: string[]
  skipped: string[]
  rollbackTargets: Record<string, string>
}

// ---------------------------------------------------------------------------
// Steps — full Node.js access (db, vercel client, deploy-core). The workflow
// sandbox cannot import these, so every Node-touching operation is its own
// `'use step'`. The workflow function below only orchestrates (sleep + steps).
// ---------------------------------------------------------------------------

/** Capture the current production deployment id (rollback target) before touching it. */
async function captureRollbackStep(agentId: string): Promise<string | null> {
  "use step"
  const rows = await db.select().from(agents).where(eq(agents.id, agentId))
  const agent = rows[0]
  if (!agent) return null
  const { token, teamId } = await resolveVercelAuth()
  return getProductionDeploymentId({ token, teamId }, projectName(agent)).catch(
    () => null,
  )
}

/** Version-only deploy from the frozen snapshot. Returns the new preview deployment id. */
async function deployStep(
  userId: string,
  agentId: string,
  target: string,
  aiPin: string,
): Promise<string> {
  "use step"
  const { previewDeploymentId } = await deployAgentCore(userId, agentId, {
    eveVersion: target,
    aiVersion: aiPin,
    fromSnapshot: true,
    skipPoll: true,
  })
  return previewDeploymentId
}

/** Single-shot READY poll for a deployment. */
async function readyStateStep(
  previewDeploymentId: string,
): Promise<"READY" | "ERROR" | "BUILDING"> {
  "use step"
  const { token, teamId } = await resolveVercelAuth()
  return getReadyState({ token, teamId }, previewDeploymentId)
}

/** Promote a ready preview to production. */
async function promoteStep(
  userId: string,
  agentId: string,
  previewDeploymentId: string,
): Promise<void> {
  "use step"
  await promoteAgentCore(userId, agentId, previewDeploymentId)
}

async function persistResultStep(
  runRecordId: string,
  result: FleetResult,
): Promise<void> {
  "use step"
  await db
    .update(fleetUpdates)
    .set({ status: "done", result })
    .where(eq(fleetUpdates.id, runRecordId))
}

/**
 * Per-agent orchestration: capture rollback → deploy from snapshot → durable
 * READY poll → promote. Plain (workflow-level) so it stays unit-testable; its
 * body uses ONLY `sleep` + the steps above — never a Node module directly —
 * so it bundles cleanly into the workflow sandbox.
 *
 * Idempotent: deployAgentCore's CAS lock guards double-deploy; promote is a
 * no-op if already live.
 */
export async function updateOneAgent(
  userId: string,
  agentId: string,
  target: string,
  aiPin: string,
): Promise<AgentOutcome> {
  // Capture the current production deployment for rollback BEFORE touching it.
  const rollbackTarget = await captureRollbackStep(agentId)

  // Deploy from the frozen snapshot, version-only. skipPoll: we poll below.
  const previewDeploymentId = await deployStep(userId, agentId, target, aiPin)

  // Durable poll: short single-shot steps + free sleep. Cap at ~10 min.
  const DEADLINE = 10 * 60
  const TICK = 5
  let elapsed = 0
  let state: "READY" | "ERROR" | "BUILDING" = "BUILDING"
  while (elapsed < DEADLINE) {
    state = await readyStateStep(previewDeploymentId)
    if (state === "READY" || state === "ERROR") break
    await sleep(`${TICK}s`)
    elapsed += TICK
  }

  if (state !== "READY") {
    // Build errored or timed out — prod untouched, skip + record.
    return { agentId, outcome: "skipped", rollbackTarget }
  }

  await promoteStep(userId, agentId, previewDeploymentId)
  return { agentId, outcome: "updated", rollbackTarget }
}

/**
 * The durable fleet-update workflow. Orchestrates only: one per-agent update +
 * small spacing sleep, then persist the result. mode ∈ {"canary","rest"};
 * canary is one chosen bot, rest is the others. `userId` is passed in (not
 * imported) so the workflow sandbox never pulls in the session/db modules.
 */
export async function updateFleet(input: {
  runRecordId: string
  mode: "canary" | "rest"
  agentIds: string[]
  target: string
  aiPin: string
  userId: string
}): Promise<FleetResult> {
  "use workflow"
  const result: FleetResult = {
    updated: [],
    skipped: [],
    rollbackTargets: {},
  }

  for (const agentId of input.agentIds) {
    try {
      const r = await updateOneAgent(
        input.userId,
        agentId,
        input.target,
        input.aiPin,
      )
      if (r.outcome === "updated") result.updated.push(agentId)
      else result.skipped.push(agentId)
      if (r.rollbackTarget) result.rollbackTargets[agentId] = r.rollbackTarget
    } catch {
      result.skipped.push(agentId)
    }
    // Small spacing between bots; durable sleep, no compute cost.
    await sleep("3s")
  }

  await persistResultStep(input.runRecordId, result)
  return result
}
