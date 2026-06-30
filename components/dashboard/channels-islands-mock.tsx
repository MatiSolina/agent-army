"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Plus, X, Bot } from "lucide-react"
import { SlackGlyph, WhatsAppGlyph, TelegramGlyph } from "@/components/dashboard/brand-icons"

// note: dummy data, no DB. Mirrors the real model: each app row is a channel
// with an agentId (1 app → 1 agent). Islands are by channel type.

type ChannelType = "slack" | "kapso" | "telegram"

type App = {
  id: string
  name: string
  detail: string // workspace / phone / @username
  agentId: string | null
}

const AGENTS = [
  { id: "sales", name: "Sales" },
  { id: "support", name: "Support" },
  { id: "billing", name: "Billing" },
  { id: "marketing", name: "Marketing" },
]

const agentName = (id: string | null) =>
  id ? AGENTS.find((a) => a.id === id)?.name ?? "Deleted agent" : null

const INITIAL: Record<ChannelType, App[]> = {
  slack: [
    { id: "s1", name: "Acme workspace", detail: "acme.slack.com", agentId: "sales" },
    { id: "s2", name: "Support workspace", detail: "support.slack.com", agentId: "support" },
  ],
  kapso: [
    { id: "k1", name: "Sales line", detail: "+54 11 5555-1234", agentId: "sales" },
    { id: "k2", name: "Billing line", detail: "+54 11 4444-5678", agentId: "billing" },
  ],
  telegram: [
    { id: "t1", name: "Updates bot", detail: "@acme_updates", agentId: null },
  ],
}

const ISLANDS: { type: ChannelType; title: string; blurb: string; icon: React.ReactNode }[] = [
  { type: "slack", title: "Slack", blurb: "Workspaces connected via Vercel Connect.", icon: <SlackGlyph className="h-4 w-4" /> },
  { type: "kapso", title: "WhatsApp (Kapso)", blurb: "Phone numbers routed through Kapso.", icon: <WhatsAppGlyph className="h-4 w-4" /> },
  { type: "telegram", title: "Telegram", blurb: "Bots answering via the Bot API.", icon: <TelegramGlyph className="h-4 w-4" /> },
]

function Island({
  title,
  blurb,
  icon,
  apps,
  onAssign,
  onUnassign,
  onAdd,
}: {
  title: string
  blurb: string
  icon: React.ReactNode
  apps: App[]
  onAssign: (appId: string, agentId: string) => void
  onUnassign: (appId: string) => void
  onAdd: () => void
}) {
  return (
    <section className="flex flex-col rounded-xl border border-border bg-background">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-secondary">
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <p className="truncate text-xs text-muted-foreground">{blurb}</p>
        </div>
        <Button size="sm" variant="ghost" className="gap-1 text-xs" onClick={onAdd}>
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Add app
        </Button>
      </header>

      <ul className="divide-y divide-border">
        {apps.length === 0 && (
          <li className="flex items-center justify-center px-4 py-8 text-center">
            <p className="text-xs text-muted-foreground">
              No {title.split(" ")[0].toLowerCase()} apps connected yet.
            </p>
          </li>
        )}
        {apps.map((app) => {
          const name = agentName(app.agentId)
          return (
            <li key={app.id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{app.name}</p>
                <p className="truncate font-mono text-xs text-muted-foreground">{app.detail}</p>
              </div>

              {app.agentId ? (
                <div className="flex items-center gap-1.5">
                  <span className="flex items-center gap-1.5 rounded-md border border-border bg-secondary px-2 py-1 text-xs font-medium text-foreground">
                    <Bot className="h-3 w-3" aria-hidden="true" />
                    {name}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-muted-foreground"
                    aria-label="Unassign agent"
                    onClick={() => onUnassign(app.id)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ) : (
                <Select
                  items={AGENTS.map((a) => ({ value: a.id, label: a.name }))}
                  onValueChange={(v) => {
                    if (typeof v === "string" && v) onAssign(app.id, v)
                  }}
                >
                  <SelectTrigger className="h-7 w-36 text-xs text-muted-foreground">
                    <SelectValue placeholder="Assign agent" />
                  </SelectTrigger>
                  <SelectContent>
                    {AGENTS.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export function ChannelsIslandsMock() {
  const [appsByType, setAppsByType] = useState(INITIAL)

  const assign = (type: ChannelType, appId: string, agentId: string) =>
    setAppsByType((s) => ({
      ...s,
      [type]: s[type].map((a) => (a.id === appId ? { ...a, agentId } : a)),
    }))

  const unassign = (type: ChannelType, appId: string) =>
    setAppsByType((s) => ({
      ...s,
      [type]: s[type].map((a) => (a.id === appId ? { ...a, agentId: null } : a)),
    }))

  const addApp = (type: ChannelType) =>
    setAppsByType((s) => ({
      ...s,
      [type]: [
        ...s[type],
        { id: `${type}-new-${s[type].length + 1}`, name: `New ${type} app`, detail: "—", agentId: null },
      ],
    }))

  return (
    <div className="flex flex-col gap-4">
      {ISLANDS.map((island) => (
        <Island
          key={island.type}
          title={island.title}
          blurb={island.blurb}
          icon={island.icon}
          apps={appsByType[island.type]}
          onAssign={(appId, agentId) => assign(island.type, appId, agentId)}
          onUnassign={(appId) => unassign(island.type, appId)}
          onAdd={() => addApp(island.type)}
        />
      ))}
    </div>
  )
}
