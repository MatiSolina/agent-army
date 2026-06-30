function splitAllowedOrigins(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
}

export function isAllowedFleetMcpOrigin(req: Request): boolean {
  const origin = req.headers.get("origin")
  if (!origin) return true

  const requestOrigin = new URL(req.url).origin
  if (origin === requestOrigin) return true

  return splitAllowedOrigins(process.env.MCP_ALLOWED_ORIGINS).includes(origin)
}

export function buildFleetMcpCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin")
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type, MCP-Protocol-Version",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  }

  if (origin && isAllowedFleetMcpOrigin(req)) {
    headers["Access-Control-Allow-Origin"] = origin
  }

  return headers
}
