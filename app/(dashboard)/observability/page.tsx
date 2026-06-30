import { db } from "@/lib/db"
import { spans, agents } from "@/lib/db/schema"
import { requireUserId } from "@/lib/session"
import { spanMetrics } from "@/lib/otel/spans"
import { resolveAgentName } from "@/lib/metrics"
import { ensureTraceDrain } from "@/lib/vercel/drains"
import { getVercelTeamSlug } from "@/lib/vercel/team-slug"
import { buildVercelDashboardUrls } from "@/lib/vercel/dashboard-url"
import { projectName } from "@/lib/eve/project"
import { PageHeader } from "@/components/dashboard/page-header"
import { desc, eq } from "drizzle-orm"
import type { Span, Agent } from "@/lib/db/schema"
import { Activity, ArrowUpRight } from "lucide-react"
import Link from "next/link"

// No force-dynamic: requireUserId() reads the session cookie, so the page is
// dynamic anyway. Dropping the flag lets the client router cache serve instant
// back-to-back nav instead of refetching every time.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(date: Date): string {
  return date.toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" })
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

// ---------------------------------------------------------------------------
// Sub-components (server RSC)
// ---------------------------------------------------------------------------

function MetricCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-2 font-mono text-3xl font-semibold tracking-tight text-foreground">
        {value}
      </p>
    </div>
  )
}

function BreakdownCard({
  label,
  entries,
  labelFor,
  hrefFor,
}: {
  label: string
  entries: Array<[string, number]>
  labelFor?: (key: string) => string
  hrefFor?: (key: string) => string | null
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">—</p>
      ) : (
        <ul className="space-y-1.5">
          {entries.map(([key, count]) => {
            const display = labelFor ? labelFor(key) : key
            const href = hrefFor ? hrefFor(key) : null
            return (
              <li key={key} className="flex items-center justify-between">
                {href ? (
                  <Link
                    href={href}
                    className="truncate text-sm text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {display}
                  </Link>
                ) : (
                  <span className="truncate text-sm text-foreground">{display}</span>
                )}
                <span className="ml-4 shrink-0 font-mono text-sm text-muted-foreground">
                  {count}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function SpanRow({ span, names }: { span: Span; names: Record<string, string> }) {
  const agentLabel = span.agentId
    ? resolveAgentName(span.agentId, names)
    : span.serviceName ?? "—"
  const tokens =
    span.inputTokens != null || span.outputTokens != null
      ? `${formatTokens(span.inputTokens ?? 0)} / ${formatTokens(span.outputTokens ?? 0)}`
      : "—"

  return (
    <li className="grid grid-cols-12 items-center gap-3 px-4 py-2.5 text-sm">
      <span className="col-span-3 truncate font-mono text-xs text-foreground" title={span.name}>
        {span.name}
      </span>
      <span className="col-span-3 truncate text-muted-foreground">
        {span.agentId ? (
          <Link
            href={`/agents/${span.agentId}`}
            className="transition-colors hover:text-foreground"
          >
            {agentLabel}
          </Link>
        ) : (
          agentLabel
        )}
      </span>
      <span className="col-span-2 truncate font-mono text-xs text-muted-foreground" title={span.model ?? ""}>
        {span.model ?? "—"}
      </span>
      <span className="col-span-1 text-right font-mono text-xs text-muted-foreground">
        {tokens}
      </span>
      <span className="col-span-1 text-right font-mono text-xs text-muted-foreground">
        {formatDuration(span.durationMs)}
      </span>
      <span className="col-span-2 text-right text-xs text-muted-foreground">
        {formatDate(span.startTime)}
      </span>
    </li>
  )
}

function CtaButton({
  href,
  children,
  primary,
}: {
  href: string
  children: React.ReactNode
  primary?: boolean
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-1.5 rounded-md px-3.5 py-2 text-sm font-medium transition-colors ${
        primary
          ? "bg-foreground text-background hover:bg-foreground/90"
          : "border border-border text-foreground hover:bg-secondary/60"
      }`}
    >
      {children}
      <ArrowUpRight className="size-3.5" aria-hidden="true" />
    </a>
  )
}

// Shown when no spans have arrived because the drain isn't wired up (plan-gated
// or unconfigured). The agents already emit OTel, so we always offer the free
// "view it in Vercel" path alongside the upgrade that streams it in here.
function ConnectCta({
  vercelObservabilityUrl,
  billingUrl,
}: {
  vercelObservabilityUrl: string | null
  billingUrl: string
}) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <Activity className="mb-4 size-10 text-muted-foreground/40" aria-hidden="true" />
      <p className="text-base font-medium text-foreground">
        Your agents are already being traced
      </p>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">
        Every deployed agent emits OpenTelemetry — tokens, latency, model and
        tool calls. See it now in Vercel, or stream it into this dashboard with a
        Trace Drain (Vercel Pro).
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        {vercelObservabilityUrl && (
          <CtaButton href={vercelObservabilityUrl}>View in Vercel</CtaButton>
        )}
        <CtaButton href={billingUrl} primary>
          Stream it here — upgrade
        </CtaButton>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function ObservabilityPage() {
  const userId = await requireUserId()

  // Endpoint the drain delivers to (this app's own production URL).
  const prodHost = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? "agent-army-eve.vercel.app"
  const drainEndpoint = `https://${prodHost}/api/drains/traces`

  const [rows, agentRows, drain] = await Promise.all([
    db
      .select()
      .from(spans)
      .where(eq(spans.userId, userId))
      .orderBy(desc(spans.startTime))
      .limit(500),
    db
      .select({
        id: agents.id,
        name: agents.name,
        vercelProjectId: agents.vercelProjectId,
        deploymentUrl: agents.deploymentUrl,
      })
      .from(agents)
      .where(eq(agents.userId, userId)),
    // Self-healing: idempotent, and reports plan_blocked on Pro Trial. note:
    // runs on every load of this admin page — cheap (1 GET); cache in
    // app_settings only if it ever shows up as slow. Never let it break the page.
    ensureTraceDrain({
      token: process.env.VERCEL_TOKEN,
      teamId: process.env.VERCEL_TEAM_ID,
      secret: process.env.VERCEL_DRAIN_SECRET,
      endpoint: drainEndpoint,
    }).catch(() => ({ status: "error" as const, message: "ensure failed" })),
  ])

  // Deep-links for the CTA: free "view in Vercel" (any plan) + upgrade.
  const teamSlug = getVercelTeamSlug()
  const deployedAgent = agentRows.find((a) => !!a.deploymentUrl)
  const vercelObservabilityUrl =
    teamSlug && deployedAgent
      ? buildVercelDashboardUrls({
          teamSlug,
          projectName: projectName({ id: deployedAgent.id, name: deployedAgent.name } as Agent),
        }).observability
      : null
  const billingUrl = teamSlug
    ? `https://vercel.com/${encodeURIComponent(teamSlug)}/~/settings/billing`
    : "https://vercel.com/account/billing"
  const drainBlocked = drain.status === "plan_blocked" || drain.status === "unconfigured"

  const names = Object.fromEntries(agentRows.map((a) => [a.id, a.name]))
  // Resolve spanMetrics.byProject keys (vercelProjectId | serviceName) to names.
  const nameByProject = Object.fromEntries(
    agentRows.filter((a) => a.vercelProjectId).map((a) => [a.vercelProjectId!, a.name]),
  )

  // spanMetrics works on derived AgentSpans; reuse it by mapping db rows back.
  const agentSpans = rows.map((r) => ({
    spanId: r.spanId,
    traceId: r.traceId,
    name: r.name,
    serviceName: r.serviceName,
    vercelProjectId: r.vercelProjectId,
    startTime: r.startTime,
    durationMs: r.durationMs,
    model: r.model,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
  }))
  const metrics = spanMetrics(agentSpans, new Date())

  return (
    <div className="mx-auto max-w-5xl px-4 pb-16 pt-8 sm:px-6">
      <PageHeader
        title="Observability"
        description="OpenTelemetry traces streamed from your deployed agents via Vercel Trace Drains."
      />

      {rows.length === 0 ? (
        !deployedAgent ? (
          // Nothing deployed yet — don't talk about plans, there's nothing to trace.
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <Activity className="mb-4 size-10 text-muted-foreground/40" aria-hidden="true" />
            <p className="text-base font-medium text-foreground">No deployed agents yet</p>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              Deploy an agent and its OpenTelemetry traces — tokens, latency,
              model and tool calls — will appear here.
            </p>
            <Link
              href="/agents"
              className="mt-6 inline-flex items-center gap-1.5 rounded-md bg-foreground px-3.5 py-2 text-sm font-medium text-background transition-colors hover:bg-foreground/90"
            >
              Go to Agents
            </Link>
          </div>
        ) : drainBlocked ? (
          <ConnectCta
            vercelObservabilityUrl={vercelObservabilityUrl}
            billingUrl={billingUrl}
          />
        ) : (
          // Drain is active (or its status is unknown) — just waiting for traffic.
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <Activity className="mb-4 size-10 text-muted-foreground/40" aria-hidden="true" />
            <p className="text-base font-medium text-foreground">No traces yet</p>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              Waiting for traffic — spans from your deployed agents will appear
              here as they handle requests.
            </p>
          </div>
        )
      ) : (
        <>
          {/* ── Metric cards ─────────────────────────────────────────── */}
          <section aria-label="Metrics" className="mb-8">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <MetricCard label="Spans" value={metrics.totalSpans} />
              <MetricCard label="Traces" value={metrics.traces} />
              <MetricCard label="Last 24 h" value={metrics.last24h} />
              <MetricCard label="Tokens in" value={formatTokens(metrics.totalInputTokens)} />
              <MetricCard label="Tokens out" value={formatTokens(metrics.totalOutputTokens)} />
            </div>
          </section>

          {/* ── Breakdown by agent ────────────────────────────────────── */}
          <section aria-label="Breakdown" className="mb-10">
            <div className="grid grid-cols-1 gap-3">
              <BreakdownCard
                label="Spans by agent"
                entries={Object.entries(metrics.byProject).sort(([, a], [, b]) => b - a)}
                labelFor={(key) => nameByProject[key] ?? key}
              />
            </div>
          </section>

          {/* ── Recent spans ──────────────────────────────────────────── */}
          <section aria-label="Recent spans">
            <h2 className="mb-4 text-sm font-medium uppercase tracking-wide text-muted-foreground">
              Recent spans
            </h2>
            <div className="rounded-lg border border-border bg-card">
              <div className="grid grid-cols-12 gap-3 border-b border-border px-4 py-2 text-[0.7rem] font-medium uppercase tracking-wide text-muted-foreground">
                <span className="col-span-3">Span</span>
                <span className="col-span-3">Agent</span>
                <span className="col-span-2">Model</span>
                <span className="col-span-1 text-right">Tok i/o</span>
                <span className="col-span-1 text-right">Dur</span>
                <span className="col-span-2 text-right">When</span>
              </div>
              <ul className="divide-y divide-border">
                {rows.map((s) => (
                  <SpanRow key={s.spanId} span={s} names={names} />
                ))}
              </ul>
            </div>
          </section>
        </>
      )}
    </div>
  )
}
