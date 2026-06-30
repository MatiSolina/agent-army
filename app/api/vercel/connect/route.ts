import { type NextRequest, NextResponse } from "next/server"
import { generateOAuthState } from "@/lib/vercel/oauth"
import { getSessionUser } from "@/lib/session"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Cookie holding the anti-CSRF state for the in-flight Vercel install flow. */
export const VERCEL_OAUTH_STATE_COOKIE = "vercel_oauth_state"

/**
 * Start the Vercel integration install (OAuth) flow.
 *
 * GET /api/vercel/connect
 *
 * Generates a CSPRNG `state`, stores it in an httpOnly cookie, and redirects to
 * the external install URL (https://vercel.com/integrations/<slug>/new?state=…).
 * Vercel mirrors `state` back to /api/vercel/callback, where we verify it
 * against the cookie to defeat login-CSRF (an attacker pinning their own code).
 *
 * Without VERCEL_INTEGRATION_SLUG we cannot build the install URL → bounce back
 * to /mcp with an error flag.
 */
export async function GET(req: NextRequest) {
  const origin = new URL(req.url).origin
  const user = await getSessionUser()
  if (!user) {
    return NextResponse.redirect(new URL("/sign-in", origin))
  }

  const slug = process.env.VERCEL_INTEGRATION_SLUG

  if (!slug) {
    console.error("[vercel-connect] missing VERCEL_INTEGRATION_SLUG")
    return NextResponse.redirect(new URL("/mcp?vercel=error", origin))
  }

  const state = generateOAuthState()
  const installUrl = new URL(`https://vercel.com/integrations/${slug}/new`)
  installUrl.searchParams.set("state", state)

  const res = NextResponse.redirect(installUrl)
  res.cookies.set(VERCEL_OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 30, // matches Vercel's 30-min code validity window
  })
  return res
}
