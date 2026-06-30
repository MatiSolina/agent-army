/**
 * Config-drift detection: is the agent's current dashboard config different from
 * the config the live deployment was built from?
 *
 * A Deploy is a SNAPSHOT for build-shaped config. Runtime prompt text is the
 * exception: generated Eve agents resolve it from the Fleet Manager on every
 * turn via dynamic instructions, so prompt edits do not require a redeploy.
 * `deployAgent` stamps `deployedConfigHash` with the hash of the config it
 * compiled into that build; the dashboard re-hashes the current row and shows a
 * "needs redeploy" badge when build-shaped config differs.
 *
 * Pure: no I/O. The hash is over an explicit ALLOWLIST of build-affecting fields
 * so deploy bookkeeping (status, timestamps, urls, eveVersion) never reads as
 * drift — a naive `updatedAt > lastDeployedAt` check is unreliable because the
 * deploy/promote/failure paths all bump `updatedAt`.
 *
 * note: hashes the agent row only; a *connection's* content changing (not its
 * assignment) is not detected. Upgrade to fold connection hashes in if/when
 * connection edits need to trigger the badge.
 */

import { createHash } from "node:crypto"
import type {
  Agent,
  AgentSkill,
  AgentSubagent,
  AgentSchedule,
  AgentSandbox,
  AgentHarness,
} from "@/lib/db/schema"

// The fields a user edits that change what the deployed agent does. Add new
// build-affecting fields here (the only maintenance cost of the allowlist).
const BUILD_FIELDS = [
  "name",
  "description",
  "model",
  "temperature",
  "maxSteps",
  "skills",
  "toolIds",
  "connectionIds",
  "subagents",
  "schedules",
  "sandbox",
  "harness",
] as const satisfies readonly (keyof Agent)[]

// The build-affecting config, isolated from identity + deploy bookkeeping.
// Defined STANDALONE (not Pick<Agent>) on purpose: the schema's deployedConfig
// jsonb column is typed with this, and a Pick<Agent> would make Agent depend on
// itself through that column and collapse its inferred type to `any`.
export type AgentConfigSnapshot = {
  name: string
  description: string | null
  model: string
  temperature: number
  maxSteps: number
  skills: AgentSkill[]
  toolIds: string[]
  connectionIds: string[]
  subagents: AgentSubagent[]
  schedules: AgentSchedule[]
  sandbox: AgentSandbox
  harness: AgentHarness
}

/** Pluck the build-affecting fields. Stored at deploy time to diff against later. */
export function agentConfigSnapshot(agent: Agent): AgentConfigSnapshot {
  const snap = {} as Record<string, unknown>
  for (const f of BUILD_FIELDS) snap[f] = agent[f]
  return snap as AgentConfigSnapshot
}

export function agentConfigHash(agent: Agent): string {
  const payload = BUILD_FIELDS.map((f) => [f, agent[f]])
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex")
}

/**
 * Rehydrate a version-update build from the frozen build snapshot only. Old DB
 * rows may still have now-runtime fields in deployedConfig (systemPrompt,
 * instructions), so never spread the raw JSON over the live row.
 */
export function agentWithBuildSnapshot(agent: Agent): Agent {
  if (!agent.deployedConfig) return agent

  const next = { ...agent } as Agent
  const target = next as Record<(typeof BUILD_FIELDS)[number], unknown>
  for (const field of BUILD_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(agent.deployedConfig, field)) {
      target[field] = agent.deployedConfig[field]
    }
  }
  return next
}

/** True when the agent has a deployed snapshot AND current config differs from it. */
export function hasConfigDrift(agent: Agent): boolean {
  if (!agent.deployedConfigHash) return false
  return agentConfigHash(agent) !== agent.deployedConfigHash
}

// Friendly names for the diff shown in the deploy confirm dialog.
const FIELD_LABELS: Record<(typeof BUILD_FIELDS)[number], string> = {
  name: "Name",
  description: "Description",
  model: "Model",
  temperature: "Temperature",
  maxSteps: "Max steps",
  skills: "Skills",
  toolIds: "Tools",
  connectionIds: "MCP connections",
  subagents: "Subagents",
  schedules: "Schedules",
  sandbox: "Sandbox",
  harness: "Built-in tools",
}

export type ConfigChange = { field: string; label: string; summary: string }

// Compact, non-noisy summary of a single field change.
function summarizeChange(before: unknown, after: unknown): string {
  if (Array.isArray(before) || Array.isArray(after)) {
    const b = Array.isArray(before) ? before.length : 0
    const a = Array.isArray(after) ? after.length : 0
    return `${b} → ${a}`
  }
  if (typeof before === "number" || typeof after === "number") {
    return `${before} → ${after}`
  }
  if (typeof before === "string" && typeof after === "string") {
    return before.length <= 40 && after.length <= 40
      ? `${before} → ${after}`
      : "edited"
  }
  // Objects (sandbox), or mixed null/undefined.
  return "updated"
}

/**
 * Field-by-field diff of the CURRENT (saved) config against the snapshot the
 * live deployment was built from. Powers the "what will this Deploy change?"
 * confirm dialog. Returns [] when nothing changed or nothing is deployed yet.
 */
export function diffDeployedConfig(
  deployed: AgentConfigSnapshot | null | undefined,
  agent: Agent,
): ConfigChange[] {
  if (!deployed) return []
  const current = agentConfigSnapshot(agent)
  const changes: ConfigChange[] = []
  for (const f of BUILD_FIELDS) {
    if (JSON.stringify(deployed[f]) !== JSON.stringify(current[f])) {
      changes.push({
        field: f,
        label: FIELD_LABELS[f],
        summary: summarizeChange(deployed[f], current[f]),
      })
    }
  }
  return changes
}
