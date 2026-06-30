import { describe, it, expect } from "vitest"
import { conversationMetrics, resolveAgentName } from "./metrics"
import type { Message } from "./db/schema"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    userId: "user-1",
    channelId: "channel-1",
    agentId: "agent-1",
    conversationId: "conv-1",
    role: "user",
    content: "Hello",
    createdAt: new Date("2024-01-15T12:00:00.000Z"),
    ...overrides,
  }
}

// Reference "now" for all tests: 2024-01-15T15:00:00Z
// Messages within 24h = created after 2024-01-14T15:00:00Z
const NOW = new Date("2024-01-15T15:00:00.000Z")

// ---------------------------------------------------------------------------
// Dataset: 2 conversations, mixed roles, 2 agents, old+recent messages
// ---------------------------------------------------------------------------

// conv-1: agent-1, 3 messages: 2 recent, 1 old
const MSG_C1_USER_RECENT = makeMessage({
  id: "1",
  conversationId: "conv-1",
  agentId: "agent-1",
  role: "user",
  createdAt: new Date("2024-01-15T14:00:00.000Z"), // 1h ago → recent
})
const MSG_C1_ASSISTANT_RECENT = makeMessage({
  id: "2",
  conversationId: "conv-1",
  agentId: "agent-1",
  role: "assistant",
  createdAt: new Date("2024-01-15T14:01:00.000Z"), // recent
})
const MSG_C1_USER_OLD = makeMessage({
  id: "3",
  conversationId: "conv-1",
  agentId: "agent-1",
  role: "user",
  createdAt: new Date("2024-01-14T10:00:00.000Z"), // >24h ago → old
})

// conv-2: agent-2, 2 messages: 1 recent, 1 old
const MSG_C2_USER_RECENT = makeMessage({
  id: "4",
  conversationId: "conv-2",
  agentId: "agent-2",
  role: "user",
  createdAt: new Date("2024-01-15T15:00:00.000Z"), // exactly now → recent
})
const MSG_C2_ASSISTANT_OLD = makeMessage({
  id: "5",
  conversationId: "conv-2",
  agentId: "agent-2",
  role: "assistant",
  createdAt: new Date("2024-01-13T00:00:00.000Z"), // 2 days ago → old
})

// conv-3: null agentId, 1 message, recent
const MSG_C3_NO_AGENT = makeMessage({
  id: "6",
  conversationId: "conv-3",
  agentId: null,
  role: "user",
  createdAt: new Date("2024-01-15T14:30:00.000Z"), // recent
})

const DATASET = [
  MSG_C1_USER_RECENT,
  MSG_C1_ASSISTANT_RECENT,
  MSG_C1_USER_OLD,
  MSG_C2_USER_RECENT,
  MSG_C2_ASSISTANT_OLD,
  MSG_C3_NO_AGENT,
]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("conversationMetrics", () => {
  describe("totalMessages", () => {
    it("counts all messages in the dataset", () => {
      const result = conversationMetrics(DATASET, NOW)
      expect(result.totalMessages).toBe(6)
    })

    it("returns 0 for an empty array", () => {
      const result = conversationMetrics([], NOW)
      expect(result.totalMessages).toBe(0)
    })
  })

  describe("conversations", () => {
    it("counts unique conversationIds", () => {
      const result = conversationMetrics(DATASET, NOW)
      expect(result.conversations).toBe(3)
    })

    it("counts 1 when all messages share the same conversationId", () => {
      const msgs = [MSG_C1_USER_RECENT, MSG_C1_ASSISTANT_RECENT, MSG_C1_USER_OLD]
      const result = conversationMetrics(msgs, NOW)
      expect(result.conversations).toBe(1)
    })

    it("returns 0 for an empty array", () => {
      const result = conversationMetrics([], NOW)
      expect(result.conversations).toBe(0)
    })
  })

  describe("byRole", () => {
    it("counts messages per role", () => {
      const result = conversationMetrics(DATASET, NOW)
      // 4 user + 2 assistant
      expect(result.byRole["user"]).toBe(4)
      expect(result.byRole["assistant"]).toBe(2)
    })

    it("returns an empty object for empty input", () => {
      const result = conversationMetrics([], NOW)
      expect(result.byRole).toEqual({})
    })

    it("handles a single role", () => {
      const msgs = [MSG_C1_USER_RECENT, MSG_C1_USER_OLD]
      const result = conversationMetrics(msgs, NOW)
      expect(result.byRole["user"]).toBe(2)
      expect(result.byRole["assistant"]).toBeUndefined()
    })
  })

  describe("byAgent", () => {
    it("counts messages per agentId", () => {
      const result = conversationMetrics(DATASET, NOW)
      expect(result.byAgent["agent-1"]).toBe(3)
      expect(result.byAgent["agent-2"]).toBe(2)
    })

    it("groups null agentId under '—'", () => {
      const result = conversationMetrics(DATASET, NOW)
      expect(result.byAgent["—"]).toBe(1)
    })

    it("returns an empty object for empty input", () => {
      const result = conversationMetrics([], NOW)
      expect(result.byAgent).toEqual({})
    })
  })

  describe("last24h", () => {
    it("counts messages created within 24h of now", () => {
      const result = conversationMetrics(DATASET, NOW)
      // recent: msg 1, 2, 4, 6 = 4
      expect(result.last24h).toBe(4)
    })

    it("includes messages created exactly at now", () => {
      // MSG_C2_USER_RECENT.createdAt === NOW
      const result = conversationMetrics([MSG_C2_USER_RECENT], NOW)
      expect(result.last24h).toBe(1)
    })

    it("excludes messages created exactly 24h before now", () => {
      const exactlyBoundary = makeMessage({
        id: "boundary",
        createdAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1000), // exactly 24h ago
      })
      const result = conversationMetrics([exactlyBoundary], NOW)
      expect(result.last24h).toBe(0)
    })

    it("returns 0 when all messages are old", () => {
      const result = conversationMetrics([MSG_C1_USER_OLD, MSG_C2_ASSISTANT_OLD], NOW)
      expect(result.last24h).toBe(0)
    })

    it("returns 0 for empty input", () => {
      const result = conversationMetrics([], NOW)
      expect(result.last24h).toBe(0)
    })
  })
})

describe("resolveAgentName", () => {
  it("returns the mapped name when the id is present in the map", () => {
    const names = { "agent-1": "Support Bot", "agent-2": "Sales Bot" }
    expect(resolveAgentName("agent-1", names)).toBe("Support Bot")
  })

  it("returns the raw id when it is not in the map", () => {
    const names = { "agent-1": "Support Bot" }
    expect(resolveAgentName("agent-2", names)).toBe("agent-2")
  })

  it("returns the '—' sentinel unchanged (no name)", () => {
    const names = { "agent-1": "Support Bot" }
    expect(resolveAgentName("—", names)).toBe("—")
  })
})
