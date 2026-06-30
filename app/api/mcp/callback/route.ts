import { auth } from "@ai-sdk/mcp"
import { type NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { connections } from "@/lib/db/schema"
import { and, eq } from "drizzle-orm"
import { DEMO_USER_ID, getSessionUser } from "@/lib/session"
import { DbOAuthStore } from "@/lib/mcp/db-oauth-store"
import { DbOAuthClientProvider } from "@/lib/mcp/oauth-provider"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * OAuth 2.1 redirect callback. This is the single fixed redirect_uri that was
 * registered with the authorization server; the connection id arrives as the
 * `cid` query param.
 *
 * GET /api/mcp/callback?cid=...&code=...&state=...
 *
 * The SDK's `auth()` validates the CSRF `state` against the stored value
 * (`callbackState`), runs PKCE token exchange, and persists tokens via the
 * provider. Tokens never appear in any redirect URL.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const origin = url.origin
  const params = url.searchParams

  const cid = params.get("cid")
  const code = params.get("code")
  const state = params.get("state")
  const oauthError = params.get("error")
  const oauthErrorDescription = params.get("error_description")

  const user = await getSessionUser()
  if (!user) {
    return NextResponse.redirect(new URL("/sign-in", origin))
  }
  const userId = DEMO_USER_ID
  const store = new DbOAuthStore()

  const failTo = (id: string | null) =>
    NextResponse.redirect(
      new URL(
        id ? `/mcp?connected=0&cid=${encodeURIComponent(id)}` : "/mcp?connected=0",
        origin,
      ),
    )

  if (!cid) {
    return failTo(null)
  }

  const rows = await db
    .select()
    .from(connections)
    .where(and(eq(connections.id, cid), eq(connections.userId, userId)))
    .limit(1)
  const row = rows[0]
  if (!row) {
    return failTo(null)
  }

  // CSRF guard for ALL state-mutating paths (success AND error): the incoming
  // `state` must match the stored `oauthState`. OAuth error responses carry the
  // same `state`, so an attacker can't forge `?error=...` to flip an unrelated
  // connection to "failed". A missing/blank stored state means no flow is in
  // progress (replay / forced-null) → reject without mutating.
  if (!row.oauthState || !state || state !== row.oauthState) {
    return failTo(cid)
  }

  // The authorization server reported an error (e.g. the user denied access).
  if (oauthError) {
    await db
      .update(connections)
      .set({
        status: "failed",
        oauthError: oauthErrorDescription ?? oauthError,
        oauthState: null,
        oauthCodeVerifier: null,
        updatedAt: new Date(),
      })
      .where(and(eq(connections.id, cid), eq(connections.userId, userId)))
    return failTo(cid)
  }

  if (!code) {
    return failTo(cid)
  }

  // Rebuild the SAME provider so redirectUrl is byte-identical to the connect
  // leg (exact-match redirect_uri).
  const provider = new DbOAuthClientProvider(
    store,
    cid,
    origin,
    row.oauthScope ?? undefined,
  )

  try {
    await auth(provider, {
      serverUrl: row.url,
      authorizationCode: code,
      // The SDK compares this against storedState() for CSRF protection.
      callbackState: state,
      scope: row.oauthScope ?? undefined,
    })

    // Success: tokens were persisted by saveTokens(). Clear transient state.
    await db
      .update(connections)
      .set({
        status: "connected",
        oauthState: null,
        oauthCodeVerifier: null,
        oauthError: null,
        updatedAt: new Date(),
      })
      .where(and(eq(connections.id, cid), eq(connections.userId, userId)))

    return NextResponse.redirect(
      new URL(`/mcp?connected=1&cid=${encodeURIComponent(cid)}`, origin),
    )
  } catch (err) {
    // Log ONLY the error class, not err.message, which (via @ai-sdk/mcp's
    // parseErrorResponse) can carry the authorization server's response body.
    // Persist a generic message so we never echo an upstream response either.
    const cls = err instanceof Error ? err.name : "Error"
    console.error(`[mcp-callback] token exchange failed for ${cid} (${cls})`)
    await db
      .update(connections)
      .set({
        status: "failed",
        oauthError: "Authorization failed during token exchange.",
        oauthState: null,
        oauthCodeVerifier: null,
        updatedAt: new Date(),
      })
      .where(and(eq(connections.id, cid), eq(connections.userId, userId)))
    return failTo(cid)
  }
}
