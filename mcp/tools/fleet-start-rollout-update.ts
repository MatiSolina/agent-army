import type { InferSchema, ToolExtraArguments, ToolMetadata } from "xmcp"
import { startRolloutUpdateForMcp } from "@/lib/fleet-mcp/services"
import { fleetMcpJsonResult, runAuditedFleetTool } from "@/lib/fleet-mcp/tools"

export const schema = {}

export const metadata: ToolMetadata = {
  name: "fleet-start-rollout-update",
  description: "Start the rollout update over the remaining deployed drifted agents.",
  annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
}

export default async function fleetStartRolloutUpdate(
  _params: InferSchema<typeof schema>,
  extra: ToolExtraArguments,
) {
  return fleetMcpJsonResult(
    await runAuditedFleetTool(
      extra,
      { toolName: metadata.name, requiredScope: "fleet:update" },
      startRolloutUpdateForMcp,
    ),
  )
}
