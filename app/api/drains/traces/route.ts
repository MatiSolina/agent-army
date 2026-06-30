import { type NextRequest } from "next/server"
import { inArray } from "drizzle-orm"
import { db } from "@/lib/db"
import { agents, spans } from "@/lib/db/schema"
import { getUserId } from "@/lib/session"
import { verifyDrainSignature } from "@/lib/otel/verify"
import { parseTraceExport } from "@/lib/otel/parse"
import { toAgentSpan } from "@/lib/otel/spans"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Vercel Trace Drain ingest endpoint.
 *
 * POST /api/drains/traces  (configured as a team-level custom-endpoint Trace
 * Drain in Vercel → Team Settings → Drains, format: JSON over OTLP/HTTP).
 *
 * Every deployed agent emits @vercel/otel spans (see lib/eve/generate.ts
 * `emitInstrumentation`); Vercel forwards them here. Auth is the drain's HMAC
 * signature (no operator session) — so /api/drains is exempt from the auth gate
 * in lib/supabase/middleware.ts, mirroring /api/mcp/token.
 *
 * note: JSON format only (protobuf would need a decoder dep); set the drain
 * to JSON. Body is read raw and assumed uncompressed, matching Vercel's own
 * signature-verification example (docs/drains/security).
 */
export async function POST(req: NextRequest) {
  const secret = process.env.VERCEL_DRAIN_SECRET
  if (!secret) {
    // Misconfigured FM — fail loud rather than silently accepting unsigned data.
    return new Response("drain secret not configured", { status: 500 })
  }

  const raw = await req.text()
  if (!verifyDrainSignature(raw, req.headers.get("x-vercel-signature"), secret)) {
    return Response.json(
      { code: "invalid_signature", error: "signature didn't match" },
      { status: 403 },
    )
  }

  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return new Response("invalid json", { status: 400 })
  }

  const agentSpans = parseTraceExport(payload).map(toAgentSpan)
  // Vercel pings the endpoint with an empty/test body on creation — accept it.
  if (agentSpans.length === 0) return Response.json({ ok: true, ingested: 0 })

  const userId = await getUserId()

  // Map each span's Vercel projectId back to a dashboard agent id (one lookup).
  const projectIds = [
    ...new Set(agentSpans.map((s) => s.vercelProjectId).filter((p): p is string => !!p)),
  ]
  const agentRows = projectIds.length
    ? await db
        .select({ id: agents.id, vercelProjectId: agents.vercelProjectId })
        .from(agents)
        .where(inArray(agents.vercelProjectId, projectIds))
    : []
  const agentByProject = new Map(
    agentRows.map((a) => [a.vercelProjectId, a.id]),
  )

  // Drop spans that don't belong to a known deployed agent project: the drain is
  // team-wide, so unrelated Vercel projects also POST here. Only ingest spans we
  // can attribute to one of our agents.
  const rows = agentSpans
    .filter((s) => s.vercelProjectId && agentByProject.has(s.vercelProjectId))
    .map((s) => ({
    spanId: s.spanId,
    traceId: s.traceId,
    userId,
    agentId: agentByProject.get(s.vercelProjectId!) ?? null,
    vercelProjectId: s.vercelProjectId,
    serviceName: s.serviceName,
    name: s.name,
    model: s.model,
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    durationMs: s.durationMs,
    startTime: s.startTime,
  }))

  // Everything filtered out (only unrelated projects in this batch) → nothing to
  // write, and insert([]) would throw.
  if (rows.length === 0) return Response.json({ ok: true, ingested: 0 })

  // At-least-once delivery → dedupe on the (traceId, spanId) pair. spanId is only
  // unique WITHIN a trace per OTel, so deduping on spanId alone could drop a
  // distinct span that happens to share an id across traces.
  await db
    .insert(spans)
    .values(rows)
    .onConflictDoNothing({ target: [spans.traceId, spans.spanId] })

  return Response.json({ ok: true, ingested: rows.length })
}
