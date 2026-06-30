import type { FlatSpan } from "./parse"

// Derives agent-facing metrics from OTLP flat spans. This is the one place that
// knows the AI SDK / gen_ai attribute conventions — kept apart from the OTLP
// parser so volatile vendor names don't leak into wire-format handling.

export type AgentSpan = {
  spanId: string
  traceId: string
  name: string
  serviceName: string | null
  vercelProjectId: string | null
  startTime: Date
  durationMs: number
  model: string | null
  inputTokens: number | null
  outputTokens: number | null
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

// First non-null value across candidate attribute keys (token/model names vary
// between the gen_ai semconv and the AI SDK's own `ai.*` attributes).
function pick<T>(
  attrs: Record<string, unknown>,
  keys: string[],
  coerce: (v: unknown) => T | null,
): T | null {
  for (const k of keys) {
    const got = coerce(attrs[k])
    if (got !== null) return got
  }
  return null
}

// Unix nanos exceed 2^53, so do the arithmetic in BigInt and only narrow the
// (small) millisecond results to Number.
function nanosToMs(ns: string): number {
  return Number(BigInt(ns) / BigInt(1_000_000))
}

export function toAgentSpan(s: FlatSpan): AgentSpan {
  const a = s.attributes
  return {
    spanId: s.spanId,
    traceId: s.traceId,
    name: s.name,
    serviceName: str(s.resource["service.name"]),
    vercelProjectId: str(s.resource["vercel.projectId"]),
    startTime: new Date(nanosToMs(s.startTimeUnixNano)),
    durationMs: nanosToMs(s.endTimeUnixNano) - nanosToMs(s.startTimeUnixNano),
    model: pick(a, ["gen_ai.response.model", "gen_ai.request.model", "ai.model.id"], str),
    inputTokens: pick(a, ["gen_ai.usage.input_tokens", "ai.usage.promptTokens", "ai.usage.inputTokens"], num),
    outputTokens: pick(a, ["gen_ai.usage.output_tokens", "ai.usage.completionTokens", "ai.usage.outputTokens"], num),
  }
}

export type SpanMetrics = {
  totalSpans: number
  traces: number
  totalInputTokens: number
  totalOutputTokens: number
  last24h: number
  byProject: Record<string, number>
}

export function spanMetrics(spans: AgentSpan[], now: Date): SpanMetrics {
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const traceIds = new Set<string>()
  const byProject: Record<string, number> = {}
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let last24h = 0

  for (const s of spans) {
    traceIds.add(s.traceId)
    const key = s.vercelProjectId ?? s.serviceName ?? "—"
    byProject[key] = (byProject[key] ?? 0) + 1
    totalInputTokens += s.inputTokens ?? 0
    totalOutputTokens += s.outputTokens ?? 0
    if (s.startTime > cutoff) last24h++
  }

  return {
    totalSpans: spans.length,
    traces: traceIds.size,
    totalInputTokens,
    totalOutputTokens,
    last24h,
    byProject,
  }
}
