import { FLEET_MCP_RESOURCE_PATH } from "@/lib/fleet-mcp/oauth"
import {
  buildFleetMcpCorsHeaders,
  isAllowedFleetMcpOrigin,
} from "@/lib/fleet-mcp/origin"

export type FleetMcpAuthInfo = {
  token: string
  clientId: string
  scopes: string[]
  expiresAt?: number
  resource?: string | URL
  extra?: Record<string, unknown>
}

export type FleetMcpHttpDeps = {
  xmcpHandler: (request: Request) => Promise<Response>
  verifyBearerToken: (
    request: Request,
    bearerToken: string,
  ) => Promise<FleetMcpAuthInfo | null | undefined>
}

function bearerToken(req: Request): string | null {
  const [type, token] = (req.headers.get("authorization") ?? "").split(" ")
  return type?.toLowerCase() === "bearer" && token ? token : null
}

function unauthorized(req: Request, description: string) {
  const metadataUrl = `${new URL(req.url).origin}/.well-known/oauth-protected-resource${FLEET_MCP_RESOURCE_PATH}`
  return Response.json(
    {
      jsonrpc: "2.0",
      error: { code: -32001, message: description },
      id: null,
    },
    {
      status: 401,
      headers: {
        ...buildFleetMcpCorsHeaders(req),
        "WWW-Authenticate": `Bearer error="invalid_token", error_description="${description}", resource_metadata="${metadataUrl}"`,
      },
    },
  )
}

export async function handleFleetMcpPost(
  req: Request,
  deps: FleetMcpHttpDeps,
): Promise<Response> {
  if (!isAllowedFleetMcpOrigin(req)) {
    return new Response("Forbidden origin", { status: 403 })
  }

  const token = bearerToken(req)
  if (!token) return unauthorized(req, "No authorization provided")

  let authInfo: FleetMcpAuthInfo | null | undefined
  try {
    authInfo = await deps.verifyBearerToken(req, token)
  } catch {
    authInfo = null
  }
  if (!authInfo) return unauthorized(req, "Invalid token")

  ;(req as Request & { auth?: FleetMcpAuthInfo }).auth = authInfo
  const res = await deps.xmcpHandler(req)
  const headers = new Headers(res.headers)
  for (const [key, value] of Object.entries(buildFleetMcpCorsHeaders(req))) {
    headers.set(key, value)
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  })
}

export async function handleFleetMcpOptions(req: Request): Promise<Response> {
  if (!isAllowedFleetMcpOrigin(req)) {
    return new Response("Forbidden origin", { status: 403 })
  }
  return new Response(null, {
    status: 204,
    headers: buildFleetMcpCorsHeaders(req),
  })
}

export async function handleFleetMcpGet(): Promise<Response> {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST, OPTIONS" },
  })
}
