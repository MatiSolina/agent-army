import { db } from "@/lib/db"
import { fleetUpdates } from "@/lib/db/schema"
import { and, eq } from "drizzle-orm"

/**
 * True iff a canary for `target` ran to completion AND actually updated its
 * agent without rolling back. This is the human-gate proof the rollout step
 * must check: a rollout must never run on a target whose canary was skipped,
 * failed, or never executed. (fleetUpdates has no per-user column — single
 * operator — so this is account-wide.)
 */
export async function hasPassedCanary(target: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(fleetUpdates)
    .where(
      and(
        eq(fleetUpdates.mode, "canary"),
        eq(fleetUpdates.target, target),
        eq(fleetUpdates.status, "done"),
      ),
    )
  return rows.some(
    (r) =>
      !!r.result &&
      !!r.canaryAgentId &&
      r.result.updated.includes(r.canaryAgentId) &&
      !(r.canaryAgentId in r.result.rollbackTargets),
  )
}
