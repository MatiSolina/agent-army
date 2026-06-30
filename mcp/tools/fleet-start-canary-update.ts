import { z } from "zod"
import type { InferSchema, ToolExtraArguments, ToolMetadata } from "xmcp"
import { startCanaryUpdateForMcp } from "@/lib/fleet-mcp/services"
import { fleetMcpJsonResult, runAuditedFleetTool } from "@/lib/fleet-mcp/tools"

export const schema = {
  agentId: z.string().min(1).describe("Agent id to update first as the canary."),
}

export const metadata: ToolMetadata = {
  name: "fleet-start-canary-update",
  description: "Start a fleet Eve patch update for one canary agent.",
  annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
}

export default async function fleetStartCanaryUpdate(
  params: InferSchema<typeof schema>,
  extra: ToolExtraArguments,
) {
  return fleetMcpJsonResult(
    await runAuditedFleetTool(
      extra,
      {
        toolName: metadata.name,
        requiredScope: "fleet:update",
        agentId: params.agentId,
      },
      () => startCanaryUpdateForMcp(params.agentId),
    ),
  )
}
