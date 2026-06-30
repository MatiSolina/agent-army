import { describe, it, expect } from "vitest"
import {
  buildAgentEnvSpec,
  connectionTokenEnvKey,
  expectedEnvKeys,
} from "./env-spec"
import { buildEveAgent } from "./generate"
import type { Agent, Connection } from "@/lib/db/schema"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    userId: "user-1",
    name: "Soporte Bot",
    description: "Atiende clientes",
    model: "openai/gpt-4o-mini",
    systemPrompt: "Sos un agente de soporte amable y conciso.",
    temperature: 70,
    instructions: "Be concise.",
    maxSteps: 10,
    enabled: true,
    skills: [],
    toolIds: [],
    connectionIds: [],
    subagents: [],
    schedules: [],
    sandbox: { enabled: false },
    harness: {},
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

function makeConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: "conn-1",
    userId: "user-1",
    name: "Linear",
    transport: "http",
    url: "https://mcp.linear.app/mcp",
    token: null,
    status: "connected",
    oauthClientInfo: null as never,
    oauthServerInfo: null as never,
    oauthTokens: null as never,
    oauthTokensUpdatedAt: null,
    oauthCodeVerifier: null,
    oauthState: null,
    oauthScope: null,
    oauthError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// connectionTokenEnvKey
// ---------------------------------------------------------------------------
describe("connectionTokenEnvKey", () => {
  it("uppercases and uses underscore separator (NOT dash)", () => {
    expect(connectionTokenEnvKey("My Service")).toBe("MY_SERVICE_TOKEN")
  })

  it("collapses runs of non-alphanumerics to a single underscore", () => {
    expect(connectionTokenEnvKey("Foo -- Bar!! Baz")).toBe("FOO_BAR_BAZ_TOKEN")
  })

  it("strips leading/trailing separators", () => {
    expect(connectionTokenEnvKey("  !weird!  ")).toBe("WEIRD_TOKEN")
  })

  it("falls back to CONNECTION when the name slugifies to empty", () => {
    expect(connectionTokenEnvKey("!!!")).toBe("CONNECTION_TOKEN")
  })

  // PARITY: the key MUST match exactly the env var the generated connection file
  // reads from process.env, or the secret never reaches the MCP client.
  it("matches the <SLUG>_TOKEN the generated connection file references", () => {
    const conn = makeConnection({ name: "Acme CRM", token: "secret-xyz" })
    const agent = makeAgent({ connectionIds: [conn.id] })
    const files = buildEveAgent(agent, { connections: [conn] })
    const connFile = Object.entries(files).find(([p]) =>
      p.startsWith("agent/connections/"),
    )?.[1]
    expect(connFile).toBeTruthy()
    const key = connectionTokenEnvKey(conn.name)
    expect(connFile).toContain(`process.env.${key}`)
  })
})

// ---------------------------------------------------------------------------
// buildAgentEnvSpec: connection tokens
// ---------------------------------------------------------------------------
describe("buildAgentEnvSpec — connection tokens", () => {
  it("emits <SLUG>_TOKEN for an assigned, non-stdio, token connection", () => {
    const conn = makeConnection({ name: "Acme CRM", token: "tok_123" })
    const agent = makeAgent({ connectionIds: [conn.id] })
    const specs = buildAgentEnvSpec({
      agent,
      connections: [conn],
      channel: null,
    })
    expect(specs).toContainEqual({ key: "ACME_CRM_TOKEN", value: "tok_123" })
  })

  it("ignores connections that are NOT assigned to the agent", () => {
    const conn = makeConnection({ name: "Acme CRM", token: "tok_123" })
    const agent = makeAgent({ connectionIds: [] })
    const specs = buildAgentEnvSpec({
      agent,
      connections: [conn],
      channel: null,
    })
    expect(specs).toEqual([])
  })

  it("skips stdio connections (not a remote MCP server)", () => {
    const conn = makeConnection({
      name: "Local",
      token: "tok_123",
      transport: "stdio",
    })
    const agent = makeAgent({ connectionIds: [conn.id] })
    const specs = buildAgentEnvSpec({
      agent,
      connections: [conn],
      channel: null,
    })
    expect(specs).toEqual([])
  })

  it("skips connections with no token (OAuth / none auth)", () => {
    const conn = makeConnection({ name: "Linear", token: null })
    const agent = makeAgent({ connectionIds: [conn.id] })
    const specs = buildAgentEnvSpec({
      agent,
      connections: [conn],
      channel: null,
    })
    expect(specs).toEqual([])
  })

  it("skips connections with a whitespace-only token", () => {
    const conn = makeConnection({ name: "Linear", token: "   " })
    const agent = makeAgent({ connectionIds: [conn.id] })
    const specs = buildAgentEnvSpec({
      agent,
      connections: [conn],
      channel: null,
    })
    expect(specs).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// buildAgentEnvSpec: FM token broker base URL
// ---------------------------------------------------------------------------
describe("buildAgentEnvSpec — FM_BASE_URL", () => {
  it("emits FM_BASE_URL when fmBaseUrl is provided", () => {
    const specs = buildAgentEnvSpec({
      agent: makeAgent(),
      connections: [],
      channel: null,
      fmBaseUrl: "https://agent-army-eve.vercel.app",
    })
    expect(specs).toContainEqual({
      key: "FM_BASE_URL",
      value: "https://agent-army-eve.vercel.app",
    })
  })

  it("omits FM_BASE_URL when fmBaseUrl is null/undefined/empty", () => {
    for (const fmBaseUrl of [null, undefined, "", "  "]) {
      const specs = buildAgentEnvSpec({
        agent: makeAgent(),
        connections: [],
        channel: null,
        fmBaseUrl,
      })
      expect(specs.find((s) => s.key === "FM_BASE_URL")).toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------
// buildAgentEnvSpec: Kapso channel
// ---------------------------------------------------------------------------
describe("buildAgentEnvSpec — Kapso channel", () => {
  it("folds the assigned channel's Kapso creds into the spec", () => {
    const agent = makeAgent()
    const specs = buildAgentEnvSpec({
      agent,
      connections: [],
      channel: {
        kapsoApiKey: "k_api",
        kapsoPhoneNumberId: "555",
        kapsoWebhookSecret: "whsec",
      },
    })
    expect(specs).toContainEqual({ key: "KAPSO_API_KEY", value: "k_api" })
    expect(specs).toContainEqual({
      key: "KAPSO_PHONE_NUMBER_ID",
      value: "555",
    })
    expect(specs).toContainEqual({
      key: "KAPSO_WEBHOOK_SECRET",
      value: "whsec",
    })
  })

  it("omits blank Kapso values", () => {
    const agent = makeAgent()
    const specs = buildAgentEnvSpec({
      agent,
      connections: [],
      channel: {
        kapsoApiKey: "k_api",
        kapsoPhoneNumberId: "  ",
        kapsoWebhookSecret: null,
      },
    })
    expect(specs).toContainEqual({ key: "KAPSO_API_KEY", value: "k_api" })
    expect(specs.find((s) => s.key === "KAPSO_PHONE_NUMBER_ID")).toBeUndefined()
    expect(specs.find((s) => s.key === "KAPSO_WEBHOOK_SECRET")).toBeUndefined()
  })

  it("a null channel contributes no Kapso vars", () => {
    const agent = makeAgent()
    const specs = buildAgentEnvSpec({
      agent,
      connections: [],
      channel: null,
    })
    expect(specs).toEqual([])
  })

  it("a slack-typed channel contributes NO Kapso vars (Connect manages creds)", () => {
    const agent = makeAgent()
    const specs = buildAgentEnvSpec({
      agent,
      connections: [],
      // Defensive: even if kapso fields were somehow set, type='slack' must
      // never push KAPSO_*; a Slack agent gets its creds from Vercel Connect.
      channel: {
        type: "slack",
        kapsoApiKey: "leak",
        kapsoPhoneNumberId: "leak",
        kapsoWebhookSecret: "leak",
      },
    })
    expect(specs).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// buildAgentEnvSpec: Telegram channel
// ---------------------------------------------------------------------------
describe("buildAgentEnvSpec — Telegram channel", () => {
  it("pushes both TELEGRAM_* vars for a telegram channel", () => {
    const agent = makeAgent()
    const specs = buildAgentEnvSpec({
      agent,
      connections: [],
      channel: {
        type: "telegram",
        kapsoApiKey: null,
        kapsoPhoneNumberId: null,
        kapsoWebhookSecret: null,
        telegramBotToken: "123:abc",
        telegramWebhookSecretToken: "s",
      },
    })
    expect(specs).toContainEqual({ key: "TELEGRAM_BOT_TOKEN", value: "123:abc" })
    expect(specs).toContainEqual({
      key: "TELEGRAM_WEBHOOK_SECRET_TOKEN",
      value: "s",
    })
    // A telegram channel pushes no KAPSO_* vars.
    expect(specs.find((s) => s.key.startsWith("KAPSO_"))).toBeUndefined()
  })

  it("a slack channel still pushes no channel env (regression)", () => {
    const agent = makeAgent()
    const specs = buildAgentEnvSpec({
      agent,
      connections: [],
      channel: {
        type: "slack",
        kapsoApiKey: "leak",
        kapsoPhoneNumberId: "leak",
        kapsoWebhookSecret: "leak",
      },
    })
    expect(specs).toEqual([])
  })

  it("a kapso channel still pushes the 3 KAPSO_* keys (regression)", () => {
    const agent = makeAgent()
    const specs = buildAgentEnvSpec({
      agent,
      connections: [],
      channel: {
        type: "kapso",
        kapsoApiKey: "k_api",
        kapsoPhoneNumberId: "555",
        kapsoWebhookSecret: "whsec",
      },
    })
    expect(specs).toContainEqual({ key: "KAPSO_API_KEY", value: "k_api" })
    expect(specs).toContainEqual({ key: "KAPSO_PHONE_NUMBER_ID", value: "555" })
    expect(specs).toContainEqual({ key: "KAPSO_WEBHOOK_SECRET", value: "whsec" })
  })
})

// ---------------------------------------------------------------------------
// buildAgentEnvSpec: Discord channel
// ---------------------------------------------------------------------------
describe("buildAgentEnvSpec — Discord channel", () => {
  it("pushes all three DISCORD_* vars for a discord channel", () => {
    const agent = makeAgent()
    const specs = buildAgentEnvSpec({
      agent,
      connections: [],
      channel: {
        type: "discord",
        kapsoApiKey: null,
        kapsoPhoneNumberId: null,
        kapsoWebhookSecret: null,
        discordBotToken: "bot-tok",
        discordApplicationId: "app-id",
        discordPublicKey: "pub-key",
      },
    })
    expect(specs).toContainEqual({ key: "DISCORD_BOT_TOKEN", value: "bot-tok" })
    expect(specs).toContainEqual({
      key: "DISCORD_APPLICATION_ID",
      value: "app-id",
    })
    expect(specs).toContainEqual({ key: "DISCORD_PUBLIC_KEY", value: "pub-key" })
    // A discord channel pushes no KAPSO_* vars.
    expect(specs.find((s) => s.key.startsWith("KAPSO_"))).toBeUndefined()
  })

  it("a slack channel still pushes no channel env (regression)", () => {
    const agent = makeAgent()
    const specs = buildAgentEnvSpec({
      agent,
      connections: [],
      channel: {
        type: "slack",
        kapsoApiKey: "leak",
        kapsoPhoneNumberId: "leak",
        kapsoWebhookSecret: "leak",
      },
    })
    expect(specs).toEqual([])
  })

  it("a kapso channel still pushes the 3 KAPSO_* keys (regression)", () => {
    const agent = makeAgent()
    const specs = buildAgentEnvSpec({
      agent,
      connections: [],
      channel: {
        type: "kapso",
        kapsoApiKey: "k_api",
        kapsoPhoneNumberId: "555",
        kapsoWebhookSecret: "whsec",
      },
    })
    expect(specs).toContainEqual({ key: "KAPSO_API_KEY", value: "k_api" })
    expect(specs).toContainEqual({ key: "KAPSO_PHONE_NUMBER_ID", value: "555" })
    expect(specs).toContainEqual({ key: "KAPSO_WEBHOOK_SECRET", value: "whsec" })
  })
})

// ---------------------------------------------------------------------------
// expectedEnvKeys: the keys the Secrets tab should render as configurable
// ---------------------------------------------------------------------------
describe("expectedEnvKeys", () => {
  it("returns exactly the two TELEGRAM_* keys for a telegram channel", () => {
    const agent = makeAgent()
    expect(
      expectedEnvKeys({ agent, connections: [], channelType: "telegram" }).sort(),
    ).toEqual(["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET_TOKEN"])
  })

  it("returns exactly the three DISCORD_* keys for a discord channel", () => {
    const agent = makeAgent()
    expect(
      expectedEnvKeys({ agent, connections: [], channelType: "discord" }).sort(),
    ).toEqual([
      "DISCORD_APPLICATION_ID",
      "DISCORD_BOT_TOKEN",
      "DISCORD_PUBLIC_KEY",
    ])
  })

  it("returns no keys for a slack channel", () => {
    const agent = makeAgent()
    expect(expectedEnvKeys({ agent, connections: [], channelType: "slack" })).toEqual(
      [],
    )
  })

  it("returns no keys for a null channel type", () => {
    const agent = makeAgent()
    expect(expectedEnvKeys({ agent, connections: [], channelType: null })).toEqual(
      [],
    )
  })

  it("returns the 3 KAPSO_* keys for a kapso channel (regression)", () => {
    const agent = makeAgent()
    expect(
      expectedEnvKeys({ agent, connections: [], channelType: "kapso" }).sort(),
    ).toEqual(["KAPSO_API_KEY", "KAPSO_PHONE_NUMBER_ID", "KAPSO_WEBHOOK_SECRET"])
  })

  it("includes <SLUG>_TOKEN for an assigned token connection", () => {
    const conn = makeConnection({ name: "Acme CRM", token: "tok_123" })
    const agent = makeAgent({ connectionIds: [conn.id] })
    expect(expectedEnvKeys({ agent, connections: [conn], channelType: null }))
      .toEqual(["ACME_CRM_TOKEN"])
  })

  it("EXCLUDES non-token (oauth/none) connections — they emit no env secret", () => {
    // Linear is an OAuth catalog entry with no static token: emits nothing, so
    // it must NOT render a <SLUG>_TOKEN field in the Secrets tab.
    const conn = makeConnection({ name: "Linear", token: null })
    const agent = makeAgent({ connectionIds: [conn.id] })
    expect(expectedEnvKeys({ agent, connections: [conn], channelType: null }))
      .toEqual([])
  })

  it("skips stdio connections and unassigned connections", () => {
    const stdio = makeConnection({
      id: "c1",
      name: "Local",
      token: "t",
      transport: "stdio",
    })
    const unassigned = makeConnection({ id: "c2", name: "Other", token: "t" })
    const agent = makeAgent({ connectionIds: ["c1"] })
    expect(
      expectedEnvKeys({
        agent,
        connections: [stdio, unassigned],
        channelType: null,
      }),
    ).toEqual([])
  })

  it("includes the three KAPSO_* keys when a channel is assigned", () => {
    const agent = makeAgent()
    expect(
      expectedEnvKeys({ agent, connections: [], channelType: "kapso" }).sort(),
    ).toEqual(["KAPSO_API_KEY", "KAPSO_PHONE_NUMBER_ID", "KAPSO_WEBHOOK_SECRET"])
  })

  it("combines token keys and KAPSO_* keys with no duplicates", () => {
    const conn = makeConnection({ name: "Acme CRM", token: "tok_123" })
    const agent = makeAgent({ connectionIds: [conn.id] })
    expect(
      expectedEnvKeys({ agent, connections: [conn], channelType: "kapso" }).sort(),
    ).toEqual([
      "ACME_CRM_TOKEN",
      "KAPSO_API_KEY",
      "KAPSO_PHONE_NUMBER_ID",
      "KAPSO_WEBHOOK_SECRET",
    ])
  })
})

// ---------------------------------------------------------------------------
// buildAgentEnvSpec: combined + de-dup
// ---------------------------------------------------------------------------
describe("buildAgentEnvSpec — combined", () => {
  it("includes both connection tokens and Kapso vars together", () => {
    const conn = makeConnection({ name: "Acme CRM", token: "tok_123" })
    const agent = makeAgent({ connectionIds: [conn.id] })
    const specs = buildAgentEnvSpec({
      agent,
      connections: [conn],
      channel: {
        kapsoApiKey: "k_api",
        kapsoPhoneNumberId: null,
        kapsoWebhookSecret: null,
      },
    })
    const keys = specs.map((s) => s.key).sort()
    expect(keys).toEqual(["ACME_CRM_TOKEN", "KAPSO_API_KEY"])
  })

  it("de-dups by key (last wins) when two connections slug-collide", () => {
    // Documents the pre-existing generate.ts slug-collision limitation: two
    // distinctly-named connections can produce the same <SLUG>_TOKEN key.
    const a = makeConnection({ id: "c1", name: "Acme CRM", token: "first" })
    const b = makeConnection({ id: "c2", name: "Acme-CRM", token: "second" })
    const agent = makeAgent({ connectionIds: ["c1", "c2"] })
    const specs = buildAgentEnvSpec({
      agent,
      connections: [a, b],
      channel: null,
    })
    const matching = specs.filter((s) => s.key === "ACME_CRM_TOKEN")
    expect(matching).toHaveLength(1)
    expect(matching[0].value).toBe("second")
  })
})
