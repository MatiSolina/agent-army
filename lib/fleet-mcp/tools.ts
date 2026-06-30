import { randomUUID } from "node:crypto"
import { db } from "@/lib/db"
import { fleetMcpAuditLogs } from "@/lib/db/schema"
import { DEMO_USER_ID } from "@/lib/session"
import type { FLEET_MCP_SCOPES } from "@/lib/fleet-mcp/oauth"
import { isFleetMcpE2eMode } from "@/lib/fleet-mcp/e2e"

export type FleetMcpScope = (typeof FLEET_MCP_SCOPES)[number]

export type FleetMcpToolExtra = {
  authInfo?: {
    clientId: string
    scopes: string[]
    extra?: Record<string, unknown>
  }
}

export type FleetMcpAuditInput = {
  userId?: string
  clientId?: string
  toolName: string
  scope: string
  agentId?: string | null
  status: "ok" | "error"
  errorCode?: string | null
  durationMs?: number
}

export function requireFleetMcpScope(
  extra: FleetMcpToolExtra,
  scope: FleetMcpScope,
) {
  if (!extra.authInfo?.scopes.includes(scope)) {
    throw new Error(`Missing required Fleet MCP scope: ${scope}`)
  }
}

export function toSafeAgentConfig(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    model: row.model,
    instructions: row.instructions,
    systemPrompt: row.systemPrompt,
    temperature: row.temperature,
    maxSteps: row.maxSteps,
    enabled: row.enabled,
    skills: row.skills,
    toolIds: row.toolIds,
    connectionIds: row.connectionIds,
    subagents: row.subagents,
    schedules: row.schedules,
    sandbox: row.sandbox,
    harness: row.harness,
    deploymentStatus: row.deploymentStatus,
    deploymentUrl: row.deploymentUrl,
    previewUrl: row.previewUrl,
    previewDeploymentId: row.previewDeploymentId,
    eveVersion: row.eveVersion,
    lastDeployedAt: row.lastDeployedAt,
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
  }
}

export function toSafeSecretStatus(
  rows: Array<{
    key: string
    present?: boolean
    configured?: boolean
    [key: string]: unknown
  }>,
) {
  return rows.map((row) => ({
    key: row.key,
    present: row.present ?? Boolean(row.configured),
  }))
}

export function fleetMcpJsonResult(result: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: { result },
  }
}

export async function writeFleetMcpAuditLog(input: FleetMcpAuditInput) {
  if (isFleetMcpE2eMode()) {
    const globalAudit = globalThis as typeof globalThis & {
      __fleetMcpE2eAuditLog?: FleetMcpAuditInput[]
    }
    globalAudit.__fleetMcpE2eAuditLog ??= []
    globalAudit.__fleetMcpE2eAuditLog.push(input)
    return
  }

  await db.insert(fleetMcpAuditLogs).values({
    id: randomUUID(),
    userId: input.userId ?? DEMO_USER_ID,
    clientId: input.clientId ?? "unknown",
    toolName: input.toolName,
    scope: input.scope,
    agentId: input.agentId ?? null,
    status: input.status,
    errorCode: input.errorCode ?? null,
    durationMs: input.durationMs ?? 0,
  })
}

export async function runAuditedFleetTool<T>(
  extra: FleetMcpToolExtra,
  options: {
    toolName: string
    requiredScope: FleetMcpScope
    agentId?: string | null
    writeAuditLog?: (input: FleetMcpAuditInput) => Promise<void>
  },
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now()
  const writeAuditLog = options.writeAuditLog ?? writeFleetMcpAuditLog
  const baseAudit = {
    userId:
      typeof extra.authInfo?.extra?.userId === "string"
        ? extra.authInfo.extra.userId
        : DEMO_USER_ID,
    clientId: extra.authInfo?.clientId ?? "unknown",
    toolName: options.toolName,
    scope: options.requiredScope,
    agentId: options.agentId ?? null,
  }

  let result: T
  try {
    requireFleetMcpScope(extra, options.requiredScope)
    result = await fn()
  } catch (error) {
    // Audit is best-effort: never let a logging failure mask the original error.
    await writeAuditLog({
      ...baseAudit,
      status: "error",
      errorCode: error instanceof Error ? error.message.slice(0, 120) : "error",
      durationMs: Date.now() - started,
    }).catch(() => {})
    throw error
  }
  // Primary op already succeeded — a failed audit write must NOT turn a completed
  // action into a thrown error, so swallow audit errors here.
  await writeAuditLog({
    ...baseAudit,
    status: "ok",
    durationMs: Date.now() - started,
  }).catch(() => {})
  return result
}
