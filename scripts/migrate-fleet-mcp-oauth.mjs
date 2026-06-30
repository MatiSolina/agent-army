import pg from "pg"

const { Pool } = pg
const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  throw new Error("DATABASE_URL is required")
}

const pool = new Pool({
  connectionString,
})

await pool.query(`
  create table if not exists fleet_mcp_oauth_clients (
    id text primary key,
    "userId" text not null,
    "clientName" text,
    "redirectUris" jsonb not null default '[]'::jsonb,
    "grantTypes" jsonb not null default '[]'::jsonb,
    "responseTypes" jsonb not null default '[]'::jsonb,
    "tokenEndpointAuthMethod" text not null default 'none',
    scopes jsonb not null default '[]'::jsonb,
    "createdAt" timestamp not null default now(),
    "updatedAt" timestamp not null default now()
  );

  create index if not exists fleet_mcp_oauth_clients_user_id_idx
    on fleet_mcp_oauth_clients ("userId");

  create table if not exists fleet_mcp_oauth_authorization_requests (
    id text primary key,
    "userId" text,
    "clientId" text not null,
    "redirectUri" text not null,
    scopes jsonb not null default '[]'::jsonb,
    state text,
    resource text not null,
    "codeChallenge" text not null,
    "codeChallengeMethod" text not null,
    "expiresAt" timestamp not null,
    "approvedAt" timestamp,
    "deniedAt" timestamp,
    "consumedAt" timestamp,
    "createdAt" timestamp not null default now()
  );

  create index if not exists fleet_mcp_oauth_auth_requests_client_idx
    on fleet_mcp_oauth_authorization_requests ("clientId");
  create index if not exists fleet_mcp_oauth_auth_requests_expires_idx
    on fleet_mcp_oauth_authorization_requests ("expiresAt");

  create table if not exists fleet_mcp_oauth_authorization_codes (
    "codeHash" text primary key,
    "requestId" text not null,
    "userId" text not null,
    "clientId" text not null,
    "redirectUri" text not null,
    scopes jsonb not null default '[]'::jsonb,
    resource text not null,
    "codeChallenge" text not null,
    "codeChallengeMethod" text not null,
    "expiresAt" timestamp not null,
    "consumedAt" timestamp,
    "createdAt" timestamp not null default now()
  );

  create index if not exists fleet_mcp_oauth_codes_client_idx
    on fleet_mcp_oauth_authorization_codes ("clientId");
  create index if not exists fleet_mcp_oauth_codes_expires_idx
    on fleet_mcp_oauth_authorization_codes ("expiresAt");

  create table if not exists fleet_mcp_oauth_tokens (
    "tokenHash" text primary key,
    kind text not null,
    "userId" text not null,
    "clientId" text not null,
    scopes jsonb not null default '[]'::jsonb,
    resource text not null,
    "expiresAt" timestamp not null,
    "revokedAt" timestamp,
    "rotatedToHash" text,
    "createdAt" timestamp not null default now()
  );

  create index if not exists fleet_mcp_oauth_tokens_client_idx
    on fleet_mcp_oauth_tokens ("clientId");
  create index if not exists fleet_mcp_oauth_tokens_kind_expires_idx
    on fleet_mcp_oauth_tokens (kind, "expiresAt");

  create table if not exists fleet_mcp_oauth_consents (
    id text primary key,
    "userId" text not null,
    "clientId" text not null,
    "redirectUri" text not null,
    resource text not null,
    scopes jsonb not null default '[]'::jsonb,
    "createdAt" timestamp not null default now(),
    "updatedAt" timestamp not null default now()
  );

  create unique index if not exists fleet_mcp_oauth_consents_unique_idx
    on fleet_mcp_oauth_consents ("userId", "clientId", resource, "redirectUri");

  create table if not exists fleet_mcp_audit_logs (
    id text primary key,
    "userId" text not null,
    "clientId" text not null,
    "toolName" text not null,
    scope text not null,
    "agentId" text,
    status text not null,
    "errorCode" text,
    "durationMs" integer not null default 0,
    "createdAt" timestamp not null default now()
  );

  create index if not exists fleet_mcp_audit_logs_user_created_idx
    on fleet_mcp_audit_logs ("userId", "createdAt" desc);
  create index if not exists fleet_mcp_audit_logs_tool_created_idx
    on fleet_mcp_audit_logs ("toolName", "createdAt" desc);
`)

await pool.end()
console.log("fleet mcp oauth migration complete")
