"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { PageHeader } from "@/components/dashboard/page-header"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { PasswordInput } from "@/components/ui/password-input"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  createConnection,
  createOAuthConnection,
  updateConnection,
  deleteConnection,
} from "@/app/actions/connections"
import type { ClientConnection } from "@/lib/mcp/client-connection"
import { MCP_CATALOG, type McpCatalogEntry } from "@/lib/mcp-catalog"
import {
  Plug,
  Plus,
  MoreVertical,
  Pencil,
  Trash2,
  Check,
  ExternalLink,
  Search,
} from "lucide-react"

type Transport = "http" | "sse" | "stdio"

// Normalize a URL for comparing catalog entries with already-created
// connections (ignores trailing slash and case).
function normalizeUrl(url: string) {
  return url.trim().replace(/\/+$/, "").toLowerCase()
}

// Set of normalized catalog URLs whose auth method is OAuth, so we can tell
// which installed connections expose the Connect/Reconnect flow. Excludes
// Vercel-Connect-backed entries (e.g. Slack): they have no add-time DCR flow —
// consent happens at runtime via Vercel Connect — so they must NOT show the
// (broken) Connect button that points at /api/mcp/<id>/connect.
const OAUTH_CATALOG_URLS = new Set(
  MCP_CATALOG.filter((e) => e.auth === "oauth" && !e.vercelConnect).map((e) =>
    normalizeUrl(e.url),
  ),
)

function isOAuthConnection(connection: ClientConnection): boolean {
  return OAUTH_CATALOG_URLS.has(normalizeUrl(connection.url))
}

const TRANSPORT_ITEMS = [
  { value: "http", label: "HTTP" },
  { value: "sse", label: "SSE" },
  { value: "stdio", label: "stdio (dev only)" },
]

const TRANSPORT_LABEL: Record<Transport, string> = {
  http: "HTTP",
  sse: "SSE",
  stdio: "stdio",
}

type Prefill = {
  name: string
  transport: Transport
  url: string
  auth: "none" | "token" | "oauth"
  docsUrl?: string
}

function ConnectionFormDialog({
  open,
  onOpenChange,
  connection,
  prefill,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  connection: ClientConnection | null
  prefill?: Prefill | null
}) {
  const router = useRouter()
  const editing = Boolean(connection)
  const [name, setName] = useState(connection?.name ?? prefill?.name ?? "")
  const [transport, setTransport] = useState<Transport>(
    (connection?.transport as Transport) ?? prefill?.transport ?? "http",
  )
  const [url, setUrl] = useState(connection?.url ?? prefill?.url ?? "")
  // The stored token is never sent to the browser, so the field starts empty
  // when editing. A blank field on save means "keep the existing token".
  const [token, setToken] = useState("")
  const [loading, setLoading] = useState(false)
  const authHint = prefill?.auth

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) {
      toast.error("Name is required")
      return
    }
    setLoading(true)
    try {
      const trimmedToken = token.trim()
      if (editing && connection) {
        await updateConnection(connection.id, {
          name: name.trim(),
          transport,
          url: url.trim(),
          // Blank field → undefined → keep the existing token untouched.
          token: trimmedToken === "" ? undefined : trimmedToken,
        })
        toast.success("Connection updated")
      } else {
        await createConnection({
          name: name.trim(),
          transport,
          url: url.trim(),
          token: trimmedToken || null,
        })
        toast.success("Connection created")
      }
      onOpenChange(false)
      router.refresh()
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not save the connection",
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
            {editing ? "Edit MCP connection" : "New MCP connection"}
          </DialogTitle>
          <DialogDescription>
            An external MCP server that provides tools to the agent. Assign it
            later to the agents that need it.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="mcp-name">Name</Label>
            <Input
              id="mcp-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="linear"
              className="font-mono"
              required
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="mcp-transport">Transport</Label>
            <Select
              items={TRANSPORT_ITEMS}
              value={transport}
              onValueChange={(v) => setTransport((v ?? "http") as Transport)}
            >
              <SelectTrigger id="mcp-transport" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="http">HTTP</SelectItem>
                <SelectItem value="sse">SSE</SelectItem>
                <SelectItem value="stdio">stdio (dev only)</SelectItem>
              </SelectContent>
            </Select>
            {transport === "stdio" && (
              <p className="text-xs text-muted-foreground/70">
                stdio launches a local process — does not run on serverless. Use
                it only in development.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="mcp-url">URL / command</Label>
            <Input
              id="mcp-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://mcp.example.com/sse"
              className="font-mono"
            />
          </div>

          {authHint === "oauth" && (
            <div className="rounded-lg border border-dashed border-border bg-secondary/40 p-3 text-xs text-muted-foreground">
              Requires authentication; paste an access token if your server
              supports it.
              {prefill?.docsUrl && (
                <>
                  {" "}
                  <a
                    href={prefill.docsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-foreground underline underline-offset-4"
                  >
                    View documentation
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </a>
                </>
              )}
            </div>
          )}

          <div className="flex flex-col gap-2">
            <Label htmlFor="mcp-token">Token (optional)</Label>
            <PasswordInput
              id="mcp-token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={
                editing && connection?.hasToken
                  ? "•••••••• (leave blank to keep)"
                  : "••••••••"
              }
              className="font-mono"
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground/70">
              Sent as an authorization header (Bearer).
              {editing && connection?.hasToken
                ? " Leave it blank to keep the current token."
                : null}
            </p>
          </div>

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
                  : "Create connection"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const AUTH_LABEL: Record<McpCatalogEntry["auth"], string> = {
  none: "No auth",
  token: "Token",
  oauth: "OAuth",
}

function CatalogSection({
  connectionByUrl,
  addingId,
  onAdd,
  onEdit,
  onDelete,
}: {
  connectionByUrl: Map<string, ClientConnection>
  addingId: string | null
  onAdd: (entry: McpCatalogEntry) => void
  onEdit: (connection: ClientConnection) => void
  onDelete: (connection: ClientConnection) => void
}) {
  const [query, setQuery] = useState("")
  const q = query.trim().toLowerCase()
  const filtered = useMemo(() => {
    // note: Slack hidden from the MCP list for now (it stays a channel).
    // Re-show by dropping the id from this filter.
    const visible = MCP_CATALOG.filter((e) => e.id !== "slack")
    return q
      ? visible.filter(
          (e) =>
            e.name.toLowerCase().includes(q) ||
            e.description.toLowerCase().includes(q),
        )
      : visible
  }, [q])

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h2 className="text-sm font-medium text-foreground">Popular</h2>
          <p className="text-sm text-muted-foreground">
            Well-known MCP servers. Add them with one click; those requiring
            auth are pre-filled so you can paste your token.
          </p>
        </div>
        <div className="relative sm:w-64">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search server..."
            className="pl-9"
            aria-label="Search MCP server"
          />
        </div>
      </div>
      {filtered.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No servers match &quot;{query}&quot;.
        </p>
      ) : (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {filtered.map((entry) => {
          const connection = connectionByUrl.get(normalizeUrl(entry.url))
          const adding = addingId === entry.id
          return (
            <div
              key={entry.id}
              className="flex flex-col gap-3 rounded-xl border border-border p-4 transition-colors duration-150 hover:border-[rgba(255,255,255,0.2)]"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="truncate font-mono text-sm font-medium text-foreground">
                  {entry.name}
                </p>
                <div className="flex shrink-0 items-center gap-1">
                  <span className="inline-flex items-center rounded-md border border-border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {TRANSPORT_LABEL[entry.transport]}
                  </span>
                  <span className="inline-flex items-center rounded-md border border-dashed border-border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {AUTH_LABEL[entry.auth]}
                  </span>
                  {connection && (
                    <ConnectionMenu
                      connection={connection}
                      onEdit={onEdit}
                      onDelete={onDelete}
                    />
                  )}
                </div>
              </div>
              <p className="min-h-[2.5rem] text-xs leading-relaxed text-muted-foreground">
                {entry.description}
              </p>
              {connection ? (
                <div className="mt-auto flex flex-wrap items-center gap-2">
                  <ConnectionStatusRow connection={connection} />
                </div>
              ) : (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="mt-auto w-full gap-2"
                  disabled={adding}
                  onClick={() => onAdd(entry)}
                >
                  {adding ? (
                    "Adding..."
                  ) : (
                    <>
                      <Plus className="h-4 w-4" aria-hidden="true" />
                      Add
                    </>
                  )}
                </Button>
              )}
            </div>
          )
        })}
      </div>
      )}
    </section>
  )
}

// Per-connection status pill. Only OAuth connections surface a live status;
// token/none servers stay at `idle` and show nothing here (their existing
// "with token" / transport badges already describe them).
function ConnectionStatusPill({ connection }: { connection: ClientConnection }) {
  const status = connection.status
  if (!isOAuthConnection(connection)) return null

  const styles: Record<string, string> = {
    connected: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
    needs_auth: "border-amber-500/40 bg-amber-500/10 text-amber-400",
    connecting: "border-border bg-secondary/60 text-muted-foreground",
    failed: "border-red-500/40 bg-red-500/10 text-red-400",
    idle: "border-border bg-secondary/60 text-muted-foreground",
  }
  const labels: Record<string, string> = {
    connected: "Connected",
    needs_auth: "Needs auth",
    connecting: "Connecting…",
    failed: "Failed",
    idle: "Idle",
  }

  return (
    <span
      title={status === "failed" ? connection.oauthError ?? undefined : undefined}
      className={`inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium ${
        styles[status] ?? styles.idle
      }`}
    >
      {labels[status] ?? status}
    </span>
  )
}

// Edit/Delete dropdown shared by the catalog cards (once connected) and the
// custom-connections cards.
function ConnectionMenu({
  connection,
  onEdit,
  onDelete,
}: {
  connection: ClientConnection
  onEdit: (connection: ClientConnection) => void
  onDelete: (connection: ClientConnection) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            aria-label="Connection options"
          >
            <MoreVertical className="h-4 w-4" />
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onEdit(connection)}>
          <Pencil className="mr-2 h-4 w-4" />
          Edit
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          onClick={() => onDelete(connection)}
        >
          <Trash2 className="mr-2 h-4 w-4" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// Footer status badges + Connect/Reconnect button for an installed connection.
// OAuth servers show the live status pill; others show a plain "Connected".
function ConnectionStatusRow({ connection }: { connection: ClientConnection }) {
  const oauth = isOAuthConnection(connection)
  return (
    <>
      {connection.hasToken ? (
        <span className="inline-flex items-center rounded-md border border-border bg-secondary/60 px-2 py-1 text-xs text-muted-foreground">
          with token
        </span>
      ) : null}
      {oauth ? (
        <ConnectionStatusPill connection={connection} />
      ) : (
        <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-xs font-medium text-emerald-400">
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
          Added
        </span>
      )}
      {oauth && connection.status !== "connected" ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="ml-auto h-7 gap-1.5 px-2 text-xs"
          disabled={connection.status === "connecting"}
          onClick={() => {
            window.location.href = `/api/mcp/${connection.id}/connect`
          }}
        >
          <Plug className="h-3.5 w-3.5" aria-hidden="true" />
          {connection.status === "failed" ? "Reconnect" : "Connect"}
        </Button>
      ) : null}
    </>
  )
}

export function McpView({
  initialConnections,
  vercelCard,
}: {
  initialConnections: ClientConnection[]
  // Server-rendered Vercel connect card, passed in as a slot so this client
  // component does not need to read server-only state (stored OAuth / env).
  vercelCard?: React.ReactNode
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<ClientConnection | null>(null)
  const [prefill, setPrefill] = useState<Prefill | null>(null)
  const [toDelete, setToDelete] = useState<ClientConnection | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [addingId, setAddingId] = useState<string | null>(null)

  // Surface the OAuth redirect result (?connected=1|0&cid=...), then strip the
  // query params and refresh so the status pills reflect the new state.
  useEffect(() => {
    const connected = searchParams.get("connected")
    if (connected !== "1" && connected !== "0") return
    const cid = searchParams.get("cid")
    if (connected === "1") {
      toast.success("MCP server connected")
    } else {
      const failed = cid
        ? initialConnections.find((c) => c.id === cid)
        : undefined
      toast.error(failed?.oauthError || "Could not connect the MCP server")
    }
    router.replace("/mcp")
    router.refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  // Surface the Vercel integration redirect result (?vercel=connected|error),
  // then strip the flag and refresh so the connect card reflects the new state.
  useEffect(() => {
    const vercel = searchParams.get("vercel")
    if (vercel !== "connected" && vercel !== "error") return
    if (vercel === "connected") {
      toast.success("Vercel connected")
    } else {
      toast.error("Could not connect Vercel")
    }
    router.replace("/mcp")
    router.refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  // Map normalized URL → connection, so each catalog entry can render its own
  // connected state inline instead of duplicating it under "Your connections".
  const connectionByUrl = useMemo(
    () => new Map(initialConnections.map((c) => [normalizeUrl(c.url), c])),
    [initialConnections],
  )

  // Connections that don't match any catalog entry — these still need their own
  // section (the catalog can't render them).
  const customConnections = useMemo(() => {
    const catalogUrls = new Set(MCP_CATALOG.map((e) => normalizeUrl(e.url)))
    return initialConnections.filter(
      (c) => !catalogUrls.has(normalizeUrl(c.url)),
    )
  }, [initialConnections])

  const openCreate = () => {
    setEditing(null)
    setPrefill(null)
    setDialogOpen(true)
  }

  const openEdit = (connection: ClientConnection) => {
    setEditing(connection)
    setPrefill(null)
    setDialogOpen(true)
  }

  const handleCatalogAdd = async (entry: McpCatalogEntry) => {
    if (connectionByUrl.has(normalizeUrl(entry.url))) return
    // auth "none" → direct creation with one click
    if (entry.auth === "none") {
      setAddingId(entry.id)
      try {
        await createConnection({
          name: entry.name.toLowerCase(),
          transport: entry.transport,
          url: entry.url,
          token: null,
        })
        toast.success("Connection created")
        router.refresh()
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Could not create the connection",
        )
      } finally {
        setAddingId(null)
      }
      return
    }
    // Vercel-Connect-backed (e.g. Slack: OAuth without DCR) → just create the
    // row. There is no browser OAuth flow at add-time; per-end-user consent
    // happens at runtime via Vercel Connect (surfaced as an authorization.url),
    // and the deploy attaches the connector to the agent's project.
    if (entry.vercelConnect) {
      setAddingId(entry.id)
      try {
        await createConnection({
          name: entry.name.toLowerCase(),
          transport: entry.transport,
          url: entry.url,
          token: null,
        })
        toast.success("Connection created")
        router.refresh()
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Could not create the connection",
        )
      } finally {
        setAddingId(null)
      }
      return
    }
    // auth "oauth" → create the row, then start the browser OAuth flow.
    if (entry.auth === "oauth") {
      setAddingId(entry.id)
      try {
        const id = await createOAuthConnection(entry.id)
        // Navigate through discovery → authorization server → callback.
        window.location.href = `/api/mcp/${id}/connect`
      } catch (err) {
        toast.error(
          err instanceof Error
            ? err.message
            : "Could not start the OAuth connection",
        )
        setAddingId(null)
      }
      return
    }
    // auth "token" → open the pre-filled dialog
    setEditing(null)
    setPrefill({
      name: entry.name.toLowerCase(),
      transport: entry.transport,
      url: entry.url,
      auth: entry.auth,
      docsUrl: entry.docsUrl,
    })
    setDialogOpen(true)
  }

  const confirmDelete = async () => {
    if (!toDelete) return
    setDeleting(true)
    try {
      await deleteConnection(toDelete.id)
      toast.success("Connection deleted")
      setToDelete(null)
      router.refresh()
    } catch {
      toast.error("Could not delete the connection")
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <PageHeader
        title="MCP"
        description="Reusable MCP servers that provide external tools. Define them once and assign them to any agent."
        action={
          <Button onClick={openCreate} className="gap-2">
            <Plus className="h-4 w-4" aria-hidden="true" />
            New connection
          </Button>
        }
      />

      <div className="flex flex-col gap-8">
        {vercelCard}

        <CatalogSection
          connectionByUrl={connectionByUrl}
          addingId={addingId}
          onAdd={handleCatalogAdd}
          onEdit={openEdit}
          onDelete={setToDelete}
        />

        {customConnections.length > 0 && (
          <section className="flex flex-col gap-4">
            <h2 className="text-sm font-medium text-foreground">
              Your connections
            </h2>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {customConnections.map((connection) => {
            const transport = connection.transport as Transport
            return (
              <div
                key={connection.id}
                className="group flex flex-col gap-4 rounded-xl border border-border p-5 transition-colors duration-150 hover:border-[rgba(255,255,255,0.2)]"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-secondary">
                      <Plug
                        className="h-5 w-5 text-foreground"
                        aria-hidden="true"
                      />
                    </div>
                    <div className="min-w-0">
                      <p className="truncate font-mono font-medium text-foreground">
                        {connection.name}
                      </p>
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        {connection.url || "no url"}
                      </p>
                    </div>
                  </div>
                  <ConnectionMenu
                    connection={connection}
                    onEdit={openEdit}
                    onDelete={setToDelete}
                  />
                </div>

                <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
                  <span className="inline-flex items-center rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground">
                    {TRANSPORT_LABEL[transport] ?? transport}
                  </span>
                  {transport === "stdio" && (
                    <span className="inline-flex items-center rounded-md border border-dashed border-border px-2 py-1 text-xs text-muted-foreground">
                      dev only
                    </span>
                  )}
                  <ConnectionStatusRow connection={connection} />
                </div>
              </div>
            )
          })}
            </div>
          </section>
        )}
      </div>

      <ConnectionFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        connection={editing}
        prefill={prefill}
        key={editing?.id ?? prefill?.url ?? "new"}
      />

      <ConfirmDialog
        open={Boolean(toDelete)}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="Delete connection"
        description={
          toDelete ? (
            <>
              You are about to delete{" "}
              <span className="font-medium text-foreground">
                {toDelete.name}
              </span>
              . Agents that have it assigned will stop using it. This action
              cannot be undone.
            </>
          ) : null
        }
        confirmLabel="Delete connection"
        onConfirm={confirmDelete}
        loading={deleting}
      />
    </>
  )
}
