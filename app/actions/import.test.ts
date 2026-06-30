import { beforeEach, describe, expect, it, vi } from "vitest"
import { buildEveProject } from "@/lib/eve/project"
import { hasConfigDrift } from "@/lib/eve/config-drift"
import type { Agent } from "@/lib/db/schema"

// --- db stub: records inserts/updates, returns configurable select rows ---
const state: { rows: Agent[]; inserted: Record<string, unknown>[]; updated: Record<string, unknown>[] } = {
  rows: [],
  inserted: [],
  updated: [],
}
// Mimics the drizzle chains import.ts uses, including `.returning()`. The write
// makes the row visible + the stamp update mutates it, so the drift-hash path is
// exercised like the real DB.
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => state.rows }) }),
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        returning: async () => {
          state.inserted.push(v)
          state.rows = [v as Agent]
          return [v]
        },
      }),
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: () => {
          state.updated.push(v)
          if (state.rows[0]) Object.assign(state.rows[0], v)
          const ret = Promise.resolve([state.rows[0]]) as Promise<unknown[]> & {
            returning: () => Promise<unknown[]>
          }
          ret.returning = async () => [state.rows[0]]
          return ret
        },
      }),
    }),
  },
}))
vi.mock("drizzle-orm", () => ({ and: (...a: unknown[]) => a, eq: (...a: unknown[]) => a }))
vi.mock("@/lib/session", () => ({ requireUserId: vi.fn(async () => "demo-user") }))
vi.mock("@/lib/vercel/auth", () => ({
  resolveVercelAuth: vi.fn(async () => ({ token: "tok", teamId: "team" })),
}))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

const getProductionDeploymentId = vi.fn()
const getDeploymentFileTree = vi.fn()
const getDeploymentFile = vi.fn()
const listProjects = vi.fn()
const resolveProjectId = vi.fn(async (..._a: unknown[]) => "prj_test")
vi.mock("@/lib/vercel/client", () => ({
  getProductionDeploymentId: (...a: unknown[]) => getProductionDeploymentId(...a),
  getDeploymentFileTree: (...a: unknown[]) => getDeploymentFileTree(...a),
  getDeploymentFile: (...a: unknown[]) => getDeploymentFile(...a),
  listProjects: (...a: unknown[]) => listProjects(...a),
  resolveProjectId: (...a: unknown[]) => resolveProjectId(...a),
}))

import { importAgent, discoverDeployedAgents } from "./import"

// A deployed-agent fixture rendered to its real source files via the generator.
function fixtureFiles(): Record<string, string> {
  const agent = {
    id: "11111111-2222-3333-4444-555555555555",
    userId: "u",
    name: "Sales Bot",
    description: null,
    model: "anthropic/claude-haiku-4.5",
    systemPrompt: "You are Sales Bot. Close deals.",
    temperature: 70,
    instructions: "x",
    maxSteps: 10,
    enabled: true,
    skills: [{ id: "s", name: "Pitch", description: "How to pitch", content: "Be brief." }],
    toolIds: [],
    connectionIds: [],
    subagents: [],
    schedules: [],
    sandbox: { enabled: false },
    harness: { bash: false },
    vercelProjectId: null,
    deploymentUrl: null,
    deploymentStatus: "none",
    eveVersion: null,
    lastDeployedAt: null,
    deployedConfigHash: null,
    deployedConfig: null,
    deploymentError: null,
    previewUrl: null,
    previewDeploymentId: null,
    eveVerifiedVersion: null,
    eveVerifyError: null,
    imported: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Agent
  return buildEveProject(agent, { connections: [] })
}

// Wire the mocked client to serve a file map (paths prefixed with src/, like
// the real deployment tree).
function serveFiles(files: Record<string, string>) {
  getProductionDeploymentId.mockResolvedValue("dpl_prod")
  getDeploymentFileTree.mockResolvedValue(
    Object.keys(files).map((k) => ({ path: `src/${k}`, uid: k })),
  )
  getDeploymentFile.mockImplementation(async (_cfg, _dpl, uid: string) => files[uid])
}

beforeEach(() => {
  state.rows = []
  state.inserted = []
  state.updated = []
  vi.clearAllMocks()
})

describe("importAgent", () => {
  it("inserts a fresh row with recovered config + no false drift badge", async () => {
    serveFiles(fixtureFiles())
    const out = await importAgent("sales-bot-12345678")

    expect(state.inserted).toHaveLength(1)
    const row = state.inserted[0] as Agent
    expect(row.model).toBe("anthropic/claude-haiku-4.5")
    expect(row.systemPrompt).toBe("You are Sales Bot. Close deals.")
    expect(row.skills[0].content.trim()).toBe("Be brief.")
    expect(row.harness).toEqual({ bash: false })
    expect(row.temperature).toBe(70) // defaulted
    expect(row.connectionIds).toEqual([])
    expect(row.deploymentStatus).toBe("deployed")
    expect(row.imported).toBe(true) // update-only, never tears down Vercel on delete
    expect(row.vercelProjectId).toBe("prj_test") // real project id, not the deployment id
    expect(row.deploymentUrl).toBe("https://sales-bot-12345678.vercel.app")
    // id reused from the baked AGENT_ID (no other row owns it)
    expect(row.id).toBe("11111111-2222-3333-4444-555555555555")
    // The stamped snapshot/hash must mean NO drift on a fresh import (asserted
    // on the persisted+stamped row, which the mock mutated through both writes).
    expect(hasConfigDrift(state.rows[0])).toBe(false)
    expect(out.slug).toBe("sales-bot")
  })

  it("throws when the project has no production deployment", async () => {
    getProductionDeploymentId.mockResolvedValue(null)
    await expect(importAgent("x-12345678")).rejects.toThrow(/no production deployment/)
  })

  it("throws on a non-eve project", async () => {
    getProductionDeploymentId.mockResolvedValue("dpl_x")
    getDeploymentFileTree.mockResolvedValue([{ path: "src/package.json", uid: "pkg" }])
    getDeploymentFile.mockResolvedValue('{"name":"x","dependencies":{"next":"15"}}')
    await expect(importAgent("x-12345678")).rejects.toThrow(/Not an Eve agent/)
  })

  it("rejects a client-supplied slug that isn't a project name", async () => {
    await expect(importAgent("../../etc/passwd")).rejects.toThrow(/Invalid project name/)
  })

  it("UPDATEs an already-IMPORTED row on re-import (idempotent, no duplicate)", async () => {
    const files = fixtureFiles()
    serveFiles(files)
    // Re-importing matches by the baked AGENT_ID, but only when the row was
    // imported from THIS Vercel project (deploymentUrl matches the slug).
    state.rows = [
      {
        id: "11111111-2222-3333-4444-555555555555",
        userId: "demo-user",
        name: "Sales Bot",
        imported: true,
        deploymentUrl: "https://sales-bot-12345678.vercel.app",
      } as Agent,
    ]
    await importAgent("sales-bot-12345678")
    expect(state.inserted).toHaveLength(0) // updated, never inserted
    expect(state.updated.length).toBeGreaterThanOrEqual(1)
  })

  it("won't let a baked AGENT_ID hijack an imported row from a different project", async () => {
    // Malicious/mis-baked project: its slug ("evil-99999999") differs from the
    // victim's, but its source bakes the victim's id. The victim row must NOT be
    // updated; a fresh row is inserted instead.
    serveFiles(fixtureFiles()) // bakes id 1111...-5555
    state.rows = [
      {
        id: "11111111-2222-3333-4444-555555555555",
        userId: "demo-user",
        name: "Victim",
        imported: true,
        deploymentUrl: "https://victim-11111111.vercel.app",
      } as Agent,
    ]
    await importAgent("evil-99999999")
    // A NEW row is inserted (victim not overwritten), with a fresh id, never
    // the victim's, since the baked id is already owned by another project.
    expect(state.inserted).toHaveLength(1)
    expect(state.inserted[0]!.id).not.toBe("11111111-2222-3333-4444-555555555555")
  })

  it("won't let a project NAMED after the victim's projectName hijack it", async () => {
    // Sharper attack: the malicious project's slug is set to the victim's
    // deterministic projectName ("sales-bot-11111111") AND its source bakes the
    // victim's id. projectName(victim) === slug, but the victim's real Vercel
    // binding (deploymentUrl) is a DIFFERENT project. Must NOT overwrite.
    serveFiles(fixtureFiles()) // bakes id 1111...-5555, name "Sales Bot"
    state.rows = [
      {
        id: "11111111-2222-3333-4444-555555555555",
        userId: "demo-user",
        name: "Sales Bot", // projectName → "sales-bot-11111111"
        imported: true,
        deploymentUrl: "https://sales-bot-realproject.vercel.app", // real binding, different
      } as Agent,
    ]
    await importAgent("sales-bot-11111111") // == projectName(victim), attacker-chosen
    // INSERT (fresh row), not UPDATE of the victim → the victim was never the
    // update target. (The post-insert stamp write is the only thing in `updated`.)
    expect(state.inserted).toHaveLength(1)
    expect(state.inserted[0]!.id).not.toBe("11111111-2222-3333-4444-555555555555")
  })

  it("refuses to clobber an agent-army-MANAGED agent (imported=false)", async () => {
    serveFiles(fixtureFiles())
    state.rows = [
      {
        id: "11111111-2222-3333-4444-555555555555",
        userId: "demo-user",
        name: "Sales Bot",
        imported: false,
      } as Agent,
    ]
    await expect(importAgent("sales-bot-12345678")).rejects.toThrow(/already managed/)
    expect(state.inserted).toHaveLength(0)
    expect(state.updated).toHaveLength(0)
  })
})

describe("discoverDeployedAgents", () => {
  it("returns eve projects flagged with import/production status", async () => {
    listProjects.mockResolvedValue({
      projects: [
        { id: "p1", name: "sales-bot-12345678", framework: "eve", productionDeploymentId: "dpl_a" },
        { id: "p2", name: "draft-agent", framework: "eve", productionDeploymentId: null },
        { id: "p3", name: "some-nextjs-app", framework: "nextjs", productionDeploymentId: "dpl_b" },
      ],
    })
    state.rows = [{ id: "12345678", userId: "demo-user", name: "Sales Bot" } as Agent]

    const { projects } = await discoverDeployedAgents()
    expect(projects.map((p) => p.slug)).toEqual(["sales-bot-12345678", "draft-agent"]) // nextjs filtered out
    expect(projects.find((p) => p.slug === "sales-bot-12345678")?.alreadyImported).toBe(true)
    expect(projects.find((p) => p.slug === "draft-agent")?.hasProduction).toBe(false)
  })

  it("degrades to [] on a Vercel error", async () => {
    listProjects.mockRejectedValue(new Error("403"))
    expect(await discoverDeployedAgents()).toEqual({ projects: [] })
  })
})
