import { z } from "zod"
import type { InferSchema, ToolExtraArguments, ToolMetadata } from "xmcp"
import { updateAgentConfigForMcp } from "@/lib/fleet-mcp/services"
import { fleetMcpJsonResult, runAuditedFleetTool } from "@/lib/fleet-mcp/tools"

export const schema = {
  agentId: z.string().min(1).describe("Agent id to update."),
  config: z
    .record(z.string(), z.unknown())
    .describe(
      "Partial agent config patch. Array fields (skills, subagents, schedules) are REPLACED wholesale, not merged — omitting an item deletes it.",
    ),
}

export const metadata: ToolMetadata = {
  name: "fleet-update-agent-config",
  // Array fields are replace-not-merge, so a patch can delete data and repeating
  // it with different surrounding state is not a no-op → destructive + non-idempotent.
  description: "Patch one agent's editable configuration without deploying it.",
  annotations: { destructiveHint: true, idempotentHint: false },
}

export default async function fleetUpdateAgentConfig(
  params: InferSchema<typeof schema>,
  extra: ToolExtraArguments,
) {
  return fleetMcpJsonResult(
    await runAuditedFleetTool(
      extra,
      {
        toolName: metadata.name,
        requiredScope: "agent:write",
        agentId: params.agentId,
      },
      () => updateAgentConfigForMcp(params.agentId, params.config),
    ),
  )
}
