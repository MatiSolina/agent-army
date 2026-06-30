import { describe, it, expect } from "vitest"
import { discoverEveAgent } from "./discover"
import { buildEveAgent } from "./generate"
import { buildEveProject } from "./project"
import type { Agent, Connection } from "@/lib/db/schema"

// A complete agent fixture exercising every recoverable emitter.
function fixtureAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-abc12345-dead-beef",
    userId: "u1",
    name: "Support Bot",
    description: "desc",
    model: "anthropic/claude-haiku-4.5",
    systemPrompt: 'You are "Support".\nBe terse.\n---not frontmatter---',
    temperature: 70,
    instructions: "ignored",
    maxSteps: 10,
    enabled: true,
    skills: [
      {
        id: "s1",
        name: "House Style",
        description: 'Tone: friendly, no "fluff".',
        content: "# Style\n\nUse short sentences.\n",
      },
    ],
    toolIds: [],
    connectionIds: ["c1"],
    subagents: [
      {
        id: "sub1",
        name: "Researcher",
        model: "openai/gpt-4o-mini",
        instructions: "Research deeply.\nCite sources.",
      },
    ],
    schedules: [
      {
        id: "sch1",
        name: "Daily Digest",
        cron: "0 9 * * *",
        prompt: "Summarize yesterday.",
        enabled: true,
      },
    ],
    sandbox: {
      enabled: true,
      runtime: "node22",
      setupCommands: "npm i\necho hi",
      timeoutMs: 30000,
    },
    harness: { bash: false, webSearch: false },
    vercelProjectId: null,
    deploymentUrl: null,
    deploymentStatus: "none",
    eveVersion: null,
    lastDeployedAt: null,
    deployedConfigHash: null,
    deployedConfig: null,
    deploymentError: null,
    previewUrl: null,
    previewDeploymentId: null,
    eveVerifiedVersion: null,
    eveVerifyError: null,
    imported: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

const tokenConn: Connection = {
  id: "c1",
  userId: "u1",
  name: "Linear API",
  transport: "http",
  url: "https://mcp.linear.app/sse",
  token: "secret-token-value",
  status: "connected",
  oauthClientInfo: null,
  oauthServerInfo: null,
  oauthTokens: null,
  oauthTokensUpdatedAt: null,
  oauthCodeVerifier: null,
  oauthState: null,
  oauthScope: null,
  oauthError: null,
  createdAt: new Date(),
  updatedAt: new Date(),
}

describe("discoverEveAgent — round-trip (regression guard vs generate.ts)", () => {
  it("recovers every recoverable field from generated files", () => {
    const agent = fixtureAgent()
    const files = buildEveProject(agent, { connections: [tokenConn] })

    const d = discoverEveAgent(files)

    expect(d.name).toBe("Support Bot") // exact, from agent.ts comment
    expect(d.sourceAgentId).toBe(agent.id)
    expect(d.model).toBe(agent.model)
    expect(d.systemPrompt).toBe(agent.systemPrompt) // incl. quotes/newlines/---
    expect(d.eveVersion).toBe(files["package.json"].length ? JSON.parse(files["package.json"]).dependencies.eve : null)

    // skill: description + content round-trip; name is the lossy slug
    expect(d.skills).toHaveLength(1)
    expect(d.skills[0].description).toBe('Tone: friendly, no "fluff".')
    expect(d.skills[0].content.trim()).toBe("# Style\n\nUse short sentences.")

    // subagent: model + raw instructions round-trip
    expect(d.subagents).toHaveLength(1)
    expect(d.subagents[0].model).toBe("openai/gpt-4o-mini")
    expect(d.subagents[0].instructions).toBe("Research deeply.\nCite sources.")

    // schedule
    expect(d.schedules).toHaveLength(1)
    expect(d.schedules[0].cron).toBe("0 9 * * *")
    expect(d.schedules[0].prompt.trim()).toBe("Summarize yesterday.")

    // sandbox
    expect(d.sandbox.enabled).toBe(true)
    expect(d.sandbox.runtime).toBe("node22")
    expect(d.sandbox.setupCommands).toBe("npm i\necho hi")

    // harness: bash + webSearch off (webSearch via web_search.ts)
    expect(d.harness).toEqual({ bash: false, webSearch: false })

    // connection: url + name (from description literal); token NOT recovered
    expect(d.connections).toHaveLength(1)
    expect(d.connections[0].url).toBe("https://mcp.linear.app/sse")
    expect(d.connections[0].name).toBe("Linear API")
    expect(d.connections[0].auth).toBe("token")
    expect(JSON.stringify(d.connections[0])).not.toContain("secret-token-value")

    // channel: defaults to kapso when none assigned
    expect(d.channel).toEqual({ type: "kapso" })

    expect(d.warnings).toEqual([])
  })

  it("recovers each channel type + its non-secret param", () => {
    const slack = discoverEveAgent(
      buildEveAgent(fixtureAgent(), {
        connections: [],
        channel: { type: "slack", slackConnectUid: "slack/support" },
      }),
    )
    expect(slack.channel).toEqual({ type: "slack", slackConnectUid: "slack/support" })

    const tg = discoverEveAgent(
      buildEveAgent(fixtureAgent(), {
        connections: [],
        channel: { type: "telegram", telegramBotUsername: "support_bot" },
      }),
    )
    expect(tg.channel).toEqual({ type: "telegram", telegramBotUsername: "support_bot" })

    const discord = discoverEveAgent(
      buildEveAgent(fixtureAgent(), {
        connections: [],
        channel: { type: "discord" },
      }),
    )
    expect(discord.channel).toEqual({ type: "discord" })
  })

  it("reports no sandbox when absent", () => {
    const d = discoverEveAgent(
      buildEveAgent(fixtureAgent({ sandbox: { enabled: false } }), { connections: [] }),
    )
    expect(d.sandbox).toEqual({ enabled: false })
  })
})

describe("discoverEveAgent — robustness", () => {
  it("throws on a non-eve project (no model, no eve dep)", () => {
    expect(() =>
      discoverEveAgent({ "package.json": '{"name":"x","dependencies":{"next":"15"}}' }),
    ).toThrow(/Not an Eve agent/)
  })

  it("keeps going when one skill file is corrupt, recording a warning path", () => {
    const files = buildEveProject(fixtureAgent(), { connections: [tokenConn] })
    // Corrupt the runtime prompt so FALLBACK can't parse → warning, rest survives.
    files["agent/instructions/runtime.ts"] = "garbage with no AGENT_ID const"
    const d = discoverEveAgent(files)
    expect(d.model).toBe("anthropic/claude-haiku-4.5") // still recovered
    expect(d.warnings.some((w) => /FALLBACK_SYSTEM_PROMPT/.test(w))).toBe(true)
  })

  it("imports from package.json alone when agent.ts is missing (no throw)", () => {
    const d = discoverEveAgent({
      "package.json": '{"name":"foo-12345678","dependencies":{"eve":"0.16.0"}}',
    })
    expect(d.eveVersion).toBe("0.16.0")
    expect(d.name).toBe("foo")
    expect(d.warnings.some((w) => /model/.test(w))).toBe(true)
  })
})
