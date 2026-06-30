import { describe, it, expect, vi, beforeEach } from "vitest"

// These actions are auth-gated; stub the operator session so the gateway logic
// under test runs.
vi.mock("@/lib/session", () => ({
  requireSessionUser: vi.fn(async () => ({ id: "u", email: "op@x.io", name: "Op" })),
}))

describe("getGatewayModels", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("returns [] when the gateway throws", async () => {
    vi.doMock("ai", () => ({
      gateway: {
        getAvailableModels: vi.fn().mockRejectedValue(new Error("boom")),
      },
    }))
    const { getGatewayModels } = await import("@/app/actions/models")
    await expect(getGatewayModels()).resolves.toEqual([])
  })

  it("maps gateway results through mapGatewayModels", async () => {
    vi.doMock("ai", () => ({
      gateway: {
        getAvailableModels: vi.fn().mockResolvedValue({
          models: [{ id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6" }],
        }),
      },
    }))
    const { getGatewayModels } = await import("@/app/actions/models")
    await expect(getGatewayModels()).resolves.toContainEqual({
      id: "anthropic/claude-sonnet-4.6",
      label: "Claude Sonnet 4.6",
      provider: "anthropic",
    })
  })
})
