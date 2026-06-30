import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  primaryKey,
} from "drizzle-orm/pg-core"
import type {
  OAuthClientInformation,
  OAuthAuthorizationServerInformation,
  OAuthTokens,
} from "@ai-sdk/mcp"
// Type-only (erased at compile): the deploy snapshot shape stored in jsonb. The
// cycle is safe — AgentConfigSnapshot is Pick<Agent, build fields>, which never
// includes deployedConfig itself.
import type { AgentConfigSnapshot } from "@/lib/eve/config-drift"

// ----- eve-style agent config types (stored as jsonb) -----

export type AgentSkill = {
  id: string
  name: string
  description: string
  content: string // markdown procedure
}

export type AgentTool = {
  id: string
  name: string
  description: string
  // JSON schema (as a string) describing the tool's input
  inputSchema: string
}

export type AgentConnection = {
  id: string
  name: string
  // MCP server transport
  transport: "http" | "sse" | "stdio"
  url: string
  // optional auth header value
  token?: string
}

export type AgentSubagent = {
  id: string
  name: string
  model: string
  instructions: string
}

export type AgentSchedule = {
  id: string
  name: string
  cron: string
  prompt: string
  enabled: boolean
}

export type AgentSandbox = {
  enabled: boolean
  runtime?: string // e.g. "node22", "python3.12"
  setupCommands?: string // newline-separated shell commands
  timeoutMs?: number
}

// Per-agent guardrail: which built-in harness tools the deployed agent keeps.
// Every flag defaults to ON when absent — an empty object (or a missing field)
// means "full default harness", so existing agents are unaffected. Only an
// explicit `false` disables a tool (the generator emits a `disableTool()` file).
// For a locked-down customer-support bot, turn them all off so the model
// literally cannot run shell, touch a filesystem, or reach the web — it can
// still use its MCP connections.
export type AgentHarness = {
  bash?: boolean // bash
  files?: boolean // read_file, write_file, glob, grep
  webFetch?: boolean // web_fetch
  webSearch?: boolean // web_search
}

// ----- Auth is handled by Supabase Auth (auth.users); no app-side auth tables. -----

// ----- App tables (scoped by userId, no foreign keys) -----

export const agents = pgTable("agents", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  model: text("model").notNull().default("openai/gpt-4o-mini"),
  systemPrompt: text("systemPrompt")
    .notNull()
    .default("You are a helpful assistant."),
  // temperature stored as integer 0-100 (divide by 100 at use site)
  temperature: integer("temperature").notNull().default(70),
  // ----- eve-style configuration -----
  instructions: text("instructions")
    .notNull()
    .default("You are a helpful assistant. Respond clearly and concisely."),
  maxSteps: integer("maxSteps").notNull().default(10),
  enabled: boolean("enabled").notNull().default(true),
  skills: jsonb("skills").$type<AgentSkill[]>().notNull().default([]),
  // Tools and MCP connections are now global, reusable entities (see the
  // `tools` / `connections` tables). The agent only stores the assigned ids.
  // NOTE: the legacy inline `tools` / `connections` jsonb columns still exist
  // in the DB but are intentionally not mapped here — they are ignored.
  toolIds: jsonb("toolIds").$type<string[]>().notNull().default([]),
  connectionIds: jsonb("connectionIds")
    .$type<string[]>()
    .notNull()
    .default([]),
  subagents: jsonb("subagents").$type<AgentSubagent[]>().notNull().default([]),
  schedules: jsonb("schedules").$type<AgentSchedule[]>().notNull().default([]),
  sandbox: jsonb("sandbox").$type<AgentSandbox>().notNull().default({
    enabled: false,
  }),
  // Built-in harness guardrail. Empty object = full default harness (every tool
  // on), so existing rows keep today's behavior. See `AgentHarness`.
  harness: jsonb("harness").$type<AgentHarness>().notNull().default({}),
  // ----- Eve/Vercel deployment state (additive; see scripts/migrate-deployment.mjs) -----
  // Vercel project id for the agent's own Eve deployment (from .vercel/project.json).
  vercelProjectId: text("vercelProjectId"),
  // Last successful production deployment URL.
  deploymentUrl: text("deploymentUrl"),
  // Lifecycle: none | deploying | deployed | failed | preview_ready
  // ('preview_ready' = a preview build is up and awaiting promotion to prod).
  deploymentStatus: text("deploymentStatus").notNull().default("none"),
  // The Eve version this agent was last deployed with (null = never deployed).
  // Compared against the FM's current target (EVE_VERSION) to offer "Update Eve".
  eveVersion: text("eveVersion"),
  lastDeployedAt: timestamp("lastDeployedAt"),
  // Hash (lib/eve/config-drift) of the config the live build was compiled from.
  // Compared against the current row to show a "needs redeploy" drift badge.
  deployedConfigHash: text("deployedConfigHash"),
  // The build-affecting config snapshot the live build was compiled from. Lets
  // the deploy confirm dialog show a field-by-field diff of what will change.
  deployedConfig: jsonb("deployedConfig").$type<AgentConfigSnapshot>(),
  // Last failure message (truncated), surfaced in the UI when status = 'failed'.
  deploymentError: text("deploymentError"),
  // Last preview deploy URL (testable in the web chat, not yet promoted to prod).
  previewUrl: text("previewUrl"),
  // Its Vercel deployment id, used to promote the preview to production.
  previewDeploymentId: text("previewDeploymentId"),
  // ----- Gated eve-bump preview-test verdict (additive; see scripts/migrate-eve-verify.mjs) -----
  // The gated eve version this agent verified OK in a pinned preview deploy.
  // `eveUpdateOffer` treats `eveVerifiedVersion === latest` as a per-agent
  // override of the gate (offers the Update even when the bump is `gated`).
  eveVerifiedVersion: text("eveVerifiedVersion"),
  // The raw (sanitized) error from the last FAILED preview-test — feeds the
  // copy-paste handoff prompt. Mutually exclusive with eveVerifiedVersion; both
  // are cleared on any config change (a stale verdict must not un-gate). Distinct
  // from `deploymentError` (which holds the last PROD deploy failure).
  eveVerifyError: text("eveVerifyError"),
  // True for agents brought in via "Import deployed agent" — linked to a Vercel
  // deployment agent-army did NOT create. The dashboard restricts them to prompt
  // updates (served live via /api/agents/<id>/runtime-config, no rebuild) and
  // NEVER tears down their Vercel project on delete (the operator owns it). See
  // scripts/migrate-import-flag.mjs.
  imported: boolean("imported").notNull().default(false),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
})

export const channels = pgTable("channels", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull(),
  name: text("name").notNull(),
  type: text("type").notNull().default("kapso"),
  agentId: text("agentId"),
  kapsoApiKey: text("kapsoApiKey"),
  kapsoPhoneNumberId: text("kapsoPhoneNumberId"),
  // Non-secret display phone number (e.g. "+1 205-840-7113") captured from the
  // number picker, used for the UI label + a wa.me deep link. The id above is the
  // Meta phone_number_id (not a dialable number), so this is stored separately.
  kapsoPhoneNumber: text("kapsoPhoneNumber"),
  kapsoWebhookSecret: text("kapsoWebhookSecret"),
  // Slack channel (type='slack'): the Vercel Connect connector UID — this
  // agent's Slack app identity (e.g. "slack/soporte"). Connect brokers the bot
  // token + webhook verification; no Slack secrets live in our DB.
  slackConnectUid: text("slackConnectUid"),
  // Telegram channel (type='telegram'): static secrets read by the deployed
  // eve runtime as TELEGRAM_BOT_TOKEN / TELEGRAM_WEBHOOK_SECRET_TOKEN. Unlike
  // Slack (Connect-brokered), these live in our DB and are pushed to the
  // agent's Vercel project env. telegramBotUsername is non-secret (group
  // @mention dispatch + informational).
  telegramBotToken: text("telegramBotToken"),
  telegramWebhookSecretToken: text("telegramWebhookSecretToken"),
  telegramBotUsername: text("telegramBotUsername"),
  // Discord channel (type='discord'): THREE static secrets read by the deployed
  // eve runtime as DISCORD_BOT_TOKEN / DISCORD_APPLICATION_ID / DISCORD_PUBLIC_KEY.
  // Unlike Telegram there is NO non-secret username analog; unlike Slack none are
  // Connect-brokered; none are auto-minted (publicKey is issued by the Discord portal).
  discordBotToken: text("discordBotToken"),
  discordApplicationId: text("discordApplicationId"),
  discordPublicKey: text("discordPublicKey"),
  status: text("status").notNull().default("disconnected"),
  // Webhook registration lifecycle (manual step in Kapso): pending | registered | verified | failed
  webhookStatus: text("webhookStatus").notNull().default("pending"),
  webhookTestedAt: timestamp("webhookTestedAt"),
  webhookTestError: text("webhookTestError"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
})

export const messages = pgTable("messages", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull(),
  channelId: text("channelId").notNull(),
  agentId: text("agentId"),
  conversationId: text("conversationId").notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
})

// ----- OTel spans ingested from Vercel Trace Drains (see app/api/drains/traces) -----
// Each deployed agent emits @vercel/otel spans; a team-level Trace Drain POSTs
// them here. spanId is the PK so at-least-once re-delivery is idempotent
// (insert ... on conflict do nothing). note: no raw-attributes jsonb column
// — add one when the UI needs tool-call/error detail beyond these summary cols.
export const spans = pgTable(
  "spans",
  {
    spanId: text("spanId").notNull(),
    traceId: text("traceId").notNull(),
    userId: text("userId").notNull(),
    // Resolved from vercelProjectId at ingest; null when no agent row matches.
    agentId: text("agentId"),
    vercelProjectId: text("vercelProjectId"),
    serviceName: text("serviceName"),
    name: text("name").notNull(),
    model: text("model"),
    inputTokens: integer("inputTokens"),
    outputTokens: integer("outputTokens"),
    durationMs: integer("durationMs").notNull().default(0),
    startTime: timestamp("startTime").notNull(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  // spanId is unique only WITHIN a trace per OTel, so the identity is the pair.
  (t) => [primaryKey({ columns: [t.traceId, t.spanId] })],
)

// ----- Global, reusable Tools (assigned to agents by id) -----
export const tools = pgTable("tools", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  // JSON Schema (stored as a string) describing the tool's input.
  inputSchema: text("inputSchema").notNull().default(""),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
})

// ----- Global, reusable MCP connections (assigned to agents by id) -----
export const connections = pgTable("connections", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull(),
  name: text("name").notNull(),
  // MCP transport: "http" | "sse" | "stdio"
  transport: text("transport").notNull().default("http"),
  url: text("url").notNull().default(""),
  token: text("token"),
  // ----- OAuth 2.1 state machine + artifacts (server-side only) -----
  // Per-connection lifecycle: idle | connecting | connected | needs_auth | failed
  status: text("status").notNull().default("idle"),
  // Dynamic Client Registration result (client_id, optional client_secret, ...).
  oauthClientInfo: jsonb("oauthClientInfo").$type<OAuthClientInformation>(),
  // Cached authorization-server metadata resolved from discovery.
  oauthServerInfo:
    jsonb("oauthServerInfo").$type<OAuthAuthorizationServerInformation>(),
  // Live tokens (access/refresh). NEVER leaves the server.
  oauthTokens: jsonb("oauthTokens").$type<OAuthTokens>(),
  // When oauthTokens was last written — the absolute issuance time used to derive
  // expiry from the tokens' relative expires_in. A dedicated column (NOT the
  // row-wide updatedAt, which unrelated edits bump) so expiry stays accurate.
  oauthTokensUpdatedAt: timestamp("oauthTokensUpdatedAt"),
  // Transient PKCE verifier for the in-flight authorization.
  oauthCodeVerifier: text("oauthCodeVerifier"),
  // Transient CSRF state for the in-flight authorization.
  oauthState: text("oauthState"),
  // Requested scope string (from the catalog entry).
  oauthScope: text("oauthScope"),
  // Last failure message, surfaced in the UI when status = 'failed'.
  oauthError: text("oauthError"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
})

// ----- App-wide key/value settings (single-tenant; see scripts/migrate-vercel-auth.mjs) -----
// Stores small structured config blobs keyed by a stable string. Used (among
// others) for the Vercel OAuth connection result under key 'vercel_oauth'.
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
})

// ----- Fleet MCP OAuth 2.1 control-plane auth -----

export const fleetMcpOAuthClients = pgTable("fleet_mcp_oauth_clients", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull(),
  clientName: text("clientName"),
  redirectUris: jsonb("redirectUris").$type<string[]>().notNull().default([]),
  grantTypes: jsonb("grantTypes").$type<string[]>().notNull().default([]),
  responseTypes: jsonb("responseTypes").$type<string[]>().notNull().default([]),
  tokenEndpointAuthMethod: text("tokenEndpointAuthMethod")
    .notNull()
    .default("none"),
  scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
})

export const fleetMcpOAuthAuthorizationRequests = pgTable(
  "fleet_mcp_oauth_authorization_requests",
  {
    id: text("id").primaryKey(),
    userId: text("userId"),
    clientId: text("clientId").notNull(),
    redirectUri: text("redirectUri").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    state: text("state"),
    resource: text("resource").notNull(),
    codeChallenge: text("codeChallenge").notNull(),
    codeChallengeMethod: text("codeChallengeMethod").notNull(),
    expiresAt: timestamp("expiresAt").notNull(),
    approvedAt: timestamp("approvedAt"),
    deniedAt: timestamp("deniedAt"),
    consumedAt: timestamp("consumedAt"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
)

export const fleetMcpOAuthAuthorizationCodes = pgTable(
  "fleet_mcp_oauth_authorization_codes",
  {
    codeHash: text("codeHash").primaryKey(),
    requestId: text("requestId").notNull(),
    userId: text("userId").notNull(),
    clientId: text("clientId").notNull(),
    redirectUri: text("redirectUri").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    resource: text("resource").notNull(),
    codeChallenge: text("codeChallenge").notNull(),
    codeChallengeMethod: text("codeChallengeMethod").notNull(),
    expiresAt: timestamp("expiresAt").notNull(),
    consumedAt: timestamp("consumedAt"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
)

export const fleetMcpOAuthTokens = pgTable("fleet_mcp_oauth_tokens", {
  tokenHash: text("tokenHash").primaryKey(),
  kind: text("kind").notNull(),
  userId: text("userId").notNull(),
  clientId: text("clientId").notNull(),
  scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
  resource: text("resource").notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  revokedAt: timestamp("revokedAt"),
  rotatedToHash: text("rotatedToHash"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
})

export const fleetMcpOAuthConsents = pgTable("fleet_mcp_oauth_consents", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull(),
  clientId: text("clientId").notNull(),
  redirectUri: text("redirectUri").notNull(),
  resource: text("resource").notNull(),
  scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
})

export const fleetMcpAuditLogs = pgTable("fleet_mcp_audit_logs", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull(),
  clientId: text("clientId").notNull(),
  toolName: text("toolName").notNull(),
  scope: text("scope").notNull(),
  agentId: text("agentId"),
  status: text("status").notNull(),
  errorCode: text("errorCode"),
  durationMs: integer("durationMs").notNull().default(0),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
})

export type Agent = typeof agents.$inferSelect
export type Channel = typeof channels.$inferSelect
export type Message = typeof messages.$inferSelect
export type Span = typeof spans.$inferSelect
export type Tool = typeof tools.$inferSelect
export type Connection = typeof connections.$inferSelect
export type AppSetting = typeof appSettings.$inferSelect
export type FleetMcpOAuthClient = typeof fleetMcpOAuthClients.$inferSelect
export type FleetMcpOAuthAuthorizationRequest =
  typeof fleetMcpOAuthAuthorizationRequests.$inferSelect
export type FleetMcpOAuthAuthorizationCode =
  typeof fleetMcpOAuthAuthorizationCodes.$inferSelect
export type FleetMcpOAuthToken = typeof fleetMcpOAuthTokens.$inferSelect
export type FleetMcpOAuthConsent = typeof fleetMcpOAuthConsents.$inferSelect
export type FleetMcpAuditLog = typeof fleetMcpAuditLogs.$inferSelect

// ----- Fleet-update workflow runs (see scripts/migrate-fleet-updates.mjs) -----
// Tracks a fleet-update workflow run so the dashboard can poll its status
// (the Workflow DevKit has no list-runs API → persist the runId ourselves).
// A canary run has canaryAgentId set + mode "canary"; the rollout over the rest
// is mode "rest". status: running | done | failed; result holds the per-agent
// outcome once finished.
export const fleetUpdates = pgTable("fleet_updates", {
  id: text("id").primaryKey(),
  runId: text("runId"),
  mode: text("mode").notNull(),
  target: text("target").notNull(),
  aiPin: text("aiPin").notNull(),
  canaryAgentId: text("canaryAgentId"),
  status: text("status").notNull().default("running"),
  result: jsonb("result").$type<{
    updated: string[]
    skipped: string[]
    rollbackTargets: Record<string, string>
  }>(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
})

export type FleetUpdate = typeof fleetUpdates.$inferSelect

// Postgres-backed fixed-window rate limiter (no KV/Redis in this stack, and an
// in-memory counter would be per-serverless-instance → useless). One row per
// limiter key (e.g. "oauth-token:1.2.3.4"); count resets when the window rolls.
export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull().default(0),
  windowStart: timestamp("windowStart").notNull().defaultNow(),
})
