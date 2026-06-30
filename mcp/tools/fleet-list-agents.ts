import type { InferSchema, ToolExtraArguments, ToolMetadata } from "xmcp"
import { listAgentsForMcp } from "@/lib/fleet-mcp/services"
import { fleetMcpJsonResult, runAuditedFleetTool } from "@/lib/fleet-mcp/tools"

export const schema = {}

export const metadata: ToolMetadata = {
  name: "fleet-list-agents",
  description: "List the Fleet Manager agents with safe deployment summaries.",
  annotations: { readOnlyHint: true },
}

export default async function fleetListAgents(
  _params: InferSchema<typeof schema>,
  extra: ToolExtraArguments,
) {
  return fleetMcpJsonResult(
    await runAuditedFleetTool(
      extra,
      { toolName: metadata.name, requiredScope: "fleet:read" },
      listAgentsForMcp,
    ),
  )
}
