import { beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// Mocks — no real deploy, no real Vercel, no real ping.
// ---------------------------------------------------------------------------

// Capture the db.update().set(...) payloads so we can assert verdict writes.
const setCalls: Record<string, unknown>[] = []
const dbUpdate = vi.fn((_table?: unknown) => ({
  set: (payload: Record<string, unknown>) => {
    setCalls.push(payload)
    return { where: vi.fn(async () => undefined) }
  },
}))
vi.mock("@/lib/db", () => ({ db: { update: (a: unknown) => dbUpdate(a) } }))
vi.mock("@/lib/db/schema", () => ({ agents: { id: "id", userId: "userId" } }))
vi.mock("drizzle-orm", () => ({ and: (...a: unknown[]) => a, eq: (...a: unknown[]) => a }))

vi.mock("@/lib/session", () => ({
  requireUserId: vi.fn(async () => "demo-user"),
}))
vi.mock("@/lib/mcp/get-connections", () => ({
  getConnections: vi.fn(async () => []),
}))
vi.mock("@/lib/eve/eve-version", () => ({
  resolveLatestEve: vi.fn(async () => ({
    latest: "0.17.0",
    target: "0.16.0",
    // The pinned-back target's ai peer (old). The preview-test must NOT use this.
    aiPin: "^7.2.0",
    // The CANDIDATE's ai peer — what the preview pinned to 0.17.0 must carry.
    latestAiPin: "^8.0.0",
    gated: true,
  })),
}))

const deployAgentCore = vi.fn(async (..._args: unknown[]) => ({
  previewUrl: "https://preview.vercel.app",
  previewDeploymentId: "dpl_PREVIEW",
}))
vi.mock("@/lib/eve/deploy-core", () => ({
  deployAgentCore: (...args: unknown[]) => deployAgentCore(...args),
}))

const sendToDeployedAgent = vi.fn(async (..._args: unknown[]) => ({
  text: "pong",
  sessionId: "s1",
  startIndex: 1,
}))
vi.mock("@/lib/eve/session-client", () => ({
  sendToDeployedAgent: (...args: unknown[]) => sendToDeployedAgent(...args),
}))

const deleteDeployment = vi.fn(async (..._args: unknown[]) => ({ existed: true }))
vi.mock("@/lib/vercel/client", () => ({
  deleteDeployment: (...args: unknown[]) => deleteDeployment(...args),
}))
vi.mock("@/lib/vercel/auth", () => ({
  resolveVercelAuth: vi.fn(async () => ({ token: "t", teamId: "team" })),
}))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

import { testEvePreview } from "./deploy"

beforeEach(() => {
  setCalls.length = 0
  deployAgentCore.mockClear()
  sendToDeployedAgent.mockClear()
  deleteDeployment.mockClear()
})

describe("testEvePreview — success path", () => {
  it("deploys a preview pinned to the candidate, pings it, sets the verdict", async () => {
    const out = await testEvePreview("agent-1", "0.17.0")

    // Preview pinned to the candidate eve version + the CANDIDATE's ai peer
    // (latestAiPin), in previewTest mode (must not corrupt the live row).
    expect(deployAgentCore).toHaveBeenCalledWith(
      "demo-user",
      "agent-1",
      expect.objectContaining({
        eveVersion: "0.17.0",
        aiVersion: "^8.0.0",
        previewTest: true,
      }),
    )
    // Pinged the preview URL.
    expect(sendToDeployedAgent).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "https://preview.vercel.app" }),
    )
    // Verdict persisted: eveVerifiedVersion set, eveVerifyError cleared.
    const verdict = setCalls.find((c) => "eveVerifiedVersion" in c)
    expect(verdict).toMatchObject({
      eveVerifiedVersion: "0.17.0",
      eveVerifyError: null,
    })
    // Success returns the preview URL and no error; the preview is NOT deleted.
    expect(out).toEqual({ verdictUrl: "https://preview.vercel.app" })
    expect(deleteDeployment).not.toHaveBeenCalled()
  })
})

describe("testEvePreview — failure path", () => {
  it("persists the error, clears the verified version, deletes the preview", async () => {
    sendToDeployedAgent.mockRejectedValueOnce(
      new Error("Deployed agent session request failed (500)"),
    )

    const out = await testEvePreview("agent-1", "0.17.0")

    // Error persisted; verified version cleared.
    const verdict = setCalls.find((c) => "eveVerifyError" in c)
    expect(verdict).toMatchObject({ eveVerifiedVersion: null })
    expect(String(verdict?.eveVerifyError)).toContain("500")
    // The pinned preview is deleted (housekeeping).
    expect(deleteDeployment).toHaveBeenCalledWith(
      expect.objectContaining({ token: "t" }),
      "dpl_PREVIEW",
    )
    // Returns null + the error string for the handoff prompt.
    expect(out.verdictUrl).toBeNull()
    expect(out.error).toContain("500")
    // The verdict write touches ONLY the verdict columns — it never rewrites
    // deploymentStatus / eveVersion / previewUrl, because previewTest mode never
    // corrupted the live row in the first place (no fix-up needed).
    expect(verdict).not.toHaveProperty("deploymentStatus")
    expect(verdict).not.toHaveProperty("eveVersion")
    expect(verdict).not.toHaveProperty("previewUrl")
    expect(verdict).not.toHaveProperty("previewDeploymentId")
  })

  it("handles a build/deploy failure (no preview to ping) and persists the error", async () => {
    deployAgentCore.mockRejectedValueOnce(new Error("build blew up: TS2345"))

    const out = await testEvePreview("agent-1", "0.17.0")

    expect(sendToDeployedAgent).not.toHaveBeenCalled()
    const verdict = setCalls.find((c) => "eveVerifyError" in c)
    expect(verdict).toMatchObject({ eveVerifiedVersion: null })
    expect(String(verdict?.eveVerifyError)).toContain("TS2345")
    expect(out.verdictUrl).toBeNull()
    expect(out.error).toContain("TS2345")
  })

  it("fails when the ping returns an empty body (non-empty body required)", async () => {
    sendToDeployedAgent.mockResolvedValueOnce({
      text: "",
      sessionId: "s1",
      startIndex: 1,
    })

    const out = await testEvePreview("agent-1", "0.17.0")

    expect(out.verdictUrl).toBeNull()
    expect(deleteDeployment).toHaveBeenCalledWith(
      expect.objectContaining({ token: "t" }),
      "dpl_PREVIEW",
    )
    const verdict = setCalls.find((c) => "eveVerifyError" in c)
    expect(verdict).toMatchObject({ eveVerifiedVersion: null })
  })
})
