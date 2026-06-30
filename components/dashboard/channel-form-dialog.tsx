"use client"

import { useEffect, useId, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { PasswordInput } from "@/components/ui/password-input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  createChannel,
  updateChannel,
  getSlackConnectors,
  discoverKapsoPhoneNumbers,
} from "@/app/actions/channels"
import { RefreshCw, ExternalLink } from "lucide-react"
import type { Agent } from "@/lib/db/schema"
import type { ClientChannel } from "@/lib/channels/client-channel"
import type { KapsoPhoneNumber } from "@/lib/channels/kapso"
import { discordInteractionsEndpointUrl } from "@/lib/channels/webhook-url"

const NONE = "__none__"

export function ChannelFormDialog({
  open,
  onOpenChange,
  channel,
  defaultType = "kapso",
  agents,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  channel?: ClientChannel | null
  /** Pre-selected channel type for a fresh create (per-island "Add" CTAs). */
  defaultType?: string
  agents: Agent[]
  /** Called after a save that assigned an agent, so the list can show the build. */
  onSaved?: (channelId: string, agentId: string) => void
}) {
  const router = useRouter()
  const editing = Boolean(channel)
  const agentLabelId = useId()

  const [name, setName] = useState(channel?.name ?? "")
  // Channel type is fixed: an edit keeps the channel's type, a create inherits
  // the type of the island it was launched from. It is never user-editable here.
  const type = channel?.type ?? defaultType
  const [agentId, setAgentId] = useState(channel?.agentId ?? NONE)
  const [apiKey, setApiKey] = useState("")
  const [phoneNumberId, setPhoneNumberId] = useState(
    channel?.kapsoPhoneNumberId ?? "",
  )
  // The human display number that goes with the picked id (for the wa.me link).
  const [phoneNumber, setPhoneNumber] = useState(channel?.kapsoPhoneNumber ?? "")
  const [slackConnectUid, setSlackConnectUid] = useState(
    channel?.slackConnectUid ?? "",
  )
  const [telegramBotToken, setTelegramBotToken] = useState("")
  const [telegramWebhookSecretToken, setTelegramWebhookSecretToken] = useState("")
  const [telegramBotUsername, setTelegramBotUsername] = useState(
    channel?.telegramBotUsername ?? "",
  )
  // Discord: three secrets, all required from the portal (none auto-generated).
  const [discordBotToken, setDiscordBotToken] = useState("")
  const [discordApplicationId, setDiscordApplicationId] = useState("")
  const [discordPublicKey, setDiscordPublicKey] = useState("")
  const [loading, setLoading] = useState(false)

  // Kapso phone-number discovery: with the API key alone we can list the
  // project's numbers, so the operator picks one instead of pasting an id.
  const [kapsoNumbers, setKapsoNumbers] = useState<KapsoPhoneNumber[]>([])
  const [discovering, setDiscovering] = useState(false)
  const [discoverError, setDiscoverError] = useState<string | null>(null)

  const discoverNumbers = async () => {
    setDiscovering(true)
    setDiscoverError(null)
    try {
      const res = await discoverKapsoPhoneNumbers({
        apiKey: apiKey.trim() || undefined,
        channelId: channel?.id,
      })
      setKapsoNumbers(res.numbers)
      if (res.error) setDiscoverError(res.error)
      else if (res.numbers.length === 0)
        setDiscoverError("No phone numbers in this Kapso project")
    } catch {
      setDiscoverError("Failed to reach Kapso")
    } finally {
      setDiscovering(false)
    }
  }

  const isSlack = type === "slack"
  const isTelegram = type === "telegram"
  const isDiscord = type === "discord"
  const isKapso = !isSlack && !isTelegram && !isDiscord

  // Auto-discover numbers when editing a Kapso channel that already has a stored
  // key, so the Phone Number renders as a labelled picker (current number
  // preselected) instead of the raw phone_number_id. Uses the stored key via
  // channelId; the secret never reaches the browser.
  useEffect(() => {
    if (!(open && isKapso && channel?.id && channel.hasKapsoApiKey)) return
    let active = true
    queueMicrotask(async () => {
      setDiscovering(true)
      setDiscoverError(null)
      try {
        const res = await discoverKapsoPhoneNumbers({ channelId: channel.id })
        if (!active) return
        setKapsoNumbers(res.numbers)
        if (res.error) setDiscoverError(res.error)
      } catch {
        if (active) setDiscoverError("Failed to reach Kapso")
      } finally {
        if (active) setDiscovering(false)
      }
    })
    return () => {
      active = false
    }
  }, [open, isKapso, channel?.id, channel?.hasKapsoApiKey])

  // Create flow: auto-discover numbers shortly after the API key is pasted, so
  // the picker appears on its own, with no manual "Find my numbers" click and no
  // editable phone-number textbox. Debounced to coalesce paste/typing.
  useEffect(() => {
    if (editing || !isKapso) return
    const key = apiKey.trim()
    if (!key) return
    let active = true
    const timer = setTimeout(() => {
      setDiscovering(true)
      setDiscoverError(null)
      discoverKapsoPhoneNumbers({ apiKey: key })
        .then((res) => {
          if (!active) return
          setKapsoNumbers(res.numbers)
          if (res.error) setDiscoverError(res.error)
        })
        .catch(() => {
          if (active) setDiscoverError("Failed to reach Kapso")
        })
        .finally(() => {
          if (active) setDiscovering(false)
        })
    }, 600)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [apiKey, editing, isKapso])

  // Slack connector picker: list the team's connectors so the operator selects
  // one instead of pasting a UID. Manual entry stays available as a fallback.
  const [connectors, setConnectors] = useState<
    { uid: string; supportsTriggers: boolean }[]
  >([])
  const [createUrl, setCreateUrl] = useState<string | null>(null)
  const [loadingConnectors, setLoadingConnectors] = useState(false)
  const [manualEntry, setManualEntry] = useState(false)

  const loadConnectors = async () => {
    setLoadingConnectors(true)
    try {
      const res = await getSlackConnectors()
      setConnectors(res.connectors)
      setCreateUrl(res.createUrl)
    } catch {
      setConnectors([])
    } finally {
      setLoadingConnectors(false)
    }
  }

  useEffect(() => {
    if (!(open && isSlack)) return
    let active = true
    // Deferred so the initial setState isn't synchronous within the effect.
    queueMicrotask(async () => {
      setLoadingConnectors(true)
      try {
        const res = await getSlackConnectors()
        if (!active) return
        setConnectors(res.connectors)
        setCreateUrl(res.createUrl)
      } catch {
        if (active) setConnectors([])
      } finally {
        if (active) setLoadingConnectors(false)
      }
    })
    return () => {
      active = false
    }
  }, [open, isSlack])

  // The WhatsApp webhook is owned by the DEPLOYED AGENT (its own Eve runtime),
  // not the dashboard. Derive it from the currently-selected agent's deployment.
  const selectedAgent =
    agentId === NONE ? null : (agents.find((a) => a.id === agentId) ?? null)
  const discordEndpoint = discordInteractionsEndpointUrl(selectedAgent)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) {
      toast.error("Name is required")
      return
    }
    setLoading(true)
    try {
      // Secret fields (API key, webhook secret) are never pre-filled on edit so
      // the plaintext is not serialized to the client. A blank field in edit
      // mode therefore means "leave unchanged": send `undefined` so the server
      // preserves the stored value instead of clearing it. Non-secret fields are
      // always sent as-is.
      const apiKeyTrimmed = apiKey.trim()
      const tgBotTokenTrimmed = telegramBotToken.trim()
      const tgWebhookSecretTrimmed = telegramWebhookSecretToken.trim()
      const dcBotTokenTrimmed = discordBotToken.trim()
      const dcAppIdTrimmed = discordApplicationId.trim()
      const dcPublicKeyTrimmed = discordPublicKey.trim()
      const payload = isSlack
        ? {
            name: name.trim(),
            type: "slack",
            agentId: agentId === NONE ? null : agentId,
            slackConnectUid: slackConnectUid.trim() || null,
          }
        : isTelegram
          ? {
              name: name.trim(),
              type: "telegram",
              agentId: agentId === NONE ? null : agentId,
              telegramBotToken:
                editing && !tgBotTokenTrimmed ? undefined : tgBotTokenTrimmed,
              // Blank on create is fine; the server auto-generates the secret.
              telegramWebhookSecretToken:
                editing && !tgWebhookSecretTrimmed
                  ? undefined
                  : tgWebhookSecretTrimmed,
              telegramBotUsername: telegramBotUsername.trim() || null,
            }
          : isDiscord
          ? {
              name: name.trim(),
              type: "discord",
              agentId: agentId === NONE ? null : agentId,
              // All three are required (no auto-generate). Preserve-on-blank only
              // while editing so the stored secret is not cleared.
              discordBotToken:
                editing && !dcBotTokenTrimmed ? undefined : dcBotTokenTrimmed,
              discordApplicationId:
                editing && !dcAppIdTrimmed ? undefined : dcAppIdTrimmed,
              discordPublicKey:
                editing && !dcPublicKeyTrimmed ? undefined : dcPublicKeyTrimmed,
            }
          : {
            name: name.trim(),
            type: "kapso",
            agentId: agentId === NONE ? null : agentId,
            kapsoApiKey: editing && !apiKeyTrimmed ? undefined : apiKeyTrimmed,
            kapsoPhoneNumberId: phoneNumberId.trim(),
            kapsoPhoneNumber: phoneNumber.trim() || null,
            // The webhook secret is auto-minted server-side on create and
            // auto-registered with Kapso on promote, never entered here.
          }
      const assignedAgentId = agentId === NONE ? null : agentId
      let savedChannelId: string
      if (editing && channel) {
        await updateChannel(channel.id, payload)
        savedChannelId = channel.id
        toast.success("Channel updated")
      } else {
        savedChannelId = await createChannel(payload)
        toast.success("Channel created")
      }
      // Assigning an agent triggers a background (re)deploy. Tell the parent so
      // the row shows the build immediately (the agent's stored status is stale).
      if (assignedAgentId) onSaved?.(savedChannelId, assignedAgentId)
      onOpenChange(false)
      router.refresh()
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not save the channel",
      )
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {editing
              ? "Edit channel"
              : isSlack
                ? "New Slack channel"
                : isTelegram
                  ? "New Telegram channel"
                  : isDiscord
                    ? "New Discord channel"
                    : "New WhatsApp channel"}
          </DialogTitle>
          <DialogDescription>
            {isSlack
              ? "Run an agent as a Slack bot. Credentials are brokered by Vercel Connect."
              : isTelegram
                ? "Run an agent as a Telegram bot. The webhook is registered automatically on deploy."
                : isDiscord
                  ? "Run an agent as a Discord bot. The interactions endpoint is registered automatically on deploy."
                  : "Connect a WhatsApp number via Kapso and assign an agent to it."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {/* Channel type is fixed by the island the create was launched from
              (the title already names it), so there is no type picker here. */}

          <div className="flex flex-col gap-2">
            <Label htmlFor="ch-name">Channel name</Label>
            <Input
              id="ch-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={
                isSlack
                  ? "Soporte"
                  : isTelegram
                    ? "Telegram Bot"
                    : isDiscord
                      ? "Discord Bot"
                      : "WhatsApp Support"
              }
              required
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label id={agentLabelId} htmlFor="ch-agent">
              Assigned agent
            </Label>
            <Select
              items={[
                { value: NONE, label: "No agent" },
                ...agents.map((a) => ({ value: a.id, label: a.name })),
              ]}
              value={agentId}
              onValueChange={(v) => setAgentId(v ?? NONE)}
            >
              <SelectTrigger
                id="ch-agent"
                aria-labelledby={agentLabelId}
                className="w-full"
              >
                <SelectValue placeholder="No agent" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>No agent</SelectItem>
                {agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {agents.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Create an agent first to be able to assign it.
              </p>
            )}
          </div>

          {isSlack && (
            <div className="flex flex-col gap-3 rounded-xl border border-border p-4">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="ch-slack-uid">Slack connector</Label>
                <div className="flex items-center gap-3 text-xs">
                  {createUrl && (
                    <a
                      href={createUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-foreground underline underline-offset-4"
                    >
                      Create connector
                      <ExternalLink className="h-3 w-3" aria-hidden="true" />
                    </a>
                  )}
                  <button
                    type="button"
                    onClick={() => void loadConnectors()}
                    className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                    aria-label="Refresh connectors"
                  >
                    <RefreshCw
                      className={`h-3 w-3 ${loadingConnectors ? "animate-spin" : ""}`}
                      aria-hidden="true"
                    />
                    Refresh
                  </button>
                </div>
              </div>

              {manualEntry || (connectors.length === 0 && !loadingConnectors) ? (
                <Input
                  id="ch-slack-uid"
                  value={slackConnectUid}
                  onChange={(e) => setSlackConnectUid(e.target.value)}
                  placeholder="slack/soporte"
                  autoComplete="off"
                  className="font-mono"
                />
              ) : (
                <Select
                  items={connectors.map((c) => ({
                    value: c.uid,
                    label: c.supportsTriggers ? c.uid : `${c.uid} (no triggers)`,
                  }))}
                  value={slackConnectUid}
                  onValueChange={(v) => setSlackConnectUid(v ?? "")}
                >
                  <SelectTrigger id="ch-slack-uid" className="w-full font-mono">
                    <SelectValue placeholder="Select a Slack connector" />
                  </SelectTrigger>
                  <SelectContent>
                    {connectors.map((c) => (
                      <SelectItem key={c.uid} value={c.uid}>
                        {c.supportsTriggers ? c.uid : `${c.uid} (no triggers)`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}

              {connectors.length > 0 && (
                <button
                  type="button"
                  onClick={() => setManualEntry((m) => !m)}
                  className="self-start text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
                >
                  {manualEntry ? "Pick from list" : "Enter UID manually"}
                </button>
              )}

              {slackConnectUid &&
                connectors.find((c) => c.uid === slackConnectUid)
                  ?.supportsTriggers === false && (
                  <p className="text-xs text-warning">
                    This connector has no triggers enabled — Slack won&apos;t
                    deliver events. Create it with triggers (the bot stays silent
                    otherwise).
                  </p>
                )}

              <p className="text-xs text-muted-foreground">
                No connector yet? Click <strong>Create connector</strong>, pick
                Slack, enable <strong>Triggers</strong>, install it in your
                workspace, then <strong>Refresh</strong> and select it. On deploy
                the agent is attached and Slack events route to{" "}
                <code>/eve/v1/slack</code> automatically.
              </p>
            </div>
          )}

          {isTelegram && (
            <div className="rounded-xl border border-border p-4">
              <p className="mb-3 text-sm font-medium text-foreground">
                Telegram credentials
              </p>
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="ch-tg-token">Bot Token</Label>
                  <PasswordInput
                    id="ch-tg-token"
                    value={telegramBotToken}
                    onChange={(e) => setTelegramBotToken(e.target.value)}
                    placeholder="123456:ABC-DEF..."
                    autoComplete="off"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="ch-tg-secret">Webhook Secret Token</Label>
                  <PasswordInput
                    id="ch-tg-secret"
                    value={telegramWebhookSecretToken}
                    onChange={(e) =>
                      setTelegramWebhookSecretToken(e.target.value)
                    }
                    placeholder="Leave blank to auto-generate"
                    autoComplete="off"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="ch-tg-username">Bot username (optional)</Label>
                  <Input
                    id="ch-tg-username"
                    value={telegramBotUsername}
                    onChange={(e) => setTelegramBotUsername(e.target.value)}
                    placeholder="my_bot"
                    autoComplete="off"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  eve registers the webhook at{" "}
                  <code>/eve/v1/telegram</code> via <code>setWebhook</code> when
                  you deploy the assigned agent. No manual step required.
                </p>
              </div>
            </div>
          )}

          {isDiscord && (
            <div className="rounded-xl border border-border p-4">
              <p className="mb-3 text-sm font-medium text-foreground">
                Discord credentials
              </p>
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="ch-dc-token">Bot Token</Label>
                  <PasswordInput
                    id="ch-dc-token"
                    value={discordBotToken}
                    onChange={(e) => setDiscordBotToken(e.target.value)}
                    placeholder="Discord bot token"
                    autoComplete="off"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="ch-dc-appid">Application ID</Label>
                  <PasswordInput
                    id="ch-dc-appid"
                    value={discordApplicationId}
                    onChange={(e) => setDiscordApplicationId(e.target.value)}
                    placeholder="Application (client) ID"
                    autoComplete="off"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="ch-dc-pubkey">Public Key</Label>
                  <PasswordInput
                    id="ch-dc-pubkey"
                    value={discordPublicKey}
                    onChange={(e) => setDiscordPublicKey(e.target.value)}
                    placeholder="Ed25519 public key"
                    autoComplete="off"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  All three come from the Discord Developer Portal (no
                  auto-generate). eve registers the Interactions Endpoint URL at{" "}
                  <code>/eve/v1/discord</code> via the Discord API when you deploy
                  the assigned agent. You can also paste it into the portal
                  manually:
                </p>
                <code className="overflow-x-auto rounded-md border border-border bg-secondary px-3 py-2 font-mono text-xs text-muted-foreground">
                  {discordEndpoint.ready
                    ? discordEndpoint.url
                    : "Available after you deploy the assigned agent"}
                </code>
              </div>
            </div>
          )}

          {!isSlack && !isTelegram && !isDiscord && (
          <>
          <div className="rounded-xl border border-border p-4">
            <p className="mb-3 text-sm font-medium text-foreground">
              Kapso credentials
            </p>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="ch-apikey">API Key</Label>
                <PasswordInput
                  id="ch-apikey"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="kapso_..."
                  autoComplete="off"
                />
              </div>
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="ch-phone">Phone Number</Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1.5 text-xs"
                    onClick={discoverNumbers}
                    disabled={discovering || (!apiKey.trim() && !editing)}
                  >
                    <RefreshCw
                      className={`h-3 w-3 ${discovering ? "animate-spin" : ""}`}
                    />
                    {discovering ? "Finding…" : "Find my numbers"}
                  </Button>
                </div>
                {/* The number is ALWAYS a picker, never an editable textbox. The
                    list shows up once the API key is pasted (auto-discovered) or
                    via "Find my numbers"; before that, a disabled hint. */}
                {kapsoNumbers.length > 0 ? (
                  <Select
                    items={kapsoNumbers.map((n) => ({
                      label: n.label,
                      value: n.phoneNumberId,
                    }))}
                    value={phoneNumberId}
                    onValueChange={(v) => {
                      const id = v ?? ""
                      setPhoneNumberId(id)
                      setPhoneNumber(
                        kapsoNumbers.find((n) => n.phoneNumberId === id)
                          ?.phoneNumber ?? "",
                      )
                    }}
                  >
                    <SelectTrigger id="ch-phone" className="w-full">
                      <SelectValue placeholder="Select a phone number" />
                    </SelectTrigger>
                    <SelectContent>
                      {kapsoNumbers.map((n) => (
                        <SelectItem key={n.phoneNumberId} value={n.phoneNumberId}>
                          {n.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    id="ch-phone"
                    disabled
                    value=""
                    placeholder={
                      discovering
                        ? "Loading your numbers…"
                        : "Paste your API key to load numbers"
                    }
                  />
                )}
                {discoverError && (
                  <p className="text-xs text-muted-foreground">{discoverError}</p>
                )}
              </div>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              The webhook secret is generated for you and registered with Kapso
              automatically when the assigned agent deploys — no manual webhook
              setup needed.
            </p>
          </div>
          </>
          )}

          <DialogFooter className="mt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading
                ? "Saving..."
                : editing
                  ? "Save changes"
                  : "Create channel"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
