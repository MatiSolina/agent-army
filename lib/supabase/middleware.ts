import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"

// Public paths that must work without an operator session.
const PUBLIC_PREFIXES = [
  "/sign-in",
  "/api/vercel/callback",
  "/api/mcp/callback",
  // M2M token broker: DEPLOYED eve agents call this with their per-agent
  // EVE_AGENT_TOKEN; the route does its own bearer auth. It must NOT be
  // redirected to /sign-in, or every OAuth MCP tool fails at runtime with the
  // login page instead of a token.
  "/api/mcp/token",
  // Vercel Trace Drain ingest: Vercel POSTs OTel spans here authed by the drain
  // HMAC signature, not an operator session. Must not redirect to /sign-in.
  "/api/drains",
  // Fleet MCP remote control-plane: OAuth/DCR/metadata carry their own
  // route-level auth and the MCP endpoint is protected by bearer tokens.
  "/api/fleet-mcp",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-authorization-server",
]

const PUBLIC_PATTERNS = [
  // Runtime prompt config: deployed Eve agents call this with their per-agent
  // EVE_AGENT_TOKEN. Keep it narrow so other /api/agents routes still require an
  // operator session.
  /^\/api\/agents\/[^/]+\/runtime-config$/,
]

export function isPublic(pathname: string) {
  return (
    PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/")) ||
    PUBLIC_PATTERNS.some((p) => p.test(pathname))
  )
}

/** Refresh the Supabase session cookie and gate non-public routes behind a logged-in user. */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request })
  const { pathname } = request.nextUrl

  if (isPublic(pathname)) {
    return response
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          response = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          )
        },
      },
    },
  )

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    const url = request.nextUrl.clone()
    url.pathname = "/sign-in"
    return NextResponse.redirect(url)
  }

  return response
}
