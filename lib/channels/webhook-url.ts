/**
 * Compute the WhatsApp webhook URL an operator must configure in Kapso.
 *
 * In the Eve model each agent is its own deployment and OWNS the WhatsApp
 * webhook: the generated channel `agent/channels/kapso.ts` mounts a
 * `/kapso/webhook` route, which Eve exposes at `<deployment>/kapso/webhook`.
 * Custom defineChannel routes mount at their LITERAL path from the deployment
 * root: they are NOT prefixed with `/eve/v1/<stem>` (that prefix is only for
 * built-in channels). So the webhook to register in Kapso is the DEPLOYED
 * AGENT's URL, not the dashboard origin. Until the assigned agent is deployed
 * there is no URL to give Kapso, so callers should show a "deploy first" hint.
 *
 * Pure + synchronous for unit-testing and SSR safety.
 */
export type DeployState = {
  deploymentUrl: string | null
  deploymentStatus: string
}

export function kapsoWebhookUrl(
  agent: DeployState | null,
): { ready: true; url: string } | { ready: false; url: null } {
  if (!agent) return { ready: false, url: null }
  if (agent.deploymentStatus !== "deployed") return { ready: false, url: null }
  const base = agent.deploymentUrl?.trim().replace(/\/+$/, "")
  if (!base) return { ready: false, url: null }
  return { ready: true, url: `${base}/kapso/webhook` }
}

/**
 * Compute the Telegram webhook URL for a deployed agent. Unlike the Kapso
 * custom channel (mounted at its LITERAL `/kapso/webhook` path), Telegram is a
 * BUILT-IN eve channel, so it mounts under the `/eve/v1/<stem>` prefix at
 * `<deployment>/eve/v1/telegram`. This URL is INFORMATIONAL ONLY: the actual
 * registration is automated on promote via the Bot API setWebhook
 * (lib/telegram/set-webhook.ts), so there is no manual paste step. Until the
 * assigned agent is deployed there is no URL yet, so callers show a hint.
 *
 * Pure + synchronous for unit-testing and SSR safety.
 */
export function telegramWebhookUrl(
  agent: DeployState | null,
): { ready: true; url: string } | { ready: false; url: null } {
  if (!agent) return { ready: false, url: null }
  if (agent.deploymentStatus !== "deployed") return { ready: false, url: null }
  const base = agent.deploymentUrl?.trim().replace(/\/+$/, "")
  if (!base) return { ready: false, url: null }
  return { ready: true, url: `${base}/eve/v1/telegram` }
}

/**
 * Compute the Discord Interactions Endpoint URL for a deployed agent. Like
 * Telegram (and unlike the literal-path Kapso custom channel) Discord is a
 * BUILT-IN eve channel, so it mounts under the `/eve/v1/<stem>` prefix at
 * `<deployment>/eve/v1/discord`. Registration is automated on promote via the
 * Discord REST API (lib/discord/set-interactions-endpoint.ts), but the URL is
 * ALSO surfaced so the operator can paste it into the Discord Developer Portal
 * as a fallback and for (manual) slash-command setup. Until the assigned agent
 * is deployed there is no URL yet, so callers show a hint.
 *
 * Pure + synchronous for unit-testing and SSR safety.
 */
export function discordInteractionsEndpointUrl(
  agent: DeployState | null,
): { ready: true; url: string } | { ready: false; url: null } {
  if (!agent) return { ready: false, url: null }
  if (agent.deploymentStatus !== "deployed") return { ready: false, url: null }
  const base = agent.deploymentUrl?.trim().replace(/\/+$/, "")
  if (!base) return { ready: false, url: null }
  return { ready: true, url: `${base}/eve/v1/discord` }
}
