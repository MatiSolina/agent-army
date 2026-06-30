import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"

// vi.mock is hoisted before imports, so the factory runs before
// mockGetVercelOidcToken is declared. vi.hoisted lifts the mock fn above the
// hoist boundary so the factory can reference it.

const { mockGetVercelOidcToken } = vi.hoisted(() => ({
  mockGetVercelOidcToken: vi.fn(),
}))

vi.mock("@vercel/oidc", () => ({
  getVercelOidcToken: mockGetVercelOidcToken,
}))

import { getOidcToken } from "@/lib/skills/oidc-token"

// The token helper prefers the @vercel/oidc helper (auto-refresh in local dev)
// and falls back to process.env.VERCEL_OIDC_TOKEN when that throws, so skills.sh
// still works in CI / containers where the CLI is not linked.

describe("getOidcToken", () => {
  const origEnv = process.env.VERCEL_OIDC_TOKEN

  beforeEach(() => {
    mockGetVercelOidcToken.mockReset()
    delete process.env.VERCEL_OIDC_TOKEN
  })

  afterEach(() => {
    if (origEnv === undefined) delete process.env.VERCEL_OIDC_TOKEN
    else process.env.VERCEL_OIDC_TOKEN = origEnv
  })

  it("returns the token from @vercel/oidc when it resolves", async () => {
    mockGetVercelOidcToken.mockResolvedValueOnce("fresh-oidc-token")
    expect(await getOidcToken()).toBe("fresh-oidc-token")
  })

  it("falls back to process.env.VERCEL_OIDC_TOKEN when the helper throws", async () => {
    process.env.VERCEL_OIDC_TOKEN = "env-fallback-token"
    mockGetVercelOidcToken.mockRejectedValueOnce(new Error("not linked"))
    expect(await getOidcToken()).toBe("env-fallback-token")
  })

  it("returns null when the helper throws and no env var is set", async () => {
    mockGetVercelOidcToken.mockRejectedValueOnce(new Error("not linked"))
    expect(await getOidcToken()).toBeNull()
  })
})
