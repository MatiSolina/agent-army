import { z } from "zod"
import type { InferSchema, ToolExtraArguments, ToolMetadata } from "xmcp"
import { listAgentDeploymentsForMcp } from "@/lib/fleet-mcp/services"
import { fleetMcpJsonResult, runAuditedFleetTool } from "@/lib/fleet-mcp/tools"

export const schema = {
  agentId: z.string().min(1).describe("Agent id whose deployments should be listed."),
}

export const metadata: ToolMetadata = {
  name: "fleet-list-agent-deployments",
  description: "List recent Vercel deployments for one agent and mark production.",
  annotations: { readOnlyHint: true },
}

export default async function fleetListAgentDeployments(
  params: InferSchema<typeof schema>,
  extra: ToolExtraArguments,
) {
  return fleetMcpJsonResult(
    await runAuditedFleetTool(
      extra,
      {
        toolName: metadata.name,
        requiredScope: "deploy:read",
        agentId: params.agentId,
      },
      () => listAgentDeploymentsForMcp(params.agentId),
    ),
  )
}
