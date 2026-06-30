import { type NextRequest, NextResponse } from "next/server"
import { exchangeCodeForToken, safeCompareState } from "@/lib/vercel/oauth"
import { setStoredVercelOAuth } from "@/lib/vercel/auth"
import { VERCEL_OAUTH_STATE_COOKIE } from "../connect/route"
import { getSessionUser } from "@/lib/session"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Vercel integration OAuth redirect callback.
 *
 * GET /api/vercel/callback?code=...&state=...&teamId=...&configurationId=...
 *
 * The single fixed redirect_uri registered with the Vercel integration. We
 * exchange the single-use `code` for an access token (SERVER-SIDE ONLY, the
 * client_secret never reaches the browser), persist the result in app_settings
 * under key 'vercel_oauth', then redirect back to /mcp with a status flag.
 *
 * SECURITY:
 *  - CSRF: the `state` mirrored back by Vercel must match the httpOnly cookie
 *    set by /api/vercel/connect. A missing/mismatched state is rejected BEFORE
 *    the token exchange, so an attacker cannot pin their own `code` onto this
 *    single-tenant install. The cookie is always cleared on the way out.
 *  - On any failure we console.error a sanitized message (no secret, no raw
 *    response body) and redirect with ?vercel=error. The access token is never
 *    placed in a redirect URL.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const origin = url.origin
  const params = url.searchParams

  const code = params.get("code")
  const state = params.get("state")
  const cookieState = req.cookies.get(VERCEL_OAUTH_STATE_COOKIE)?.value ?? null

  // Always clear the one-shot state cookie, whatever the outcome.
  const fail = () => {
    const res = NextResponse.redirect(new URL("/mcp?vercel=error", origin))
    res.cookies.delete(VERCEL_OAUTH_STATE_COOKIE)
    return res
  }

  const user = await getSessionUser()
  if (!user) {
    const res = NextResponse.redirect(new URL("/sign-in", origin))
    res.cookies.delete(VERCEL_OAUTH_STATE_COOKIE)
    return res
  }

  // CSRF gate: reject before doing anything with the code.
  if (!safeCompareState(state, cookieState)) {
    console.error("[vercel-callback] state mismatch — possible CSRF, rejected")
    return fail()
  }

  if (!code) {
    return fail()
  }

  const clientId = process.env.VERCEL_INTEGRATION_CLIENT_ID
  const clientSecret = process.env.VERCEL_INTEGRATION_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    console.error(
      "[vercel-callback] missing VERCEL_INTEGRATION_CLIENT_ID / VERCEL_INTEGRATION_CLIENT_SECRET",
    )
    return fail()
  }

  // The redirect_uri must byte-match the one used to start the install flow.
  const redirectUri = `${origin}/api/vercel/callback`

  try {
    const result = await exchangeCodeForToken({
      code,
      redirectUri,
      clientId,
      clientSecret,
    })

    await setStoredVercelOAuth({
      accessToken: result.accessToken,
      teamId: result.teamId,
      installationId: result.installationId,
      scope: result.scope,
    })

    const ok = NextResponse.redirect(new URL("/mcp?vercel=connected", origin))
    ok.cookies.delete(VERCEL_OAUTH_STATE_COOKIE)
    return ok
  } catch (err) {
    // Log a sanitized message only. The thrown errors are already fixed
    // strings (no secret / body), but be explicit and never echo `err.message`
    // back into the UI.
    console.error(
      "[vercel-callback] token exchange failed:",
      err instanceof Error ? err.message : "unknown error",
    )
    return fail()
  }
}
