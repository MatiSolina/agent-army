"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { ArrowLeft, FilePlus2, Sparkles } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { getModelLabel } from "@/lib/models"
import { createAgent, createAgentFromTemplate } from "@/app/actions/agents"
import { AGENT_TEMPLATES, type AgentTemplate } from "@/lib/templates"

// mode  → pick template vs start from scratch
// pick  → choose which template (list)
// template → review the chosen template, then create
type Step = "mode" | "pick" | "template"

const BACK_TO: Record<Step, Step> = {
  mode: "mode",
  pick: "mode",
  template: "pick",
}

export function AgentFormDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const [step, setStep] = useState<Step>("mode")
  const [template, setTemplate] = useState<AgentTemplate | null>(null)
  const [loading, setLoading] = useState(false)

  // Reset to the first step on close so the next open starts fresh.
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setStep("mode")
      setTemplate(null)
    }
    onOpenChange(next)
  }

  // Land the user in the editor with whatever was just created. `build` adds a
  // ?building=1 flag the editor consumes once to kick off a preview build;
  // template agents deploy with zero extra config, so we build immediately.
  const create = async (
    run: () => Promise<string>,
    opts?: { build?: boolean },
  ) => {
    setLoading(true)
    try {
      const slug = await run()
      toast.success(opts?.build ? "Agent created — building preview" : "Agent created")
      onOpenChange(false)
      router.push(`/agents/${slug}${opts?.build ? "?building=1" : ""}`)
    } catch {
      toast.error("Could not create the agent")
    } finally {
      setLoading(false)
    }
  }

  const title =
    step === "mode"
      ? "New agent"
      : step === "pick"
        ? "Choose a template"
        : template?.name ?? "Template"

  const description_ =
    step === "mode"
      ? "Start from a template or build one from scratch."
      : step === "pick"
        ? "Pick a template to start from. You can tweak everything afterwards."
        : "Review what this template ships with, then create the agent."

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {step !== "mode" && (
              <button
                type="button"
                onClick={() => setStep(BACK_TO[step])}
                className="mr-2 inline-flex items-center text-muted-foreground transition-colors hover:text-foreground"
                aria-label="Back"
              >
                <ArrowLeft className="size-4" />
              </button>
            )}
            {title}
          </DialogTitle>
          <DialogDescription>{description_}</DialogDescription>
        </DialogHeader>

        {step === "mode" && (
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => setStep("pick")}
              className="flex items-start gap-3 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:border-foreground/30 hover:bg-accent"
            >
              <Sparkles className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
              <span className="flex flex-col gap-1">
                <span className="text-sm font-medium">From a template</span>
                <span className="text-xs text-muted-foreground">
                  Start from a ready-made agent with instructions and skills.
                </span>
              </span>
            </button>
            <button
              type="button"
              disabled={loading}
              onClick={() => create(() => createAgent({}))}
              className="flex items-start gap-3 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:border-foreground/30 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
            >
              <FilePlus2 className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
              <span className="flex flex-col gap-1">
                <span className="text-sm font-medium">From scratch</span>
                <span className="text-xs text-muted-foreground">
                  Create a blank agent and configure everything yourself.
                </span>
              </span>
            </button>
          </div>
        )}

        {step === "pick" && (
          <div className="flex flex-col gap-2">
            {AGENT_TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  setTemplate(t)
                  setStep("template")
                }}
                className="flex items-start gap-3 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-foreground/30 hover:bg-accent"
              >
                <Sparkles className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="flex flex-col gap-1">
                  <span className="text-sm font-medium">{t.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {t.description}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}

        {step === "template" && template && (
          <div className="flex flex-col gap-4">
            <TemplateDetail template={template} />
            <DialogFooter className="mt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setStep("pick")}
              >
                Back
              </Button>
              <Button
                type="button"
                disabled={loading}
                onClick={() =>
                  create(() => createAgentFromTemplate(template.id), {
                    build: true,
                  })
                }
              >
                {loading ? "Creating…" : "Use this template"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function TemplateDetail({ template }: { template: AgentTemplate }) {
  const badges = [
    `${template.skills.length} skill${template.skills.length === 1 ? "" : "s"}`,
    template.subagents.length > 0 &&
      `${template.subagents.length} subagent${template.subagents.length === 1 ? "" : "s"}`,
    template.schedules.length > 0 &&
      `${template.schedules.length} schedule${template.schedules.length === 1 ? "" : "s"}`,
    template.sandbox.enabled && "sandbox",
  ].filter(Boolean) as string[]

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">{template.description}</p>

      <div className="grid grid-cols-2 gap-3 text-sm">
        <Meta label="Model" value={getModelLabel(template.model)} />
        <Meta
          label="Temperature"
          value={(template.temperature / 100).toFixed(2)}
        />
      </div>

      {badges.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {badges.map((b) => (
            <span
              key={b}
              className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground"
            >
              {b}
            </span>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          Instructions
        </span>
        <pre className="max-h-40 overflow-y-auto rounded-lg border border-border bg-muted/30 p-3 text-xs whitespace-pre-wrap text-foreground/80">
          {template.instructions}
        </pre>
      </div>

      {template.skills.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            Skills
          </span>
          <ul className="flex flex-col gap-1">
            {template.skills.map((s) => (
              <li key={s.id} className="text-xs text-foreground/80">
                <span className="font-medium">{s.name}</span> — {s.description}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-foreground">{value}</span>
    </div>
  )
}
