import { randomUUID } from "node:crypto"
import { and, desc, eq, isNull, isNotNull, ne, or } from "drizzle-orm"
import { start } from "workflow/api"
import { db } from "@/lib/db"
import {
  agents,
  channels,
  connections,
  fleetUpdates,
  type Agent,
  type AgentHarness,
  type AgentSandbox,
  type AgentSchedule,
  type AgentSkill,
  type AgentSubagent,
} from "@/lib/db/schema"
import {
  DEFAULT_INSTRUCTIONS,
  DEFAULT_MODEL,
  DEFAULT_SANDBOX_RUNTIME,
  DEFAULT_SANDBOX_TIMEOUT_MS,
  LIMITS,
} from "@/lib/defaults"
import { validateCron } from "@/lib/validation"
import { DEMO_USER_ID } from "@/lib/session"
import { toClientConnection } from "@/lib/mcp/client-connection"
import { projectName } from "@/lib/eve/project"
import { expectedEnvKeys } from "@/lib/eve/env-spec"
import { resolveVercelAuth } from "@/lib/vercel/auth"
import {
  getProductionDeploymentId,
  listDeployments,
  listProjectEnvKeys,
} from "@/lib/vercel/client"
import { resolveLatestEve } from "@/lib/eve/eve-version"
import { hasPassedCanary } from "@/lib/eve/fleet-gate"
import { deployAgentCore, promoteAgentCore } from "@/lib/eve/deploy-core"
import { updateFleet } from "@/lib/eve/fleet-update.workflow"
import { toSafeAgentConfig, toSafeSecretStatus } from "@/lib/fleet-mcp/tools"
import { isFleetMcpE2eMode } from "@/lib/fleet-mcp/e2e"

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

type FleetMcpE2eAgent = Record<string, unknown> & {
  id: string
  name: string
  description: string | null
  model: string
  instructions: string
  systemPrompt: string
  temperature: number
  maxSteps: number
  enabled: boolean
  skills: AgentSkill[]
  toolIds: string[]
  connectionIds: string[]
  subagents: AgentSubagent[]
  schedules: AgentSchedule[]
  sandbox: AgentSandbox
  harness: AgentHarness
  deploymentStatus: string
  deploymentUrl: string | null
  previewUrl: string | null
  previewDeploymentId: string | null
  eveVersion: string | null
  lastDeployedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

function e2eState() {
  const globalState = globalThis as typeof globalThis & {
    __fleetMcpE2eServices?: {
      agents: FleetMcpE2eAgent[]
      rolloutRuns: Array<Record<string, unknown>>
    }
  }
  globalState.__fleetMcpE2eServices ??= {
    agents: [
      {
        id: "agent-e2e",
        userId: DEMO_USER_ID,
        name: "E2E Support Agent",
        description: "Local Fleet MCP E2E fixture",
        model: DEFAULT_MODEL,
        systemPrompt: DEFAULT_INSTRUCTIONS,
        instructions: DEFAULT_INSTRUCTIONS,
        temperature: 70,
        maxSteps: 10,
        enabled: true,
        skills: [],
        toolIds: [],
        connectionIds: ["conn-e2e"],
        subagents: [],
        schedules: [],
        sandbox: { enabled: false },
        harness: {},
        deploymentStatus: "deployed",
        deploymentUrl: "https://agent-e2e.vercel.app",
        previewUrl: null,
        previewDeploymentId: null,
        eveVersion: "0.16.0",
        lastDeployedAt: new Date("2026-06-29T00:00:00.000Z"),
        createdAt: new Date("2026-06-29T00:00:00.000Z"),
        updatedAt: new Date("2026-06-29T00:00:00.000Z"),
      },
    ],
    rolloutRuns: [],
  }
  return globalState.__fleetMcpE2eServices
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function boundedText(value: unknown, limit: number): string {
  return asString(value).trim().slice(0, limit)
}

function boundedBody(value: unknown, limit: number): string {
  return asString(value).slice(0, limit)
}

function boundedInt(value: unknown, min: number, max: number, fallback: number) {
  const n = typeof value === "number" ? value : Number(value)
  const rounded = Number.isFinite(n) ? Math.round(n) : fallback
  return Math.min(max, Math.max(min, rounded))
}

function modelId(value: unknown): string {
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
      if (error) throw new Error(`Schedule "${name}": ${error}`)
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

function normalizeHarness(value: unknown): AgentHarness {
  const v = isRecord(value) ? value : {}
  const harness: AgentHarness = {}
  if (v.bash === false) harness.bash = false
  if (v.files === false) harness.files = false
  if (v.webFetch === false) harness.webFetch = false
  if (v.webSearch === false) harness.webSearch = false
  return harness
}

async function loadAgent(agentId: string): Promise<Agent> {
  if (isFleetMcpE2eMode()) {
    const agent = e2eState().agents.find((row) => row.id === agentId)
    if (!agent) throw new Error("Agent not found")
    return agent as unknown as Agent
  }

  const rows = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.userId, DEMO_USER_ID)))
  const agent = rows[0]
  if (!agent) throw new Error("Agent not found")
  return agent
}

function safeProjectName(agent: Agent) {
  const slug = projectName(agent)
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) {
    throw new Error("Could not derive a safe project name")
  }
  return slug
}

export async function listAgentsForMcp() {
  if (isFleetMcpE2eMode()) {
    return e2eState().agents.map(toSafeAgentConfig)
  }

  const rows = await db
    .select()
    .from(agents)
    .where(eq(agents.userId, DEMO_USER_ID))
    .orderBy(desc(agents.createdAt))
  return rows.map(toSafeAgentConfig)
}

export async function getAgentConfigForMcp(agentId: string) {
  return toSafeAgentConfig(await loadAgent(agentId))
}

export async function createAgentForMcp(input: {
  name?: unknown
  description?: unknown
  model?: unknown
  instructions?: unknown
  temperature?: unknown
}) {
  if (isFleetMcpE2eMode()) {
    const id = `agent-e2e-${e2eState().agents.length + 1}`
    const name = boundedText(input.name, LIMITS.agentName) || "Untitled agent"
    const instructions =
      boundedBody(input.instructions, LIMITS.instructions).trim() ||
      DEFAULT_INSTRUCTIONS
    const now = new Date()
    const agent: FleetMcpE2eAgent = {
      id,
      userId: DEMO_USER_ID,
      name,
      description:
        boundedText(input.description, LIMITS.agentDescription) || null,
      model: modelId(input.model),
      systemPrompt: instructions,
      instructions,
      temperature: boundedInt(input.temperature, 0, 100, 70),
      maxSteps: 10,
      enabled: true,
      skills: [],
      toolIds: [],
      connectionIds: [],
      subagents: [],
      schedules: [],
      sandbox: { enabled: false },
      harness: {},
      deploymentStatus: "none",
      deploymentUrl: null,
      previewUrl: null,
      previewDeploymentId: null,
      eveVersion: null,
      lastDeployedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    e2eState().agents.unshift(agent)
    return toSafeAgentConfig(agent)
  }

  const id = randomUUID()
  const name = boundedText(input.name, LIMITS.agentName) || "Untitled agent"
  const instructions =
    boundedBody(input.instructions, LIMITS.instructions).trim() ||
    DEFAULT_INSTRUCTIONS
  await db.insert(agents).values({
    id,
    userId: DEMO_USER_ID,
    name,
    description: boundedText(input.description, LIMITS.agentDescription) || null,
    model: modelId(input.model),
    systemPrompt: instructions,
    instructions,
    temperature: boundedInt(input.temperature, 0, 100, 70),
  })
  return getAgentConfigForMcp(id)
}

export async function updateAgentConfigForMcp(
  agentId: string,
  patch: Record<string, unknown>,
) {
  const current = await loadAgent(agentId)
  const instructions =
    boundedBody(patch.instructions ?? current.instructions, LIMITS.instructions)
      .trim() || DEFAULT_INSTRUCTIONS

  if (isFleetMcpE2eMode()) {
    const state = e2eState()
    const index = state.agents.findIndex((row) => row.id === agentId)
    if (index === -1) throw new Error("Agent not found")
    state.agents[index] = {
      ...state.agents[index],
      name:
        boundedText(patch.name ?? current.name, LIMITS.agentName) ||
        current.name,
      description:
        boundedText(
          patch.description ?? current.description ?? "",
          LIMITS.agentDescription,
        ) || null,
      enabled:
        typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
      model: modelId(patch.model ?? current.model),
      temperature: boundedInt(
        patch.temperature ?? current.temperature,
        0,
        100,
        current.temperature,
      ),
      maxSteps: boundedInt(
        patch.maxSteps ?? current.maxSteps,
        1,
        MAX_STEPS,
        current.maxSteps,
      ),
      instructions,
      systemPrompt: instructions,
      skills:
        "skills" in patch ? normalizeSkills(patch.skills) : current.skills,
      connectionIds:
        "connectionIds" in patch
          ? normalizeConnectionIds(patch.connectionIds)
          : current.connectionIds,
      subagents:
        "subagents" in patch
          ? normalizeSubagents(patch.subagents)
          : current.subagents,
      schedules:
        "schedules" in patch
          ? normalizeSchedules(patch.schedules)
          : current.schedules,
      sandbox:
        "sandbox" in patch ? normalizeSandbox(patch.sandbox) : current.sandbox,
      harness:
        "harness" in patch ? normalizeHarness(patch.harness) : current.harness,
      updatedAt: new Date(),
    }
    return toSafeAgentConfig(state.agents[index])
  }

  await db
    .update(agents)
    .set({
      name:
        boundedText(patch.name ?? current.name, LIMITS.agentName) ||
        current.name,
      description:
        boundedText(
          patch.description ?? current.description ?? "",
          LIMITS.agentDescription,
        ) || null,
      enabled:
        typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
      model: modelId(patch.model ?? current.model),
      temperature: boundedInt(
        patch.temperature ?? current.temperature,
        0,
        100,
        current.temperature,
      ),
      maxSteps: boundedInt(
        patch.maxSteps ?? current.maxSteps,
        1,
        MAX_STEPS,
        current.maxSteps,
      ),
      instructions,
      systemPrompt: instructions,
      skills:
        "skills" in patch ? normalizeSkills(patch.skills) : current.skills,
      connectionIds:
        "connectionIds" in patch
          ? normalizeConnectionIds(patch.connectionIds)
          : current.connectionIds,
      subagents:
        "subagents" in patch
          ? normalizeSubagents(patch.subagents)
          : current.subagents,
      schedules:
        "schedules" in patch
          ? normalizeSchedules(patch.schedules)
          : current.schedules,
      sandbox:
        "sandbox" in patch ? normalizeSandbox(patch.sandbox) : current.sandbox,
      harness:
        "harness" in patch ? normalizeHarness(patch.harness) : current.harness,
      updatedAt: new Date(),
    })
    .where(and(eq(agents.id, agentId), eq(agents.userId, DEMO_USER_ID)))
  return getAgentConfigForMcp(agentId)
}

export async function listConnectionsForMcp() {
  if (isFleetMcpE2eMode()) {
    return [
      {
        id: "conn-e2e",
        name: "linear",
        transport: "http",
        url: "https://mcp.linear.app/mcp",
        status: "connected",
        oauthError: null,
        oauthScope: "read write",
        hasToken: false,
        createdAt: new Date("2026-06-29T00:00:00.000Z"),
      },
    ]
  }

  const rows = await db
    .select()
    .from(connections)
    .where(eq(connections.userId, DEMO_USER_ID))
    .orderBy(desc(connections.createdAt))
  return rows.map(toClientConnection)
}

export async function getAgentSecretStatusForMcp(agentId: string) {
  if (isFleetMcpE2eMode()) {
    await loadAgent(agentId)
    return toSafeSecretStatus([
      { key: "AI_GATEWAY_API_KEY", configured: true, value: "not-returned" },
      { key: "EVE_API_SECRET", configured: true, value: "not-returned" },
    ])
  }

  const agent = await loadAgent(agentId)
  const [allConnections, assignedChannels] = await Promise.all([
    db.select().from(connections).where(eq(connections.userId, DEMO_USER_ID)),
    db
      .select()
      .from(channels)
      .where(and(eq(channels.agentId, agentId), eq(channels.userId, DEMO_USER_ID))),
  ])
  const expected = expectedEnvKeys({
    agent,
    connections: allConnections,
    channelType: assignedChannels[0]?.type ?? null,
  })
  if (expected.length === 0) return []

  let presentKeys = new Set<string>()
  try {
    const { token, teamId } = await resolveVercelAuth()
    const onProject = await listProjectEnvKeys(
      { token, teamId },
      safeProjectName(agent),
    )
    presentKeys = new Set(onProject.map((env) => env.key))
  } catch {
    presentKeys = new Set()
  }

  return toSafeSecretStatus(
    expected.map((key) => ({ key, configured: presentKeys.has(key) })),
  )
}

export async function listAgentDeploymentsForMcp(agentId: string) {
  if (isFleetMcpE2eMode()) {
    await loadAgent(agentId)
    return [
      {
        id: "dpl_e2e_prod",
        url: "https://agent-e2e.vercel.app",
        state: "READY",
        createdAt: Date.parse("2026-06-29T00:00:00.000Z"),
        target: "production",
        isProduction: true,
      },
    ]
  }

  const agent = await loadAgent(agentId)
  try {
    const { token, teamId } = await resolveVercelAuth()
    const cfg = { token, teamId }
    const slug = safeProjectName(agent)
    const [deployments, productionId] = await Promise.all([
      listDeployments(cfg, slug, 20),
      getProductionDeploymentId(cfg, slug),
    ])
    return deployments.map((deployment) => ({
      ...deployment,
      isProduction: deployment.id === productionId,
    }))
  } catch {
    return []
  }
}

export async function deployAgentPreviewForMcp(agentId: string) {
  if (isFleetMcpE2eMode()) {
    const state = e2eState()
    const agent = state.agents.find((row) => row.id === agentId)
    if (!agent) throw new Error("Agent not found")
    agent.deploymentStatus = "preview_ready"
    agent.previewUrl = `https://${agent.id}-preview.vercel.app`
    agent.previewDeploymentId = `dpl_${agent.id}_preview`
    agent.updatedAt = new Date()
    return {
      previewUrl: agent.previewUrl,
      previewDeploymentId: agent.previewDeploymentId,
    }
  }

  const allConnections = await db
    .select()
    .from(connections)
    .where(eq(connections.userId, DEMO_USER_ID))
  const eve = await resolveLatestEve()
  return deployAgentCore(DEMO_USER_ID, agentId, {
    connections: allConnections,
    eveVersion: eve.target,
    aiVersion: eve.aiPin,
    skipPoll: true,
  })
}

export async function promoteAgentDeploymentForMcp(
  agentId: string,
  deploymentId: string,
) {
  if (isFleetMcpE2eMode()) {
    const agent = e2eState().agents.find((row) => row.id === agentId)
    if (!agent) throw new Error("Agent not found")
    agent.deploymentStatus = "deployed"
    agent.deploymentUrl = `https://${agent.id}.vercel.app`
    agent.previewUrl = null
    agent.previewDeploymentId = null
    agent.updatedAt = new Date()
    return { url: agent.deploymentUrl, deploymentId }
  }

  return promoteAgentCore(DEMO_USER_ID, agentId, deploymentId)
}

async function driftedAgentIds(target: string): Promise<string[]> {
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.userId, DEMO_USER_ID),
        eq(agents.deploymentStatus, "deployed"),
        // Rebuildable-from-snapshot only (deployAgentCore deploys fromSnapshot and
        // locks before checking it, so a snapshotless row would just go 'failed').
        isNotNull(agents.deployedConfig),
        or(isNull(agents.eveVersion), ne(agents.eveVersion, target)),
      ),
    )
  return rows.map((row) => row.id)
}

export async function startCanaryUpdateForMcp(canaryAgentId: string) {
  if (isFleetMcpE2eMode()) {
    await loadAgent(canaryAgentId)
    const run = {
      runRecordId: `fleet-e2e-canary-${e2eState().rolloutRuns.length + 1}`,
      runId: `run-e2e-canary-${e2eState().rolloutRuns.length + 1}`,
    }
    e2eState().rolloutRuns.push(run)
    return run
  }

  const { target, aiPin, gated } = await resolveLatestEve()
  if (gated) {
    throw new Error("Latest eve is a gated bump and needs manual review")
  }
  // Reject arbitrary/ineligible ids before mutating deploy state: deployAgentCore
  // sets deploymentStatus='deploying' before checking the snapshot, so a draft or
  // never-deployed agent would get marked 'failed'. Only drifted+deployed bots
  // (which have a deployedConfig snapshot) are eligible canaries.
  const drifted = await driftedAgentIds(target)
  if (!drifted.includes(canaryAgentId)) {
    throw new Error("Agent is not an eligible canary (must be a deployed bot behind the target version).")
  }
  const id = randomUUID()
  await db
    .insert(fleetUpdates)
    .values({ id, mode: "canary", target, aiPin, canaryAgentId })
  const run = await start(updateFleet, [
    {
      runRecordId: id,
      mode: "canary",
      agentIds: [canaryAgentId],
      target,
      aiPin,
      userId: DEMO_USER_ID,
    },
  ])
  await db
    .update(fleetUpdates)
    .set({ runId: run.runId })
    .where(eq(fleetUpdates.id, id))
  return { runRecordId: id, runId: run.runId }
}

export async function startRolloutUpdateForMcp() {
  if (isFleetMcpE2eMode()) {
    const run = {
      runRecordId: `fleet-e2e-rollout-${e2eState().rolloutRuns.length + 1}`,
      runId: `run-e2e-rollout-${e2eState().rolloutRuns.length + 1}`,
      agentIds: e2eState().agents.map((agent) => agent.id),
    }
    e2eState().rolloutRuns.push(run)
    return run
  }

  const { target, aiPin, gated } = await resolveLatestEve()
  if (gated) {
    throw new Error("Latest eve is a gated bump and needs manual review")
  }
  // Server-side canary gate: never roll the fleet on a target without a passed canary.
  if (!(await hasPassedCanary(target))) {
    throw new Error("Run and verify a canary on this version before rolling out to the fleet.")
  }
  const agentIds = await driftedAgentIds(target)
  const id = randomUUID()
  await db.insert(fleetUpdates).values({ id, mode: "rest", target, aiPin })
  const run = await start(updateFleet, [
    {
      runRecordId: id,
      mode: "rest",
      agentIds,
      target,
      aiPin,
      userId: DEMO_USER_ID,
    },
  ])
  await db
    .update(fleetUpdates)
    .set({ runId: run.runId })
    .where(eq(fleetUpdates.id, id))
  return { runRecordId: id, runId: run.runId, agentIds }
}
