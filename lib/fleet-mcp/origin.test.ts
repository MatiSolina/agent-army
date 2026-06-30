import { describe, expect, it } from "vitest"
import {
  buildFleetMcpCorsHeaders,
  isAllowedFleetMcpOrigin,
} from "./origin"

function req(url: string, origin?: string) {
  const headers = new Headers()
  if (origin) headers.set("origin", origin)
  return new Request(url, { headers })
}

describe("Fleet MCP origin guard", () => {
  it("allows non-browser and same-origin requests", () => {
    expect(isAllowedFleetMcpOrigin(req("https://fm.test/api/fleet-mcp"))).toBe(
      true,
    )
    expect(
      isAllowedFleetMcpOrigin(
        req("https://fm.test/api/fleet-mcp", "https://fm.test"),
      ),
    ).toBe(true)
  })

  it("allows only exact origins from MCP_ALLOWED_ORIGINS", () => {
    process.env.MCP_ALLOWED_ORIGINS =
      "https://claude.ai, https://mcp-client.example"

    expect(
      isAllowedFleetMcpOrigin(
        req("https://fm.test/api/fleet-mcp", "https://claude.ai"),
      ),
    ).toBe(true)
    expect(
      isAllowedFleetMcpOrigin(
        req("https://fm.test/api/fleet-mcp", "https://evil.example"),
      ),
    ).toBe(false)
  })

  it("returns strict CORS headers for allowed browser origins", () => {
    process.env.MCP_ALLOWED_ORIGINS = "https://claude.ai"

    const headers = buildFleetMcpCorsHeaders(
      req("https://fm.test/api/fleet-mcp", "https://claude.ai"),
    )

    expect(headers["Access-Control-Allow-Origin"]).toBe("https://claude.ai")
    expect(headers["Access-Control-Allow-Methods"]).toBe("POST, OPTIONS")
    expect(headers["Access-Control-Allow-Headers"]).toContain("Authorization")
    expect(headers.Vary).toBe("Origin")
  })
})
