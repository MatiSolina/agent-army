import { z } from "zod"
import type { InferSchema, ToolExtraArguments, ToolMetadata } from "xmcp"
import { getAgentSecretStatusForMcp } from "@/lib/fleet-mcp/services"
import { fleetMcpJsonResult, runAuditedFleetTool } from "@/lib/fleet-mcp/tools"

export const schema = {
  agentId: z.string().min(1).describe("Agent id to inspect."),
}

export const metadata: ToolMetadata = {
  name: "fleet-get-agent-secret-status",
  description: "Read which expected secret keys are configured, never secret values.",
  annotations: { readOnlyHint: true },
}

export default async function fleetGetAgentSecretStatus(
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
      () => getAgentSecretStatusForMcp(params.agentId),
    ),
  )
}
