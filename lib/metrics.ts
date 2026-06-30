import type { Message } from "@/lib/db/schema"

/**
 * Derives conversation-level metrics from a flat list of messages.
 *
 * @param messages - All messages to aggregate (typically scoped to a userId).
 * @param now - Reference timestamp injected for testability.
 */
export function conversationMetrics(
  messages: Message[],
  now: Date,
): {
  totalMessages: number
  conversations: number
  byRole: Record<string, number>
  byAgent: Record<string, number>
  last24h: number
} {
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000)

  const conversationIds = new Set<string>()
  const byRole: Record<string, number> = {}
  const byAgent: Record<string, number> = {}
  let last24h = 0

  for (const msg of messages) {
    conversationIds.add(msg.conversationId)

    byRole[msg.role] = (byRole[msg.role] ?? 0) + 1

    const agentKey = msg.agentId ?? "—"
    byAgent[agentKey] = (byAgent[agentKey] ?? 0) + 1

    if (msg.createdAt > cutoff) {
      last24h++
    }
  }

  return {
    totalMessages: messages.length,
    conversations: conversationIds.size,
    byRole,
    byAgent,
    last24h,
  }
}

/**
 * Resolves an agent id to its display name.
 *
 * Returns the mapped name when present; otherwise the id is returned unchanged
 * (covers both unknown ids and the "—" sentinel used for messages with no
 * agent).
 *
 * @param agentId - The raw agent id (or the "—" sentinel).
 * @param names - Map of agent id → name.
 */
export function resolveAgentName(
  agentId: string,
  names: Record<string, string>,
): string {
  return names[agentId] ?? agentId
}
