import { describe, expect, it } from "vitest"
import type { Channel } from "@/lib/db/schema"
import {
  groupChannelsByIsland,
  isChannelConfigured,
  islandOf,
  toClientChannel,
  type ClientChannel,
} from "./client-channel"

function fullRow(overrides: Partial<Channel> = {}): Channel {
  return {
    id: "channel-1",
    userId: "demo-user",
    name: "support",
    type: "kapso",
    agentId: "agent-1",
    kapsoApiKey: "kapso-secret-api-key",
    kapsoPhoneNumberId: "123456789",
    kapsoPhoneNumber: "+1 205-840-7113",
    kapsoWebhookSecret: "webhook-signing-secret",
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
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-02T00:00:00Z"),
    ...overrides,
  }
}

describe("toClientChannel", () => {
  it("exposes only browser-safe channel fields", () => {
    const client = toClientChannel(fullRow())
    expect(client).toEqual<ClientChannel>({
      id: "channel-1",
      name: "support",
      type: "kapso",
      agentId: "agent-1",
      kapsoPhoneNumberId: "123456789",
      kapsoPhoneNumber: "+1 205-840-7113",
      slackConnectUid: null,
      telegramBotUsername: null,
      status: "connected",
      webhookStatus: "pending",
      hasKapsoApiKey: true,
      hasKapsoWebhookSecret: true,
      hasTelegramBotToken: false,
      hasTelegramWebhookSecretToken: false,
      hasDiscordBotToken: false,
      hasDiscordApplicationId: false,
      hasDiscordPublicKey: false,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })
  })

  it("surfaces the Slack connector UID (not a secret) for a slack channel", () => {
    const client = toClientChannel(
      fullRow({ type: "slack", slackConnectUid: "slack/soporte" }),
    )
    expect(client.slackConnectUid).toBe("slack/soporte")
  })

  it("surfaces the telegram bot username + secret booleans, never the raw secrets", () => {
    const client = toClientChannel(
      fullRow({
        type: "telegram",
        telegramBotToken: "123:supersecret",
        telegramWebhookSecretToken: "whk-supersecret",
        telegramBotUsername: "my_bot",
      }),
    )
    // Non-secret username surfaced raw.
    expect(client.telegramBotUsername).toBe("my_bot")
    // Only booleans for the two secrets.
    expect(client.hasTelegramBotToken).toBe(true)
    expect(client.hasTelegramWebhookSecretToken).toBe(true)
    // Raw secret values never leak (neither as keys nor in serialization).
    const keys = Object.keys(client)
    expect(keys).not.toContain("telegramBotToken")
    expect(keys).not.toContain("telegramWebhookSecretToken")
    const serialized = JSON.stringify(client)
    expect(serialized).not.toContain("123:supersecret")
    expect(serialized).not.toContain("whk-supersecret")
  })

  it("reports false telegram secret booleans when the secrets are absent", () => {
    const client = toClientChannel(
      fullRow({
        type: "telegram",
        telegramBotToken: null,
        telegramWebhookSecretToken: null,
        telegramBotUsername: null,
      }),
    )
    expect(client.hasTelegramBotToken).toBe(false)
    expect(client.hasTelegramWebhookSecretToken).toBe(false)
    expect(client.telegramBotUsername).toBeNull()
  })

  it("surfaces discord secret booleans, never the raw secrets", () => {
    const client = toClientChannel(
      fullRow({
        type: "discord",
        discordBotToken: "discord-bot-secret",
        discordApplicationId: "discord-app-id",
        discordPublicKey: "discord-pub-key",
      }),
    )
    expect(client.hasDiscordBotToken).toBe(true)
    expect(client.hasDiscordApplicationId).toBe(true)
    expect(client.hasDiscordPublicKey).toBe(true)
    // Raw values never leak (neither as keys nor in serialization).
    const keys = Object.keys(client)
    expect(keys).not.toContain("discordBotToken")
    expect(keys).not.toContain("discordApplicationId")
    expect(keys).not.toContain("discordPublicKey")
    const serialized = JSON.stringify(client)
    expect(serialized).not.toContain("discord-bot-secret")
    expect(serialized).not.toContain("discord-app-id")
    expect(serialized).not.toContain("discord-pub-key")
  })

  it("reports false discord booleans when the fields are absent", () => {
    const client = toClientChannel(
      fullRow({
        type: "discord",
        discordBotToken: null,
        discordApplicationId: null,
        discordPublicKey: null,
      }),
    )
    expect(client.hasDiscordBotToken).toBe(false)
    expect(client.hasDiscordApplicationId).toBe(false)
    expect(client.hasDiscordPublicKey).toBe(false)
  })

  it("never leaks Kapso credentials", () => {
    const client = toClientChannel(fullRow())
    const serialized = JSON.stringify(client)
    expect(serialized).not.toContain("kapso-secret-api-key")
    expect(serialized).not.toContain("webhook-signing-secret")

    const keys = Object.keys(client)
    expect(keys).not.toContain("kapsoApiKey")
    expect(keys).not.toContain("kapsoWebhookSecret")
    expect(keys).not.toContain("userId")
  })

  it("reports credential state without exposing credential values", () => {
    expect(
      toClientChannel(fullRow({ kapsoApiKey: null })).hasKapsoApiKey,
    ).toBe(false)
    expect(
      toClientChannel(fullRow({ kapsoWebhookSecret: null }))
        .hasKapsoWebhookSecret,
    ).toBe(false)
  })
})

describe("isChannelConfigured", () => {
  const cc = (overrides: Partial<Channel> = {}) =>
    toClientChannel(fullRow(overrides))

  it("kapso: configured only with api key + phone number + webhook secret", () => {
    expect(isChannelConfigured(cc())).toBe(true)
    expect(isChannelConfigured(cc({ kapsoApiKey: null }))).toBe(false)
    expect(isChannelConfigured(cc({ kapsoPhoneNumberId: null }))).toBe(false)
    expect(isChannelConfigured(cc({ kapsoWebhookSecret: null }))).toBe(false)
  })

  it("does NOT depend on whether an agent is assigned", () => {
    expect(isChannelConfigured(cc({ agentId: null }))).toBe(true)
  })

  it("slack: configured when the connector UID is set", () => {
    expect(
      isChannelConfigured(cc({ type: "slack", slackConnectUid: "slack/x" })),
    ).toBe(true)
    expect(
      isChannelConfigured(cc({ type: "slack", slackConnectUid: null })),
    ).toBe(false)
  })

  it("telegram: configured when both secrets are present", () => {
    expect(
      isChannelConfigured(
        cc({
          type: "telegram",
          telegramBotToken: "t",
          telegramWebhookSecretToken: "s",
        }),
      ),
    ).toBe(true)
    expect(
      isChannelConfigured(
        cc({ type: "telegram", telegramBotToken: "t", telegramWebhookSecretToken: null }),
      ),
    ).toBe(false)
  })

  it("discord: configured when all three secrets are present", () => {
    expect(
      isChannelConfigured(
        cc({
          type: "discord",
          discordBotToken: "b",
          discordApplicationId: "a",
          discordPublicKey: "p",
        }),
      ),
    ).toBe(true)
    expect(
      isChannelConfigured(
        cc({ type: "discord", discordBotToken: "b", discordApplicationId: "a", discordPublicKey: null }),
      ),
    ).toBe(false)
  })
})

describe("islandOf", () => {
  it("maps slack, telegram, and discord to their own islands", () => {
    expect(islandOf("slack")).toBe("slack")
    expect(islandOf("telegram")).toBe("telegram")
    expect(islandOf("discord")).toBe("discord")
  })

  it("buckets kapso and any unknown/whatsapp type into the kapso island", () => {
    expect(islandOf("kapso")).toBe("kapso")
    expect(islandOf("whatsapp")).toBe("kapso")
    expect(islandOf("")).toBe("kapso")
  })
})

describe("groupChannelsByIsland", () => {
  const client = (overrides: Partial<ClientChannel>): ClientChannel =>
    toClientChannel(fullRow()) && {
      ...toClientChannel(fullRow()),
      ...overrides,
    }

  it("returns the islands in a stable order, even when empty", () => {
    expect(groupChannelsByIsland([]).map((g) => g.island)).toEqual([
      "slack",
      "kapso",
      "telegram",
      "discord",
    ])
  })

  it("places each channel under its island bucket", () => {
    const channels = [
      client({ id: "a", type: "slack" }),
      client({ id: "b", type: "kapso" }),
      client({ id: "c", type: "telegram" }),
      client({ id: "d", type: "whatsapp" }),
      client({ id: "e", type: "discord" }),
    ]
    const byIsland = Object.fromEntries(
      groupChannelsByIsland(channels).map((g) => [
        g.island,
        g.channels.map((c) => c.id),
      ]),
    )
    expect(byIsland).toEqual({
      slack: ["a"],
      kapso: ["b", "d"],
      telegram: ["c"],
      discord: ["e"],
    })
  })
})
