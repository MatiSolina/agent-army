/**
 * Register a deployed agent's Discord Interactions Endpoint URL via the REST
 * API's `PATCH /applications/@me`-equivalent (`/applications/<applicationId>`).
 *
 * eve itself never sets this URL (it only verifies the inbound Ed25519
 * signature headers and ACKs within 3 seconds), so the control plane registers
 * the deployed PROD URL on promote. The PATCH fully REPLACES the endpoint on
 * each call, so it is idempotent — safe to re-run on every promote with no
 * retries needed. On save Discord synchronously PINGs the URL (POST type:1), so
 * the endpoint must be LIVE and verify Ed25519 (which a promoted eve deploy
 * satisfies); a failed PING surfaces as a 400 here.
 *
 * Slash-command registration is a SEPARATE manual step (out of scope here): it
 * is `PUT /applications/<applicationId>/commands` and is not required for the
 * channel to function. We deliberately do not automate it.
 *
 * SECURITY: the bot token goes in the Authorization HEADER (never the path/body)
 * and is NEVER included in a thrown error message.
 */

export async function setDiscordInteractionsEndpoint(args: {
  botToken: string
  applicationId: string
  url: string
  fetchImpl?: typeof fetch
}): Promise<void> {
  const f = args.fetchImpl ?? fetch
  const endpoint = `https://discord.com/api/v10/applications/${args.applicationId}`
  const res = await f(endpoint, {
    method: "PATCH",
    headers: {
      Authorization: `Bot ${args.botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ interactions_endpoint_url: args.url }),
  })
  if (!res.ok) {
    let detail = "unknown error"
    try {
      const body = await res.json()
      detail = body?.message ?? detail
    } catch {
      // ignore parse failures
    }
    // NEVER include the bot token in the message.
    throw new Error(
      `Discord set interactions endpoint failed (status ${res.status}): ${detail}`,
    )
  }
}
