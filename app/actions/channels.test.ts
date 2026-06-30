import { describe, it, expect, vi, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Mock every I/O boundary so the "use server" channel actions run with no
// request, no network, no real db. The actions are exercised end-to-end
// (createChannel / updateChannel / assignAgentToChannel) which internally runs
// computeStatus / validateChannelAssignment / normalizeChannelInput. The
// helpers themselves can't be imported (a "use server" file only exports async
// functions). Mirrors the deploy-core.test capture-and-fixture db.
// ---------------------------------------------------------------------------

import { agents, channels } from "@/lib/db/schema"

const { stores, fakeDb, inserted } = vi.hoisted(() => {
  const stores = new Map<unknown, Record<string, unknown>[]>()
  const inserted: Record<string, unknown>[] = []
  const fakeDb = () => ({
    select: (_proj?: unknown) => ({
      from: (table: unknown) => {
        const build = () => {
          const rows = (stores.get(table) ?? []).slice()
          const p = Promise.resolve(rows) as Promise<unknown[]> & {
            limit: () => Promise<unknown[]>
            orderBy: () => Promise<unknown[]>
          }
          p.limit = () => Promise.resolve(rows)
          p.orderBy = () => Promise.resolve(rows)
          return p
        }
        return { where: () => build(), orderBy: () => build() }
      },
    }),
    insert: (_table: unknown) => ({
      values: (v: Record<string, unknown>) => {
        inserted.push(v)
        return Promise.resolve()
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => {
          const rows = stores.get(table) ?? []
          for (const r of rows) Object.assign(r, patch)
          return Promise.resolve(rows.slice())
        },
      }),
    }),
  })
  return { stores, fakeDb, inserted }
})

vi.mock("@/lib/db", () => ({ db: fakeDb() }))
vi.mock("@/lib/session", () => ({
  requireUserId: async () => "demo-user",
  DEMO_USER_ID: "demo-user",
}))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("next/server", () => ({ after: vi.fn() }))
vi.mock("@/app/actions/deploy", () => ({
  deployAndPromoteAgent: vi.fn(async () => ({ url: "https://x.vercel.app" })),
}))
vi.mock("@/lib/vercel/client", () => ({ listConnectors: vi.fn(async () => []) }))
vi.mock("@/lib/vercel/auth", () => ({
  resolveVercelAuth: async () => ({ token: "t", teamId: "team" }),
}))
vi.mock("@/lib/vercel/team-slug", () => ({ getVercelTeamSlug: () => null }))

// The pure Platform-API client is unit-tested in lib/channels/kapso.test.ts;
// here we only verify the action's glue (auth + which key it discovers with).
const listKapsoPhoneNumbersMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/channels/kapso", () => ({
  listKapsoPhoneNumbers: listKapsoPhoneNumbersMock,
}))

import {
  createChannel,
  updateChannel,
  assignAgentToChannel,
  discoverKapsoPhoneNumbers,
} from "./channels"

function setRows(table: unknown, rows: Record<string, unknown>[]) {
  stores.set(table, rows)
}

beforeEach(() => {
  stores.clear()
  inserted.length = 0
  // An assigned agent must exist for assertAgentExists to pass.
  setRows(agents, [{ id: "agent-1", userId: "demo-user" }])
})

describe("createChannel — telegram", () => {
  it("persists a telegram channel with both secrets and the bot username", async () => {
    await createChannel({
      name: "tg",
      type: "telegram",
      agentId: "agent-1",
      telegramBotToken: "123:abc",
      telegramWebhookSecretToken: "sek",
      telegramBotUsername: "my_bot",
    })
    const row = inserted[0]
    expect(row.type).toBe("telegram")
    expect(row.telegramBotToken).toBe("123:abc")
    expect(row.telegramWebhookSecretToken).toBe("sek")
    expect(row.telegramBotUsername).toBe("my_bot")
    // Both secrets present + assigned → connected.
    expect(row.status).toBe("connected")
  })

  it("auto-generates a webhook secret token when none is provided", async () => {
    await createChannel({
      name: "tg",
      type: "telegram",
      agentId: "agent-1",
      telegramBotToken: "123:abc",
      telegramBotUsername: "my_bot",
    })
    const row = inserted[0]
    expect(typeof row.telegramWebhookSecretToken).toBe("string")
    expect((row.telegramWebhookSecretToken as string).length).toBeGreaterThan(0)
    // url-safe base64 charset only.
    expect(row.telegramWebhookSecretToken as string).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it("is disconnected when unassigned (no agent), even with a token", async () => {
    await createChannel({
      name: "tg",
      type: "telegram",
      agentId: null,
      telegramBotToken: "123:abc",
      telegramWebhookSecretToken: "sek",
    })
    expect(inserted[0].status).toBe("disconnected")
  })

  it("throws when assigned but the bot token is missing", async () => {
    await expect(
      createChannel({
        name: "tg",
        type: "telegram",
        agentId: "agent-1",
        telegramWebhookSecretToken: "sek",
      }),
    ).rejects.toThrow(/Telegram/i)
  })
})

describe("updateChannel — telegram preserve-on-blank", () => {
  function existingTelegram(overrides: Record<string, unknown> = {}) {
    return {
      id: "ch1",
      userId: "demo-user",
      name: "tg",
      type: "telegram",
      agentId: "agent-1",
      kapsoApiKey: null,
      kapsoPhoneNumberId: null,
      kapsoWebhookSecret: null,
      slackConnectUid: null,
      telegramBotToken: "123:abc",
      telegramWebhookSecretToken: "sek",
      telegramBotUsername: "my_bot",
      status: "connected",
      webhookStatus: "pending",
      ...overrides,
    }
  }

  it("leaves stored secrets unchanged when input secrets are undefined", async () => {
    const row = existingTelegram()
    setRows(channels, [row])
    await updateChannel("ch1", { name: "tg", telegramBotUsername: "renamed" })
    expect(row.telegramBotToken).toBe("123:abc")
    expect(row.telegramWebhookSecretToken).toBe("sek")
    expect(row.telegramBotUsername).toBe("renamed")
  })

  it("overwrites a secret when a new value is provided", async () => {
    const row = existingTelegram()
    setRows(channels, [row])
    await updateChannel("ch1", {
      name: "tg",
      telegramBotToken: "999:zzz",
    })
    expect(row.telegramBotToken).toBe("999:zzz")
    // The other secret is preserved (undefined input).
    expect(row.telegramWebhookSecretToken).toBe("sek")
  })
})

describe("assignAgentToChannel — telegram", () => {
  it("re-validates using the existing row's telegram secrets", async () => {
    setRows(channels, [
      {
        id: "ch1",
        userId: "demo-user",
        name: "tg",
        type: "telegram",
        agentId: null,
        kapsoApiKey: null,
        kapsoPhoneNumberId: null,
        kapsoWebhookSecret: null,
        slackConnectUid: null,
        telegramBotToken: null,
        telegramWebhookSecretToken: null,
        telegramBotUsername: "my_bot",
        status: "disconnected",
        webhookStatus: "pending",
      },
    ])
    await expect(assignAgentToChannel("ch1", "agent-1")).rejects.toThrow(/Telegram/i)
  })
})

describe("assignAgentToChannel — one channel per agent", () => {
  const tgRow = (over: Record<string, unknown>) => ({
    userId: "demo-user",
    type: "telegram",
    agentId: null,
    kapsoApiKey: null,
    kapsoPhoneNumberId: null,
    kapsoWebhookSecret: null,
    slackConnectUid: null,
    telegramBotToken: "1:abc",
    telegramWebhookSecretToken: "sek",
    telegramBotUsername: null,
    discordBotToken: null,
    discordApplicationId: null,
    discordPublicKey: null,
    status: "disconnected",
    webhookStatus: "pending",
    ...over,
  })

  it("rejects assigning an agent that already runs another channel", async () => {
    setRows(channels, [
      tgRow({ id: "c1", name: "first", agentId: null }),
      tgRow({ id: "c2", name: "second", agentId: "agent-1" }),
    ])
    await expect(assignAgentToChannel("c1", "agent-1")).rejects.toThrow(
      /already|one channel/i,
    )
  })

  it("allows assigning an agent that is not on any other channel", async () => {
    setRows(channels, [
      tgRow({ id: "c1", name: "first", agentId: null }),
      tgRow({ id: "c2", name: "second", agentId: null }),
    ])
    await expect(assignAgentToChannel("c1", "agent-1")).resolves.toBeUndefined()
  })

  it("rejects creating a channel for an agent that already runs another", async () => {
    setRows(channels, [tgRow({ id: "c2", name: "second", agentId: "agent-1" })])
    await expect(
      createChannel({
        name: "new",
        type: "telegram",
        agentId: "agent-1",
        telegramBotToken: "1:abc",
        telegramWebhookSecretToken: "sek",
      }),
    ).rejects.toThrow(/already|one channel/i)
  })
})

describe("createChannel — discord", () => {
  it("persists a discord channel with all three secrets", async () => {
    await createChannel({
      name: "dc",
      type: "discord",
      agentId: "agent-1",
      discordBotToken: "bot-tok",
      discordApplicationId: "app-id",
      discordPublicKey: "pub-key",
    })
    const row = inserted[0]
    expect(row.type).toBe("discord")
    expect(row.discordBotToken).toBe("bot-tok")
    expect(row.discordApplicationId).toBe("app-id")
    expect(row.discordPublicKey).toBe("pub-key")
    // All three present + assigned → connected.
    expect(row.status).toBe("connected")
  })

  it("is disconnected when unassigned, even with all secrets", async () => {
    await createChannel({
      name: "dc",
      type: "discord",
      agentId: null,
      discordBotToken: "bot-tok",
      discordApplicationId: "app-id",
      discordPublicKey: "pub-key",
    })
    expect(inserted[0].status).toBe("disconnected")
  })

  it("throws when assigned but a secret is missing", async () => {
    await expect(
      createChannel({
        name: "dc",
        type: "discord",
        agentId: "agent-1",
        discordBotToken: "bot-tok",
        discordApplicationId: "app-id",
        // discordPublicKey missing
      }),
    ).rejects.toThrow(/Discord/i)
  })

  it("does NOT auto-generate any value when a discord secret is blank", async () => {
    // CRITICAL DIVERGENCE from telegram: none of the three discord secrets are
    // minted. A blank public key stays null (it comes from the Discord portal),
    // so it does not become connected and nothing is randomly generated.
    await createChannel({
      name: "dc",
      type: "discord",
      agentId: null,
      discordBotToken: "bot-tok",
      discordApplicationId: "app-id",
    })
    const row = inserted[0]
    expect(row.discordPublicKey).toBeNull()
    expect(row.discordBotToken).toBe("bot-tok")
    expect(row.discordApplicationId).toBe("app-id")
  })
})

describe("updateChannel — discord preserve-on-blank", () => {
  function existingDiscord(overrides: Record<string, unknown> = {}) {
    return {
      id: "ch1",
      userId: "demo-user",
      name: "dc",
      type: "discord",
      agentId: "agent-1",
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

  it("leaves stored secrets unchanged when input secrets are undefined", async () => {
    const row = existingDiscord()
    setRows(channels, [row])
    await updateChannel("ch1", { name: "dc renamed" })
    expect(row.discordBotToken).toBe("bot-tok")
    expect(row.discordApplicationId).toBe("app-id")
    expect(row.discordPublicKey).toBe("pub-key")
    expect(row.name).toBe("dc renamed")
  })

  it("overwrites a secret when a new value is provided", async () => {
    const row = existingDiscord()
    setRows(channels, [row])
    await updateChannel("ch1", {
      name: "dc",
      discordBotToken: "new-tok",
    })
    expect(row.discordBotToken).toBe("new-tok")
    // The others are preserved (undefined input).
    expect(row.discordApplicationId).toBe("app-id")
    expect(row.discordPublicKey).toBe("pub-key")
  })
})

describe("assignAgentToChannel — discord", () => {
  it("re-validates using the existing row's discord secrets", async () => {
    setRows(channels, [
      {
        id: "ch1",
        userId: "demo-user",
        name: "dc",
        type: "discord",
        agentId: null,
        kapsoApiKey: null,
        kapsoPhoneNumberId: null,
        kapsoWebhookSecret: null,
        slackConnectUid: null,
        telegramBotToken: null,
        telegramWebhookSecretToken: null,
        telegramBotUsername: null,
        discordBotToken: "bot-tok",
        discordApplicationId: "app-id",
        discordPublicKey: null,
        status: "disconnected",
        webhookStatus: "pending",
      },
    ])
    await expect(assignAgentToChannel("ch1", "agent-1")).rejects.toThrow(/Discord/i)
  })
})

describe("discoverKapsoPhoneNumbers", () => {
  beforeEach(() => listKapsoPhoneNumbersMock.mockReset())

  it("uses the channel's stored API key (client never resends the secret)", async () => {
    setRows(channels, [
      { id: "c1", userId: "demo-user", type: "kapso", kapsoApiKey: "stored-key" },
    ])
    listKapsoPhoneNumbersMock.mockResolvedValueOnce([
      { phoneNumberId: "1", label: "+54 · Acme", status: "CONNECTED" },
    ])
    const res = await discoverKapsoPhoneNumbers({ channelId: "c1" })
    expect(listKapsoPhoneNumbersMock).toHaveBeenCalledWith("stored-key")
    expect(res.numbers).toHaveLength(1)
    expect(res.error).toBeNull()
  })

  it("prefers an explicitly typed key (new-channel case) over any stored one", async () => {
    listKapsoPhoneNumbersMock.mockResolvedValueOnce([])
    const res = await discoverKapsoPhoneNumbers({ apiKey: "typed-key" })
    expect(listKapsoPhoneNumbersMock).toHaveBeenCalledWith("typed-key")
    expect(res.error).toBeNull()
  })

  it("returns an error string instead of throwing when discovery fails", async () => {
    listKapsoPhoneNumbersMock.mockRejectedValueOnce(
      new Error("Kapso phone-numbers request failed (401)"),
    )
    const res = await discoverKapsoPhoneNumbers({ apiKey: "bad" })
    expect(res.numbers).toEqual([])
    expect(res.error).toMatch(/401/)
  })

  it("returns an error and skips the network when no key is available", async () => {
    setRows(channels, [
      { id: "c2", userId: "demo-user", type: "kapso", kapsoApiKey: null },
    ])
    const res = await discoverKapsoPhoneNumbers({ channelId: "c2" })
    expect(res.error).toMatch(/api key/i)
    expect(listKapsoPhoneNumbersMock).not.toHaveBeenCalled()
  })
})

describe("createChannel — kapso webhook secret auto-mint", () => {
  it("auto-generates the webhook secret when none is provided", async () => {
    await createChannel({
      name: "wa",
      type: "kapso",
      agentId: "agent-1",
      kapsoApiKey: "k",
      kapsoPhoneNumberId: "123",
    })
    const row = inserted[0]
    expect(typeof row.kapsoWebhookSecret).toBe("string")
    expect((row.kapsoWebhookSecret as string).length).toBeGreaterThanOrEqual(32)
    // All three creds present + assigned → connected (no manual secret needed).
    expect(row.status).toBe("connected")
  })

  it("keeps an explicitly provided secret instead of minting a new one", async () => {
    await createChannel({
      name: "wa",
      type: "kapso",
      agentId: "agent-1",
      kapsoApiKey: "k",
      kapsoPhoneNumberId: "123",
      kapsoWebhookSecret: "operator-chosen",
    })
    expect(inserted[0].kapsoWebhookSecret).toBe("operator-chosen")
  })

  it("persists the display phone number alongside the id", async () => {
    await createChannel({
      name: "wa",
      type: "kapso",
      agentId: "agent-1",
      kapsoApiKey: "k",
      kapsoPhoneNumberId: "123",
      kapsoPhoneNumber: "+1 205-840-7113",
    })
    expect(inserted[0].kapsoPhoneNumber).toBe("+1 205-840-7113")
  })
})
