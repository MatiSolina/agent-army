import { describe, it, expect } from "vitest"
import {
  claimedDeployLock,
  truncate,
  kapsoEnvFromChannel,
  telegramEnvFromChannel,
  discordEnvFromChannel,
} from "@/lib/eve/deploy-helpers"

describe("claimedDeployLock (concurrency CAS guard)", () => {
  it("proceeds when the compare-and-swap matched a row", () => {
    expect(claimedDeployLock(1)).toBe(true)
  })

  it("bails when zero rows matched (a concurrent deploy holds the lock)", () => {
    expect(claimedDeployLock(0)).toBe(false)
  })
})

describe("truncate", () => {
  it("leaves short messages untouched", () => {
    expect(truncate("boom", 2000)).toBe("boom")
  })

  it("truncates long messages and appends an ellipsis", () => {
    const out = truncate("x".repeat(2100), 2000)
    expect(out.length).toBe(2001)
    expect(out.endsWith("…")).toBe(true)
  })
})

describe("kapsoEnvFromChannel", () => {
  it("maps a fully-configured channel to all three KAPSO_* vars", () => {
    expect(
      kapsoEnvFromChannel({
        kapsoApiKey: "k_123",
        kapsoPhoneNumberId: "555",
        kapsoWebhookSecret: "shh",
      }),
    ).toEqual({
      KAPSO_API_KEY: "k_123",
      KAPSO_PHONE_NUMBER_ID: "555",
      KAPSO_WEBHOOK_SECRET: "shh",
    })
  })

  it("omits vars whose value is null/empty/whitespace", () => {
    expect(
      kapsoEnvFromChannel({
        kapsoApiKey: "k_123",
        kapsoPhoneNumberId: null,
        kapsoWebhookSecret: "   ",
      }),
    ).toEqual({ KAPSO_API_KEY: "k_123" })
  })

  it("returns an empty object for a null channel (no assigned channel)", () => {
    expect(kapsoEnvFromChannel(null)).toEqual({})
  })

  it("returns an empty object for a channel with no creds", () => {
    expect(
      kapsoEnvFromChannel({
        kapsoApiKey: null,
        kapsoPhoneNumberId: null,
        kapsoWebhookSecret: null,
      }),
    ).toEqual({})
  })
})

describe("telegramEnvFromChannel", () => {
  it("maps a configured channel to both TELEGRAM_* vars", () => {
    expect(
      telegramEnvFromChannel({
        telegramBotToken: "123:abc",
        telegramWebhookSecretToken: "s",
      }),
    ).toEqual({
      TELEGRAM_BOT_TOKEN: "123:abc",
      TELEGRAM_WEBHOOK_SECRET_TOKEN: "s",
    })
  })

  it("returns an empty object for a null channel", () => {
    expect(telegramEnvFromChannel(null)).toEqual({})
  })

  it("omits blank/whitespace-only values", () => {
    expect(
      telegramEnvFromChannel({
        telegramBotToken: "123:abc",
        telegramWebhookSecretToken: "   ",
      }),
    ).toEqual({ TELEGRAM_BOT_TOKEN: "123:abc" })
  })
})

describe("discordEnvFromChannel", () => {
  it("maps a fully-configured channel to all three DISCORD_* vars", () => {
    expect(
      discordEnvFromChannel({
        discordBotToken: "bot-tok",
        discordApplicationId: "app-id",
        discordPublicKey: "pub-key",
      }),
    ).toEqual({
      DISCORD_BOT_TOKEN: "bot-tok",
      DISCORD_APPLICATION_ID: "app-id",
      DISCORD_PUBLIC_KEY: "pub-key",
    })
  })

  it("returns an empty object for a null channel", () => {
    expect(discordEnvFromChannel(null)).toEqual({})
  })

  it("omits blank/whitespace-only values", () => {
    expect(
      discordEnvFromChannel({
        discordBotToken: "bot-tok",
        discordApplicationId: "   ",
        discordPublicKey: "",
      }),
    ).toEqual({ DISCORD_BOT_TOKEN: "bot-tok" })
  })
})
