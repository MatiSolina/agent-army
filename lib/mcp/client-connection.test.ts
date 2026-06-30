import { describe, it, expect } from "vitest"
import type { Connection } from "@/lib/db/schema"
import { toClientConnection, type ClientConnection } from "./client-connection"

// A full server-side row, including every secret OAuth artifact. The mapper
// must NEVER let any of these reach the returned object.
function fullRow(overrides: Partial<Connection> = {}): Connection {
  return {
    id: "conn-1",
    userId: "demo-user",
    name: "linear",
    transport: "http",
    url: "https://mcp.linear.app/sse",
    token: "static-bearer-secret",
    status: "connected",
    oauthClientInfo: { client_id: "client-123", client_secret: "shh" },
    oauthServerInfo: {
      authorizationServerUrl: "https://auth.example.com",
      tokenEndpoint: "https://auth.example.com/token",
    },
    oauthTokens: {
      access_token: "ACCESS-SECRET",
      token_type: "bearer",
      refresh_token: "REFRESH-SECRET",
    },
    oauthCodeVerifier: "PKCE-VERIFIER-SECRET",
    oauthState: "CSRF-STATE-SECRET",
    oauthScope: "read write",
    oauthError: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-02T00:00:00Z"),
    ...overrides,
  } as Connection
}

describe("toClientConnection", () => {
  it("exposes only the safe, non-secret fields", () => {
    const client = toClientConnection(fullRow())
    expect(client).toEqual<ClientConnection>({
      id: "conn-1",
      name: "linear",
      transport: "http",
      url: "https://mcp.linear.app/sse",
      status: "connected",
      oauthError: null,
      oauthScope: "read write",
      hasToken: true,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })
  })

  it("never leaks any secret OAuth artifact or the static token", () => {
    const client = toClientConnection(fullRow())
    const serialized = JSON.stringify(client)
    expect(serialized).not.toContain("ACCESS-SECRET")
    expect(serialized).not.toContain("REFRESH-SECRET")
    expect(serialized).not.toContain("PKCE-VERIFIER-SECRET")
    expect(serialized).not.toContain("CSRF-STATE-SECRET")
    expect(serialized).not.toContain("static-bearer-secret")
    expect(serialized).not.toContain("client_secret")
    expect(serialized).not.toContain("shh")
    // Belt-and-suspenders: the well-known secret-bearing keys are absent.
    const keys = Object.keys(client)
    expect(keys).not.toContain("token")
    expect(keys).not.toContain("oauthTokens")
    expect(keys).not.toContain("oauthCodeVerifier")
    expect(keys).not.toContain("oauthState")
    expect(keys).not.toContain("oauthClientInfo")
    expect(keys).not.toContain("oauthServerInfo")
    expect(keys).not.toContain("userId")
  })

  it("reports hasToken=false when there is no static token", () => {
    expect(toClientConnection(fullRow({ token: null })).hasToken).toBe(false)
    expect(toClientConnection(fullRow({ token: "" })).hasToken).toBe(false)
  })
})
