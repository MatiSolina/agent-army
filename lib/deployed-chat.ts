// LIVE TEST transport for the agent editor's "Test" tab. Chats with the agent's
// REAL deployed Eve project on Vercel (NOT an in-dashboard simulator). The front
// keeps the Chat SDK web adapter (AI SDK useChat protocol); only the SOURCE of
// the reply changed: instead of a local simulator we proxy to the deployed
// agent via lib/eve/session-client.
import { Chat } from "chat"
import { createWebAdapter } from "@chat-adapter/web"
import { createMemoryState } from "@chat-adapter/state-memory"
import { sendToDeployedAgent } from "@/lib/eve/session-client"
import type { Agent } from "@/lib/db/schema"

// note: in-memory map of web thread id -> {sessionId, continuationToken},
// for multi-turn continuity (Eve follow-ups REQUIRE the continuation token).
// Resets on server restart (fine for a test tab). Persist (e.g. to a table) only
// if testers ever need durable transcripts across restarts.
const sessions = new Map<string, { sessionId: string; continuationToken?: string }>()

/**
 * Build a Chat instance that serves a browser chat UI (AI SDK useChat protocol)
 * for testing a single agent against its LIVE deployed Eve runtime.
 *
 * The caller must only build this for a deployed agent (deploymentStatus
 * "deployed" + a deploymentUrl); the route guards that and returns 409 otherwise.
 */
export function buildDeployedBot(agent: Agent) {
  const baseUrl = agent.deploymentUrl ?? ""

  const bot = new Chat({
    userName: "agent",
    adapters: {
      web: createWebAdapter({
        userName: "agent",
        // No auth in this dashboard; every tester is the same playground user.
        getUser: () => ({ id: "playground" }),
      }),
    },
    state: createMemoryState(),
  })

  bot.onDirectMessage(async (thread, message) => {
    const incoming = message.text?.trim()
    if (!incoming) return

    await thread.startTyping?.()

    const prior = sessions.get(thread.id)
    const { text, sessionId, continuationToken } = await sendToDeployedAgent({
      baseUrl,
      message: incoming,
      sessionId: prior?.sessionId,
      continuationToken: prior?.continuationToken,
    })
    sessions.set(thread.id, { sessionId, continuationToken })

    await thread.post(text)
  })

  return bot
}
