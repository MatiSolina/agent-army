import { createFleetMcpOAuthService } from "@/lib/fleet-mcp/oauth"
import { rateLimitOk, clientIp } from "@/lib/rate-limit"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// This endpoint is PUBLIC (dynamic client registration). Cap the body so a
// single request can't persist unbounded metadata, and throttle per IP so it
// can't be used to flood the clients table.
const MAX_BODY_BYTES = 16 * 1024
const REGISTER_RATE = { limit: 10, windowSeconds: 60 }

export async function POST(req: Request) {
  if (!(await rateLimitOk(`oauth-register:${clientIp(req)}`, REGISTER_RATE.limit, REGISTER_RATE.windowSeconds))) {
    return Response.json({ error: "invalid_request" }, { status: 429 })
  }
  const raw = await req.text()
  if (raw.length > MAX_BODY_BYTES) {
    return Response.json({ error: "invalid_request" }, { status: 413 })
  }
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 })
  }

  try {
    const service = createFleetMcpOAuthService(req)
    const client = await service.registerClient(
      typeof body === "object" && body !== null ? body : {},
    )
    return Response.json(client, { status: 201 })
  } catch (error) {
    return Response.json(
      {
        error: "invalid_client_metadata",
        error_description:
          error instanceof Error ? error.message : "Invalid client metadata",
      },
      { status: 400 },
    )
  }
}
