import type { SessionUser } from "@/lib/session"

export function isFleetMcpE2eMode() {
  return process.env.FLEET_MCP_E2E === "1" && process.env.NODE_ENV !== "production"
}

export function fleetMcpE2eUser(): SessionUser | null {
  if (!isFleetMcpE2eMode()) return null
  return {
    id: "fleet-mcp-e2e-operator",
    email: "fleet-mcp-e2e@example.com",
    name: "Fleet MCP E2E Operator",
  }
}
