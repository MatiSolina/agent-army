import { describe, it, expect } from "vitest"
import { systemPromptInstruction } from "@/app/actions/generate-prompt-meta"

describe("systemPromptInstruction", () => {
  it("embeds the user description", () => {
    const out = systemPromptInstruction("a refund triage bot for a shoe store")
    expect(out).toContain("a refund triage bot for a shoe store")
  })

  it("asks for a second-person English system prompt", () => {
    const out = systemPromptInstruction("anything")
    expect(out.toLowerCase()).toContain("system prompt")
    expect(out).toMatch(/second person|"You are/i)
  })

  it("returns a non-empty instruction even for a blank description", () => {
    expect(systemPromptInstruction("   ").length).toBeGreaterThan(0)
  })
})
