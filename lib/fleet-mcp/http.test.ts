import { describe, expect, it, vi } from "vitest"
import {
  handleFleetMcpGet,
  handleFleetMcpOptions,
  handleFleetMcpPost,
} from "./http"

function req(init?: { auth?: string; origin?: string }) {
  const headers = new Headers({ "content-type": "application/json" })
  if (init?.auth) headers.set("authorization", init.auth)
  if (init?.origin) headers.set("origin", init.origin)
  return new Request("https://fm.test/api/fleet-mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  })
}

describe("/api/fleet-mcp HTTP boundary", () => {
  it("returns a bearer challenge when POST is unauthenticated", async () => {
    const xmcpHandler = vi.fn()
    const verifyBearerToken = vi.fn()

    const res = await handleFleetMcpPost(req(), {
      xmcpHandler,
      verifyBearerToken,
    })

    expect(res.status).toBe(401)
    expect(res.headers.get("www-authenticate")).toContain("Bearer")
    expect(xmcpHandler).not.toHaveBeenCalled()
  })

  it("returns 401 for invalid bearer tokens", async () => {
    const xmcpHandler = vi.fn()
    const verifyBearerToken = vi.fn(async () => null)

    const res = await handleFleetMcpPost(req({ auth: "Bearer bad" }), {
      xmcpHandler,
      verifyBearerToken,
    })

    expect(res.status).toBe(401)
    expect(xmcpHandler).not.toHaveBeenCalled()
  })

  it("returns 403 before auth work for disallowed browser origins", async () => {
    process.env.MCP_ALLOWED_ORIGINS = "https://claude.ai"
    const xmcpHandler = vi.fn()
    const verifyBearerToken = vi.fn()

    const res = await handleFleetMcpPost(
      req({ auth: "Bearer good", origin: "https://evil.example" }),
      { xmcpHandler, verifyBearerToken },
    )

    expect(res.status).toBe(403)
    expect(verifyBearerToken).not.toHaveBeenCalled()
    expect(xmcpHandler).not.toHaveBeenCalled()
  })

  it("passes valid POST requests through to xmcp", async () => {
    process.env.MCP_ALLOWED_ORIGINS = "https://claude.ai"
    const xmcpHandler = vi.fn(async () => Response.json({ ok: true }))
    const verifyBearerToken = vi.fn(async () => ({
      token: "fmcp_at_good",
      clientId: "client-1",
      scopes: ["fleet:read"],
      expiresAt: 1,
      resource: "https://fm.test/api/fleet-mcp",
    }))

    const res = await handleFleetMcpPost(
      req({ auth: "Bearer good", origin: "https://claude.ai" }),
      { xmcpHandler, verifyBearerToken },
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(xmcpHandler).toHaveBeenCalledOnce()
  })

  it("answers OPTIONS with strict CORS headers", async () => {
    process.env.MCP_ALLOWED_ORIGINS = "https://claude.ai"
    const res = await handleFleetMcpOptions(
      new Request("https://fm.test/api/fleet-mcp", {
        method: "OPTIONS",
        headers: { origin: "https://claude.ai" },
      }),
    )

    expect(res.status).toBe(204)
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://claude.ai",
    )
  })

  it("keeps GET closed until xmcp's Next adapter supports SSE correctly", async () => {
    const res = await handleFleetMcpGet()
    expect(res.status).toBe(405)
    expect(res.headers.get("allow")).toBe("POST, OPTIONS")
  })
})
