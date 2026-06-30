import { z } from "zod"
import type { InferSchema, ToolExtraArguments, ToolMetadata } from "xmcp"
import { createAgentForMcp } from "@/lib/fleet-mcp/services"
import { fleetMcpJsonResult, runAuditedFleetTool } from "@/lib/fleet-mcp/tools"

export const schema = {
  name: z.string().optional().describe("Human-readable agent name."),
  description: z.string().optional().describe("Short agent description."),
  model: z.string().optional().describe("AI Gateway model id, e.g. openai/gpt-4o-mini."),
  instructions: z.string().optional().describe("Runtime instructions for the agent."),
  temperature: z.number().int().min(0).max(100).optional(),
}

export const metadata: ToolMetadata = {
  name: "fleet-create-agent",
  description: "Create a new Fleet Manager agent from a minimal configuration.",
  annotations: { destructiveHint: false, idempotentHint: false },
}

export default async function fleetCreateAgent(
  params: InferSchema<typeof schema>,
  extra: ToolExtraArguments,
) {
  return fleetMcpJsonResult(
    await runAuditedFleetTool(
      extra,
      { toolName: metadata.name, requiredScope: "agent:write" },
      () => createAgentForMcp(params),
    ),
  )
}
