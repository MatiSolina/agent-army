"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"
import {
  getAgentDeployments,
  promoteAgentDeployment,
} from "@/app/actions/deploy"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Rocket, Loader2, History } from "lucide-react"

export type Deployment = Awaited<ReturnType<typeof getAgentDeployments>>[number]

/**
 * Deployments tab: lists the agent's recent Vercel deployments and lets a
 * non-technical user promote any built one to production. Rollback == promoting
 * an older deployment (Vercel's native promote primitive, no custom logic).
 *
 * Controlled by AgentEditor: the list (and its loading state) is fetched up in
 * the editor the moment the agent is selected, so the data is ready before this
 * tab is ever opened. `deployments === null` means still loading the first time.
 * State strings are raw Vercel values (READY|ERROR|BUILDING|QUEUED|…); only
 * READY rows can be promoted.
 */
export function AgentDeployments({
  agentId,
  deployments,
  loading,
  onReload,
}: {
  agentId: string
  deployments: Deployment[] | null
  loading: boolean
  onReload: () => void
}) {
  const [promoting, startPromoting] = useTransition()
  // Track which row is mid-promotion so only that button shows a spinner.
  const [promotingId, setPromotingId] = useState<string | null>(null)

  const promote = (deployment: Deployment) => {
    setPromotingId(deployment.id)
    startPromoting(async () => {
      try {
        await promoteAgentDeployment(agentId, deployment.id)
        toast.success("Promoted to production")
        // Re-load so the Production badge moves to the freshly-promoted row.
        onReload()
      } catch {
        toast.error("Promotion failed")
      } finally {
        setPromotingId(null)
      }
    })
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-sm font-medium text-foreground">Deployments</h3>
        <p className="text-xs text-muted-foreground">
          Every deploy is a preview you can test first. Promote one to publish it
          to production, or promote an older one to roll back.
        </p>
      </div>

      {deployments === null ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-border py-12 text-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          <p className="text-xs text-muted-foreground">Loading deployments…</p>
        </div>
      ) : deployments.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-12 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-secondary">
            <History className="h-5 w-5 text-muted-foreground" />
          </div>
          <p className="max-w-sm text-xs text-muted-foreground">
            No deployments yet. Click Deploy to build a preview you can test
            before publishing.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          <ul className="divide-y divide-border">
            {deployments.map((d) => {
              const isReady = d.state === "READY"
              const isError = d.state === "ERROR"
              const rowPromoting = promotingId === d.id
              return (
                <li
                  key={d.id}
                  className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center"
                >
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      isReady
                        ? "bg-success"
                        : isError
                          ? "bg-destructive"
                          : "bg-muted-foreground"
                    }`}
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {formatDate(d.createdAt)}
                    </p>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {d.state.toLowerCase()} · {d.url}
                    </p>
                  </div>
                  {d.isProduction ? (
                    <Badge variant="secondary" className="shrink-0">
                      Production
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="shrink-0">
                      Preview
                    </Badge>
                  )}
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => promote(d)}
                    disabled={
                      d.isProduction ||
                      !isReady ||
                      promoting ||
                      loading
                    }
                    className="shrink-0 gap-1.5"
                    title={
                      d.isProduction
                        ? "Already live on production"
                        : isReady
                          ? "Promote this deployment to production"
                          : "Only successful deployments can be promoted"
                    }
                  >
                    {rowPromoting ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Rocket className="h-3.5 w-3.5" />
                    )}
                    {d.isProduction ? "Live" : "Promote to production"}
                  </Button>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}

/** Short, human-readable timestamp from epoch ms (0 / missing → fallback). */
function formatDate(ms: number): string {
  if (!ms) return "Unknown date"
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}
