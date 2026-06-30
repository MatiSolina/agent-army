"use client"

import { useState, useEffect, useRef } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { PageHeader } from "@/components/dashboard/page-header"
import { AgentFormDialog } from "@/components/dashboard/agent-form-dialog"
import { ImportAgentDialog } from "@/components/dashboard/import-agent-dialog"
import { Button } from "@/components/ui/button"
import { DeleteAgentDialog } from "@/components/ui/delete-agent-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { getModelLabel } from "@/lib/models"
import { hasConfigDrift } from "@/lib/eve/config-drift"
import { deleteAgent } from "@/app/actions/agents"
import {
  startFleetCanary,
  startFleetRollout,
  getFleetUpdate,
} from "@/app/actions/fleet"
import type { Agent } from "@/lib/db/schema"
import { agentSlug } from "@/lib/slug"
import type { EveTarget } from "@/lib/eve/eve-version"
import {
  Bot,
  Plus,
  MoreHorizontal,
  Pencil,
  Trash2,
  AlertTriangle,
  ArrowUpCircle,
  Download,
} from "lucide-react"

export function AgentsView({
  initialAgents,
  eve,
  behindIds,
}: {
  initialAgents: Agent[]
  eve: EveTarget
  behindIds: string[]
}) {
  const router = useRouter()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [toDelete, setToDelete] = useState<Agent | null>(null)
  const [deleting, setDeleting] = useState(false)

  const openCreate = () => setDialogOpen(true)

  const confirmDelete = async () => {
    if (!toDelete) return
    setDeleting(true)
    try {
      await deleteAgent(toDelete.id)
      toast.success("Agent deleted")
      setToDelete(null)
      router.refresh()
    } catch {
      toast.error("Could not delete the agent")
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <PageHeader
        title="Agents"
        description="Create and configure the AI agents that will respond in your channels. Each agent defines its own model, instructions, and temperature."
        action={
          <div className="flex items-center gap-2">
            <Button onClick={() => setImportOpen(true)} variant="outline" className="gap-2">
              <Download className="h-4 w-4" aria-hidden="true" />
              Import
            </Button>
            <Button onClick={openCreate} className="gap-2">
              <Plus className="h-4 w-4" aria-hidden="true" />
              New agent
            </Button>
          </div>
        }
      />

      <FleetUpdateBanner eve={eve} behindIds={behindIds} agents={initialAgents} />

      {initialAgents.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border py-20 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg border border-border bg-secondary">
            <Bot className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
          </div>
          <div className="space-y-1">
            <p className="text-base font-medium text-foreground">
              No agents yet
            </p>
            <p className="text-sm text-muted-foreground">
              Create your first agent to start responding to messages.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={openCreate} variant="secondary" className="gap-2">
              <Plus className="h-4 w-4" aria-hidden="true" />
              Create agent
            </Button>
            <Button onClick={() => setImportOpen(true)} variant="outline" className="gap-2">
              <Download className="h-4 w-4" aria-hidden="true" />
              Import deployed
            </Button>
          </div>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          <ul className="divide-y divide-border">
            {initialAgents.map((agent) => (
              <li
                key={agent.id}
                className="group flex items-center gap-4 px-4 py-3.5 transition-colors duration-150 hover:bg-secondary/40"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-secondary">
                  <Bot className="h-4 w-4 text-foreground" aria-hidden="true" />
                </div>

                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <Link
                    href={`/agents/${agentSlug(agent.name)}`}
                    className="truncate text-left text-sm font-medium text-foreground hover:underline"
                  >
                    {agent.name}
                  </Link>
                  <p className="truncate text-xs text-muted-foreground">
                    {agent.description || "No description"}
                  </p>
                </div>

                <div className="hidden items-center gap-2 sm:flex">
                  {/* Imported agents are update-only — they can't be redeployed
                      from the dashboard, so a config-drift "needs redeploy" badge
                      is meaningless for them. */}
                  {!agent.imported && hasConfigDrift(agent) && (
                    <span
                      className="flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-500"
                      title="Build config edited since last deploy — re-Deploy to apply"
                    >
                      <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                      Needs redeploy
                    </span>
                  )}
                  <span className="rounded-md border border-border px-2 py-1 font-mono text-xs text-muted-foreground">
                    {getModelLabel(agent.model)}
                  </span>
                </div>

                <div className="hidden w-20 shrink-0 justify-end md:flex">
                  {agent.deploymentUrl ? (
                    <span
                      className="flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-xs font-medium text-emerald-500"
                      title="Online — this agent has a live production deployment serving its channels"
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
                      Online
                    </span>
                  ) : (
                    <span
                      className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground"
                      title="Offline — no live production deployment yet. Deploy this build to production to bring it online."
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" aria-hidden="true" />
                      Offline
                    </span>
                  )}
                </div>

                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0 text-muted-foreground transition-opacity data-[state=open]:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                        aria-label="Agent options"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    }
                  />
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={() => router.push(`/agents/${agentSlug(agent.name)}`)}
                    >
                      <Pencil className="mr-2 h-4 w-4" />
                      Configure
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => setToDelete(agent)}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
          </ul>
        </div>
      )}

      <AgentFormDialog open={dialogOpen} onOpenChange={setDialogOpen} />
      <ImportAgentDialog open={importOpen} onOpenChange={setImportOpen} />

      <DeleteAgentDialog
        open={Boolean(toDelete)}
        onOpenChange={(o) => !o && setToDelete(null)}
        agentName={toDelete?.name ?? ""}
        onConfirm={confirmDelete}
        loading={deleting}
        imported={toDelete?.imported ?? false}
      />
    </>
  )
}

/**
 * Version-drift banner: detects a newer eve patch and offers a canary-first
 * fleet update. Gated (minor/major) bumps show a notice with no button.
 * After a canary completes, shows the result + a Continue-rollout button.
 *
 * Leak notice: a version update also applies any pending edits to assigned
 * connections (their content isn't snapshotted) — surfaced in the default card.
 */
function FleetUpdateBanner({
  eve,
  behindIds,
  agents,
}: {
  eve: EveTarget
  behindIds: string[]
  agents: Agent[]
}) {
  const router = useRouter()
  const [canaryPick, setCanaryPick] = useState(behindIds[0] ?? "")
  const [runRecordId, setRunRecordId] = useState<string | null>(null)
  const [canaryResult, setCanaryResult] = useState<{
    status: string
    updated: string[]
    skipped: string[]
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const driftedAgents = agents.filter((a) => behindIds.includes(a.id))
  // Deployed agents not yet on the LATEST eve. For a gated (breaking) bump these
  // are updated per-agent from each editor (safety-tested), so the notice below
  // is only relevant while some agent is still behind the latest. Once every
  // agent is on the latest, there is nothing for the operator to do — the only
  // thing still "behind" is the dev's EVE_VERSION pin, which isn't their concern.
  const agentsBehindLatest = agents.filter(
    (a) =>
      !a.imported && // imported agents aren't redeployable from here
      !!a.deploymentUrl &&
      !!a.eveVersion &&
      a.eveVersion !== eve.latest,
  )
  // No agents, or nothing actually behind = no notice.
  const nothingToShow =
    agents.length === 0 ||
    (eve.gated ? agentsBehindLatest.length === 0 : behindIds.length === 0)
  const canaryDone = canaryResult?.status === "done"

  // Poll the canary run until done.
  useEffect(() => {
    if (!runRecordId || canaryDone) return
    pollRef.current = setInterval(async () => {
      const row = await getFleetUpdate(runRecordId)
      if (!row) return
      if (row.status === "done" || row.status === "failed") {
        setCanaryResult({
          status: row.status,
          updated: row.result?.updated ?? [],
          skipped: row.result?.skipped ?? [],
        })
        if (pollRef.current) clearInterval(pollRef.current)
      }
    }, 4000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [runRecordId, canaryDone])

  const runCanary = async () => {
    if (!canaryPick) return
    setBusy(true)
    try {
      const { runRecordId } = await startFleetCanary(canaryPick)
      setRunRecordId(runRecordId)
      toast.success("Update started")
    } catch {
      toast.error("Could not start the update")
    } finally {
      setBusy(false)
    }
  }

  const runRollout = async () => {
    setBusy(true)
    try {
      await startFleetRollout()
      toast.success("Rollout started — the rest is updating")
      router.refresh()
    } catch {
      toast.error("Could not start the rollout")
    } finally {
      setBusy(false)
    }
  }

  if (nothingToShow) return null

  if (eve.gated) {
    const n = agentsBehindLatest.length
    return (
      <div className="mb-6 flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-muted-foreground">
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" aria-hidden="true" />
        Eve {eve.latest} available (breaking) — {n} agent{n === 1 ? "" : "s"} on an
        older version. Open each one to update it; the update is safety-tested
        before it ships.
      </div>
    )
  }

  if (canaryDone) {
    const ok = canaryResult!.updated.length > 0
    return (
      <div className="mb-6 flex flex-col gap-3 rounded-xl border border-border bg-secondary/30 px-4 py-3 text-sm">
        <div className="flex items-center gap-2">
          <ArrowUpCircle
            className={`h-4 w-4 shrink-0 ${ok ? "text-emerald-500" : "text-amber-500"}`}
            aria-hidden="true"
          />
          Update on Eve {eve.target} — {ok ? "updated" : "skipped (build failed)"}. Verify it,
          then continue.
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={runRollout} disabled={busy} className="gap-2">
            <ArrowUpCircle className="h-4 w-4" aria-hidden="true" />
            Continue rollout
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-secondary/30 px-4 py-3 text-sm">
      <div className="flex items-center gap-2 text-foreground">
        <ArrowUpCircle className="h-4 w-4 shrink-0 text-foreground" aria-hidden="true" />
        Eve {eve.target} available · {behindIds.length} bots behind
      </div>
      {driftedAgents.length > 0 && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Select
            items={driftedAgents.map((a) => ({ value: a.id, label: a.name }))}
            value={canaryPick}
            onValueChange={(v) => setCanaryPick(v ?? "")}
          >
            <SelectTrigger className="w-full sm:w-56">
              <SelectValue placeholder="Pick a bot" />
            </SelectTrigger>
            <SelectContent>
              {driftedAgents.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={runCanary} disabled={busy || !canaryPick} className="gap-2">
            <ArrowUpCircle className="h-4 w-4" aria-hidden="true" />
            Update
          </Button>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        A version update also applies any pending changes to assigned connections (their content
        isn&apos;t snapshotted).
      </p>
    </div>
  )
}
