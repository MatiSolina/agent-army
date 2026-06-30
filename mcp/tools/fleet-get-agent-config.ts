import { z } from "zod"
import type { InferSchema, ToolExtraArguments, ToolMetadata } from "xmcp"
import { getAgentConfigForMcp } from "@/lib/fleet-mcp/services"
import { fleetMcpJsonResult, runAuditedFleetTool } from "@/lib/fleet-mcp/tools"

export const schema = {
  agentId: z.string().min(1).describe("Agent id to read."),
}

export const metadata: ToolMetadata = {
  name: "fleet-get-agent-config",
  description: "Read one agent's safe configuration snapshot without secrets.",
  annotations: { readOnlyHint: true },
}

export default async function fleetGetAgentConfig(
  params: InferSchema<typeof schema>,
  extra: ToolExtraArguments,
) {
  return fleetMcpJsonResult(
    await runAuditedFleetTool(
      extra,
      {
        toolName: metadata.name,
        requiredScope: "fleet:read",
        agentId: params.agentId,
      },
      () => getAgentConfigForMcp(params.agentId),
    ),
  )
}
