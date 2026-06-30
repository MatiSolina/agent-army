import { type NextRequest } from "next/server"
import { eq } from "drizzle-orm"
import { db } from "@/lib/db"
import { agents } from "@/lib/db/schema"
import { getFreshAccessToken } from "@/lib/mcp/get-fresh-token"
import { verifyAgentToken } from "@/lib/eve/agent-token"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Machine-to-machine OAuth token broker for child agents.
 *
 * GET /api/mcp/token?conn=<connectionId>&agent=<agentId>
 *   Authorization: Bearer <EVE_AGENT_TOKEN>
 *
 * The child agent's generated MCP connection calls this with its PER-AGENT token
 * HMAC(FM_AGENT_KEY, agentId) and its own id. We verify the token authorizes that
 * agent AND that the requested connection belongs to it, so a leaked agent token
 * can only broker tokens for its OWN connections, never the whole fleet's.
 *
 * The OAuth flow itself is self-hosted in the FM (consent once in the UI,
 * refresh server-side via {@link getFreshAccessToken}); this endpoint only
 * returns the currently-valid access token. Tokens NEVER appear in any log.
 */
export async function GET(req: NextRequest) {
  const token = extractBearerToken(req.headers.get("authorization"))
  const sp = new URL(req.url).searchParams
  const conn = sp.get("conn")
  const agentParam = sp.get("agent")
  if (!conn || !agentParam) {
    return new Response(null, { status: 400 })
  }

  // The credential must be agent <agentParam>'s token, and the requested
  // connection must be assigned to that agent.
  if (!verifyAgentToken(agentParam, token, process.env.FM_AGENT_KEY)) {
    return new Response(null, { status: 401 })
  }
  const rows = await db.select().from(agents).where(eq(agents.id, agentParam))
  const agent = rows[0]
  if (!agent) return new Response(null, { status: 401 })
  if (!(agent.connectionIds as string[]).includes(conn)) {
    return new Response(null, { status: 403 })
  }

  try {
    const { token: accessToken, expiresAt } = await getFreshAccessToken(conn)
    return Response.json(
      expiresAt != null ? { token: accessToken, expiresAt } : { token: accessToken },
    )
  } catch (err) {
    // Map "needs reconnect" conditions to 409 so the operator UI can prompt a
    // reconnect; everything else (refresh / network failure) is a 502. Log only
    // the redacted message, never the token or the AS response body.
    const message = err instanceof Error ? err.message : "unknown error"
    if (/needs reconnect|no token|expired/i.test(message)) {
      return new Response(null, { status: 409 })
    }
    console.error(`[mcp-token] broker failed for ${conn}: ${message}`)
    return new Response(null, { status: 502 })
  }
}

/**
 * Extract the value from an "Authorization: Bearer <token>" header. Inlined
 * (rather than imported from eve/channels/auth, which is not installed in the
 * Fleet Manager), the same trivial split the generated eve channel uses.
 */
function extractBearerToken(header: string | null): string | null {
  if (!header) return null
  const prefix = "Bearer "
  if (!header.startsWith(prefix)) return null
  const value = header.slice(prefix.length).trim()
  return value.length > 0 ? value : null
}
