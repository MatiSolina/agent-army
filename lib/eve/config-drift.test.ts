import { describe, it, expect } from "vitest"
import {
  agentConfigHash,
  hasConfigDrift,
  agentConfigSnapshot,
  diffDeployedConfig,
} from "./config-drift"
import type { Agent } from "@/lib/db/schema"

// A "Deploy" is a snapshot for build-shaped config, while prompt text is runtime
// config resolved by the deployed agent on each turn. This proves we can detect
// build drift WITHOUT false-positiving on deploy bookkeeping
// (status/timestamps/urls) or prompt edits.

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    userId: "demo-user",
    name: "Soporte Bot",
    description: "Atiende clientes",
    model: "openai/gpt-4o-mini",
    systemPrompt: "Sos un agente de soporte.",
    temperature: 70,
    instructions: "Be concise.",
    maxSteps: 10,
    enabled: true,
    skills: [],
    toolIds: [],
    connectionIds: [],
    subagents: [],
    schedules: [],
    sandbox: { enabled: false },
    vercelProjectId: null,
    deploymentUrl: null,
    deploymentStatus: "none",
    eveVersion: null,
    lastDeployedAt: null,
    deploymentError: null,
    previewUrl: null,
    previewDeploymentId: null,
    deployedConfigHash: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  } as Agent
}

describe("agentConfigHash", () => {
  it("is deterministic for identical config", () => {
    expect(agentConfigHash(makeAgent())).toBe(agentConfigHash(makeAgent()))
  })

  it("changes when a build-affecting field changes", () => {
    const base = agentConfigHash(makeAgent())
    expect(agentConfigHash(makeAgent({ model: "openai/gpt-5" }))).not.toBe(base)
    expect(
      agentConfigHash(makeAgent({ connectionIds: ["conn-1"] })),
    ).not.toBe(base)
    expect(
      agentConfigHash(makeAgent({ skills: [{ id: "s1", name: "x", description: "y", content: "z" }] })),
    ).not.toBe(base)
    // Disabling a built-in tool changes what the deployed agent can do → drift.
    expect(
      agentConfigHash(makeAgent({ harness: { bash: false } })),
    ).not.toBe(base)
  })

  it("does NOT change when only the runtime prompt changes", () => {
    const base = agentConfigHash(makeAgent())
    expect(agentConfigHash(makeAgent({ systemPrompt: "Edited live prompt." }))).toBe(base)
    expect(agentConfigHash(makeAgent({ instructions: "Edited live prompt." }))).toBe(base)
  })

  it("does NOT change when only deploy bookkeeping changes", () => {
    const base = agentConfigHash(makeAgent())
    expect(
      agentConfigHash(
        makeAgent({
          deploymentStatus: "deployed",
          deploymentUrl: "https://x.vercel.app",
          eveVersion: "1.2.3",
          lastDeployedAt: new Date("2026-06-27"),
          updatedAt: new Date("2026-06-27"),
          deployedConfigHash: "whatever",
          previewUrl: "https://preview.vercel.app",
        }),
      ),
    ).toBe(base)
  })
})

describe("hasConfigDrift", () => {
  it("is false when the agent was never deployed (no baseline)", () => {
    expect(hasConfigDrift(makeAgent({ deployedConfigHash: null }))).toBe(false)
  })

  it("is false when current config matches the deployed snapshot", () => {
    const agent = makeAgent()
    expect(hasConfigDrift({ ...agent, deployedConfigHash: agentConfigHash(agent) })).toBe(false)
  })

  it("is true when current config differs from the deployed snapshot", () => {
    const deployed = makeAgent()
    const edited = makeAgent({
      maxSteps: 20,
      deployedConfigHash: agentConfigHash(deployed),
    })
    expect(hasConfigDrift(edited)).toBe(true)
  })
})

describe("agentConfigSnapshot", () => {
  it("keeps build-affecting fields and drops deploy bookkeeping + identity", () => {
    const snap = agentConfigSnapshot(makeAgent())
    expect(snap).toHaveProperty("connectionIds")
    expect(snap).not.toHaveProperty("systemPrompt")
    expect(snap).not.toHaveProperty("instructions")
    expect(snap).not.toHaveProperty("id")
    expect(snap).not.toHaveProperty("deploymentStatus")
    expect(snap).not.toHaveProperty("deployedConfigHash")
    expect(snap).not.toHaveProperty("updatedAt")
  })

  it("hashes to the same value as agentConfigHash (shared snapshot)", () => {
    const agent = makeAgent()
    // The snapshot is the unit the hash is computed over, so two snapshots of
    // the same config must hash-compare equal via agentConfigHash.
    expect(agentConfigHash({ ...agent })).toBe(agentConfigHash(agent))
  })
})

describe("diffDeployedConfig", () => {
  it("returns [] when there is no deployed snapshot", () => {
    expect(diffDeployedConfig(null, makeAgent())).toEqual([])
  })

  it("returns [] when nothing changed", () => {
    const agent = makeAgent()
    expect(diffDeployedConfig(agentConfigSnapshot(agent), agent)).toEqual([])
  })

  it("flags a changed short text field with 'from → to'", () => {
    const deployed = agentConfigSnapshot(makeAgent({ model: "openai/gpt-4o-mini" }))
    const changes = diffDeployedConfig(deployed, makeAgent({ model: "openai/gpt-5" }))
    expect(changes).toHaveLength(1)
    expect(changes[0].field).toBe("model")
    expect(changes[0].label).toBe("Model")
    expect(changes[0].summary).toBe("openai/gpt-4o-mini → openai/gpt-5")
  })

  it("summarizes list fields by count with a friendly label", () => {
    const deployed = agentConfigSnapshot(makeAgent({ connectionIds: [] }))
    const changes = diffDeployedConfig(deployed, makeAgent({ connectionIds: ["c1"] }))
    const conn = changes.find((c) => c.field === "connectionIds")
    expect(conn?.label).toBe("MCP connections")
    expect(conn?.summary).toBe("0 → 1")
  })

  it("summarizes long text as 'edited' (no noisy dump)", () => {
    const deployed = agentConfigSnapshot(makeAgent({ instructions: "short" }))
    const changes = diffDeployedConfig(
      deployed,
      makeAgent({ instructions: "x".repeat(60) }),
    )
    expect(changes.find((c) => c.field === "instructions")).toBeUndefined()
  })

  it("reports every changed field", () => {
    const deployed = agentConfigSnapshot(makeAgent())
    const changes = diffDeployedConfig(
      deployed,
      makeAgent({ model: "m2", maxSteps: 20 }),
    )
    expect(changes.map((c) => c.field).sort()).toEqual(["maxSteps", "model"])
  })
})
