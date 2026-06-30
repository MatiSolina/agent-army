// Catalog of popular remote MCP servers.
//
// URLs and auth methods verified from official sources on 2026-06-25.
// Rule: only servers with a verifiable public remote endpoint are included
// (streamable HTTP or SSE). stdio/local-only servers are excluded.
//
// Verification sources (per entry, see inline comment):
//  - Anthropic / Claude Code docs: https://code.claude.com/docs/en/mcp
//  - Official docs from each provider.

export type McpCatalogEntry = {
  id: string
  name: string
  description: string
  transport: "http" | "sse"
  url: string
  auth: "none" | "token" | "oauth"
  docsUrl?: string
  // Requested OAuth scope string for `auth: "oauth"` entries. When undefined
  // the authorization server's advertised default scopes are used.
  oauthScopes?: string
  // Vercel Connect connector UID. When set, the generated connection uses eve's
  // `connect(<uid>)` (Vercel Connect brokers OAuth + holds the token) INSTEAD of
  // our DCR token broker. This is the only way to reach OAuth servers without
  // Dynamic Client Registration (e.g. Slack), and removes per-connection token
  // brokering: the deployed agent exchanges its Vercel OIDC for the token, with
  // the connector installed once at the team level.
  vercelConnect?: string
}

// Catalog policy: only ONE-CLICK servers. Either auth:"none" (added instantly)
// or auth:"oauth" (Add → consent redirect). Token/PAT servers are intentionally
// excluded: they make the user go mint and paste an API key, which isn't
// one-click. (GitHub also can't do OAuth here: its auth server lacks Dynamic
// Client Registration, the only method our connect flow supports.)
export const MCP_CATALOG: McpCatalogEntry[] = [
  {
    // Source: docs.slack.dev/ai/slack-mcp-server (streamable HTTP; OAuth WITHOUT
    // Dynamic Client Registration → cannot use our DCR broker). Routed through
    // Vercel Connect's native Slack connector instead. Requires the operator to
    // install the Slack connector once in the team's Vercel Connect.
    id: "slack",
    name: "Slack",
    description: "Slack channels, messages, and search.",
    transport: "http",
    url: "https://mcp.slack.com/mcp",
    auth: "oauth",
    // The team's Vercel Connect Slack connector UID (created via
    // `vercel connect create slack -n agentarmy`). eve's connect() resolves the
    // token from it. Each deployed agent project must be attached to this
    // connector (`vercel connect attach slack/agentarmy -p <project>`).
    vercelConnect: "slack/agentarmy",
    docsUrl: "https://docs.slack.dev/ai/slack-mcp-server/",
  },
  {
    // Source: linear.app/docs/mcp (streamable HTTP recommended; OAuth or Bearer token)
    id: "linear",
    name: "Linear",
    description: "Linear issues, projects, and cycles.",
    transport: "http",
    url: "https://mcp.linear.app/mcp",
    auth: "oauth",
    oauthScopes: "read write",
    docsUrl: "https://linear.app/docs/mcp",
  },
  {
    // Source: developers.notion.com/guides/mcp (streamable HTTP, OAuth)
    id: "notion",
    name: "Notion",
    description: "Pages and databases from your Notion workspace.",
    transport: "http",
    url: "https://mcp.notion.com/mcp",
    auth: "oauth",
    docsUrl: "https://developers.notion.com/guides/mcp/get-started-with-mcp",
  },
  {
    // Source: code.claude.com/docs/en/mcp (claude mcp add --transport http sentry https://mcp.sentry.dev/mcp)
    id: "sentry",
    name: "Sentry",
    description: "Sentry errors, issues, and monitoring.",
    transport: "http",
    url: "https://mcp.sentry.dev/mcp",
    auth: "oauth",
    docsUrl: "https://mcp.sentry.dev",
  },
  {
    // Source: code.claude.com/docs/en/mcp (claude mcp add --transport http stripe https://mcp.stripe.com)
    id: "stripe",
    name: "Stripe",
    description: "Stripe payments, customers, and billing.",
    transport: "http",
    url: "https://mcp.stripe.com",
    auth: "oauth",
    docsUrl: "https://docs.stripe.com/mcp",
  },
  {
    // Source: support.atlassian.com Rovo MCP (endpoint v2; OAuth 2.1)
    id: "atlassian",
    name: "Atlassian",
    description: "Jira and Confluence Cloud (Rovo).",
    transport: "http",
    url: "https://mcp.atlassian.com/v1/mcp/authv2",
    auth: "oauth",
    docsUrl: "https://www.atlassian.com/platform/remote-mcp-server",
  },
  {
    // Source: code.claude.com/docs/en/mcp (claude mcp add --transport sse asana https://mcp.asana.com/sse)
    id: "asana",
    name: "Asana",
    description: "Asana Work Graph tasks and projects.",
    transport: "sse",
    url: "https://mcp.asana.com/sse",
    auth: "oauth",
    docsUrl: "https://developers.asana.com/docs/using-asanas-model-control-protocol-mcp-server",
  },
  {
    // Source: vercel.com/docs/agent-resources/vercel-mcp (streamable HTTP, OAuth, read-only)
    id: "vercel",
    name: "Vercel",
    description: "Vercel projects and deployments (read-only).",
    transport: "http",
    url: "https://mcp.vercel.com",
    auth: "oauth",
    docsUrl: "https://vercel.com/docs/agent-resources/vercel-mcp",
  },
  {
    // Source: developers.cloudflare.com/agents/model-context-protocol (OAuth catalog)
    id: "cloudflare",
    name: "Cloudflare",
    description: "Cloudflare API and resources.",
    transport: "http",
    url: "https://mcp.cloudflare.com/mcp",
    auth: "oauth",
    docsUrl: "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/",
  },
  {
    // Source: code.claude.com/docs/en/mcp (claude mcp add --transport http paypal --scope project https://mcp.paypal.com/mcp)
    id: "paypal",
    name: "PayPal",
    description: "PayPal payments, invoices, shipments, and refunds.",
    transport: "http",
    url: "https://mcp.paypal.com/mcp",
    auth: "oauth",
    docsUrl: "https://www.paypal.ai/",
  },
  {
    // Source: neon.com/docs/ai/connect-mcp-clients-to-neon (endpoint /mcp; OAuth or API key)
    id: "neon",
    name: "Neon",
    description: "Neon serverless Postgres databases.",
    transport: "http",
    url: "https://mcp.neon.tech/mcp",
    auth: "oauth",
    docsUrl: "https://neon.com/docs/ai/neon-mcp-server",
  },
  {
    // Source: developers.figma.com/docs/figma-mcp-server/remote-server-installation (endpoint /mcp; OAuth)
    id: "figma",
    name: "Figma",
    description: "Figma files and design system (Dev Mode).",
    transport: "http",
    url: "https://mcp.figma.com/mcp",
    auth: "oauth",
    docsUrl: "https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/",
  },
  {
    // Source: developers.intercom.com/docs/guides/mcp (streamable HTTP recommended; OAuth, US only)
    id: "intercom",
    name: "Intercom",
    description: "Intercom conversations and support (Fin).",
    transport: "http",
    url: "https://mcp.intercom.com/mcp",
    auth: "oauth",
    docsUrl: "https://developers.intercom.com/docs/guides/mcp",
  },
  {
    // Source: context7.com/docs (endpoint /mcp; no auth for basic use, optional API key)
    id: "context7",
    name: "Context7",
    description: "Up-to-date library documentation for LLMs.",
    transport: "http",
    url: "https://mcp.context7.com/mcp",
    auth: "none",
    docsUrl: "https://github.com/upstash/context7",
  },
  {
    // Source: mcp.deepwiki.com (no auth; endpoint /mcp streamable HTTP)
    id: "deepwiki",
    name: "DeepWiki",
    description: "Search documentation for public GitHub repos.",
    transport: "http",
    url: "https://mcp.deepwiki.com/mcp",
    auth: "none",
    docsUrl: "https://deepwiki.com",
  },
]
