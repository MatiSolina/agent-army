import { z } from "zod"
import type { InferSchema, ToolExtraArguments, ToolMetadata } from "xmcp"
import { deployAgentPreviewForMcp } from "@/lib/fleet-mcp/services"
import { fleetMcpJsonResult, runAuditedFleetTool } from "@/lib/fleet-mcp/tools"

export const schema = {
  agentId: z.string().min(1).describe("Agent id to deploy as a staged production preview."),
}

export const metadata: ToolMetadata = {
  name: "fleet-deploy-agent-preview",
  description: "Build and deploy one agent to a testable preview URL without promoting it.",
  annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
}

export default async function fleetDeployAgentPreview(
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
      () => deployAgentPreviewForMcp(params.agentId),
    ),
  )
}
