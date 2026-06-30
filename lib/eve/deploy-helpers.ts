/**
 * Pure helpers for the deployAgent server action. Kept OUT of the
 * "use server" module because a "use server" file may only export async
 * functions — these are sync and need to be unit-testable in isolation.
 */

/** Truncate a failure message before persisting it. */
export function truncate(msg: string, max = 2000): string {
  return msg.length > max ? msg.slice(0, max) + "…" : msg
}

/**
 * Decide whether a deploy may proceed given how many rows the compare-and-swap
 * "mark deploying" UPDATE matched. Zero rows means a concurrent deploy already
 * holds the lock (or the row vanished), so we must bail.
 */
export function claimedDeployLock(matchedRows: number): boolean {
  return matchedRows > 0
}

/**
 * Map an assigned WhatsApp channel's Kapso credentials to the env vars the
 * generated Eve channel reads (KAPSO_API_KEY / KAPSO_PHONE_NUMBER_ID /
 * KAPSO_WEBHOOK_SECRET). These are pushed onto the deployment so the agent's own
 * runtime can receive + reply over WhatsApp. Vars with no usable value
 * (null / empty / whitespace) are omitted so we never set a blank env var, and a
 * null channel (no channel assigned to this agent) yields {}.
 */
export function kapsoEnvFromChannel(
  channel: {
    kapsoApiKey: string | null
    kapsoPhoneNumberId: string | null
    kapsoWebhookSecret: string | null
  } | null,
): Record<string, string> {
  if (!channel) return {}
  const env: Record<string, string> = {}
  const put = (key: string, value: string | null) => {
    if (value && value.trim().length > 0) env[key] = value
  }
  put("KAPSO_API_KEY", channel.kapsoApiKey)
  put("KAPSO_PHONE_NUMBER_ID", channel.kapsoPhoneNumberId)
  put("KAPSO_WEBHOOK_SECRET", channel.kapsoWebhookSecret)
  return env
}

/**
 * Map an assigned Telegram channel's static secrets to the env vars the
 * generated eve channel reads (TELEGRAM_BOT_TOKEN / TELEGRAM_WEBHOOK_SECRET_TOKEN).
 * Like Kapso (and unlike Slack, which is Connect-brokered) these are static
 * secrets pushed onto the deployment. Same trim/omit semantics as
 * kapsoEnvFromChannel: blank/whitespace values are dropped and a null channel
 * yields {}.
 */
export function telegramEnvFromChannel(
  channel: {
    telegramBotToken: string | null
    telegramWebhookSecretToken: string | null
  } | null,
): Record<string, string> {
  if (!channel) return {}
  const env: Record<string, string> = {}
  const put = (key: string, value: string | null) => {
    if (value && value.trim().length > 0) env[key] = value
  }
  put("TELEGRAM_BOT_TOKEN", channel.telegramBotToken)
  put("TELEGRAM_WEBHOOK_SECRET_TOKEN", channel.telegramWebhookSecretToken)
  return env
}

/**
 * Map an assigned Discord channel's three static secrets to the env vars the
 * generated eve channel reads (DISCORD_BOT_TOKEN / DISCORD_APPLICATION_ID /
 * DISCORD_PUBLIC_KEY). Like Telegram (and unlike Slack, which is
 * Connect-brokered) these are static secrets pushed onto the deployment. Same
 * trim/omit/null->{} semantics as telegramEnvFromChannel: blank/whitespace
 * values are dropped and a null channel yields {}.
 */
export function discordEnvFromChannel(
  channel: {
    discordBotToken: string | null
    discordApplicationId: string | null
    discordPublicKey: string | null
  } | null,
): Record<string, string> {
  const out: Record<string, string> = {}
  if (!channel) return out
  const put = (k: string, v: string | null) => {
    const t = v?.trim()
    if (t) out[k] = t
  }
  put("DISCORD_BOT_TOKEN", channel.discordBotToken)
  put("DISCORD_APPLICATION_ID", channel.discordApplicationId)
  put("DISCORD_PUBLIC_KEY", channel.discordPublicKey)
  return out
}
