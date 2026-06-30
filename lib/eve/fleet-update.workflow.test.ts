import { describe, it, expect, vi, beforeEach } from "vitest"

// Mocks: the per-agent helper depends on deployAgentCore (skipPoll path),
// promoteAgentCore, getReadyState (single-shot poll), getProductionDeploymentId
// (rollback target), resolveVercelAuth, and a session-free agents read for the
// slug. None of these touch the request, the network, or a real db.

const { getReadyStateImpl } = vi.hoisted(() => ({
  getReadyStateImpl: vi.fn(async () => "READY" as "READY" | "ERROR" | "BUILDING"),
}))

vi.mock("./deploy-core", () => ({
  deployAgentCore: vi.fn(async () => ({
    previewUrl: "u",
    previewDeploymentId: "dpl_new",
  })),
  promoteAgentCore: vi.fn(async () => ({ url: "https://bot.vercel.app" })),
}))
vi.mock("@/lib/vercel/client", () => ({
  getProductionDeploymentId: vi.fn(async () => "dpl_old"),
  getReadyState: getReadyStateImpl,
}))
vi.mock("@/lib/vercel/auth", () => ({
  resolveVercelAuth: async () => ({ token: "t", teamId: "x" }),
}))
vi.mock("@/lib/eve/project", () => ({
  projectName: (a: { name: string; id: string }) =>
    a.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-" + a.id.slice(0, 8),
}))
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () =>
          Promise.resolve([{ id: "a1", name: "Bot", deployedConfig: null }]),
      }),
    }),
  },
}))
// sleep is a workflow primitive; stub it so the poll loop is instant.
vi.mock("workflow", () => ({ sleep: vi.fn(async () => undefined) }))

import { updateOneAgent } from "./fleet-update.workflow"
import { deployAgentCore, promoteAgentCore } from "./deploy-core"
import { getReadyState, getProductionDeploymentId } from "@/lib/vercel/client"

describe("updateOneAgent (per-agent fleet-update step)", () => {
  beforeEach(() => {
    vi.mocked(deployAgentCore).mockClear()
    vi.mocked(promoteAgentCore).mockClear()
    vi.mocked(getProductionDeploymentId).mockClear()
    getReadyStateImpl.mockReset()
    getReadyStateImpl.mockResolvedValue("READY")
  })

  it("captures the rollback target, deploys from snapshot (skipPoll), promotes on READY", async () => {
    const r = await updateOneAgent("demo-user", "a1", "0.16.2", "^7.0.0")
    expect(getProductionDeploymentId).toHaveBeenCalledOnce()
    expect(r).toEqual({ agentId: "a1", outcome: "updated", rollbackTarget: "dpl_old" })
    expect(deployAgentCore).toHaveBeenCalledWith(
      "demo-user",
      "a1",
      expect.objectContaining({
        eveVersion: "0.16.2",
        aiVersion: "^7.0.0",
        fromSnapshot: true,
        skipPoll: true,
      }),
    )
    expect(promoteAgentCore).toHaveBeenCalledWith("demo-user", "a1", "dpl_new")
  })

  it("skips (no promote) when the build errors", async () => {
    // BUILDING then ERROR → poll loop sees ERROR and skips without promoting.
    getReadyStateImpl
      .mockResolvedValueOnce("BUILDING")
      .mockResolvedValueOnce("ERROR")
    const r = await updateOneAgent("demo-user", "a2", "0.16.2", "^7.0.0")
    expect(r.outcome).toBe("skipped")
    expect(promoteAgentCore).not.toHaveBeenCalled()
  })
})
