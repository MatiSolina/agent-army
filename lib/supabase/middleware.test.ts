import { describe, it, expect } from "vitest"
import { isPublic } from "./middleware"

// The operator-session gate must NOT trap machine-to-machine endpoints that
// carry their own bearer auth. /api/mcp/token is the FM token broker the
// DEPLOYED eve agents call with EVE_API_SECRET. If the middleware redirects it
// to /sign-in, every OAuth MCP tool (e.g. Linear) fails at runtime because the
// agent gets the login page instead of the access token.
describe("isPublic", () => {
  it("treats the M2M MCP token broker as public (it has its own bearer auth)", () => {
    expect(isPublic("/api/mcp/token")).toBe(true)
  })

  it("treats the agent runtime config endpoint as public because it has bearer auth", () => {
    expect(isPublic("/api/agents/agent-1/runtime-config")).toBe(true)
  })

  it("keeps the OAuth callback routes public", () => {
    expect(isPublic("/api/mcp/callback")).toBe(true)
    expect(isPublic("/api/vercel/callback")).toBe(true)
    expect(isPublic("/sign-in")).toBe(true)
  })

  it("treats Fleet MCP OAuth and metadata endpoints as public because they carry their own auth", () => {
    expect(isPublic("/api/fleet-mcp")).toBe(true)
    expect(isPublic("/api/fleet-mcp/oauth/register")).toBe(true)
    expect(isPublic("/api/fleet-mcp/oauth/token")).toBe(true)
    expect(isPublic("/.well-known/oauth-protected-resource")).toBe(true)
    expect(
      isPublic("/.well-known/oauth-protected-resource/api/fleet-mcp"),
    ).toBe(true)
    expect(isPublic("/.well-known/oauth-authorization-server")).toBe(true)
  })

  it("still gates operator routes behind a session", () => {
    expect(isPublic("/")).toBe(false)
    expect(isPublic("/agents/123")).toBe(false)
    expect(isPublic("/api/agents/123/chat")).toBe(false)
  })
})
