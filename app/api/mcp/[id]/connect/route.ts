import { auth } from "@ai-sdk/mcp"
import { type NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { connections } from "@/lib/db/schema"
import { and, eq } from "drizzle-orm"
import { DEMO_USER_ID, getSessionUser } from "@/lib/session"
import { DbOAuthStore } from "@/lib/mcp/db-oauth-store"
import { DbOAuthClientProvider } from "@/lib/mcp/oauth-provider"
import { assertPublicHttpUrl } from "@/lib/mcp/ssrf-guard"
import { MCP_CATALOG } from "@/lib/mcp-catalog"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Start the OAuth 2.1 (authorization-code + PKCE) flow for an MCP connection.
 *
 * GET /api/mcp/[id]/connect
 *
 * Discovery, Dynamic Client Registration, PKCE generation, and CSRF state are
 * all handled by the AI SDK's `auth()` driven through our provider. We either
 * 302 the browser to the authorization server, or — if a refresh token already
 * minted fresh tokens — go straight back to /mcp as connected.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const origin = new URL(req.url).origin
  const user = await getSessionUser()
  if (!user) {
    return NextResponse.redirect(new URL("/sign-in", origin))
  }
  const userId = DEMO_USER_ID

  const rows = await db
    .select()
    .from(connections)
    .where(and(eq(connections.id, id), eq(connections.userId, userId)))
    .limit(1)
  const row = rows[0]

  if (!row) {
    return NextResponse.redirect(new URL("/mcp?error=not_found", origin))
  }

  // OAuth applies only to remote (http/sse) servers.
  if (row.transport === "stdio") {
    return NextResponse.redirect(new URL("/mcp?error=not_oauth", origin))
  }

  // Allowlist: OAuth connect is ONLY for vetted catalog OAuth servers (the only
  // way to create one is createOAuthConnection from MCP_CATALOG). Refusing any
  // other URL removes the arbitrary-URL server-side-request (SSRF) surface — a
  // custom/token connection can never drive auth() discovery to an attacker host.
  const isCatalogOAuth = MCP_CATALOG.some(
    (e) => e.auth === "oauth" && e.url === row.url,
  )
  if (!isCatalogOAuth) {
    return NextResponse.redirect(new URL("/mcp?error=not_oauth", origin))
  }

  // Defense-in-depth: even catalog URLs are re-checked to be public hosts before
  // auth() performs server-side OAuth discovery.
  try {
    await assertPublicHttpUrl(row.url)
  } catch (err) {
    const cls = err instanceof Error ? err.name : "Error"
    console.error(`[mcp-connect] blocked non-public URL for ${id} (${cls})`)
    return NextResponse.redirect(new URL("/mcp?error=invalid_url", origin))
  }

  const store = new DbOAuthStore()

  // Reset transient state before starting a fresh authorization.
  await store.patch(id, {
    oauthState: null,
    oauthCodeVerifier: null,
  })
  await db
    .update(connections)
    .set({ status: "connecting", oauthError: null, updatedAt: new Date() })
    .where(and(eq(connections.id, id), eq(connections.userId, userId)))

  const provider = new DbOAuthClientProvider(
    store,
    id,
    origin,
    row.oauthScope ?? undefined,
  )

  try {
    const result = await auth(provider, {
      serverUrl: row.url,
      scope: row.oauthScope ?? undefined,
    })

    if (result === "AUTHORIZED") {
      // Existing refresh token already produced tokens — no redirect needed.
      await db
        .update(connections)
        .set({ status: "connected", oauthError: null, updatedAt: new Date() })
        .where(and(eq(connections.id, id), eq(connections.userId, userId)))
      return NextResponse.redirect(
        new URL(`/mcp?connected=1&cid=${encodeURIComponent(id)}`, origin),
      )
    }

    // result === "REDIRECT": send the browser to the authorization endpoint.
    const target = provider.pendingAuthorizationUrl
    if (!target) {
      throw new Error("OAuth flow returned REDIRECT but no authorization URL")
    }
    return NextResponse.redirect(target)
  } catch (err) {
    // Log ONLY the error class — not err.message, which can carry an upstream
    // authorization-server response body. Persist a generic message so we never
    // echo an upstream response into the UI either.
    const cls = err instanceof Error ? err.name : "Error"
    console.error(`[mcp-connect] OAuth flow failed for ${id} (${cls})`)
    await db
      .update(connections)
      .set({
        status: "failed",
        oauthError: "Could not start the authorization flow.",
        updatedAt: new Date(),
      })
      .where(and(eq(connections.id, id), eq(connections.userId, userId)))
    return NextResponse.redirect(
      new URL(`/mcp?connected=0&cid=${encodeURIComponent(id)}`, origin),
    )
  }
}
