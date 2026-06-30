"use client"

import { useEffect, useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { promoteAgentDeployment } from "@/app/actions/deploy"
import { Check, Loader2, CircleDashed, MessageSquare, Rocket, X } from "lucide-react"

type Phase = "preparing" | "building" | "ready" | "error"

type Progress = {
  phase: Phase
  deploymentId: string | null
  url: string | null
  state: string | null
  logs: string[]
}

const STEPS: { key: Phase; label: string }[] = [
  { key: "preparing", label: "Preparing project" },
  { key: "building", label: "Building on Vercel" },
  { key: "ready", label: "Ready" },
]

const ORDER: Phase[] = ["preparing", "building", "ready"]

/**
 * Live redeploy modal: while deployAgent runs server-side, this polls the
 * deploy-progress route (a route handler, NOT a server action — those serialize
 * behind the long deploy) and streams Vercel's real build state + log tail.
 *
 * `since` is when the user clicked Deploy, so a prior build's READY state never
 * flashes before the new deployment registers. `failed` lets the parent surface
 * a deployAgent rejection that happens BEFORE any Vercel deployment exists
 * (project/env error) — the route would otherwise sit on "preparing" forever.
 */
export function DeployProgressModal({
  agentId,
  open,
  onOpenChange,
  since,
  failed,
  onTestPreview,
}: {
  agentId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  since: number
  failed: boolean
  // Jump to the Test tab to chat against the fresh preview build. The raw
  // deployment URL is the bare eve runtime (OIDC-gated, no chat UI), so the only
  // useful way to test a preview is the dashboard's proxied Test chat.
  onTestPreview: () => void
}) {
  const router = useRouter()
  const [progress, setProgress] = useState<Progress | null>(null)
  const [promoting, startPromoting] = useTransition()
  const logRef = useRef<HTMLDivElement>(null)

  const phase: Phase = failed && progress?.phase !== "ready" ? "error" : progress?.phase ?? "preparing"
  const done = phase === "ready" || phase === "error"

  // Poll the progress route while the build is in flight. Recursive timeout (not
  // setInterval) so a slow response never overlaps the next poll. Stops once a
  // terminal phase is reached or the modal closes.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    let settleTicks = 0 // extra polls after READY to let build logs materialize

    const tick = async () => {
      try {
        const res = await fetch(
          `/api/agents/${agentId}/deploy-progress?since=${since}`,
          { cache: "no-store" },
        )
        if (cancelled) return
        if (res.ok) {
          const data = (await res.json()) as Progress
          if (cancelled) return
          // Never let a transient empty poll wipe logs we already captured.
          setProgress((prev) => ({
            ...data,
            logs: data.logs?.length ? data.logs : prev?.logs ?? [],
          }))
          // Stop once terminal — but only after logs land. A fast build flips to
          // READY before the events endpoint has materialized its log lines, so
          // keep polling a few more ticks to backfill the tail.
          const terminal = data.phase === "ready" || data.phase === "error"
          if (terminal && (data.logs?.length || ++settleTicks >= 3)) return
        }
      } catch {
        // transient — keep polling
      }
      if (!cancelled) timer = setTimeout(tick, 2000)
    }
    tick()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, agentId, since])

  // Keep the log console pinned to the newest line.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [progress?.logs])

  const promote = () => {
    if (!progress?.deploymentId) return
    const deploymentId = progress.deploymentId
    startPromoting(async () => {
      try {
        await promoteAgentDeployment(agentId, deploymentId)
        toast.success("Published to production")
        onOpenChange(false)
        router.refresh()
      } catch {
        toast.error("Could not publish to production")
      }
    })
  }

  const previewHref = progress?.url
    ? progress.url.startsWith("http")
      ? progress.url
      : `https://${progress.url}`
    : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" showCloseButton={done}>
        <DialogHeader>
          <DialogTitle>Redeploying agent</DialogTitle>
          <DialogDescription>
            {phase === "ready"
              ? "Build finished — test the preview, then publish it to production."
              : phase === "error"
                ? "The deployment did not finish. See the build log below."
                : "Building a fresh preview on Vercel. This usually takes a minute."}
          </DialogDescription>
        </DialogHeader>

        {/* Stepper */}
        <ol className="space-y-2">
          {STEPS.map((step) => {
            const state = stepState(step.key, phase)
            return (
              <li
                key={step.key}
                className="flex items-center gap-2.5 text-sm"
              >
                {state === "done" ? (
                  <Check className="h-4 w-4 text-success" aria-hidden="true" />
                ) : state === "active" ? (
                  <Loader2
                    className="h-4 w-4 animate-spin text-foreground"
                    aria-hidden="true"
                  />
                ) : state === "error" ? (
                  <X className="h-4 w-4 text-destructive" aria-hidden="true" />
                ) : (
                  <CircleDashed
                    className="h-4 w-4 text-muted-foreground/50"
                    aria-hidden="true"
                  />
                )}
                <span
                  className={
                    state === "pending"
                      ? "text-muted-foreground"
                      : state === "error"
                        ? "text-destructive"
                        : "text-foreground"
                  }
                >
                  {step.label}
                </span>
              </li>
            )
          })}
        </ol>

        {/* Live build log tail */}
        <div
          ref={logRef}
          className="h-48 overflow-y-auto rounded-lg border border-border bg-secondary/40 p-3 font-mono text-xs leading-relaxed text-muted-foreground"
        >
          {progress?.logs?.length ? (
            progress.logs.map((line, i) => (
              <div key={i} className="whitespace-pre-wrap break-all">
                {line}
              </div>
            ))
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground/60">
              Waiting for build output…
            </div>
          )}
        </div>

        {/* Actions — only render the footer bar once there's something to act
            on. While building there are no buttons, so an always-on footer just
            reads as a broken empty strip. */}
        {done && (
          <div className="-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            {phase === "ready" && previewHref && (
              <>
                <Button variant="outline" onClick={onTestPreview}>
                  <MessageSquare className="h-4 w-4" />
                  Test preview
                </Button>
                <Button onClick={promote} disabled={promoting}>
                  {promoting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Rocket className="h-4 w-4" />
                  )}
                  Publish to production
                </Button>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** Per-step state given the current phase, walking the linear ORDER. */
function stepState(
  step: Phase,
  phase: Phase,
): "done" | "active" | "pending" | "error" {
  if (phase === "error") {
    // Mark the step that was in flight as errored; earlier steps stay done.
    return step === "ready" ? "error" : "done"
  }
  const stepIdx = ORDER.indexOf(step)
  const phaseIdx = ORDER.indexOf(phase)
  if (stepIdx < phaseIdx) return "done"
  if (stepIdx === phaseIdx) return phase === "ready" ? "done" : "active"
  return "pending"
}
