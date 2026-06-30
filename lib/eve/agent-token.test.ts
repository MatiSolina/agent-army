import { describe, it, expect } from "vitest"
import { agentToken, verifyAgentToken } from "./agent-token"

const KEY = "fm-agent-key"

describe("agentToken / verifyAgentToken", () => {
  it("is deterministic and differs across agent ids", () => {
    expect(agentToken("a", KEY)).toBe(agentToken("a", KEY))
    expect(agentToken("a", KEY)).not.toBe(agentToken("b", KEY))
  })

  it("verifies a token against its own agent id", () => {
    expect(verifyAgentToken("a", agentToken("a", KEY), KEY)).toBe(true)
  })

  it("REJECTS agent A's token presented for agent B (cross-agent isolation)", () => {
    expect(verifyAgentToken("b", agentToken("a", KEY), KEY)).toBe(false)
  })

  it("rejects a token minted under a different FM key", () => {
    expect(verifyAgentToken("a", agentToken("a", "other-key"), KEY)).toBe(false)
  })

  it("returns false (no throw) for null/garbage/length-mismatch input", () => {
    expect(verifyAgentToken("a", null, KEY)).toBe(false)
    expect(verifyAgentToken("a", "garbage", KEY)).toBe(false)
    expect(verifyAgentToken("a", agentToken("a", KEY), undefined)).toBe(false)
  })
})
