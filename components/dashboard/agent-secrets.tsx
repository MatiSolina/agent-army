import { Badge } from "@/components/ui/badge"
import { KeyRound, ShieldCheck, ExternalLink } from "lucide-react"

/**
 * Per-agent Secrets / Environment section (read-only).
 *
 * Secrets are NOT entered here. Their values are injected at deploy time from
 * their real sources (the agent's MCP connections, its WhatsApp channel, and
 * Fleet Manager env) and persisted onto the agent's OWN Vercel project. This UI
 * only LISTS the env keys the agent expects + whether each is currently set,
 * and links out to Vercel to inspect, edit, or rotate the values.
 */
export function AgentSecrets({
  status,
  vercelEnvUrl,
}: {
  /** Expected env keys + whether each is already configured on Vercel. */
  status: { key: string; configured: boolean }[]
  /** Deep-link to the Vercel project's env page; undefined hides the link. */
  vercelEnvUrl?: string
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-sm font-medium text-foreground">
            Secrets and environment
          </h3>
          <p className="text-xs text-muted-foreground">
            Injected into this agent at deploy time and stored encrypted on its
            Vercel project. Edit or rotate the values on Vercel — they are not
            managed from here.
          </p>
        </div>
        {vercelEnvUrl && (
          <a
            href={vercelEnvUrl}
            target="_blank"
            rel="noreferrer"
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Manage on Vercel
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
      </div>

      {status.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-12 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-secondary">
            <KeyRound className="h-5 w-5 text-muted-foreground" />
          </div>
          <p className="max-w-sm text-xs text-muted-foreground">
            No secrets are required yet. Assign a token-based MCP connection or a
            WhatsApp channel to this agent and its credentials will appear here.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-border rounded-xl border border-border">
          {status.map(({ key, configured }) => (
            <div
              key={key}
              className="flex items-center justify-between gap-2 px-5 py-3"
            >
              <span className="font-mono text-xs text-muted-foreground">
                {key}
              </span>
              {configured ? (
                <Badge variant="secondary" className="gap-1">
                  <ShieldCheck className="h-3 w-3" />
                  Configured
                </Badge>
              ) : (
                <Badge variant="destructive">Not set</Badge>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
