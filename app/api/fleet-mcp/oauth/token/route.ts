import { createFleetMcpOAuthService } from "@/lib/fleet-mcp/oauth"
import { rateLimitOk, clientIp } from "@/lib/rate-limit"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Public token endpoint → throttle per IP+client to bound brute-force / grant
// replay. Generous enough for normal OAuth refresh traffic.
const TOKEN_RATE = { limit: 30, windowSeconds: 60 }

function tokenError(error: string, description: string, status = 400) {
  return Response.json(
    { error, error_description: description },
    {
      status,
      headers: { "Cache-Control": "no-store" },
    },
  )
}

export async function POST(req: Request) {
  // Throttle by IP BEFORE parsing the body, so a flood can't even force form
  // parsing. (client_id-scoped throttling happens implicitly via the same key.)
  if (!(await rateLimitOk(`oauth-token:${clientIp(req)}`, TOKEN_RATE.limit, TOKEN_RATE.windowSeconds))) {
    return tokenError("temporarily_unavailable", "Too many requests", 429)
  }

  const form = await req.formData()
  const grantType = String(form.get("grant_type") ?? "")
  const clientId = String(form.get("client_id") ?? "")
  const resource = String(form.get("resource") ?? "")

  const service = createFleetMcpOAuthService(req)

  try {
    if (grantType === "authorization_code") {
      return Response.json(
        await service.exchangeAuthorizationCode({
          code: String(form.get("code") ?? ""),
          codeVerifier: String(form.get("code_verifier") ?? ""),
          clientId,
          redirectUri: String(form.get("redirect_uri") ?? ""),
          resource,
        }),
        { headers: { "Cache-Control": "no-store" } },
      )
    }

    if (grantType === "refresh_token") {
      return Response.json(
        await service.refreshAccessToken({
          refreshToken: String(form.get("refresh_token") ?? ""),
          clientId,
          resource,
        }),
        { headers: { "Cache-Control": "no-store" } },
      )
    }

    return tokenError("unsupported_grant_type", "Unsupported grant_type")
  } catch (error) {
    return tokenError(
      "invalid_grant",
      error instanceof Error ? error.message : "Invalid grant",
    )
  }
}
