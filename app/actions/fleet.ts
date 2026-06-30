"use server"

import { requireUserId } from "@/lib/session"
import { db } from "@/lib/db"
import { agents, fleetUpdates } from "@/lib/db/schema"
import { and, eq, ne, isNull, isNotNull, or } from "drizzle-orm"
import { resolveLatestEve } from "@/lib/eve/eve-version"
import { hasPassedCanary } from "@/lib/eve/fleet-gate"
import { start } from "workflow/api"
import { updateFleet } from "@/lib/eve/fleet-update.workflow"
import { randomUUID } from "node:crypto"
import { revalidatePath } from "next/cache"

/**
 * Drifted bots: deployed + their eve pin is not the target. The canary is
 * already on the target after startFleetCanary, so it falls out of this set
 * automatically for the rest rollout.
 */
async function driftedAgentIds(target: string): Promise<string[]> {
  const userId = await requireUserId()
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.userId, userId),
        eq(agents.deploymentStatus, "deployed"),
        // Must be rebuildable from its snapshot: updateFleet deploys fromSnapshot,
        // and deployAgentCore claims the deploy lock BEFORE checking the snapshot,
        // so a deployed-but-snapshotless row would just get marked 'failed'.
        isNotNull(agents.deployedConfig),
        or(isNull(agents.eveVersion), ne(agents.eveVersion, target)),
      ),
    )
  return rows.map((r) => r.id)
}

/**
 * Update ONE chosen bot first (canary). Operator eyeballs it before the rest.
 * Gated bumps (minor/major) throw; only patch bumps are auto-offered.
 */
export async function startFleetCanary(
  canaryAgentId: string,
): Promise<{ runRecordId: string }> {
  const userId = await requireUserId()
  const { target, aiPin, gated } = await resolveLatestEve()
  if (gated) {
    throw new Error("Latest eve is a gated (minor/major) bump — needs manual review")
  }
  // The canary must be a real drifted+deployed bot. Reject arbitrary ids (stale
  // client state or a direct server-action call) before touching deploy state.
  const drifted = await driftedAgentIds(target)
  if (!drifted.includes(canaryAgentId)) {
    throw new Error("That agent is not an eligible canary (must be deployed and behind the target).")
  }
  const id = randomUUID()
  await db.insert(fleetUpdates).values({ id, mode: "canary", target, aiPin, canaryAgentId })
  const run = await start(updateFleet, [
    { runRecordId: id, mode: "canary", agentIds: [canaryAgentId], target, aiPin, userId },
  ])
  await db
    .update(fleetUpdates)
    .set({ runId: run.runId })
    .where(eq(fleetUpdates.id, id))
  revalidatePath("/agents")
  return { runRecordId: id }
}

/**
 * Continue the rollout over the rest of the drifted bots. Enabled after the
 * canary is live + verified by the operator.
 */
export async function startFleetRollout(): Promise<{ runRecordId: string }> {
  const userId = await requireUserId()
  const { target, aiPin, gated } = await resolveLatestEve()
  if (gated) {
    throw new Error("Latest eve is a gated bump — needs manual review")
  }
  // Enforce the canary gate server-side: never roll the fleet on a target whose
  // canary didn't run and pass. Stops a direct call / stale client from skipping it.
  if (!(await hasPassedCanary(target))) {
    throw new Error("Run and verify a canary on this version before rolling out to the fleet.")
  }
  const all = await driftedAgentIds(target)
  const id = randomUUID()
  await db.insert(fleetUpdates).values({ id, mode: "rest", target, aiPin })
  const run = await start(updateFleet, [
    { runRecordId: id, mode: "rest", agentIds: all, target, aiPin, userId },
  ])
  await db
    .update(fleetUpdates)
    .set({ runId: run.runId })
    .where(eq(fleetUpdates.id, id))
  revalidatePath("/agents")
  return { runRecordId: id }
}

/** Poll a fleet-update run's status (no list-runs API → read our own row). */
export async function getFleetUpdate(id: string) {
  await requireUserId()
  const rows = await db.select().from(fleetUpdates).where(eq(fleetUpdates.id, id))
  return rows[0] ?? null
}
