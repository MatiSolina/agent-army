import { describe, it, expect, vi } from "vitest"
import {
  parseAccessTokenResponse,
  exchangeCodeForToken,
  generateOAuthState,
  safeCompareState,
} from "./oauth"

describe("parseAccessTokenResponse", () => {
  it("reads all snake_case fields on the happy path", () => {
    const json = {
      access_token: "vercel_oauth_token_abc123",
      team_id: "team_xyz",
      installation_id: "icfg_123",
      scope: "read write",
    }
    expect(parseAccessTokenResponse(json)).toEqual({
      accessToken: "vercel_oauth_token_abc123",
      teamId: "team_xyz",
      installationId: "icfg_123",
      scope: "read write",
    })
  })

  it("maps an explicit null team_id to null", () => {
    const json = {
      access_token: "vercel_oauth_token_abc123",
      team_id: null,
      installation_id: "icfg_123",
      scope: "read",
    }
    expect(parseAccessTokenResponse(json).teamId).toBeNull()
  })

  it("maps absent team_id / installation_id / scope to null", () => {
    const json = { access_token: "vercel_oauth_token_abc123" }
    expect(parseAccessTokenResponse(json)).toEqual({
      accessToken: "vercel_oauth_token_abc123",
      teamId: null,
      installationId: null,
      scope: null,
    })
  })

  it("throws when access_token is missing", () => {
    expect(() => parseAccessTokenResponse({ team_id: "team_xyz" })).toThrow(
      "Vercel token exchange returned no access_token",
    )
  })

  it("throws when access_token is an empty string", () => {
    expect(() => parseAccessTokenResponse({ access_token: "" })).toThrow(
      "Vercel token exchange returned no access_token",
    )
  })

  it("throws when the input is not an object", () => {
    expect(() => parseAccessTokenResponse(null)).toThrow(
      "Vercel token exchange returned no access_token",
    )
    expect(() => parseAccessTokenResponse("a-string")).toThrow(
      "Vercel token exchange returned no access_token",
    )
    expect(() => parseAccessTokenResponse([{ access_token: "x" }])).toThrow(
      "Vercel token exchange returned no access_token",
    )
  })

  it("never includes the raw json / secret material in the thrown error", () => {
    const secret = "super_secret_token_value_DO_NOT_LEAK"
    // access_token present but non-string → still invalid, and must not leak.
    const json = { access_token: 12345, leaked: secret }
    let message = ""
    try {
      parseAccessTokenResponse(json)
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toBe("Vercel token exchange returned no access_token")
    expect(message).not.toContain(secret)
    expect(message).not.toContain("12345")
  })
})

describe("exchangeCodeForToken", () => {
  it("POSTs form-urlencoded credentials to the Vercel token endpoint and parses the result", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "vercel_oauth_token_abc123",
        team_id: "team_xyz",
        installation_id: "icfg_123",
        scope: "read write",
      }),
      text: async () => "ok",
    })) as unknown as typeof fetch

    const result = await exchangeCodeForToken({
      code: "the-code",
      redirectUri: "https://app.example.com/api/vercel/callback",
      clientId: "client-id-123",
      clientSecret: "client-secret-456",
      fetchImpl,
    })

    expect(result).toEqual({
      accessToken: "vercel_oauth_token_abc123",
      teamId: "team_xyz",
      installationId: "icfg_123",
      scope: "read write",
    })

    // POST to the correct endpoint.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]
    expect(url).toBe("https://api.vercel.com/v2/oauth/access_token")
    expect(init.method).toBe("POST")
    expect(init.headers["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    )

    // Body is x-www-form-urlencoded with all four params.
    const body = new URLSearchParams(init.body as string)
    expect(body.get("client_id")).toBe("client-id-123")
    expect(body.get("client_secret")).toBe("client-secret-456")
    expect(body.get("code")).toBe("the-code")
    expect(body.get("redirect_uri")).toBe(
      "https://app.example.com/api/vercel/callback",
    )
  })

  it("throws a sanitized error (no secret/body) when the response is not ok", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: "invalid_grant", secret_echo: "leak-me" }),
      text: async () => "invalid_grant leak-me client-secret-456",
    })) as unknown as typeof fetch

    let message = ""
    try {
      await exchangeCodeForToken({
        code: "the-code",
        redirectUri: "https://app.example.com/api/vercel/callback",
        clientId: "client-id-123",
        clientSecret: "client-secret-456",
        fetchImpl,
      })
    } catch (err) {
      message = (err as Error).message
    }

    expect(message).toBe("Vercel token exchange failed")
    expect(message).not.toContain("client-secret-456")
    expect(message).not.toContain("leak-me")
    expect(message).not.toContain("400")
  })

  it("propagates the sanitized parse error when access_token is missing", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ team_id: "team_xyz" }),
      text: async () => "ok",
    })) as unknown as typeof fetch

    await expect(
      exchangeCodeForToken({
        code: "the-code",
        redirectUri: "https://app.example.com/api/vercel/callback",
        clientId: "client-id-123",
        clientSecret: "client-secret-456",
        fetchImpl,
      }),
    ).rejects.toThrow("Vercel token exchange returned no access_token")
  })
})

describe("generateOAuthState", () => {
  it("returns a non-empty, URL-safe base64url string", () => {
    const state = generateOAuthState()
    expect(state.length).toBeGreaterThan(0)
    // base64url alphabet only, safe to put in a query string / cookie.
    expect(state).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it("returns a different value on each call (CSPRNG)", () => {
    expect(generateOAuthState()).not.toBe(generateOAuthState())
  })
})

describe("safeCompareState", () => {
  it("returns true for two identical states", () => {
    const s = generateOAuthState()
    expect(safeCompareState(s, s)).toBe(true)
  })

  it("returns false for different states of equal length", () => {
    expect(safeCompareState("a".repeat(43), "b".repeat(43))).toBe(false)
  })

  it("returns false (no throw) when lengths differ", () => {
    expect(safeCompareState("short", "a-much-longer-state-value")).toBe(false)
  })

  it("returns false when either side is null or empty", () => {
    expect(safeCompareState(null, "x")).toBe(false)
    expect(safeCompareState("x", null)).toBe(false)
    expect(safeCompareState("", "")).toBe(false)
    expect(safeCompareState(null, null)).toBe(false)
  })
})
