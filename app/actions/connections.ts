"use server"

import { db } from "@/lib/db"
import { connections } from "@/lib/db/schema"
import { requireUserId } from "@/lib/session"
import { MCP_CATALOG } from "@/lib/mcp-catalog"
import { getConnections } from "@/lib/mcp/get-connections"
import { assertPublicHttpUrl } from "@/lib/mcp/ssrf-guard"
import {
  toClientConnection,
  type ClientConnection,
} from "@/lib/mcp/client-connection"
import { and, eq } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { randomUUID } from "crypto"

const TRANSPORTS = new Set(["http", "sse", "stdio"])
const MAX_NAME_LENGTH = 80
const MAX_URL_LENGTH = 2048
const MAX_TOKEN_LENGTH = 8000

function text(value: unknown, max: number): string {
  return (typeof value === "string" ? value : "").trim().slice(0, max)
}

// Defense-in-depth: in production, refuse to STORE a remote MCP URL that points
// at an internal/non-public host, so it can never reach the connect/refresh SSRF
// paths. Skipped in dev so local MCP servers (http://localhost) still work; the
// connect/refresh-time guard remains the hard boundary either way.
async function assertStorableUrl(input: ConnectionInput): Promise<void> {
  if (input.transport === "stdio") return
  if (process.env.NODE_ENV !== "production") return
  await assertPublicHttpUrl(input.url)
}

function normalizeConnectionInput(input: ConnectionInput): ConnectionInput {
  const name = text(input.name, MAX_NAME_LENGTH)
  if (!name) throw new Error("Name is required")
  if (!TRANSPORTS.has(input.transport)) {
    throw new Error("Unsupported MCP transport")
  }

  const url = text(input.url, MAX_URL_LENGTH)
  if (!url) throw new Error("Connection URL is required")

  if (input.transport === "http" || input.transport === "sse") {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error("Connection URL must be a valid URL")
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("Connection URL must use HTTP or HTTPS")
    }
    if (process.env.NODE_ENV === "production" && parsed.protocol !== "https:") {
      throw new Error("Remote MCP connections must use HTTPS in production")
    }
  }

  return {
    name,
    transport: input.transport,
    url,
    token:
      input.token === undefined
        ? undefined
        : input.token === null
          ? null
          : text(input.token, MAX_TOKEN_LENGTH),
  }
}

/**
 * Browser-safe read for client components. Projects every row through
 * `toClientConnection`, which strips all tokens and OAuth secrets so nothing
 * sensitive is serialized into the RSC/HTML payload sent to the browser.
 *
 * note: the full-row reader (`getConnections`, with tokens) lives in
 * `lib/mcp/get-connections.ts` — NOT here — so it never becomes a
 * browser-callable server action.
 */
export async function getConnectionsForClient(): Promise<ClientConnection[]> {
  const rows = await getConnections()
  return rows.map(toClientConnection)
}

export type ConnectionInput = {
  name: string
  transport: "http" | "sse" | "stdio"
  url: string
  // `null` clears the stored token; `undefined` (omitted) leaves it unchanged
  // on update. The token itself is never sent to the browser, so the edit form
  // sends `undefined` unless the user explicitly typed a new value.
  token?: string | null
}

export async function createConnection(input: ConnectionInput) {
  const userId = await requireUserId()
  const next = normalizeConnectionInput(input)
  await assertStorableUrl(next)
  const id = randomUUID()
  await db.insert(connections).values({
    id,
    userId,
    name: next.name,
    transport: next.transport,
    url: next.url,
    token: next.token || null,
  })
  revalidatePath("/mcp")
  // Agent detail pages render the connection list — keep them fresh too.
  revalidatePath("/agents/[id]", "page")
  return id
}

/**
 * Create a connection row for an OAuth MCP catalog entry, ready to start the
 * authorization flow. Does NOT run discovery — the connect route owns the
 * OAuth flow. Returns the new connection id so the caller can navigate to
 * `/api/mcp/<id>/connect`.
 */
export async function createOAuthConnection(catalogId: string): Promise<string> {
  const userId = await requireUserId()
  const entry = MCP_CATALOG.find((e) => e.id === catalogId)
  if (!entry) {
    throw new Error(`Unknown MCP catalog entry: ${catalogId}`)
  }
  if (entry.auth !== "oauth") {
    throw new Error(`Catalog entry "${catalogId}" is not an OAuth server`)
  }

  const id = randomUUID()
  await db.insert(connections).values({
    id,
    userId,
    name: entry.name.toLowerCase(),
    transport: entry.transport,
    url: entry.url,
    oauthScope: entry.oauthScopes ?? null,
    status: "needs_auth",
  })
  revalidatePath("/mcp")
  // Agent detail pages render the connection list — keep them fresh too.
  revalidatePath("/agents/[id]", "page")
  return id
}

export async function updateConnection(id: string, input: ConnectionInput) {
  const userId = await requireUserId()
  const next = normalizeConnectionInput(input)
  await assertStorableUrl(next)
  await db
    .update(connections)
    .set({
      name: next.name,
      transport: next.transport,
      url: next.url,
      // Only touch the token when the caller provided a value (string to set,
      // or explicit null to clear). `undefined` means "keep the existing
      // token" — needed because the token is never shipped to the client, so
      // the edit form cannot round-trip it.
      ...(next.token !== undefined ? { token: next.token || null } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(connections.id, id), eq(connections.userId, userId)))
  revalidatePath("/mcp")
  // Agent detail pages render the connection list — keep them fresh too.
  revalidatePath("/agents/[id]", "page")
}

export async function deleteConnection(id: string) {
  const userId = await requireUserId()
  await db
    .delete(connections)
    .where(and(eq(connections.id, id), eq(connections.userId, userId)))
  revalidatePath("/mcp")
  // Agent detail pages render the connection list — keep them fresh too.
  revalidatePath("/agents/[id]", "page")
}
