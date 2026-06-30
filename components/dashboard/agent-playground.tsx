"use client"

import { useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { MessageSquare, Send } from "lucide-react"

type ChatMessage = { id: string; role: "user" | "assistant"; text: string }

export function AgentPlayground({
  agentId,
  deploymentStatus,
  deploymentUrl,
  previewUrl,
}: {
  agentId: string
  deploymentStatus: string
  deploymentUrl: string | null
  // Per-deploy preview hash URL of a not-yet-promoted deployment. When present
  // with status "preview_ready" the chat targets the PREVIEW instead of prod.
  previewUrl?: string | null
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Session handles carried across turns (returned by the deployed agent).
  const session = useRef<{
    sessionId?: string
    continuationToken?: string
    startIndex?: number
  }>({})

  // The Test tab chats with the REAL Eve runtime. We can chat once there is
  // something to hit: a promoted production deployment, OR a pending preview the
  // user wants to test before publishing. When in preview mode we tell the proxy
  // to target agent.previewUrl via `preview: true`.
  const testingPreview =
    deploymentStatus === "preview_ready" && !!previewUrl
  const deployed = deploymentStatus === "deployed" && !!deploymentUrl
  const canTest = deployed || testingPreview
  if (!canTest) {
    return (
      <div className="flex h-[60vh] flex-col items-center justify-center gap-3 rounded-xl border border-border text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-secondary">
          <MessageSquare className="h-5 w-5 text-muted-foreground" />
        </div>
        <p className="max-w-sm text-xs text-muted-foreground">
          Deploy this agent first to test it against the live runtime.
        </p>
      </div>
    )
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const text = input.trim()
    if (!text || busy) return

    const userMsg: ChatMessage = { id: `u-${Date.now()}`, role: "user", text }
    setMessages((m) => [...m, userMsg])
    setInput("")
    setError(null)
    setBusy(true)

    try {
      const res = await fetch(`/api/agents/${agentId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          ...session.current,
          ...(testingPreview ? { preview: true } : {}),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`)
      session.current = {
        sessionId: data.sessionId,
        continuationToken: data.continuationToken,
        startIndex: data.startIndex,
      }
      setMessages((m) => [
        ...m,
        {
          id: `a-${Date.now()}`,
          role: "assistant",
          text: data.text || "(empty reply)",
        },
      ])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-[60vh] flex-col rounded-xl border border-border">
      {testingPreview && (
        <div className="flex items-center gap-1.5 border-b border-border px-4 py-2 text-xs text-muted-foreground">
          <span
            className="h-1.5 w-1.5 rounded-full bg-success"
            aria-hidden="true"
          />
          Testing preview — not yet published to production
        </div>
      )}
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-secondary">
              <MessageSquare className="h-5 w-5 text-muted-foreground" />
            </div>
            <p className="max-w-sm text-xs text-muted-foreground">
              Type a message to test the agent against its live deployed
              runtime. Prompt edits apply on the next turn; re-deploy structural
              changes.
            </p>
          </div>
        ) : (
          messages.map((m) => (
            <div
              key={m.id}
              className={
                m.role === "user" ? "flex justify-end" : "flex justify-start"
              }
            >
              <div
                className={`max-w-[80%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm ${
                  m.role === "user"
                    ? "bg-foreground text-background"
                    : "border border-border bg-secondary text-foreground"
                }`}
              >
                {m.text}
              </div>
            </div>
          ))
        )}
        {busy && (
          <div className="flex justify-start">
            <div className="rounded-lg border border-border bg-secondary px-3 py-2">
              <TypingDots />
            </div>
          </div>
        )}
        {error && (
          <div className="flex justify-start">
            <div className="max-w-[80%] rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          </div>
        )}
      </div>

      <form
        onSubmit={submit}
        className="flex items-center gap-2 border-t border-border p-3"
      >
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a message…"
          disabled={busy}
        />
        <Button type="submit" size="sm" disabled={busy || !input.trim()}>
          <Send className="h-4 w-4" />
        </Button>
      </form>
    </div>
  )
}

function TypingDots() {
  return (
    <span className="flex items-center gap-1 py-0.5" aria-label="Typing…">
      {[0, 0.15, 0.3].map((delay) => (
        <span
          key={delay}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground"
          style={{ animationDelay: `${delay}s` }}
        />
      ))}
    </span>
  )
}
