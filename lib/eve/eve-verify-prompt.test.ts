import { describe, it, expect } from "vitest"
import { buildEveVerifyHandoffPrompt } from "./eve-verify-prompt"

describe("buildEveVerifyHandoffPrompt", () => {
  it("assembles the handoff block with the agent name, versions and real error", () => {
    const prompt = buildEveVerifyHandoffPrompt({
      agentName: "Support Bot",
      fromVersion: "0.16.0",
      toVersion: "0.17.0",
      error: "TS2345: Argument of type 'X' is not assignable to 'Y'.",
    })
    expect(prompt).toContain(
      'Eve 0.16.0→0.17.0 breaks my agent "Support Bot".',
    )
    expect(prompt).toContain(
      "TS2345: Argument of type 'X' is not assignable to 'Y'.",
    )
    // Points at the generator in THIS repo, not per-instance patching.
    expect(prompt).toContain("lib/eve/generate.ts")
    expect(prompt).toContain("lib/eve/project.ts")
    // Tells the reader the fix target version.
    expect(prompt).toContain("compiles against eve 0.17.0")
  })

  it("falls back to a placeholder when no error text is available", () => {
    const prompt = buildEveVerifyHandoffPrompt({
      agentName: "Bot",
      fromVersion: "0.16.0",
      toVersion: "0.17.0",
      error: null,
    })
    expect(prompt).toContain("(no error captured)")
    expect(prompt).toContain('breaks my agent "Bot"')
  })

  it("does not crash on a name with quotes (rendered verbatim, not interpolated as code)", () => {
    const prompt = buildEveVerifyHandoffPrompt({
      agentName: 'A"B',
      fromVersion: "0.16.0",
      toVersion: "0.17.0",
      error: "boom",
    })
    expect(prompt).toContain('A"B')
  })
})
