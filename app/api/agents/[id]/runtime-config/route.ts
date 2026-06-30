import { eq } from "drizzle-orm"
import { type NextRequest } from "next/server"

import { db } from "@/lib/db"
import { agents } from "@/lib/db/schema"
import { verifyAgentToken } from "@/lib/eve/agent-token"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Machine-to-machine runtime config endpoint for deployed Eve agents.
 *
 * GET /api/agents/<id>/runtime-config
 *   Authorization: Bearer <EVE_AGENT_TOKEN>
 *
 * There is no operator session here: generated Eve runtimes call this from
 * dynamic instructions to refresh prompt text without rebuilding the Vercel
 * deployment. Auth is the PER-AGENT token HMAC(FM_AGENT_KEY, <route id>), so a
 * token only authorizes its own agent — a token for A cannot read agent B.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const token = extractBearerToken(req.headers.get("authorization"))
  const { id } = await params

  // Per-agent credential bound to THIS route id — the ONLY accepted credential.
  if (!verifyAgentToken(id, token, process.env.FM_AGENT_KEY)) {
    return new Response(null, { status: 401 })
  }

  const rows = await db.select().from(agents).where(eq(agents.id, id))
  const agent = rows[0]
  if (!agent) {
    return new Response(null, { status: 404 })
  }

  return Response.json({
    systemPrompt: agent.systemPrompt,
    revision: agent.updatedAt?.toISOString() ?? null,
  })
}

function extractBearerToken(header: string | null): string | null {
  if (!header) return null
  const prefix = "Bearer "
  if (!header.startsWith(prefix)) return null
  const value = header.slice(prefix.length).trim()
  return value.length > 0 ? value : null
}
