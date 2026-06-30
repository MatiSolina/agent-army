import { xmcpHandler } from "@xmcp/adapter"
import {
  handleFleetMcpGet,
  handleFleetMcpOptions,
  handleFleetMcpPost,
} from "@/lib/fleet-mcp/http"
import { verifyFleetMcpBearerToken } from "@/lib/fleet-mcp/oauth"
import { rateLimitOk, clientIp } from "@/lib/rate-limit"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Control-plane POST (deploy/update tools live behind it) → coarse per-IP
// throttle before dispatch. Token-scoped checks still happen inside the handler.
const MCP_RATE = { limit: 120, windowSeconds: 60 }

export async function POST(req: Request) {
  if (!(await rateLimitOk(`fleet-mcp:${clientIp(req)}`, MCP_RATE.limit, MCP_RATE.windowSeconds))) {
    return new Response("Too many requests", { status: 429 })
  }
  return handleFleetMcpPost(req, {
    xmcpHandler,
    verifyBearerToken: verifyFleetMcpBearerToken,
  })
}

export async function OPTIONS(req: Request) {
  return handleFleetMcpOptions(req)
}

export async function GET() {
  return handleFleetMcpGet()
}
