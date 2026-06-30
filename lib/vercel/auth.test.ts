import { describe, it, expect } from "vitest"
import { parseCliAuthToken, resolveVercelAuth } from "./auth"

describe("parseCliAuthToken", () => {
  it("returns the token string from a valid auth.json object", () => {
    const json = { token: "vercel_secret_abc123" }
    expect(parseCliAuthToken(json)).toBe("vercel_secret_abc123")
  })

  it("returns null when the token field is missing", () => {
    const json = { someOtherField: "value" }
    expect(parseCliAuthToken(json)).toBeNull()
  })

  it("returns null when the token field is an empty string", () => {
    const json = { token: "" }
    expect(parseCliAuthToken(json)).toBeNull()
  })

  it("returns null when the input is null", () => {
    expect(parseCliAuthToken(null)).toBeNull()
  })

  it("returns null when the input is a string", () => {
    expect(parseCliAuthToken("vercel_secret")).toBeNull()
  })

  it("returns null when the input is an array", () => {
    expect(parseCliAuthToken([{ token: "vercel_secret" }])).toBeNull()
  })

  it("returns null when the input is a number", () => {
    expect(parseCliAuthToken(42)).toBeNull()
  })

  it("returns null when the token field is not a string", () => {
    const json = { token: 12345 }
    expect(parseCliAuthToken(json)).toBeNull()
  })
})

describe("resolveVercelAuth precedence", () => {
  it("prefers stored OAuth over env when both are present", async () => {
    const result = await resolveVercelAuth({
      getStoredOAuth: async () => ({
        accessToken: "stored_token",
        teamId: "team_stored",
      }),
      getEnv: (k) =>
        ({ VERCEL_TOKEN: "env_token", VERCEL_TEAM_ID: "team_env" })[k],
    })
    expect(result).toEqual({ token: "stored_token", teamId: "team_stored" })
  })

  it("maps a stored null teamId to undefined", async () => {
    const result = await resolveVercelAuth({
      getStoredOAuth: async () => ({
        accessToken: "stored_token",
        teamId: null,
      }),
      getEnv: () => undefined,
    })
    expect(result).toEqual({ token: "stored_token", teamId: undefined })
  })

  it("falls back to env VERCEL_TOKEN/VERCEL_TEAM_ID when no stored OAuth", async () => {
    const result = await resolveVercelAuth({
      getStoredOAuth: async () => null,
      getEnv: (k) =>
        ({ VERCEL_TOKEN: "env_token", VERCEL_TEAM_ID: "team_env" })[k],
    })
    expect(result).toEqual({ token: "env_token", teamId: "team_env" })
  })

  it("uses env token with undefined teamId when VERCEL_TEAM_ID is unset", async () => {
    const result = await resolveVercelAuth({
      getStoredOAuth: async () => null,
      getEnv: (k) => ({ VERCEL_TOKEN: "env_token" })[k],
    })
    expect(result).toEqual({ token: "env_token", teamId: undefined })
  })

  it("throws when neither stored OAuth nor env token is available", async () => {
    await expect(
      resolveVercelAuth({
        getStoredOAuth: async () => null,
        getEnv: () => undefined,
        // disable the CLI auth.json fallback so the test is hermetic
        readCliAuthToken: async () => null,
      }),
    ).rejects.toThrow(/No Vercel token available/)
  })

  it("never includes the token in the thrown error", async () => {
    let thrown: unknown
    try {
      await resolveVercelAuth({
        getStoredOAuth: async () => null,
        getEnv: () => undefined,
        readCliAuthToken: async () => null,
      })
    } catch (e) {
      thrown = e
    }
    expect(String(thrown)).not.toContain("token=")
  })
})
