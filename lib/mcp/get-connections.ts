import "server-only"
import { cache } from "react"
import { db } from "@/lib/db"
import { connections } from "@/lib/db/schema"
import { requireUserId } from "@/lib/session"
import { desc, eq } from "drizzle-orm"

/**
 * SERVER-ONLY full-row read. Includes secret OAuth artifacts and the static
 * bearer token. Lives in a plain module (NOT a "use server" file) on purpose:
 * exporting it from an action module would publish it as a browser-callable
 * endpoint that leaks tokens. Only server contexts that open MCP clients
 * (agent chat → lib/agent.ts, deploy) may import this. UI must use
 * `getConnectionsForClient()`.
 *
 * Request-deduped via React cache(): the detail page hits it twice per render.
 */
export const getConnections = cache(async () => {
  const userId = await requireUserId()
  return db
    .select()
    .from(connections)
    .where(eq(connections.userId, userId))
    .orderBy(desc(connections.createdAt))
})
