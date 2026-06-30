import { describe, it, expect, vi, beforeEach } from "vitest"

let rows: unknown[] = []
vi.mock("@/lib/db", () => ({
  db: { select: () => ({ from: () => ({ where: async () => rows }) }) },
}))
vi.mock("drizzle-orm", () => ({ and: (...a: unknown[]) => a, eq: (...a: unknown[]) => a }))

import { hasPassedCanary } from "./fleet-gate"

const done = (over: Record<string, unknown>) => ({
  status: "done",
  canaryAgentId: "a1",
  result: { updated: ["a1"], skipped: [], rollbackTargets: {} },
  ...over,
})

beforeEach(() => {
  rows = []
})

describe("hasPassedCanary", () => {
  it("true when a canary completed and updated its own agent without rollback", async () => {
    rows = [done({})]
    expect(await hasPassedCanary("1.2.3")).toBe(true)
  })

  it("false when there is no canary at all", async () => {
    expect(await hasPassedCanary("1.2.3")).toBe(false)
  })

  it("false when the canary rolled back", async () => {
    rows = [done({ result: { updated: [], skipped: [], rollbackTargets: { a1: "1.2.2" } } })]
    expect(await hasPassedCanary("1.2.3")).toBe(false)
  })

  it("false when the canary agent wasn't actually updated", async () => {
    rows = [done({ result: { updated: ["other"], skipped: ["a1"], rollbackTargets: {} } })]
    expect(await hasPassedCanary("1.2.3")).toBe(false)
  })

  it("false when the run never finished (no result)", async () => {
    rows = [done({ result: null })]
    expect(await hasPassedCanary("1.2.3")).toBe(false)
  })
})
