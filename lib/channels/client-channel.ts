import type { Channel } from "@/lib/db/schema"

/**
 * Browser-safe channel shape for RSC/client props.
 *
 * It deliberately omits secret-bearing fields: `kapsoApiKey` and
 * `kapsoWebhookSecret`. The UI only needs booleans to render configured-state
 * hints without serializing credentials into HTML.
 */
export type ClientChannel = {
  id: string
  name: string
  type: string
  agentId: string | null
  kapsoPhoneNumberId: string | null
  /** Non-secret display phone number (e.g. "+1 205-840-7113") for the UI + wa.me link. */
  kapsoPhoneNumber: string | null
  /** Slack connector UID (e.g. "slack/soporte"). Not a secret. */
  slackConnectUid: string | null
  /** Telegram bot @username (e.g. "my_bot"). Not a secret. */
  telegramBotUsername: string | null
  status: string
  webhookStatus: string
  hasKapsoApiKey: boolean
  hasKapsoWebhookSecret: boolean
  /** Whether the telegram bot token secret is set (value never surfaced). */
  hasTelegramBotToken: boolean
  /** Whether the telegram webhook secret token is set (value never surfaced). */
  hasTelegramWebhookSecretToken: boolean
  /** Whether the discord bot token secret is set (value never surfaced). */
  hasDiscordBotToken: boolean
  /** Whether the discord application id secret is set (value never surfaced). */
  hasDiscordApplicationId: boolean
  /** Whether the discord public key secret is set (value never surfaced). */
  hasDiscordPublicKey: boolean
  createdAt: Date
}

/**
 * Whether a channel has the CREDENTIALS its type needs to operate — independent
 * of whether an agent is assigned. The server's computeStatus folds in agentId
 * (no agent → "disconnected"), so a configured-but-unassigned channel reads as
 * not-connected; the UI uses this to still offer agent assignment for such a
 * channel (you can't gate assignment on "connected" — that already requires an
 * agent). Browser-safe: reads only the non-secret booleans + ids.
 */
export function isChannelConfigured(channel: ClientChannel): boolean {
  if (channel.type === "slack") return Boolean(channel.slackConnectUid)
  if (channel.type === "telegram") {
    return channel.hasTelegramBotToken && channel.hasTelegramWebhookSecretToken
  }
  if (channel.type === "discord") {
    return (
      channel.hasDiscordBotToken &&
      channel.hasDiscordApplicationId &&
      channel.hasDiscordPublicKey
    )
  }
  return (
    channel.hasKapsoApiKey &&
    Boolean(channel.kapsoPhoneNumberId) &&
    channel.hasKapsoWebhookSecret
  )
}

/** The channel types we group the Channels page into, in display order. */
export const CHANNEL_ISLANDS = ["slack", "kapso", "telegram", "discord"] as const
export type ChannelIsland = (typeof CHANNEL_ISLANDS)[number]

/**
 * slack/telegram/discord each own their island; everything else (kapso,
 * whatsapp, …) falls into the kapso island. Discord gets its own island so the
 * DiscordStatus card routes to it instead of falling through to kapso.
 */
export function islandOf(type: string): ChannelIsland {
  return type === "slack"
    ? "slack"
    : type === "telegram"
      ? "telegram"
      : type === "discord"
        ? "discord"
        : "kapso"
}

/** Bucket channels into the three islands (always returns all three, in order). */
export function groupChannelsByIsland(
  channels: ClientChannel[],
): { island: ChannelIsland; channels: ClientChannel[] }[] {
  return CHANNEL_ISLANDS.map((island) => ({
    island,
    channels: channels.filter((c) => islandOf(c.type) === island),
  }))
}

export function toClientChannel(row: Channel): ClientChannel {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    agentId: row.agentId,
    kapsoPhoneNumberId: row.kapsoPhoneNumberId,
    kapsoPhoneNumber: row.kapsoPhoneNumber,
    slackConnectUid: row.slackConnectUid,
    telegramBotUsername: row.telegramBotUsername,
    status: row.status,
    webhookStatus: row.webhookStatus,
    hasKapsoApiKey: Boolean(row.kapsoApiKey),
    hasKapsoWebhookSecret: Boolean(row.kapsoWebhookSecret),
    hasTelegramBotToken: Boolean(row.telegramBotToken),
    hasTelegramWebhookSecretToken: Boolean(row.telegramWebhookSecretToken),
    hasDiscordBotToken: Boolean(row.discordBotToken),
    hasDiscordApplicationId: Boolean(row.discordApplicationId),
    hasDiscordPublicKey: Boolean(row.discordPublicKey),
    createdAt: row.createdAt,
  }
}
