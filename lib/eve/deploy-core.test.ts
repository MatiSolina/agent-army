import { describe, it, expect, vi, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Mocks for every I/O boundary so the core runs with no request, no network,
// no real db. The core is session-free: it must NOT call requireUserId /
// revalidatePath / next.cache. If it did, importing it would already fail here
// (next/cache throws outside a request in Next 16), and the test below would
// not reach the assertion.
// ---------------------------------------------------------------------------

vi.mock("@/lib/vercel/auth", () => ({
  resolveVercelAuth: async () => ({ token: "t", teamId: "team" }),
}))
vi.mock("@/lib/vercel/client", () => ({
  ensureProject: vi.fn(async () => {}),
  upsertProjectEnv: vi.fn(async () => {}),
  createDeployment: vi.fn(async () => ({
    id: "dpl_1",
    url: "https://x-abc.vercel.app",
    readyState: "READY",
  })),
  pollUntilReady: vi.fn(async () => {}),
  getProductionDeploymentId: vi.fn(async () => "dpl_old"),
  promoteDeployment: vi.fn(async () => {}),
  attachConnectorToProject: vi.fn(async () => {}),
  attachTriggerDestination: vi.fn(async () => {}),
}))
vi.mock("@/lib/vercel/deploy", () => ({
  buildDeploymentFiles: (m: Record<string, string>) =>
    Object.entries(m).map(([file, data]) => ({ file, data, encoding: "utf-8" as const })),
}))
vi.mock("@/lib/telegram/set-webhook", () => ({
  setTelegramWebhook: vi.fn(async () => {}),
}))
vi.mock("@/lib/discord/set-interactions-endpoint", () => ({
  setDiscordInteractionsEndpoint: vi.fn(async () => {}),
}))
vi.mock("@/lib/channels/kapso", () => ({
  registerKapsoWebhook: vi.fn(async () => {}),
}))

// ---------------------------------------------------------------------------
// Fake db. note: a capture-and-fixture store — does NOT evaluate drizzle
// conditions (the operators are opaque). Tests put ONE row per table, so
// ignoring `.where()` and applying `.set()` to all rows of the matched table
// is sufficient and avoids re-implementing a drizzle condition evaluator.
// Upgrade path: a real drizzle matcher if multi-row fixtures ever need it.
// vi.hoisted so the store + factory are available inside the hoisted vi.mock.
// ---------------------------------------------------------------------------

import { agents, channels, connections, type Agent } from "@/lib/db/schema"

const { stores, fakeDb, buildEveProjectSpy } = vi.hoisted(() => {
  const stores = new Map<unknown, Record<string, unknown>[]>()
  const buildEveProjectSpy = vi.fn(
    (_agent: Agent, _opts: unknown) => ({ "package.json": "{}" }),
  )
  const fakeDb = () => ({
    select: () => ({
      from: (table: unknown) => ({
        where: () => Promise.resolve((stores.get(table) ?? []).slice()),
      }),
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => {
        // `.where()` is BOTH awaitable (→ the updated rows) AND chainable to
        // `.returning()` (→ same). drizzle's real builder is thenable too.
        const apply = () => {
          const rows = stores.get(table) ?? []
          for (const r of rows) Object.assign(r, patch)
          return rows.slice()
        }
        return {
          where: () =>
            Object.assign(Promise.resolve(apply()), {
              returning: () => Promise.resolve(apply()),
            }),
          // drizzle also allows `.returning()` directly after `.set()` (no where).
          returning: () => Promise.resolve(apply()),
        }
      },
    }),
  })
  return { stores, fakeDb, buildEveProjectSpy }
})

vi.mock("@/lib/db", () => ({ db: fakeDb() }))
vi.mock("@/lib/eve/project", () => ({
  buildEveProject: buildEveProjectSpy,
  projectName: (a: { name: string; id: string }) =>
    a.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-" + a.id.slice(0, 8),
  EVE_VERSION: "0.16.0",
}))

// fetch is used for the ssoProtection PATCH — stub it to a no-op success.
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }))
})

function setRow(table: unknown, row: Record<string, unknown>) {
  stores.set(table, [row])
}

import { deployAgentCore, promoteAgentCore } from "./deploy-core"
import { attachConnectorToProject, attachTriggerDestination } from "@/lib/vercel/client"
import { setTelegramWebhook } from "@/lib/telegram/set-webhook"
import { setDiscordInteractionsEndpoint } from "@/lib/discord/set-interactions-endpoint"
import { registerKapsoWebhook } from "@/lib/channels/kapso"
import { DEMO_USER_ID } from "@/lib/session"

function minimalAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "a1",
    userId: DEMO_USER_ID,
    name: "Bot",
    description: null,
    model: "openai/gpt-4o-mini",
    systemPrompt: "You are a helpful assistant.",
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
    deploymentStatus: "deployed",
    eveVersion: "0.16.0",
    lastDeployedAt: null,
    deployedConfigHash: null,
    deployedConfig: null,
    deploymentError: null,
    previewUrl: null,
    previewDeploymentId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Agent
}

describe("deployAgentCore (session-free)", () => {
  beforeEach(() => {
    stores.clear()
    buildEveProjectSpy.mockClear()
  })

  it("runs with an explicit userId and no request/session context", async () => {
    setRow(agents, minimalAgent())
    const out = await deployAgentCore(DEMO_USER_ID, "a1", {
      connections: [],
      eveVersion: "0.16.2",
      aiVersion: "^7.0.0",
    })
    expect(out.previewDeploymentId).toBe("dpl_1")
    // The core did NOT throw "Unauthorized" — proving it is session-free.
    // The status row was advanced to preview_ready.
    expect((stores.get(agents) ?? [])[0].deploymentStatus).toBe("preview_ready")
  })

  it("clears a stale preview-test verdict on a normal (config) deploy", async () => {
    // An agent that previously verified/failed a gated bump must drop that
    // verdict when its config is re-deployed — the verdict is tied to the OLD
    // config and must not un-gate (nor linger as a stale error).
    setRow(
      agents,
      minimalAgent({
        eveVerifiedVersion: "0.17.0",
        eveVerifyError: "old stderr",
        imported: false,
      }),
    )
    await deployAgentCore(DEMO_USER_ID, "a1", {
      connections: [],
      eveVersion: "0.16.2",
      aiVersion: "^7.0.0",
    })
    const after = (stores.get(agents) ?? [])[0]
    expect(after.eveVerifiedVersion).toBeNull()
    expect(after.eveVerifyError).toBeNull()
  })

  it("previewTest mode does NOT corrupt the live deployed row", async () => {
    // A gated-bump preview-test builds a throwaway preview pinned to the
    // candidate. It must NOT mutate the live row: status stays "deployed",
    // eveVersion stays the deployed version, previewUrl/previewDeploymentId are
    // untouched, and the verdict columns are left for testEvePreview to set.
    setRow(
      agents,
      minimalAgent({
        deploymentStatus: "deployed",
        eveVersion: "0.16.0",
        deploymentUrl: "https://prod.vercel.app",
        previewUrl: null,
        previewDeploymentId: null,
        eveVerifiedVersion: null,
        eveVerifyError: "stale error must NOT be cleared by a preview-test build",
        imported: false,
      }),
    )
    const out = await deployAgentCore(DEMO_USER_ID, "a1", {
      connections: [],
      eveVersion: "0.17.0",
      aiVersion: "^8.0.0",
      previewTest: true,
    })
    // Still returns the fresh preview handle for the caller to ping/delete.
    expect(out.previewDeploymentId).toBe("dpl_1")
    expect(out.previewUrl).toBe("https://x-abc.vercel.app")
    const after = (stores.get(agents) ?? [])[0]
    // The live row is intact — the agent is still deployed on its old version.
    expect(after.deploymentStatus).toBe("deployed")
    expect(after.eveVersion).toBe("0.16.0")
    expect(after.previewUrl).toBeNull()
    expect(after.previewDeploymentId).toBeNull()
    // The verdict columns are owned by testEvePreview, not this build step.
    expect(after.eveVerifyError).toBe(
      "stale error must NOT be cleared by a preview-test build",
    )
  })

  it("attaches a Vercel-Connect-backed connector (Slack) to the agent's project", async () => {
    vi.mocked(attachConnectorToProject).mockClear()
    setRow(agents, minimalAgent({ connectionIds: ["c-slack"] }))
    await deployAgentCore(DEMO_USER_ID, "a1", {
      connections: [
        {
          id: "c-slack",
          userId: DEMO_USER_ID,
          name: "Slack",
          transport: "http",
          url: "https://mcp.slack.com/mcp",
          token: null,
        } as never,
      ],
      eveVersion: "0.16.2",
      aiVersion: "^7.0.0",
    })
    // slug = projectName({name:"Bot", id:"a1"}) → "bot-a1" (mocked).
    expect(attachConnectorToProject).toHaveBeenCalledWith(
      expect.anything(),
      "slack/agentarmy",
      "bot-a1",
    )
  })

  it("does NOT attach a connector for a non-connect connection", async () => {
    vi.mocked(attachConnectorToProject).mockClear()
    setRow(agents, minimalAgent({ connectionIds: ["c1"] }))
    await deployAgentCore(DEMO_USER_ID, "a1", {
      connections: [
        { id: "c1", userId: DEMO_USER_ID, name: "Linear", transport: "http", url: "https://mcp.linear.app/mcp", token: null } as never,
      ],
      eveVersion: "0.16.2",
      aiVersion: "^7.0.0",
    })
    expect(attachConnectorToProject).not.toHaveBeenCalled()
  })

  it("passes a slack channel to buildEveProject (so it emits slack.ts)", async () => {
    setRow(agents, minimalAgent())
    setRow(channels, {
      id: "ch1",
      userId: DEMO_USER_ID,
      name: "soporte",
      type: "slack",
      agentId: "a1",
      kapsoApiKey: null,
      kapsoPhoneNumberId: null,
      kapsoWebhookSecret: null,
      slackConnectUid: "slack/soporte",
      status: "connected",
      webhookStatus: "pending",
    })
    await deployAgentCore(DEMO_USER_ID, "a1", {
      connections: [],
      eveVersion: "0.16.2",
      aiVersion: "^7.0.0",
    })
    const [, opts] = buildEveProjectSpy.mock.calls[0]
    expect((opts as { channel?: unknown }).channel).toEqual({
      type: "slack",
      slackConnectUid: "slack/soporte",
    })
  })

  it("attaches the slack channel connector + routes its trigger to /eve/v1/slack", async () => {
    vi.mocked(attachConnectorToProject).mockClear()
    vi.mocked(attachTriggerDestination).mockClear()
    setRow(agents, minimalAgent())
    setRow(channels, {
      id: "ch1",
      userId: DEMO_USER_ID,
      name: "soporte",
      type: "slack",
      agentId: "a1",
      kapsoApiKey: null,
      kapsoPhoneNumberId: null,
      kapsoWebhookSecret: null,
      slackConnectUid: "slack/soporte",
      status: "connected",
      webhookStatus: "pending",
    })
    await deployAgentCore(DEMO_USER_ID, "a1", {
      connections: [],
      eveVersion: "0.16.2",
      aiVersion: "^7.0.0",
    })
    expect(attachConnectorToProject).toHaveBeenCalledWith(
      expect.anything(),
      "slack/soporte",
      "bot-a1",
    )
    expect(attachTriggerDestination).toHaveBeenCalledWith(
      expect.anything(),
      "slack/soporte",
      "bot-a1",
      "/eve/v1/slack",
    )
  })

  it("throws when a slack channel has no connector UID", async () => {
    setRow(agents, minimalAgent())
    setRow(channels, {
      id: "ch1",
      userId: DEMO_USER_ID,
      name: "soporte",
      type: "slack",
      agentId: "a1",
      kapsoApiKey: null,
      kapsoPhoneNumberId: null,
      kapsoWebhookSecret: null,
      slackConnectUid: null,
      status: "connected",
      webhookStatus: "pending",
    })
    await expect(
      deployAgentCore(DEMO_USER_ID, "a1", { connections: [], eveVersion: "0.16.2" }),
    ).rejects.toThrow(/connector|connect/i)
  })

  it("still rejects a kapso channel missing its credentials", async () => {
    setRow(agents, minimalAgent())
    setRow(channels, {
      id: "ch1",
      userId: DEMO_USER_ID,
      name: "wa",
      type: "kapso",
      agentId: "a1",
      kapsoApiKey: null,
      kapsoPhoneNumberId: null,
      kapsoWebhookSecret: null,
      slackConnectUid: null,
      status: "connected",
      webhookStatus: "pending",
    })
    await expect(
      deployAgentCore(DEMO_USER_ID, "a1", { connections: [], eveVersion: "0.16.2" }),
    ).rejects.toThrow(/Kapso/i)
  })

  it("passes a telegram channel to buildEveProject (so it emits telegram.ts)", async () => {
    setRow(agents, minimalAgent())
    setRow(channels, {
      id: "ch1",
      userId: DEMO_USER_ID,
      name: "tg",
      type: "telegram",
      agentId: "a1",
      kapsoApiKey: null,
      kapsoPhoneNumberId: null,
      kapsoWebhookSecret: null,
      slackConnectUid: null,
      telegramBotToken: "123:abc",
      telegramWebhookSecretToken: "s",
      telegramBotUsername: "my_bot",
      status: "connected",
      webhookStatus: "pending",
    })
    await deployAgentCore(DEMO_USER_ID, "a1", {
      connections: [],
      eveVersion: "0.16.2",
      aiVersion: "^7.0.0",
    })
    const [, opts] = buildEveProjectSpy.mock.calls[0]
    expect((opts as { channel?: unknown }).channel).toEqual({
      type: "telegram",
      slackConnectUid: null,
      telegramBotUsername: "my_bot",
    })
  })

  it("throws when a telegram channel is missing its bot token or webhook secret token", async () => {
    setRow(agents, minimalAgent())
    setRow(channels, {
      id: "ch1",
      userId: DEMO_USER_ID,
      name: "tg",
      type: "telegram",
      agentId: "a1",
      kapsoApiKey: null,
      kapsoPhoneNumberId: null,
      kapsoWebhookSecret: null,
      slackConnectUid: null,
      telegramBotToken: "123:abc",
      telegramWebhookSecretToken: null,
      telegramBotUsername: "my_bot",
      status: "connected",
      webhookStatus: "pending",
    })
    await expect(
      deployAgentCore(DEMO_USER_ID, "a1", { connections: [], eveVersion: "0.16.2" }),
    ).rejects.toThrow(/Telegram/i)
  })

  it("does NOT attach a connector or trigger destination for a telegram channel", async () => {
    vi.mocked(attachConnectorToProject).mockClear()
    vi.mocked(attachTriggerDestination).mockClear()
    setRow(agents, minimalAgent())
    setRow(channels, {
      id: "ch1",
      userId: DEMO_USER_ID,
      name: "tg",
      type: "telegram",
      agentId: "a1",
      kapsoApiKey: null,
      kapsoPhoneNumberId: null,
      kapsoWebhookSecret: null,
      slackConnectUid: null,
      telegramBotToken: "123:abc",
      telegramWebhookSecretToken: "s",
      telegramBotUsername: "my_bot",
      status: "connected",
      webhookStatus: "pending",
    })
    await deployAgentCore(DEMO_USER_ID, "a1", {
      connections: [],
      eveVersion: "0.16.2",
      aiVersion: "^7.0.0",
    })
    expect(attachConnectorToProject).not.toHaveBeenCalled()
    expect(attachTriggerDestination).not.toHaveBeenCalled()
  })

  function discordChannelRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "ch1",
      userId: DEMO_USER_ID,
      name: "dc",
      type: "discord",
      agentId: "a1",
      kapsoApiKey: null,
      kapsoPhoneNumberId: null,
      kapsoWebhookSecret: null,
      slackConnectUid: null,
      telegramBotToken: null,
      telegramWebhookSecretToken: null,
      telegramBotUsername: null,
      discordBotToken: "bot-tok",
      discordApplicationId: "app-id",
      discordPublicKey: "pub-key",
      status: "connected",
      webhookStatus: "pending",
      ...overrides,
    }
  }

  it("passes a discord channel to buildEveProject (so it emits discord.ts)", async () => {
    setRow(agents, minimalAgent())
    setRow(channels, discordChannelRow())
    await deployAgentCore(DEMO_USER_ID, "a1", {
      connections: [],
      eveVersion: "0.16.2",
      aiVersion: "^7.0.0",
    })
    const [, opts] = buildEveProjectSpy.mock.calls[0]
    // Discord threads no extra structural field — the passthrough adds nothing.
    expect((opts as { channel?: unknown }).channel).toEqual({
      type: "discord",
      slackConnectUid: null,
      telegramBotUsername: null,
    })
  })

  it("throws when a discord channel is missing any of its three secrets", async () => {
    setRow(agents, minimalAgent())
    setRow(channels, discordChannelRow({ discordPublicKey: null }))
    await expect(
      deployAgentCore(DEMO_USER_ID, "a1", { connections: [], eveVersion: "0.16.2" }),
    ).rejects.toThrow(/Discord/i)
  })

  it("does NOT attach a connector or trigger destination for a discord channel", async () => {
    vi.mocked(attachConnectorToProject).mockClear()
    vi.mocked(attachTriggerDestination).mockClear()
    setRow(agents, minimalAgent())
    setRow(channels, discordChannelRow())
    await deployAgentCore(DEMO_USER_ID, "a1", {
      connections: [],
      eveVersion: "0.16.2",
      aiVersion: "^7.0.0",
    })
    expect(attachConnectorToProject).not.toHaveBeenCalled()
    expect(attachTriggerDestination).not.toHaveBeenCalled()
  })

  it("throws when the agent is not found", async () => {
    stores.set(agents, [])
    await expect(
      deployAgentCore(DEMO_USER_ID, "missing", { connections: [] }),
    ).rejects.toThrow(/Agent not found/)
  })

  it("reads connections session-free when opts.connections is omitted", async () => {
    setRow(agents, minimalAgent())
    stores.set(connections, [
      { id: "c1", userId: DEMO_USER_ID, name: "Linear", transport: "http", url: "u", token: null },
    ])
    await deployAgentCore(DEMO_USER_ID, "a1", { eveVersion: "0.16.2", aiVersion: "^7.0.0" })
    expect(buildEveProjectSpy).toHaveBeenCalledOnce()
    const [, opts] = buildEveProjectSpy.mock.calls[0]
    expect((opts as { connections: unknown[] }).connections).toHaveLength(1)
  })
})

describe("deployAgentCore fromSnapshot (version-only update)", () => {
  function snapshot(name: string) {
    // The 14-field BUILD projection (config-drift). name included so projectName
    // stays stable → same Vercel project.
    return {
      name,
      description: null,
      model: "openai/gpt-4o-mini",
      systemPrompt: "snap prompt",
      temperature: 70,
      instructions: "snap",
      maxSteps: 10,
      skills: [],
      toolIds: [],
      connectionIds: [],
      subagents: [],
      schedules: [],
      sandbox: { enabled: false },
      harness: {},
    }
  }

  beforeEach(() => {
    stores.clear()
    buildEveProjectSpy.mockClear()
  })

  it("rebuilds from deployedConfig, not the live row", async () => {
    setRow(
      agents,
      minimalAgent({ id: "a2", name: "LiveName", deployedConfig: { ...snapshot("SnapName") } }),
    )
    await deployAgentCore(DEMO_USER_ID, "a2", {
      connections: [],
      eveVersion: "0.16.2",
      fromSnapshot: true,
    })
    const [agentArg] = buildEveProjectSpy.mock.calls[0]
    expect((agentArg as Agent).name).toBe("SnapName") // built from snapshot, NOT "LiveName"
    expect((agentArg as Agent).id).toBe("a2") // id from the live row
  })

  it("does NOT re-stamp deployedConfig/Hash (keeps drift pending)", async () => {
    const snap = { ...snapshot("Frozen") }
    setRow(
      agents,
      minimalAgent({
        id: "a3",
        name: "Edited",
        deployedConfigHash: "HASH_BEFORE",
        deployedConfig: snap,
      }),
    )
    await deployAgentCore(DEMO_USER_ID, "a3", {
      connections: [],
      eveVersion: "0.16.2",
      fromSnapshot: true,
    })
    const after = (stores.get(agents) ?? [])[0] as Record<string, unknown>
    expect(after.deployedConfig).toEqual(snap) // untouched
    expect(after.deployedConfigHash).toBe("HASH_BEFORE")
    expect(after.eveVersion).toBe("0.16.2") // only the pin moved
  })

  it("fails loud when the agent was never deployed (no snapshot)", async () => {
    setRow(
      agents,
      minimalAgent({ id: "a4", deploymentStatus: "none", deployedConfig: null }),
    )
    await expect(
      deployAgentCore(DEMO_USER_ID, "a4", { connections: [], fromSnapshot: true }),
    ).rejects.toThrow(/never deployed|no snapshot/i)
  })
})

describe("promoteAgentCore — telegram webhook registration", () => {
  beforeEach(() => {
    stores.clear()
    vi.mocked(setTelegramWebhook).mockClear()
    vi.mocked(setTelegramWebhook).mockResolvedValue(undefined)
  })

  function telegramChannelRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "ch1",
      userId: DEMO_USER_ID,
      name: "tg",
      type: "telegram",
      agentId: "a1",
      kapsoApiKey: null,
      kapsoPhoneNumberId: null,
      kapsoWebhookSecret: null,
      slackConnectUid: null,
      telegramBotToken: "123:abc",
      telegramWebhookSecretToken: "sek",
      telegramBotUsername: "my_bot",
      status: "connected",
      webhookStatus: "pending",
      webhookTestedAt: null,
      webhookTestError: null,
      ...overrides,
    }
  }

  it("registers the prod /eve/v1/telegram URL with the channel's secrets", async () => {
    setRow(agents, minimalAgent())
    setRow(channels, telegramChannelRow())
    await promoteAgentCore(DEMO_USER_ID, "a1", "dpl_1")
    expect(setTelegramWebhook).toHaveBeenCalledWith({
      botToken: "123:abc",
      webhookSecretToken: "sek",
      url: "https://bot-a1.vercel.app/eve/v1/telegram",
    })
  })

  it("does NOT register a webhook for a slack channel", async () => {
    setRow(agents, minimalAgent())
    setRow(channels, {
      id: "ch1",
      userId: DEMO_USER_ID,
      name: "soporte",
      type: "slack",
      agentId: "a1",
      kapsoApiKey: null,
      kapsoPhoneNumberId: null,
      kapsoWebhookSecret: null,
      slackConnectUid: "slack/soporte",
      telegramBotToken: null,
      telegramWebhookSecretToken: null,
      telegramBotUsername: null,
      status: "connected",
      webhookStatus: "pending",
    })
    await promoteAgentCore(DEMO_USER_ID, "a1", "dpl_1")
    expect(setTelegramWebhook).not.toHaveBeenCalled()
  })

  it("does NOT register a webhook for a kapso channel", async () => {
    setRow(agents, minimalAgent())
    setRow(channels, {
      id: "ch1",
      userId: DEMO_USER_ID,
      name: "wa",
      type: "kapso",
      agentId: "a1",
      kapsoApiKey: "k",
      kapsoPhoneNumberId: "5",
      kapsoWebhookSecret: "w",
      slackConnectUid: null,
      telegramBotToken: null,
      telegramWebhookSecretToken: null,
      telegramBotUsername: null,
      status: "connected",
      webhookStatus: "pending",
    })
    await promoteAgentCore(DEMO_USER_ID, "a1", "dpl_1")
    expect(setTelegramWebhook).not.toHaveBeenCalled()
  })

  it("marks the channel webhookStatus=registered on success", async () => {
    setRow(agents, minimalAgent())
    setRow(channels, telegramChannelRow())
    await promoteAgentCore(DEMO_USER_ID, "a1", "dpl_1")
    const ch = (stores.get(channels) ?? [])[0] as Record<string, unknown>
    expect(ch.webhookStatus).toBe("registered")
    expect(ch.webhookTestError).toBeNull()
    expect(ch.webhookTestedAt).toBeInstanceOf(Date)
  })

  it("is best-effort: a setWebhook failure still finalizes the deploy", async () => {
    vi.mocked(setTelegramWebhook).mockRejectedValue(new Error("boom"))
    setRow(agents, minimalAgent())
    setRow(channels, telegramChannelRow())
    const out = await promoteAgentCore(DEMO_USER_ID, "a1", "dpl_1")
    expect(out.url).toBe("https://bot-a1.vercel.app")
    const agent = (stores.get(agents) ?? [])[0] as Record<string, unknown>
    expect(agent.deploymentStatus).toBe("deployed")
    const ch = (stores.get(channels) ?? [])[0] as Record<string, unknown>
    expect(ch.webhookStatus).toBe("failed")
    expect(ch.webhookTestError).toContain("boom")
    expect(ch.webhookTestedAt).toBeInstanceOf(Date)
  })
})

describe("promoteAgentCore — discord interactions endpoint registration", () => {
  beforeEach(() => {
    stores.clear()
    vi.mocked(setDiscordInteractionsEndpoint).mockClear()
    vi.mocked(setDiscordInteractionsEndpoint).mockResolvedValue(undefined)
  })

  function discordChannelRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "ch1",
      userId: DEMO_USER_ID,
      name: "dc",
      type: "discord",
      agentId: "a1",
      kapsoApiKey: null,
      kapsoPhoneNumberId: null,
      kapsoWebhookSecret: null,
      slackConnectUid: null,
      telegramBotToken: null,
      telegramWebhookSecretToken: null,
      telegramBotUsername: null,
      discordBotToken: "bot-tok",
      discordApplicationId: "app-id",
      discordPublicKey: "pub-key",
      status: "connected",
      webhookStatus: "pending",
      webhookTestedAt: null,
      webhookTestError: null,
      ...overrides,
    }
  }

  it("registers the prod /eve/v1/discord URL with the channel's bot token + application id", async () => {
    setRow(agents, minimalAgent())
    setRow(channels, discordChannelRow())
    await promoteAgentCore(DEMO_USER_ID, "a1", "dpl_1")
    expect(setDiscordInteractionsEndpoint).toHaveBeenCalledWith({
      botToken: "bot-tok",
      applicationId: "app-id",
      url: "https://bot-a1.vercel.app/eve/v1/discord",
    })
  })

  it("does NOT register for a slack/kapso/telegram channel", async () => {
    setRow(agents, minimalAgent())
    setRow(channels, {
      id: "ch1",
      userId: DEMO_USER_ID,
      name: "tg",
      type: "telegram",
      agentId: "a1",
      kapsoApiKey: null,
      kapsoPhoneNumberId: null,
      kapsoWebhookSecret: null,
      slackConnectUid: null,
      telegramBotToken: "123:abc",
      telegramWebhookSecretToken: "sek",
      telegramBotUsername: "my_bot",
      discordBotToken: null,
      discordApplicationId: null,
      discordPublicKey: null,
      status: "connected",
      webhookStatus: "pending",
    })
    await promoteAgentCore(DEMO_USER_ID, "a1", "dpl_1")
    expect(setDiscordInteractionsEndpoint).not.toHaveBeenCalled()
  })

  it("marks the channel webhookStatus=registered on success", async () => {
    setRow(agents, minimalAgent())
    setRow(channels, discordChannelRow())
    await promoteAgentCore(DEMO_USER_ID, "a1", "dpl_1")
    const ch = (stores.get(channels) ?? [])[0] as Record<string, unknown>
    expect(ch.webhookStatus).toBe("registered")
    expect(ch.webhookTestError).toBeNull()
    expect(ch.webhookTestedAt).toBeInstanceOf(Date)
  })

  it("is best-effort: a registration failure still finalizes the deploy", async () => {
    vi.mocked(setDiscordInteractionsEndpoint).mockRejectedValue(new Error("boom"))
    setRow(agents, minimalAgent())
    setRow(channels, discordChannelRow())
    const out = await promoteAgentCore(DEMO_USER_ID, "a1", "dpl_1")
    expect(out.url).toBe("https://bot-a1.vercel.app")
    const agent = (stores.get(agents) ?? [])[0] as Record<string, unknown>
    expect(agent.deploymentStatus).toBe("deployed")
    const ch = (stores.get(channels) ?? [])[0] as Record<string, unknown>
    expect(ch.webhookStatus).toBe("failed")
    expect(ch.webhookTestError).toContain("boom")
    expect(ch.webhookTestedAt).toBeInstanceOf(Date)
  })
})

describe("promoteAgentCore — kapso webhook registration", () => {
  beforeEach(() => {
    stores.clear()
    vi.mocked(registerKapsoWebhook).mockClear()
    vi.mocked(registerKapsoWebhook).mockResolvedValue(undefined)
  })

  function kapsoChannelRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "ch1",
      userId: DEMO_USER_ID,
      name: "wa",
      type: "kapso",
      agentId: "a1",
      kapsoApiKey: "k",
      kapsoPhoneNumberId: "PN1",
      kapsoWebhookSecret: "shh",
      slackConnectUid: null,
      telegramBotToken: null,
      telegramWebhookSecretToken: null,
      telegramBotUsername: null,
      discordBotToken: null,
      discordApplicationId: null,
      discordPublicKey: null,
      status: "connected",
      webhookStatus: "pending",
      webhookTestedAt: null,
      webhookTestError: null,
      ...overrides,
    }
  }

  it("registers the prod /kapso/webhook URL with the channel's creds", async () => {
    setRow(agents, minimalAgent())
    setRow(channels, kapsoChannelRow())
    await promoteAgentCore(DEMO_USER_ID, "a1", "dpl_1")
    expect(registerKapsoWebhook).toHaveBeenCalledWith({
      apiKey: "k",
      phoneNumberId: "PN1",
      secret: "shh",
      url: "https://bot-a1.vercel.app/kapso/webhook",
    })
  })

  it("does NOT register when the kapso channel is missing creds", async () => {
    setRow(agents, minimalAgent())
    setRow(channels, kapsoChannelRow({ kapsoPhoneNumberId: null }))
    await promoteAgentCore(DEMO_USER_ID, "a1", "dpl_1")
    expect(registerKapsoWebhook).not.toHaveBeenCalled()
  })

  it("marks the channel webhookStatus=registered on success", async () => {
    setRow(agents, minimalAgent())
    setRow(channels, kapsoChannelRow())
    await promoteAgentCore(DEMO_USER_ID, "a1", "dpl_1")
    const ch = (stores.get(channels) ?? [])[0] as Record<string, unknown>
    expect(ch.webhookStatus).toBe("registered")
    expect(ch.webhookTestError).toBeNull()
    expect(ch.webhookTestedAt).toBeInstanceOf(Date)
  })

  it("is best-effort: a kapso registration failure still finalizes the deploy", async () => {
    vi.mocked(registerKapsoWebhook).mockRejectedValue(new Error("boom"))
    setRow(agents, minimalAgent())
    setRow(channels, kapsoChannelRow())
    const out = await promoteAgentCore(DEMO_USER_ID, "a1", "dpl_1")
    expect(out.url).toBe("https://bot-a1.vercel.app")
    const agent = (stores.get(agents) ?? [])[0] as Record<string, unknown>
    expect(agent.deploymentStatus).toBe("deployed")
    const ch = (stores.get(channels) ?? [])[0] as Record<string, unknown>
    expect(ch.webhookStatus).toBe("failed")
    expect(ch.webhookTestError).toContain("boom")
    expect(ch.webhookTestedAt).toBeInstanceOf(Date)
  })
})
