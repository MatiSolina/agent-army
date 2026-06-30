import { describe, it, expect } from "vitest"
import { parseTraceExport } from "./parse"

// A minimal OTLP/HTTP-JSON trace export, shaped exactly like the payload Vercel
// POSTs to a custom Trace Drain endpoint (docs: /docs/drains/reference/traces).
const SAMPLE = {
  resourceSpans: [
    {
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "customer-support" } },
          {
            key: "vercel.projectId",
            value: { stringValue: "prj_abc123" },
          },
        ],
      },
      scopeSpans: [
        {
          scope: { name: "vercel" },
          spans: [
            {
              traceId: "7bba9f33312b3dbb8b2c2c62bb7abe2d",
              spanId: "086e83747d0e381e",
              name: "GET /api/users",
              kind: 2,
              startTimeUnixNano: "1694723400000000000",
              endTimeUnixNano: "1694723400150000000",
            },
          ],
        },
      ],
    },
  ],
}

// Two resourceSpans, the second carrying an AI-SDK-style span with typed
// attributes (int64-as-string token counts, a string model id, a bool flag).
const MULTI = {
  resourceSpans: [
    {
      resource: { attributes: [{ key: "service.name", value: { stringValue: "a" } }] },
      scopeSpans: [
        { scope: { name: "ai" }, spans: [{ traceId: "t1", spanId: "s1", name: "first" }] },
      ],
    },
    {
      resource: { attributes: [{ key: "service.name", value: { stringValue: "b" } }] },
      scopeSpans: [
        {
          scope: { name: "ai" },
          spans: [
            {
              traceId: "t2",
              spanId: "s2",
              name: "ai.generateText",
              attributes: [
                { key: "gen_ai.usage.input_tokens", value: { intValue: "1234" } },
                { key: "gen_ai.response.model", value: { stringValue: "openai/gpt-4o-mini" } },
                { key: "ai.stream", value: { boolValue: true } },
              ],
            },
          ],
        },
      ],
    },
  ],
}

describe("parseTraceExport", () => {
  it("flattens spans across multiple resourceSpans and coerces typed attributes", () => {
    const spans = parseTraceExport(MULTI)
    expect(spans.map((s) => s.spanId)).toEqual(["s1", "s2"])

    const ai = spans[1]
    expect(ai.resource["service.name"]).toBe("b")
    // int64 arrives as a string in OTLP/JSON → coerced to a real number.
    expect(ai.attributes["gen_ai.usage.input_tokens"]).toBe(1234)
    expect(ai.attributes["gen_ai.response.model"]).toBe("openai/gpt-4o-mini")
    expect(ai.attributes["ai.stream"]).toBe(true)
  })

  it("returns [] for a malformed or empty payload", () => {
    expect(parseTraceExport(null)).toEqual([])
    expect(parseTraceExport({})).toEqual([])
    expect(parseTraceExport({ resourceSpans: "nope" })).toEqual([])
  })

  it("flattens resourceSpans into one span per OTLP span, carrying resource attributes", () => {
    const spans = parseTraceExport(SAMPLE)

    expect(spans).toHaveLength(1)
    const s = spans[0]
    expect(s.traceId).toBe("7bba9f33312b3dbb8b2c2c62bb7abe2d")
    expect(s.spanId).toBe("086e83747d0e381e")
    expect(s.name).toBe("GET /api/users")
    expect(s.startTimeUnixNano).toBe("1694723400000000000")
    expect(s.endTimeUnixNano).toBe("1694723400150000000")
    // Resource attributes are flattened to a plain object on each span.
    expect(s.resource["service.name"]).toBe("customer-support")
    expect(s.resource["vercel.projectId"]).toBe("prj_abc123")
  })
})
