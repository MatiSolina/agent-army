import { PageHeader } from "@/components/dashboard/page-header"
import Link from "next/link"
import {
  Database,
  Rocket,
  Server,
  ArrowRight,
  PencilRuler,
  FlaskConical,
  RefreshCw,
  Boxes,
} from "lucide-react"

// Static explainer of the control-plane model: config in Supabase is the source,
// "Deploy" compiles it into a real Eve project on Vercel (the runtime), and each
// deploy is a snapshot. Pure server component — ships zero client JS.

const STEPS = [
  {
    icon: PencilRuler,
    title: "Define your agent",
    body: "Configure runtime instructions, model, skills, MCP connections, subagents, schedules and channels in the dashboard. This config lives in Supabase and is the agent's single source of truth.",
  },
  {
    icon: FlaskConical,
    title: "Test in the playground",
    body: "Preview replies right here in the dashboard. This is preview only — a Test sandbox, not a production runtime. Nothing is live yet.",
  },
  {
    icon: Rocket,
    title: "Deploy",
    body: "One click compiles the config into a real Eve project and ships it to Vercel via the REST API. The deployed Eve app is the production runtime. Each agent gets its own Vercel project.",
  },
  {
    icon: RefreshCw,
    title: "Edit live or re-Deploy",
    body: "Prompt edits apply on the next turn through runtime config. Structural changes still ship as a new immutable deploy snapshot.",
  },
]

const FLOW = [
  {
    icon: Database,
    label: "Supabase config",
    sub: "source · editable",
  },
  {
    icon: Boxes,
    label: "Eve project",
    sub: "compiled · on Vercel",
  },
  {
    icon: Server,
    label: "Production runtime",
    sub: "the live agent",
  },
]

export default function HowItWorksPage() {
  return (
    <div>
      <PageHeader
        title="How it works"
        description="Define agents here, then deploy each one as its own Eve app on Vercel. The dashboard is the control plane; every deployed agent is its own independent runtime."
      />

      {/* ── Flow diagram: Config → Deploy → Runtime ───────────────────── */}
      <section aria-label="Flow" className="mb-12">
        <div className="rounded-xl border border-border bg-card p-6 sm:p-8">
          <div className="flex flex-col items-stretch gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
            {FLOW.map((node, i) => {
              const Icon = node.icon
              return (
                <div key={node.label} className="contents">
                  <div className="flex w-full flex-col items-center gap-2 text-center sm:w-auto sm:flex-1">
                    <span className="grid size-12 place-items-center rounded-lg border border-border bg-secondary text-foreground">
                      <Icon className="size-5" aria-hidden="true" />
                    </span>
                    <span className="font-mono text-sm font-medium text-foreground">
                      {node.label}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {node.sub}
                    </span>
                  </div>
                  {i < FLOW.length - 1 && (
                    <div className="flex flex-col items-center justify-center gap-1 sm:px-2">
                      <ArrowRight
                        className="size-5 rotate-90 text-muted-foreground/60 sm:rotate-0"
                        aria-hidden="true"
                      />
                      <span className="text-[0.7rem] uppercase tracking-wide text-muted-foreground/70">
                        {i === 0 ? "Deploy" : "serves"}
                      </span>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          <p className="mt-6 border-t border-border pt-4 text-center text-xs text-muted-foreground">
            Editing runtime instructions updates the live prompt. Hitting{" "}
            <span className="font-medium text-foreground">Deploy</span> again
            ships a new snapshot for structural changes.
          </p>
        </div>
      </section>

      {/* ── Steps ─────────────────────────────────────────────────────── */}
      <section aria-label="Steps">
        <ol className="grid gap-4 sm:grid-cols-2">
          {STEPS.map((step, i) => {
            const Icon = step.icon
            return (
              <li
                key={step.title}
                className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
              >
                <div className="flex items-center gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-md border border-border bg-secondary text-foreground">
                    <Icon className="size-[18px]" aria-hidden="true" />
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">
                    Step {i + 1}
                  </span>
                </div>
                <h2 className="text-base font-medium text-foreground">
                  {step.title}
                </h2>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {step.body}
                </p>
              </li>
            )
          })}
        </ol>
      </section>

      {/* ── CTA ───────────────────────────────────────────────────────── */}
      <div className="mt-10 flex flex-col items-start gap-2 rounded-xl border border-border bg-card p-5 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          Ready to build one? Head to your agents.
        </p>
        <Link
          href="/agents"
          prefetch
          className="inline-flex items-center gap-2 rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90"
        >
          Go to Agents
          <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
      </div>
    </div>
  )
}
