"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { PageHeader } from "@/components/dashboard/page-header"
import { ChannelFormDialog } from "@/components/dashboard/channel-form-dialog"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { assignAgentToChannel, deleteChannel } from "@/app/actions/channels"
import { discordInteractionsEndpointUrl } from "@/lib/channels/webhook-url"
import type { Agent } from "@/lib/db/schema"
import {
  groupChannelsByIsland,
  isChannelConfigured,
  type ChannelIsland,
  type ClientChannel,
} from "@/lib/channels/client-channel"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  SlackGlyph,
  WhatsAppGlyph,
  TelegramGlyph,
  DiscordGlyph,
} from "@/components/dashboard/brand-icons"
import {
  Plus,
  MoreVertical,
  Pencil,
  Trash2,
  Bot,
  Loader2,
  Phone,
  X,
  Settings2,
} from "lucide-react"

const ISLAND_META: Record<
  ChannelIsland,
  { title: string; blurb: string; addLabel: string; icon: React.ReactNode }
> = {
  slack: {
    title: "Slack",
    blurb: "Workspaces connected via Vercel Connect.",
    addLabel: "Add workspace",
    icon: <SlackGlyph className="h-4 w-4" />,
  },
  kapso: {
    title: "WhatsApp (Kapso)",
    blurb: "Phone numbers routed through Kapso.",
    addLabel: "Add number",
    icon: <WhatsAppGlyph className="h-4 w-4" />,
  },
  telegram: {
    title: "Telegram",
    blurb: "Bots answering via the Bot API.",
    addLabel: "Add bot",
    icon: <TelegramGlyph className="h-4 w-4" />,
  },
  discord: {
    title: "Discord",
    blurb: "Bots answering via HTTP Interactions.",
    addLabel: "Add bot",
    icon: <DiscordGlyph className="h-4 w-4" />,
  },
}

export function ChannelsView({
  initialChannels,
  agents,
}: {
  initialChannels: ClientChannel[]
  agents: Agent[]
}) {
  const router = useRouter()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<ClientChannel | null>(null)
  const [createType, setCreateType] = useState<ChannelIsland>("kapso")
  const [toDelete, setToDelete] = useState<ClientChannel | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [toUnassign, setToUnassign] = useState<ClientChannel | null>(null)
  const [unassigning, setUnassigning] = useState(false)

  // Channels with a re-deploy in flight from a just-issued assign/unassign. While
  // set, the row shows "Re-deploying…" and the agent picker is blocked, for both
  // assign (new agent building) and unassign (old agent rebuilds to drop creds)
  // trigger a build, and re-acting before it settles would clash. Value = the
  // agent id whose build we wait on; `since` guards the brief window before the
  // background build flips the agent to "deploying".
  const [busy, setBusy] = useState<Record<string, { agentId: string; since: number }>>(
    {},
  )
  const sawDeploying = useRef<Record<string, boolean>>({})

  const agentName = (id: string | null) =>
    id ? (agents.find((a) => a.id === id)?.name ?? "Deleted agent") : null

  // While a channel's agent is mid-(re)deploy the per-row status shows a
  // spinner; the page is a server component, so without this it would stay
  // "deploying…" forever until a manual reload. Poll while any assigned agent is
  // deploying OR a just-issued assign/unassign build is still pending.
  const anyDeploying = agents.some((a) => a.deploymentStatus === "deploying")
  const pollActive = anyDeploying || Object.keys(busy).length > 0
  useEffect(() => {
    if (!pollActive) return
    const id = setInterval(() => router.refresh(), 4000)
    return () => clearInterval(id)
  }, [pollActive, router])

  // Clear a busy entry once its agent's build has settled. Guard against the
  // window before the background build starts: only clear after we've seen the
  // agent "deploying", or after an 8s fallback (build never started / instant).
  useEffect(() => {
    const entries = Object.entries(busy)
    if (entries.length === 0) return
    const next = { ...busy }
    let changed = false
    for (const [channelId, { agentId, since }] of entries) {
      const status = agents.find((a) => a.id === agentId)?.deploymentStatus
      if (status === "deploying") sawDeploying.current[channelId] = true
      const settled = status !== "deploying"
      // Clear once the build we waited on has settled (we saw it go deploying
      // then leave it), or after a 120s hard cap so it can never hang. The
      // background deploy starts within seconds, so sawDeploying drives the
      // normal case and the cap only covers a deploy that never started.
      if (settled && (sawDeploying.current[channelId] || Date.now() - since > 120000)) {
        delete next[channelId]
        delete sawDeploying.current[channelId]
        changed = true
      }
    }
    // queueMicrotask: never setState synchronously inside an effect.
    if (changed) queueMicrotask(() => setBusy(next))
  }, [agents, busy])

  const openCreate = (type: ChannelIsland = "kapso") => {
    setEditing(null)
    setCreateType(type)
    setDialogOpen(true)
  }

  const openEdit = (channel: ClientChannel) => {
    setEditing(channel)
    setDialogOpen(true)
  }

  const confirmDelete = async () => {
    if (!toDelete) return
    setDeleting(true)
    try {
      await deleteChannel(toDelete.id)
      toast.success("Channel deleted")
      setToDelete(null)
      router.refresh()
    } catch {
      toast.error("Could not delete the channel")
    } finally {
      setDeleting(false)
    }
  }

  const assign = async (channel: ClientChannel, agentId: string) => {
    try {
      await assignAgentToChannel(channel.id, agentId)
      toast.success("Agent assigned")
      setBusy((b) => ({ ...b, [channel.id]: { agentId, since: Date.now() } }))
      router.refresh()
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Could not assign the agent",
      )
    }
  }

  const confirmUnassign = async () => {
    if (!toUnassign) return
    const { id: channelId, agentId } = toUnassign
    setUnassigning(true)
    try {
      await assignAgentToChannel(channelId, null)
      toast.success("Agent unassigned")
      // The old agent now rebuilds to drop the channel creds; block re-assigning
      // it until that build settles.
      if (agentId) {
        setBusy((b) => ({ ...b, [channelId]: { agentId, since: Date.now() } }))
      }
      setToUnassign(null)
      router.refresh()
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Could not unassign the agent",
      )
    } finally {
      setUnassigning(false)
    }
  }

  // note: Telegram & Discord islands hidden for now. Re-show by emptying this set.
  const hiddenIslands = new Set<ChannelIsland>(["telegram", "discord"])
  const islands = groupChannelsByIsland(initialChannels).filter(
    ({ island }) => !hiddenIslands.has(island),
  )

  return (
    <>
      <PageHeader
        title="Channels"
        description="Each island is one channel type. Use the button on an island to add a channel of that type and assign it an agent — that turns the agent into a bot on that surface."
      />

      <div className="flex flex-col gap-4">
        {islands.map(({ island, channels }) => {
          const meta = ISLAND_META[island]
          // If a channel of this type exists but was never configured, the
          // island's CTA becomes "Config channel" (resume its setup) instead of
          // offering to add another. Reverts to "Add …" once all are configured.
          const unconfigured =
            channels.find((c) => c.status !== "connected") ?? null
          return (
            <section
              key={island}
              className="flex flex-col rounded-xl border border-border bg-background"
            >
              <header className="flex items-center gap-3 border-b border-border px-4 py-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-secondary text-foreground">
                  {meta.icon}
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold text-foreground">
                    {meta.title}
                  </h3>
                  <p className="truncate text-xs text-muted-foreground">
                    {meta.blurb}
                  </p>
                </div>
                {unconfigured ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="gap-1.5 text-xs"
                    onClick={() => openEdit(unconfigured)}
                  >
                    <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
                    Config channel
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="gap-1 text-xs"
                    onClick={() => openCreate(island)}
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    {meta.addLabel}
                  </Button>
                )}
              </header>

              {channels.length === 0 ? (
                <p className="px-4 py-8 text-center text-xs text-muted-foreground">
                  No {meta.title} channels connected yet.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {channels.map((channel) => (
                    <ChannelRow
                      key={channel.id}
                      channel={channel}
                      agents={agents}
                      agentName={agentName}
                      building={Boolean(busy[channel.id])}
                      onAssign={(agentId) => assign(channel, agentId)}
                      onUnassign={() => setToUnassign(channel)}
                      onEdit={() => openEdit(channel)}
                      onDelete={() => setToDelete(channel)}
                    />
                  ))}
                </ul>
              )}
            </section>
          )
        })}
      </div>

      <ChannelFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        channel={editing}
        defaultType={createType}
        agents={agents}
        onSaved={(channelId, agentId) =>
          setBusy((b) => ({ ...b, [channelId]: { agentId, since: Date.now() } }))
        }
        key={editing?.id ?? `new-${createType}`}
      />

      <ConfirmDialog
        open={Boolean(toDelete)}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="Delete channel"
        description={
          toDelete ? (
            <>
              You are about to delete{" "}
              <span className="font-medium text-foreground">
                {toDelete.name}
              </span>
              . This action cannot be undone.
            </>
          ) : null
        }
        confirmLabel="Delete channel"
        onConfirm={confirmDelete}
        loading={deleting}
      />

      <ConfirmDialog
        open={Boolean(toUnassign)}
        onOpenChange={(o) => !o && setToUnassign(null)}
        title="Unassign agent"
        description={
          toUnassign ? (
            <>
              You are about to unassign{" "}
              <span className="font-medium text-foreground">
                {agentName(toUnassign.agentId)}
              </span>{" "}
              from{" "}
              <span className="font-medium text-foreground">
                {toUnassign.name}
              </span>
              . This re-deploys the agent and takes the bot offline on this
              channel until you assign one again.
            </>
          ) : null
        }
        confirmLabel="Unassign agent"
        loadingLabel="Unassigning…"
        onConfirm={confirmUnassign}
        loading={unassigning}
      />
    </>
  )
}

/** Mono detail line under the channel name (workspace / phone / @username). */
function ChannelDetail({ channel }: { channel: ClientChannel }) {
  if (channel.type === "slack") {
    return (
      <p className="truncate font-mono text-xs text-muted-foreground">
        slack{channel.slackConnectUid ? ` · ${channel.slackConnectUid}` : ""}
      </p>
    )
  }
  if (channel.type === "telegram") {
    return (
      <p className="truncate font-mono text-xs text-muted-foreground">
        telegram
        {channel.telegramBotUsername ? ` · @${channel.telegramBotUsername}` : ""}
      </p>
    )
  }
  if (channel.type === "discord") {
    // No non-secret @username analog; never surface secrets.
    return (
      <p className="truncate font-mono text-xs text-muted-foreground">
        discord
      </p>
    )
  }
  if (channel.kapsoPhoneNumber) {
    const digits = channel.kapsoPhoneNumber.replace(/\D/g, "")
    return (
      <a
        href={`https://wa.me/${digits}`}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="flex w-fit items-center gap-1.5 truncate font-mono text-xs text-muted-foreground transition-colors hover:text-foreground hover:underline"
        title="Open in WhatsApp"
      >
        <Phone className="h-3 w-3 shrink-0" aria-hidden="true" />
        {channel.kapsoPhoneNumber}
      </a>
    )
  }
  if (channel.kapsoPhoneNumberId) {
    return (
      <p className="flex items-center gap-1.5 truncate font-mono text-xs text-muted-foreground">
        <Phone className="h-3 w-3 shrink-0" aria-hidden="true" />
        {channel.kapsoPhoneNumberId}
      </p>
    )
  }
  return (
    <p className="truncate font-mono text-xs text-muted-foreground">
      whatsapp · kapso
    </p>
  )
}

/**
 * One channel inside an island: name + detail, a connection dot, the agent
 * assignment (inline Select when free, a chip + unassign when taken), and an
 * always-visible Edit/Delete menu. The activation status (webhook / deploy
 * lifecycle) renders below once an agent is assigned.
 */
function ChannelRow({
  channel,
  agents,
  agentName,
  building,
  onAssign,
  onUnassign,
  onEdit,
  onDelete,
}: {
  channel: ClientChannel
  agents: Agent[]
  agentName: (id: string | null) => string | null
  /** A just-issued assign/unassign build is in flight; block re-assignment. */
  building: boolean
  onAssign: (agentId: string) => void
  onUnassign: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const assigned = agentName(channel.agentId)
  const connected = channel.status === "connected"
  // Creds present (agent-independent): a channel can be fully configured yet
  // still read as not-connected because no agent is assigned. We offer the
  // assign picker on `configured`, not `connected`, so you can pick an agent.
  const configured = isChannelConfigured(channel)
  const agent = agents.find((a) => a.id === channel.agentId) ?? null

  return (
    <li className="flex flex-col gap-3 px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">
            {channel.name}
          </p>
          <ChannelDetail channel={channel} />
        </div>

        {connected ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground">
            <span
              className="h-1.5 w-1.5 rounded-full bg-success"
              aria-hidden="true"
            />
            Connected
          </span>
        ) : (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-dashed border-border px-2 py-1 text-xs text-muted-foreground">
            <span
              className="h-1.5 w-1.5 rounded-full bg-muted-foreground"
              aria-hidden="true"
            />
            {configured ? "No agent" : "Not configured"}
          </span>
        )}

        {/* Agent assignment is only meaningful once the channel is configured.
            An already-assigned agent always shows (so it can be unassigned even
            if creds were later removed). */}
        {channel.agentId ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-secondary px-2 py-1 text-xs font-medium text-foreground">
            <Bot className="h-3 w-3" aria-hidden="true" />
            {assigned}
            <button
              type="button"
              aria-label="Unassign agent"
              className="text-muted-foreground transition-colors hover:text-foreground"
              onClick={onUnassign}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ) : building ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-dashed border-border px-2 py-1 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            Re-deploying…
          </span>
        ) : configured ? (
          <Select
            items={agents.map((a) => ({ value: a.id, label: a.name }))}
            onValueChange={(v) => {
              if (typeof v === "string" && v) onAssign(v)
            }}
          >
            <SelectTrigger className="h-7 w-36 shrink-0 text-xs text-muted-foreground">
              <SelectValue placeholder="Assign agent" />
            </SelectTrigger>
            <SelectContent>
              {agents.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 text-muted-foreground"
                aria-label="Channel options"
              >
                <MoreVertical className="h-4 w-4" />
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onEdit}>
              <Pencil className="mr-2 h-4 w-4" />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {channel.agentId && channel.type === "slack" && (
        <SlackStatus channel={channel} agent={agent} building={building} />
      )}
      {channel.agentId && channel.type === "telegram" && (
        <TelegramStatus channel={channel} agent={agent} building={building} />
      )}
      {channel.agentId && channel.type === "discord" && (
        <DiscordStatus channel={channel} agent={agent} building={building} />
      )}
      {channel.agentId &&
        channel.type !== "slack" &&
        channel.type !== "telegram" &&
        channel.type !== "discord" && (
          <KapsoStatus channel={channel} agent={agent} building={building} />
        )}

      {/* Teardown build after an unassign: the channel has no agent anymore, so
          no per-type status renders, so surface the in-flight rebuild here. */}
      {building && !channel.agentId && (
        <div className="flex items-center gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          Removing the agent — re-deploying to drop this channel. You can reassign
          once it finishes.
        </div>
      )}
    </li>
  )
}

/**
 * Slack activation for an assigned channel. Unlike Kapso there is no manual
 * webhook paste: the deploy attaches the connector + routes its trigger to
 * /eve/v1/slack automatically. The only out-of-band step is the one-time
 * connector install (browser OAuth) the operator did when creating the UID.
 */
function SlackStatus({
  channel,
  agent,
  building,
}: {
  channel: ClientChannel
  agent: Agent | null
  building: boolean
}) {
  const deployStatus = building ? "deploying" : (agent?.deploymentStatus ?? "none")

  if (deployStatus === "deploying") {
    return (
      <div className="flex items-center gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        Activating Slack — re-deploying the agent to route events…
      </div>
    )
  }
  if (deployStatus !== "deployed") {
    return (
      <div className="border-t border-border pt-3 text-xs text-muted-foreground">
        Deploy the agent to activate this Slack bot. On deploy, its project is
        attached to{" "}
        <code className="font-mono">{channel.slackConnectUid ?? "the connector"}</code>{" "}
        and Slack events route automatically.
      </div>
    )
  }
  return (
    <div className="border-t border-border pt-3 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
        Live — Slack events route to{" "}
        <code className="font-mono">/eve/v1/slack</code>. The bot answers
        @mentions and DMs.
      </span>
      <p className="mt-1">
        If it stays silent, confirm the connector{" "}
        <code className="font-mono">{channel.slackConnectUid ?? ""}</code> was
        installed in the workspace (one-time browser OAuth).
      </p>
    </div>
  )
}

/**
 * Telegram activation for an assigned channel. Like Slack there is no manual
 * webhook paste: the agent's promote step registers the webhook at
 * /eve/v1/telegram via the Bot API setWebhook automatically. The only thing the
 * operator supplies is the bot token + (optional) username at channel creation.
 */
function TelegramStatus({
  channel,
  agent,
  building,
}: {
  channel: ClientChannel
  agent: Agent | null
  building: boolean
}) {
  const deployStatus = building ? "deploying" : (agent?.deploymentStatus ?? "none")

  if (deployStatus === "deploying") {
    return (
      <div className="flex items-center gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        Activating Telegram — re-deploying the agent to register its webhook…
      </div>
    )
  }
  if (deployStatus !== "deployed") {
    return (
      <div className="border-t border-border pt-3 text-xs text-muted-foreground">
        Deploy the agent to activate this Telegram bot. On deploy, its webhook is
        registered at <code className="font-mono">/eve/v1/telegram</code> via{" "}
        <code className="font-mono">setWebhook</code> automatically.
      </div>
    )
  }
  return (
    <div className="border-t border-border pt-3 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
        Live — the webhook is registered at{" "}
        <code className="font-mono">/eve/v1/telegram</code>. The bot answers DMs
        and {channel.telegramBotUsername ? `@${channel.telegramBotUsername} ` : ""}
        group mentions.
      </span>
    </div>
  )
}

/**
 * Discord activation for an assigned channel. Like Telegram there is no manual
 * paste required: the agent's promote step registers the Interactions Endpoint
 * URL at /eve/v1/discord via the Discord REST API automatically. The URL is also
 * surfaced so the operator can paste it into the Discord Developer Portal as a
 * fallback and for (manual) slash-command setup.
 */
function DiscordStatus({
  channel,
  agent,
  building,
}: {
  channel: ClientChannel
  agent: Agent | null
  building: boolean
}) {
  const endpoint = discordInteractionsEndpointUrl(agent)
  const deployStatus = building ? "deploying" : (agent?.deploymentStatus ?? "none")

  if (deployStatus === "deploying") {
    return (
      <div className="flex items-center gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        Activating Discord — re-deploying the agent to register its interactions
        endpoint…
      </div>
    )
  }
  if (!endpoint.ready) {
    return (
      <div className="border-t border-border pt-3 text-xs text-muted-foreground">
        Deploy the agent to activate this Discord bot. On deploy, its interactions
        endpoint is registered at{" "}
        <code className="font-mono">/eve/v1/discord</code> via the Discord API
        automatically.
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
        Live — the interactions endpoint is registered at{" "}
        <code className="font-mono">/eve/v1/discord</code> via the Discord API.
      </span>
      <code className="min-w-0 overflow-x-auto rounded-md border border-border bg-secondary/60 px-2 py-1 font-mono text-[11px] text-muted-foreground">
        {endpoint.url}
      </code>
      <p>
        If it stays silent, paste this URL into your Discord application&apos;s{" "}
        <strong>Interactions Endpoint URL</strong> (Developer Portal) as a
        fallback, and register a slash command (a separate manual step).
      </p>
    </div>
  )
}

/**
 * Kapso activation for an assigned channel. Mirrors SlackStatus: a pure deploy
 * lifecycle view, no manual webhook step. On the agent's promote the webhook (+
 * its auto-minted signing secret) is registered with Kapso automatically via the
 * Platform API (registerKapsoWebhook → /kapso/webhook).
 */
function KapsoStatus({
  agent,
  building,
}: {
  channel: ClientChannel
  agent: Agent | null
  building: boolean
}) {
  const deployStatus = building ? "deploying" : (agent?.deploymentStatus ?? "none")

  if (deployStatus === "deploying") {
    return (
      <div className="flex items-center gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        Activating Kapso — re-deploying the agent to register its webhook…
      </div>
    )
  }
  if (deployStatus !== "deployed") {
    return (
      <div className="border-t border-border pt-3 text-xs text-muted-foreground">
        Deploy the agent to activate this WhatsApp number. On deploy, its webhook
        is registered with Kapso automatically at{" "}
        <code className="font-mono">/kapso/webhook</code> (no manual setup).
      </div>
    )
  }
  return (
    <div className="border-t border-border pt-3 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
        Live — the webhook is registered with Kapso at{" "}
        <code className="font-mono">/kapso/webhook</code>. The bot answers incoming
        WhatsApp messages.
      </span>
    </div>
  )
}
