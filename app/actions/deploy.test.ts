import { beforeEach, describe, expect, it, vi } from "vitest"

// Module-level imports in deploy.ts that we don't exercise here; stub them so
// the module loads. The behavior under test is the deploy → promote wiring.
// A tiny db stub whose select(...).from(...).where(...) yields one agent row, so
// deployAgent can read eveVerifiedVersion to pick the eve pin.
const agentRow: Record<string, unknown> = { eveVerifiedVersion: null }
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({ where: async () => [agentRow] }),
    }),
  },
}))
vi.mock("@/lib/db/schema", () => ({ agents: { id: "id", userId: "userId" } }))
vi.mock("drizzle-orm", () => ({ and: (...a: unknown[]) => a, eq: (...a: unknown[]) => a }))
vi.mock("@/lib/session", () => ({
  requireUserId: vi.fn(async () => "demo-user"),
}))
vi.mock("@/lib/mcp/get-connections", () => ({
  getConnections: vi.fn(async () => []),
}))
vi.mock("@/lib/eve/project", () => ({ projectName: () => "agent" }))
const resolveLatestEve = vi.fn(async () => ({
  latest: "1.0.0",
  target: "1.0.0",
  aiPin: "6.0.0",
  latestAiPin: "6.0.0",
  gated: false,
}))
vi.mock("@/lib/eve/eve-version", () => ({
  resolveLatestEve: () => resolveLatestEve(),
}))
vi.mock("@/lib/vercel/client", () => ({
  listDeployments: vi.fn(),
  getProductionDeploymentId: vi.fn(),
}))
vi.mock("@/lib/vercel/auth", () => ({ resolveVercelAuth: vi.fn() }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

const deployAgentCore = vi.fn(async (..._args: unknown[]) => ({
  previewUrl: "https://preview.example.app",
  previewDeploymentId: "dpl_PREVIEW",
}))
const promoteAgentCore = vi.fn(async (..._args: unknown[]) => ({
  url: "https://content-agent.vercel.app",
}))
vi.mock("@/lib/eve/deploy-core", () => ({
  deployAgentCore: (...args: unknown[]) => deployAgentCore(...args),
  promoteAgentCore: (...args: unknown[]) => promoteAgentCore(...args),
}))

import { deployAgent, deployAndPromoteAgent } from "./deploy"

describe("deployAgent — eve pin selection", () => {
  beforeEach(() => {
    deployAgentCore.mockClear()
    resolveLatestEve.mockClear()
    agentRow.eveVerifiedVersion = null
  })

  it("deploys on the auto-update target for a non-gated bump", async () => {
    resolveLatestEve.mockResolvedValueOnce({
      latest: "0.16.2",
      target: "0.16.2",
      aiPin: "^7.0.0",
      latestAiPin: "^7.0.0",
      gated: false,
    })
    await deployAgent("agent-1")
    expect(deployAgentCore).toHaveBeenCalledWith(
      "demo-user",
      "agent-1",
      expect.objectContaining({ eveVersion: "0.16.2", aiVersion: "^7.0.0" }),
    )
  })

  it("keeps the pinned-back target for a gated bump the agent has NOT verified", async () => {
    resolveLatestEve.mockResolvedValueOnce({
      latest: "0.17.0",
      target: "0.16.0",
      aiPin: "^7.0.0",
      latestAiPin: "^8.0.0",
      gated: true,
    })
    agentRow.eveVerifiedVersion = null
    await deployAgent("agent-1")
    // Unverified gated bump → never auto-jumps the breaking version.
    expect(deployAgentCore).toHaveBeenCalledWith(
      "demo-user",
      "agent-1",
      expect.objectContaining({ eveVersion: "0.16.0", aiVersion: "^7.0.0" }),
    )
  })

  it("deploys on the CANDIDATE (+ its ai peer) for a gated bump the agent verified", async () => {
    resolveLatestEve.mockResolvedValueOnce({
      latest: "0.17.0",
      target: "0.16.0",
      aiPin: "^7.0.0",
      latestAiPin: "^8.0.0",
      gated: true,
    })
    // The agent proved 0.17.0 in a preview-test → "Update to 0.17" must ship 0.17.
    agentRow.eveVerifiedVersion = "0.17.0"
    await deployAgent("agent-1")
    expect(deployAgentCore).toHaveBeenCalledWith(
      "demo-user",
      "agent-1",
      expect.objectContaining({ eveVersion: "0.17.0", aiVersion: "^8.0.0" }),
    )
  })
})

describe("deployAndPromoteAgent", () => {
  beforeEach(() => {
    deployAgentCore.mockClear()
    promoteAgentCore.mockClear()
    agentRow.eveVerifiedVersion = null
  })

  it("builds a preview then promotes THAT build to production", async () => {
    const out = await deployAndPromoteAgent("agent-1")

    // Preview built for the agent.
    expect(deployAgentCore).toHaveBeenCalledTimes(1)
    expect(deployAgentCore).toHaveBeenCalledWith(
      "demo-user",
      "agent-1",
      expect.objectContaining({ eveVersion: "1.0.0" }),
    )

    // The just-built preview id is what gets promoted (not a stale one).
    expect(promoteAgentCore).toHaveBeenCalledTimes(1)
    expect(promoteAgentCore).toHaveBeenCalledWith(
      "demo-user",
      "agent-1",
      "dpl_PREVIEW",
    )

    // Returns the production URL from the promote.
    expect(out).toEqual({ url: "https://content-agent.vercel.app" })
  })

  it("does not promote if the preview build fails", async () => {
    deployAgentCore.mockRejectedValueOnce(new Error("build blew up"))
    await expect(deployAndPromoteAgent("agent-1")).rejects.toThrow()
    expect(promoteAgentCore).not.toHaveBeenCalled()
  })
})
