import { describe, it, expect } from "vitest"
import { toAgentSpan, spanMetrics } from "./spans"
import type { FlatSpan } from "./parse"

function flat(overrides: Partial<FlatSpan> = {}): FlatSpan {
  return {
    traceId: "t1",
    spanId: "s1",
    name: "ai.generateText",
    kind: 1,
    startTimeUnixNano: "1694723400000000000",
    endTimeUnixNano: "1694723400150000000", // +150ms
    attributes: {},
    resource: { "service.name": "customer-support", "vercel.projectId": "prj_1" },
    ...overrides,
  }
}

describe("toAgentSpan", () => {
  it("derives service name, vercel project id, start time and duration (ns precise)", () => {
    const s = toAgentSpan(flat())
    expect(s.serviceName).toBe("customer-support")
    expect(s.vercelProjectId).toBe("prj_1")
    expect(s.durationMs).toBe(150)
    expect(s.startTime.getTime()).toBe(1694723400000) // ns → ms epoch
  })

  it("reads token usage and model from gen_ai semconv attributes", () => {
    const s = toAgentSpan(
      flat({
        attributes: {
          "gen_ai.usage.input_tokens": 1200,
          "gen_ai.usage.output_tokens": 340,
          "gen_ai.response.model": "openai/gpt-4o-mini",
        },
      }),
    )
    expect(s.inputTokens).toBe(1200)
    expect(s.outputTokens).toBe(340)
    expect(s.model).toBe("openai/gpt-4o-mini")
  })

  it("falls back to AI SDK attribute names for tokens and model", () => {
    const s = toAgentSpan(
      flat({
        attributes: {
          "ai.usage.promptTokens": 50,
          "ai.usage.completionTokens": 17,
          "ai.model.id": "anthropic/claude-haiku-4-5",
        },
      }),
    )
    expect(s.inputTokens).toBe(50)
    expect(s.outputTokens).toBe(17)
    expect(s.model).toBe("anthropic/claude-haiku-4-5")
  })

  it("leaves token/model null when absent", () => {
    const s = toAgentSpan(flat())
    expect(s.inputTokens).toBeNull()
    expect(s.outputTokens).toBeNull()
    expect(s.model).toBeNull()
  })
})

describe("spanMetrics", () => {
  const base = { now: new Date("2026-06-27T00:00:00Z") }
  const recent = "1782000000000000000" // ~2026, within 24h of `now`-ish; see assertions

  it("aggregates totals, traces, tokens and per-agent counts", () => {
    const spans = [
      toAgentSpan(
        flat({
          traceId: "tA",
          spanId: "1",
          attributes: { "gen_ai.usage.input_tokens": 100, "gen_ai.usage.output_tokens": 20 },
        }),
      ),
      toAgentSpan(
        flat({
          traceId: "tA",
          spanId: "2",
          attributes: { "gen_ai.usage.input_tokens": 10, "gen_ai.usage.output_tokens": 5 },
        }),
      ),
      toAgentSpan(flat({ traceId: "tB", spanId: "3", resource: { "service.name": "sales", "vercel.projectId": "prj_2" } })),
    ]
    const m = spanMetrics(spans, base.now)
    expect(m.totalSpans).toBe(3)
    expect(m.traces).toBe(2) // tA, tB
    expect(m.totalInputTokens).toBe(110)
    expect(m.totalOutputTokens).toBe(25)
    expect(m.byProject["prj_1"]).toBe(2)
    expect(m.byProject["prj_2"]).toBe(1)
  })
})
