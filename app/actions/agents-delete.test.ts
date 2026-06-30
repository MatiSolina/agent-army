import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Agent } from "@/lib/db/schema"

const state: { agent: Partial<Agent> | undefined } = { agent: undefined }
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => (state.agent ? [state.agent] : []) }) }),
    }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
    delete: () => ({ where: async () => {} }),
  },
}))
vi.mock("drizzle-orm", () => ({ and: (...a: unknown[]) => a, desc: (x: unknown) => x, eq: (...a: unknown[]) => a }))
vi.mock("@/lib/session", () => ({ requireUserId: vi.fn(async () => "demo-user") }))
vi.mock("@/lib/vercel/auth", () => ({
  resolveVercelAuth: vi.fn(async () => ({ token: "tok", teamId: "team" })),
}))
const deleteProject = vi.fn(async (..._a: unknown[]) => ({ existed: true }))
vi.mock("@/lib/vercel/client", () => ({ deleteProject: (...a: unknown[]) => deleteProject(...a) }))
vi.mock("@/lib/eve/project", () => ({ projectName: () => "some-agent-12345678" }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

import { deleteAgent } from "./agents"

beforeEach(() => {
  state.agent = undefined
  vi.clearAllMocks()
})

describe("deleteAgent — imported agents are unlinked, not torn down", () => {
  it("does NOT delete the Vercel project for an imported agent", async () => {
    state.agent = { id: "a1", userId: "demo-user", name: "X", imported: true }
    await deleteAgent("a1")
    expect(deleteProject).not.toHaveBeenCalled()
  })

  it("DOES delete the Vercel project for a normally-created agent", async () => {
    state.agent = { id: "a2", userId: "demo-user", name: "Y", imported: false }
    await deleteAgent("a2")
    expect(deleteProject).toHaveBeenCalledTimes(1)
  })
})
