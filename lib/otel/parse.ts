// Parses an OTLP/HTTP-JSON trace export (the payload Vercel POSTs to a custom
// Trace Drain) into a flat list of spans. This layer understands ONLY the OTLP
// wire format (a stable, specified shape), not the AI-SDK semantics on top of
// it. Deriving agent/token/model metrics from these flat spans lives in
// `./spans.ts`, so the volatile vendor conventions stay in one place.

export type FlatSpan = {
  traceId: string
  spanId: string
  name: string
  /** OTLP SpanKind enum (0..5). */
  kind: number
  startTimeUnixNano: string
  endTimeUnixNano: string
  /** Span attributes, flattened from OTLP key/anyValue pairs. */
  attributes: Record<string, unknown>
  /** Resource attributes (e.g. service.name, vercel.projectId), flattened. */
  resource: Record<string, unknown>
}

// OTLP serializes a value as a one-key object: { stringValue }, { intValue },
// etc. int64 comes across as a string (JSON has no 64-bit int), so coerce to
// number, the values we care about (token counts) are well within 2^53.
function anyValue(v: unknown): unknown {
  if (v == null || typeof v !== "object") return undefined
  const o = v as Record<string, unknown>
  if ("stringValue" in o) return o.stringValue
  if ("boolValue" in o) return o.boolValue
  if ("intValue" in o) return Number(o.intValue)
  if ("doubleValue" in o) return o.doubleValue
  // arrayValue / kvlistValue are not consumed yet; add when a metric needs them.
  return undefined
}

type OtlpAttr = { key?: unknown; value?: unknown }

function flattenAttrs(attrs: unknown): Record<string, unknown> {
  if (!Array.isArray(attrs)) return {}
  const out: Record<string, unknown> = {}
  for (const a of attrs as OtlpAttr[]) {
    if (typeof a?.key === "string") out[a.key] = anyValue(a.value)
  }
  return out
}

export function parseTraceExport(payload: unknown): FlatSpan[] {
  const root = payload as { resourceSpans?: unknown }
  const resourceSpans = Array.isArray(root?.resourceSpans)
    ? root.resourceSpans
    : []

  const spans: FlatSpan[] = []
  for (const rs of resourceSpans) {
    const resource = flattenAttrs(
      (rs as { resource?: { attributes?: unknown } })?.resource?.attributes,
    )
    const scopeSpans = Array.isArray((rs as { scopeSpans?: unknown })?.scopeSpans)
      ? (rs as { scopeSpans: unknown[] }).scopeSpans
      : []
    for (const ss of scopeSpans) {
      const inner = Array.isArray((ss as { spans?: unknown })?.spans)
        ? (ss as { spans: unknown[] }).spans
        : []
      for (const sp of inner) {
        const s = sp as Record<string, unknown>
        spans.push({
          traceId: String(s.traceId ?? ""),
          spanId: String(s.spanId ?? ""),
          name: String(s.name ?? ""),
          kind: Number(s.kind ?? 0),
          startTimeUnixNano: String(s.startTimeUnixNano ?? "0"),
          endTimeUnixNano: String(s.endTimeUnixNano ?? "0"),
          attributes: flattenAttrs(s.attributes),
          resource,
        })
      }
    }
  }
  return spans
}
