"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { ArrowLeft, ExternalLink, Info, Trash2 } from "lucide-react"
import { PageHeader } from "@/components/dashboard/page-header"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { DeleteAgentDialog } from "@/components/ui/delete-agent-dialog"
import { updateAgentConfig, deleteAgent } from "@/app/actions/agents"
import { getModelLabel } from "@/lib/models"
import { agentSlug } from "@/lib/slug"
import { LIMITS } from "@/lib/defaults"
import type { Agent } from "@/lib/db/schema"

/**
 * Minimal editor for an IMPORTED agent. Imported agents are linked to a Vercel
 * deployment agent-army did NOT create, so the dashboard deliberately exposes
 * ONLY a prompt update — applied live via /api/agents/<id>/runtime-config with NO
 * rebuild. Every full-management surface (Capabilities, Channels, Secrets,
 * Deployments, Deploy, Test) is intentionally absent so the dashboard can never
 * regenerate or tear down a working deployment. Everything else (connections,
 * secrets, redeploy) the operator manages in Vercel.
 *
 * Save calls updateAgentConfig with the agent's recovered config UNCHANGED except
 * name + instructions; updateAgentConfig syncs systemPrompt from instructions,
 * which is exactly what the runtime-config endpoint serves to the live agent.
 */
export function ImportedAgentEditor({ agent }: { agent: Agent }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [name, setName] = useState(agent.name)
  const [instructions, setInstructions] = useState(agent.instructions)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const dirty = name.trim() !== agent.name || instructions !== agent.instructions

  const save = () => {
    if (!name.trim()) {
      toast.error("The agent needs a name")
      return
    }
    startTransition(async () => {
      try {
        // Pass the recovered config through unchanged; only name + instructions
        // (→ systemPrompt) move. updateAgentConfig re-normalizes + bounds it.
        await updateAgentConfig(agent.id, {
          name: name.trim(),
          description: agent.description,
          enabled: agent.enabled,
          model: agent.model,
          temperature: agent.temperature,
          maxSteps: agent.maxSteps,
          instructions,
          skills: agent.skills,
          connectionIds: agent.connectionIds,
          subagents: agent.subagents,
          schedules: agent.schedules,
          sandbox: agent.sandbox,
          harness: agent.harness,
        })
        toast.success("Updated — the live agent will pick up the new prompt")
        // The detail route is keyed by the name slug; a renamed agent changes it,
        // so navigate to the (possibly new) slug instead of refreshing the stale
        // URL (which would 404).
        router.replace(`/agents/${agentSlug(name.trim())}`)
        router.refresh()
      } catch {
        toast.error("Could not save the update")
      }
    })
  }

  const remove = () => {
    startTransition(async () => {
      try {
        await deleteAgent(agent.id)
        toast.success("Removed from agent-army (Vercel deployment untouched)")
        router.push("/agents")
      } catch {
        toast.error("Could not remove the agent")
      }
    })
  }

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => router.push("/agents")}
              className="inline-flex items-center text-muted-foreground transition-colors hover:text-foreground"
              aria-label="Back to agents"
            >
              <ArrowLeft className="size-4" />
            </button>
            {agent.name}
          </span>
        }
        description="Imported agent — you can update its prompt here. Everything else is managed in Vercel."
        action={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => setConfirmDelete(true)}
              disabled={isPending}
              className="gap-2"
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
              Remove
            </Button>
            <Button onClick={save} disabled={isPending || !dirty}>
              {isPending ? "Saving…" : "Save update"}
            </Button>
          </div>
        }
      />

      <div className="flex items-start gap-2 rounded-lg border border-border bg-secondary/40 p-3 text-sm text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span>
          This agent was imported from a Vercel deployment. Prompt edits apply
          live (no redeploy). Connections, channels and secrets stay as you
          manage them in Vercel — the dashboard won&apos;t redeploy or delete this
          project.
        </span>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_280px]">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="name" className="text-xs text-muted-foreground">
              Name
            </Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={LIMITS.agentName}
            />
          </div>
          <div className="space-y-1.5">
            <Label
              htmlFor="instructions"
              className="text-xs text-muted-foreground"
            >
              Instructions (system prompt)
            </Label>
            <Textarea
              id="instructions"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              maxLength={LIMITS.instructions}
              aria-label="Agent runtime instructions"
              className="min-h-96 font-mono text-xs leading-relaxed"
            />
          </div>
        </div>

        <aside className="space-y-3 rounded-xl border border-border p-4 text-sm">
          <h3 className="text-sm font-medium text-foreground">Deployment</h3>
          <Meta label="Model" value={getModelLabel(agent.model)} />
          <Meta label="Eve version" value={agent.eveVersion ?? "unknown"} />
          {agent.deploymentUrl && (
            <a
              href={agent.deploymentUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              Open live deployment
            </a>
          )}
        </aside>
      </div>

      <DeleteAgentDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        agentName={agent.name}
        onConfirm={remove}
        loading={isPending}
        imported
      />
    </>
  )
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-mono text-xs text-foreground">{value}</span>
    </div>
  )
}
