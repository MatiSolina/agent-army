"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Bot, Download, Loader2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  discoverDeployedAgents,
  importAgent,
  type DiscoverableProject,
} from "@/app/actions/import"

/**
 * Import a deployed Eve agent from the user's Vercel account. On open it scans
 * the team's projects (framework "eve") and lists them; picking one reads its
 * production deployment's source, reverse-parses it, and registers an agents row.
 * Mirrors AgentFormDialog's Dialog skeleton + create() try/catch shape.
 */
export function ImportAgentDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  // null = scanning (not yet loaded for the current open session).
  const [projects, setProjects] = useState<DiscoverableProject[] | null>(null)
  const [importingSlug, setImportingSlug] = useState<string | null>(null)

  // Reset to the scanning state each time the dialog opens. This is the
  // React-blessed "adjust state during render on prop change" pattern (not an
  // effect), so the spinner shows immediately on open and a re-open re-scans.
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) {
      setProjects(null)
      setImportingSlug(null)
    }
  }

  // Scan whenever the dialog is open. Guarded by `cancelled` so a close mid-scan
  // never writes stale state. setState happens only inside async callbacks.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    discoverDeployedAgents()
      .then((res) => {
        if (!cancelled) setProjects(res.projects)
      })
      .catch(() => {
        if (!cancelled) {
          toast.error("Could not list your Vercel projects")
          setProjects([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const scanning = projects === null

  const runImport = async (project: DiscoverableProject) => {
    if (!project.hasProduction) {
      toast.error("This project has no production deployment to import")
      return
    }
    setImportingSlug(project.slug)
    try {
      const { slug, warnings } = await importAgent(project.slug)
      toast.success(
        warnings.length
          ? `Imported with ${warnings.length} note${warnings.length === 1 ? "" : "s"} — re-add secrets before redeploying`
          : "Agent imported",
      )
      onOpenChange(false)
      router.push(`/agents/${slug}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not import the agent")
    } finally {
      setImportingSlug(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import a deployed agent</DialogTitle>
          <DialogDescription>
            Pull an Eve agent already deployed on your Vercel account into the
            fleet. Its config is recovered from the deployment; secrets (tokens,
            channel credentials) must be re-entered before you redeploy.
          </DialogDescription>
        </DialogHeader>

        {scanning ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Scanning your Vercel projects…
          </div>
        ) : (projects?.length ?? 0) === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            No Eve agent projects found in your Vercel account.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {(projects ?? []).map((p) => {
              const busy = importingSlug === p.slug
              const disabled = !p.hasProduction || importingSlug !== null
              return (
                <button
                  key={p.slug}
                  type="button"
                  disabled={disabled}
                  onClick={() => runImport(p)}
                  className="flex items-center gap-3 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-foreground/30 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {busy ? (
                    <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
                  ) : (
                    <Bot className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="flex flex-1 flex-col gap-0.5">
                    <span className="text-sm font-medium">{p.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {!p.hasProduction
                        ? "No production deployment"
                        : p.alreadyImported
                          ? "Already imported — re-import to refresh"
                          : "Click to import"}
                    </span>
                  </span>
                  <Download className="size-4 shrink-0 text-muted-foreground" />
                </button>
              )
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
