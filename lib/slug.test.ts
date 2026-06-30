import { describe, expect, it } from "vitest"
import { agentSlug } from "./slug"

describe("agentSlug", () => {
  it("lowercases and dashes spaces", () => {
    expect(agentSlug("Soporte Bot")).toBe("soporte-bot")
  })
  it("collapses non-alnum runs and strips edges", () => {
    expect(agentSlug("  Hello!!  World__2  ")).toBe("hello-world-2")
  })
  it("returns empty for a name with no alnum", () => {
    expect(agentSlug("***")).toBe("")
  })
})
