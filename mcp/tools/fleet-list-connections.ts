import type { InferSchema, ToolExtraArguments, ToolMetadata } from "xmcp"
import { listConnectionsForMcp } from "@/lib/fleet-mcp/services"
import { fleetMcpJsonResult, runAuditedFleetTool } from "@/lib/fleet-mcp/tools"

export const schema = {}

export const metadata: ToolMetadata = {
  name: "fleet-list-connections",
  description: "List safe MCP connection summaries without tokens or OAuth artifacts.",
  annotations: { readOnlyHint: true },
}

export default async function fleetListConnections(
  _params: InferSchema<typeof schema>,
  extra: ToolExtraArguments,
) {
  return fleetMcpJsonResult(
    await runAuditedFleetTool(
      extra,
      { toolName: metadata.name, requiredScope: "fleet:read" },
      listConnectionsForMcp,
    ),
  )
}
