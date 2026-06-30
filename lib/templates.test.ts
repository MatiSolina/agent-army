import { describe, it, expect } from "vitest"
import { AGENT_TEMPLATES, agentRowFromTemplate } from "@/lib/templates"
import { LIMITS } from "@/lib/defaults"

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

describe("AGENT_TEMPLATES", () => {
  it("is a non-empty array", () => {
    expect(Array.isArray(AGENT_TEMPLATES)).toBe(true)
    expect(AGENT_TEMPLATES.length).toBeGreaterThan(0)
  })

  it("contains a customer-support template", () => {
    const t = AGENT_TEMPLATES.find((tpl) => tpl.id === "customer-support")
    expect(t).toBeDefined()
  })

  it("has unique ids", () => {
    const ids = AGENT_TEMPLATES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("every template respects the character LIMITS", () => {
    for (const t of AGENT_TEMPLATES) {
      expect(t.name.length, t.id).toBeLessThanOrEqual(LIMITS.agentName)
      expect(t.description.length, t.id).toBeLessThanOrEqual(
        LIMITS.agentDescription,
      )
      expect(t.instructions.length, t.id).toBeLessThanOrEqual(
        LIMITS.instructions,
      )
      for (const s of t.skills) {
        expect(s.content.length, `${t.id}/${s.id}`).toBeLessThanOrEqual(
          LIMITS.skillContent,
        )
      }
      for (const sa of t.subagents) {
        expect(
          sa.instructions.length,
          `${t.id}/${sa.id}`,
        ).toBeLessThanOrEqual(LIMITS.subagentInstructions)
      }
    }
  })

  describe("customer-support template", () => {
    const t = AGENT_TEMPLATES.find((tpl) => tpl.id === "customer-support")!

    it("has string fields within LIMITS", () => {
      expect(t.name.length).toBeLessThanOrEqual(LIMITS.agentName)
      expect(t.description.length).toBeLessThanOrEqual(LIMITS.agentDescription)
      expect(t.instructions.length).toBeLessThanOrEqual(LIMITS.instructions)
    })

    it("has a non-empty name and instructions", () => {
      expect(t.name.length).toBeGreaterThan(0)
      expect(t.instructions.length).toBeGreaterThan(0)
    })
  })
})

// ---------------------------------------------------------------------------
// agentRowFromTemplate
// ---------------------------------------------------------------------------

describe("agentRowFromTemplate", () => {
  const t = AGENT_TEMPLATES.find((tpl) => tpl.id === "customer-support")!
  const row = agentRowFromTemplate(t, { id: "id-1", userId: "user-1" })

  it("uses the passed-in ids", () => {
    expect(row.id).toBe("id-1")
    expect(row.userId).toBe("user-1")
  })

  it("copies name and model from the template", () => {
    expect(row.name).toBe(t.name)
    expect(row.model).toBe(t.model)
  })

  it("maps instructions to both systemPrompt and instructions", () => {
    expect(row.systemPrompt).toBe(t.instructions)
    expect(row.instructions).toBe(t.instructions)
  })

  it("stores temperature as an integer between 0 and 100", () => {
    expect(Number.isInteger(row.temperature)).toBe(true)
    expect(row.temperature).toBeGreaterThanOrEqual(0)
    expect(row.temperature).toBeLessThanOrEqual(100)
  })

  it("is enabled", () => {
    expect(row.enabled).toBe(true)
  })

  it("has empty toolIds and connectionIds", () => {
    expect(row.toolIds).toEqual([])
    expect(row.connectionIds).toEqual([])
  })

  it("has a sandbox object", () => {
    expect(typeof row.sandbox).toBe("object")
    expect(row.sandbox).not.toBeNull()
  })

  it("has array-valued skills, subagents and schedules", () => {
    expect(Array.isArray(row.skills)).toBe(true)
    expect(Array.isArray(row.subagents)).toBe(true)
    expect(Array.isArray(row.schedules)).toBe(true)
  })
})
