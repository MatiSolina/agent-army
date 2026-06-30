import { z } from "zod"
import type { InferSchema, ToolExtraArguments, ToolMetadata } from "xmcp"
import { promoteAgentDeploymentForMcp } from "@/lib/fleet-mcp/services"
import { fleetMcpJsonResult, runAuditedFleetTool } from "@/lib/fleet-mcp/tools"

export const schema = {
  agentId: z.string().min(1).describe("Agent id to promote."),
  deploymentId: z.string().min(1).describe("Vercel deployment id to promote."),
}

export const metadata: ToolMetadata = {
  name: "fleet-promote-agent-deployment",
  description: "Promote a staged deployment to the agent's production runtime.",
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
}

export default async function fleetPromoteAgentDeployment(
  params: InferSchema<typeof schema>,
  extra: ToolExtraArguments,
) {
  return fleetMcpJsonResult(
    await runAuditedFleetTool(
      extra,
      {
        toolName: metadata.name,
        requiredScope: "deploy:write",
        agentId: params.agentId,
      },
      () => promoteAgentDeploymentForMcp(params.agentId, params.deploymentId),
    ),
  )
}
