/**
 * Pure input-normalization for agent config: bounds every string, validates the
 * model id + cron, mints stable ids, and clamps numbers. Extracted from
 * `app/actions/agents.ts` so BOTH the editor save path and the deployed-agent
 * IMPORT path (`app/actions/import.ts`) run untrusted input through the exact
 * same validator — no duplication, no drift. No I/O.
 */

import type {
  AgentSkill,
  AgentSubagent,
  AgentSchedule,
  AgentSandbox,
  AgentHarness,
} from "@/lib/db/schema"
import { validateCron } from "@/lib/validation"
import {
  DEFAULT_INSTRUCTIONS,
  DEFAULT_MODEL,
  DEFAULT_SANDBOX_RUNTIME,
  DEFAULT_SANDBOX_TIMEOUT_MS,
  LIMITS,
} from "@/lib/defaults"
import { randomUUID } from "crypto"

// Accept any AI Gateway model id ("provider/model"). We validate the shape
// rather than membership of a fixed list because the full model set is fetched
// live from the gateway; a stale allow-list would silently downgrade valid models.
const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i
const SANDBOX_RUNTIMES = new Set([
  "node24",
  "node22",
  "node20",
  "python3.12",
  "python3.11",
])
const MAX_STEPS = 50
const MAX_COLLECTION_ITEMS = 50
const MIN_SANDBOX_TIMEOUT_MS = 1000
const MAX_SANDBOX_TIMEOUT_MS = 120000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

export function boundedText(value: unknown, limit: number): string {
  return asString(value).trim().slice(0, limit)
}

export function boundedBody(value: unknown, limit: number): string {
  return asString(value).slice(0, limit)
}

export function requiredText(value: unknown, limit: number, field: string): string {
  const text = boundedText(value, limit)
  if (!text) throw new Error(`${field} is required`)
  return text
}

export function boundedInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
) {
  const n = typeof value === "number" ? value : Number(value)
  const rounded = Number.isFinite(n) ? Math.round(n) : fallback
  return Math.min(max, Math.max(min, rounded))
}

export function modelId(value: unknown): string {
  const model = asString(value)
  return MODEL_ID_RE.test(model) && model.length <= 120 ? model : DEFAULT_MODEL
}

function stableId(value: unknown): string {
  return boundedText(value, 128) || randomUUID()
}

function normalizeSkills(value: unknown): AgentSkill[] {
  if (!Array.isArray(value)) return []
  return value
    .slice(0, MAX_COLLECTION_ITEMS)
    .map((item): AgentSkill | null => {
      if (!isRecord(item)) return null
      const name = boundedText(item.name, 80)
      const content = boundedBody(item.content, LIMITS.skillContent)
      if (!name || !content.trim()) return null
      return {
        id: stableId(item.id),
        name,
        description: boundedText(item.description, 240),
        content,
      }
    })
    .filter((item): item is AgentSkill => item !== null)
}

function normalizeConnectionIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value
    .map((id) => boundedText(id, 128))
    .filter((id) => id && !seen.has(id) && seen.add(id))
    .slice(0, MAX_COLLECTION_ITEMS)
}

function normalizeSubagents(value: unknown): AgentSubagent[] {
  if (!Array.isArray(value)) return []
  return value
    .slice(0, MAX_COLLECTION_ITEMS)
    .map((item): AgentSubagent | null => {
      if (!isRecord(item)) return null
      const name = boundedText(item.name, 80)
      const instructions = boundedBody(
        item.instructions,
        LIMITS.subagentInstructions,
      )
      if (!name || !instructions.trim()) return null
      return {
        id: stableId(item.id),
        name,
        model: modelId(item.model),
        instructions,
      }
    })
    .filter((item): item is AgentSubagent => item !== null)
}

function normalizeSchedules(value: unknown): AgentSchedule[] {
  if (!Array.isArray(value)) return []
  return value
    .slice(0, MAX_COLLECTION_ITEMS)
    .map((item): AgentSchedule | null => {
      if (!isRecord(item)) return null
      const name = boundedText(item.name, 80)
      const cron = boundedText(item.cron, 120)
      const prompt = boundedBody(item.prompt, LIMITS.schedulePrompt)
      if (!name || !prompt.trim()) return null
      const error = validateCron(cron)
      if (error) {
        throw new Error(`Schedule "${name}": ${error}`)
      }
      return {
        id: stableId(item.id),
        name,
        cron,
        prompt,
        enabled: item.enabled === true,
      }
    })
    .filter((item): item is AgentSchedule => item !== null)
}

function normalizeSandbox(value: unknown): AgentSandbox {
  if (!isRecord(value) || value.enabled !== true) return { enabled: false }

  const runtime = asString(value.runtime)
  return {
    enabled: true,
    runtime: SANDBOX_RUNTIMES.has(runtime) ? runtime : DEFAULT_SANDBOX_RUNTIME,
    setupCommands: boundedBody(value.setupCommands, LIMITS.sandboxSetup),
    timeoutMs: boundedInt(
      value.timeoutMs,
      MIN_SANDBOX_TIMEOUT_MS,
      MAX_SANDBOX_TIMEOUT_MS,
      DEFAULT_SANDBOX_TIMEOUT_MS,
    ),
  }
}

// Only an explicit `false` disables a built-in tool; anything else (missing,
// true, garbage) leaves it on — the safe default keeps the full harness.
function normalizeHarness(value: unknown): AgentHarness {
  const v = isRecord(value) ? value : {}
  const off = (flag: unknown): boolean | undefined =>
    flag === false ? false : undefined
  const harness: AgentHarness = {}
  if (off(v.bash) === false) harness.bash = false
  if (off(v.files) === false) harness.files = false
  if (off(v.webFetch) === false) harness.webFetch = false
  if (off(v.webSearch) === false) harness.webSearch = false
  return harness
}

export type AgentConfigInput = {
  name: string
  description?: string | null
  enabled: boolean
  model: string
  temperature: number
  maxSteps: number
  instructions: string
  skills: AgentSkill[]
  // MCP connections are global entities; the agent stores their ids. (Custom
  // Tools are MCP-only now: the agents.toolIds column is left untouched in the
  // DB but is no longer written or compiled into the deployed agent.)
  connectionIds: string[]
  subagents: AgentSubagent[]
  schedules: AgentSchedule[]
  sandbox: AgentSandbox
  harness: AgentHarness
}

export function normalizeAgentConfigInput(
  input: AgentConfigInput,
): AgentConfigInput {
  const instructions =
    boundedBody(input.instructions, LIMITS.instructions).trim() ||
    DEFAULT_INSTRUCTIONS
  return {
    name: requiredText(input.name, LIMITS.agentName, "Name"),
    description: boundedText(input.description, LIMITS.agentDescription),
    enabled: input.enabled === true,
    model: modelId(input.model),
    temperature: boundedInt(input.temperature, 0, 100, 70),
    maxSteps: boundedInt(input.maxSteps, 1, MAX_STEPS, 10),
    instructions,
    skills: normalizeSkills(input.skills),
    connectionIds: normalizeConnectionIds(input.connectionIds),
    subagents: normalizeSubagents(input.subagents),
    schedules: normalizeSchedules(input.schedules),
    sandbox: normalizeSandbox(input.sandbox),
    harness: normalizeHarness(input.harness),
  }
}
