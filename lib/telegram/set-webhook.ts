/**
 * Register a deployed agent's Telegram webhook via the Bot API's setWebhook.
 *
 * eve itself never calls setWebhook (it only verifies the inbound
 * X-Telegram-Bot-Api-Secret-Token header), so the control plane registers the
 * deployed prod URL on promote. setWebhook fully REPLACES any prior webhook on
 * each call, so it is idempotent: safe to re-run on every promote with no
 * retries needed. We do NOT set drop_pending_updates, so a re-run never
 * silently discards queued updates.
 *
 * SECURITY: the bot token goes in the request PATH (Bot API contract) and is
 * NEVER included in a thrown error message.
 */

type FetchImpl = typeof fetch

export async function setTelegramWebhook(args: {
  botToken: string
  webhookSecretToken: string
  url: string
  fetchImpl?: FetchImpl
}): Promise<void> {
  const { botToken, webhookSecretToken, url, fetchImpl = fetch } = args
  const endpoint = `https://api.telegram.org/bot${botToken}/setWebhook`
  const res = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      secret_token: webhookSecretToken,
      allowed_updates: ["message", "callback_query"],
    }),
  })
  let body: { ok?: boolean; description?: string } | null = null
  try {
    body = (await res.json()) as { ok?: boolean; description?: string }
  } catch {
    body = null
  }
  if (!res.ok || body?.ok !== true) {
    // NEVER include botToken in the message.
    throw new Error(
      `Telegram setWebhook failed (status ${res.status}): ${body?.description ?? "unknown error"}`,
    )
  }
}
