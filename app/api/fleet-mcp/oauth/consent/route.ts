import { NextResponse } from "next/server"
import { createFleetMcpOAuthService } from "@/lib/fleet-mcp/oauth"
import { requireSessionUser } from "@/lib/session"
import { fleetMcpE2eUser } from "@/lib/fleet-mcp/e2e"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(req: Request) {
  const user = fleetMcpE2eUser() ?? (await requireSessionUser())
  const form = await req.formData()
  const requestId = String(form.get("request") ?? "")
  const decision = String(form.get("decision") ?? "")
  const service = createFleetMcpOAuthService(req)

  if (decision === "deny") {
    const location = await service.denyAuthorizationRequest(requestId)
    return NextResponse.redirect(location)
  }

  const approved = await service.approveAuthorizationRequest(requestId, {
    userId: user.id,
  })
  return NextResponse.redirect(approved.location)
}
