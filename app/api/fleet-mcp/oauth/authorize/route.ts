import { NextResponse } from "next/server"
import { createFleetMcpOAuthService } from "@/lib/fleet-mcp/oauth"
import { getSessionUser } from "@/lib/session"
import { fleetMcpE2eUser } from "@/lib/fleet-mcp/e2e"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const url = new URL(req.url)
  const user = fleetMcpE2eUser() ?? (await getSessionUser())
  if (!user) {
    const signInUrl = new URL("/sign-in", url.origin)
    signInUrl.searchParams.set("next", `${url.pathname}${url.search}`)
    return NextResponse.redirect(signInUrl)
  }

  try {
    const service = createFleetMcpOAuthService(req)
    const request = await service.startAuthorization({
      clientId: url.searchParams.get("client_id") ?? "",
      redirectUri: url.searchParams.get("redirect_uri") ?? "",
      responseType: url.searchParams.get("response_type") ?? "",
      scope: url.searchParams.get("scope") ?? "",
      state: url.searchParams.get("state"),
      resource: url.searchParams.get("resource") ?? "",
      codeChallenge: url.searchParams.get("code_challenge") ?? "",
      codeChallengeMethod: url.searchParams.get("code_challenge_method") ?? "",
    })
    const consentUrl = new URL("/fleet-mcp/consent", url.origin)
    consentUrl.searchParams.set("request", request.id)
    return NextResponse.redirect(consentUrl)
  } catch (error) {
    return Response.json(
      {
        error: "invalid_request",
        error_description:
          error instanceof Error ? error.message : "Invalid authorization request",
      },
      { status: 400 },
    )
  }
}
