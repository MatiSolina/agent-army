import { createHash } from "node:crypto"
import { createServer } from "node:net"
import { spawn } from "node:child_process"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function pkceChallenge(verifier) {
  return createHash("sha256").update(verifier).digest("base64url")
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => resolve(address.port))
    })
  })
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: "inherit",
      shell: false,
    })
    child.on("error", reject)
    child.on("exit", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`))
    })
  })
}

function spawnServer(command, args, env) {
  const child = spawn(command, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  })
  child.stdout.on("data", (chunk) => process.stdout.write(chunk))
  child.stderr.on("data", (chunk) => process.stderr.write(chunk))
  return child
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return

  child.kill("SIGTERM")
  const stopped = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ])

  if (!stopped && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL")
    await new Promise((resolve) => child.once("exit", resolve))
  }
}

function snapshotFile(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null
}

function restoreFile(path, contents) {
  if (contents !== null) writeFileSync(path, contents)
}

function localBin(name) {
  return join(
    process.cwd(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? `${name}.cmd` : name,
  )
}

async function waitForServer(baseUrl, child) {
  const started = Date.now()
  while (Date.now() - started < 60_000) {
    if (child.exitCode !== null) {
      throw new Error(`next dev exited early with ${child.exitCode}`)
    }
    try {
      const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`)
      if (res.ok) return
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error("Timed out waiting for next dev")
}

async function readJson(res) {
  const text = await res.text()
  if (!text) return null
  const dataLine = text
    .split(/\r?\n/)
    .find((line) => line.startsWith("data: "))
  return JSON.parse(dataLine ? dataLine.slice("data: ".length) : text)
}

async function postForm(url, fields, options = {}) {
  const body = new URLSearchParams()
  for (const [key, value] of Object.entries(fields)) body.set(key, value)
  return fetch(url, {
    method: "POST",
    body,
    redirect: options.redirect ?? "follow",
  })
}

async function mcpPost(baseUrl, accessToken, payload, options = {}) {
  const res = await fetch(`${baseUrl}/api/fleet-mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "mcp-protocol-version": "2025-06-18",
      ...(options.origin ? { origin: options.origin } : {}),
    },
    body: JSON.stringify(payload),
  })
  return { res, body: await readJson(res) }
}

async function authorizeAndToken(baseUrl, client, scope) {
  const redirectUri = `${baseUrl}/fleet-mcp-e2e/callback`
  const verifier = `fleet-mcp-e2e-verifier-${scope.replace(/[^a-z]/g, "-")}`
  const authorizeUrl = new URL(`${baseUrl}/api/fleet-mcp/oauth/authorize`)
  authorizeUrl.searchParams.set("response_type", "code")
  authorizeUrl.searchParams.set("client_id", client.client_id)
  authorizeUrl.searchParams.set("redirect_uri", redirectUri)
  authorizeUrl.searchParams.set("scope", scope)
  authorizeUrl.searchParams.set("state", `state-${scope}`)
  authorizeUrl.searchParams.set("resource", `${baseUrl}/api/fleet-mcp`)
  authorizeUrl.searchParams.set("code_challenge", pkceChallenge(verifier))
  authorizeUrl.searchParams.set("code_challenge_method", "S256")

  const authRes = await fetch(authorizeUrl, { redirect: "manual" })
  assert(authRes.status >= 300 && authRes.status < 400, "authorize redirects")
  const consentLocation = authRes.headers.get("location")
  assert(consentLocation?.includes("/fleet-mcp/consent"), "authorize redirects to consent")
  const requestId = new URL(consentLocation, baseUrl).searchParams.get("request")
  assert(requestId, "consent request id exists")

  const consentRes = await postForm(
    `${baseUrl}/api/fleet-mcp/oauth/consent`,
    { request: requestId, decision: "approve" },
    { redirect: "manual" },
  )
  assert(consentRes.status >= 300 && consentRes.status < 400, "consent redirects")
  const callbackLocation = consentRes.headers.get("location")
  const code = new URL(callbackLocation).searchParams.get("code")
  assert(code, "authorization code returned")

  const tokenRes = await postForm(`${baseUrl}/api/fleet-mcp/oauth/token`, {
    grant_type: "authorization_code",
    client_id: client.client_id,
    redirect_uri: redirectUri,
    code,
    code_verifier: verifier,
    resource: `${baseUrl}/api/fleet-mcp`,
  })
  assert(tokenRes.ok, "authorization_code token exchange succeeds")
  const tokens = await tokenRes.json()
  assert(tokens.access_token?.startsWith("fmcp_at_"), "access token shape")
  assert(tokens.refresh_token?.startsWith("fmcp_rt_"), "refresh token shape")
  assert(tokens.scope === scope, "token scopes match request")
  return tokens
}

async function main() {
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const e2eDistDir = `.next-fleet-mcp-e2e-${process.pid}`
  const nextEnvPath = join(process.cwd(), "next-env.d.ts")
  const tsconfigPath = join(process.cwd(), "tsconfig.json")
  const originalNextEnv = snapshotFile(nextEnvPath)
  const originalTsconfig = snapshotFile(tsconfigPath)
  const env = {
    ...process.env,
    NODE_ENV: "development",
    FLEET_MCP_E2E: "1",
    FLEET_MCP_E2E_DIST_DIR: e2eDistDir,
    FLEET_MCP_ISSUER: baseUrl,
    APP_URL: baseUrl,
    MCP_ALLOWED_ORIGINS: "https://claude.ai",
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "fleet-mcp-e2e",
    FLEET_OPERATOR_EMAIL: "fleet-mcp-e2e@example.com",
    XMCP_TELEMETRY_DISABLED: "1",
  }

  console.log("fleet-mcp e2e: building xmcp adapter")
  await run(localBin("xmcp"), ["build"], env)

  console.log(`fleet-mcp e2e: starting next dev on ${baseUrl}`)
  const server = spawnServer(
    localBin("next"),
    ["dev", "--hostname", "127.0.0.1", "--port", String(port)],
    env,
  )

  try {
    await waitForServer(baseUrl, server)

    const asMetadata = await (await fetch(`${baseUrl}/.well-known/oauth-authorization-server`)).json()
    assert(asMetadata.issuer === baseUrl, "authorization server issuer")
    assert(asMetadata.registration_endpoint.endsWith("/api/fleet-mcp/oauth/register"), "DCR metadata")

    const resourceMetadata = await (
      await fetch(`${baseUrl}/.well-known/oauth-protected-resource/api/fleet-mcp`)
    ).json()
    assert(resourceMetadata.resource === `${baseUrl}/api/fleet-mcp`, "resource metadata")
    assert(resourceMetadata.scopes_supported.includes("fleet:read"), "scope metadata")

    const registerRes = await fetch(`${baseUrl}/api/fleet-mcp/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Fleet MCP E2E",
        redirect_uris: [`${baseUrl}/fleet-mcp-e2e/callback`],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: "fleet:read agent:write deploy:read deploy:write fleet:update",
      }),
    })
    assert(registerRes.status === 201, "DCR succeeds")
    const client = await registerRes.json()
    assert(client.client_id, "client_id returned")

    const readTokens = await authorizeAndToken(baseUrl, client, "fleet:read")

    const noAuth = await fetch(`${baseUrl}/api/fleet-mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })
    assert(noAuth.status === 401, "MCP POST requires bearer auth")
    assert(noAuth.headers.get("www-authenticate")?.includes("Bearer"), "bearer challenge")

    const badOrigin = await fetch(`${baseUrl}/api/fleet-mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${readTokens.access_token}`,
        origin: "https://evil.example",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    })
    assert(badOrigin.status === 403, "MCP rejects disallowed browser origins")

    const options = await fetch(`${baseUrl}/api/fleet-mcp`, {
      method: "OPTIONS",
      headers: { origin: "https://claude.ai" },
    })
    assert(options.status === 204, "OPTIONS succeeds")
    assert(
      options.headers.get("access-control-allow-origin") === "https://claude.ai",
      "OPTIONS returns strict CORS origin",
    )

    const get = await fetch(`${baseUrl}/api/fleet-mcp`, { method: "GET" })
    assert(get.status === 405, "GET remains closed")

    const initialize = await mcpPost(baseUrl, readTokens.access_token, {
      jsonrpc: "2.0",
      id: 10,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "fleet-mcp-e2e", version: "0.0.1" },
      },
    })
    assert(initialize.res.ok, "MCP initialize succeeds")
    assert(initialize.body.result?.serverInfo, "MCP initialize returns serverInfo")

    const listTools = await mcpPost(baseUrl, readTokens.access_token, {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/list",
      params: {},
    })
    assert(listTools.res.ok, "MCP tools/list succeeds")
    const toolNames = listTools.body.result.tools.map((tool) => tool.name)
    assert(toolNames.includes("fleet-list-agents"), "fleet-list-agents registered")
    assert(toolNames.includes("fleet-create-agent"), "fleet-create-agent registered")
    assert(toolNames.length === 11, "all 11 Fleet MCP tools registered")

    const listAgents = await mcpPost(baseUrl, readTokens.access_token, {
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "fleet-list-agents", arguments: {} },
    })
    assert(listAgents.res.ok, "read-scope tool call succeeds")
    assert(
      Array.isArray(listAgents.body.result.structuredContent.result),
      "tool returns structured agent list",
    )

    const deniedCreate = await mcpPost(baseUrl, readTokens.access_token, {
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: {
        name: "fleet-create-agent",
        arguments: { name: "Should not be created" },
      },
    })
    assert(deniedCreate.res.ok, "scope failure is reported as MCP result")
    const deniedText = JSON.stringify(deniedCreate.body)
    assert(deniedText.includes("agent:write"), "scope failure mentions missing scope")

    const refreshedRes = await postForm(`${baseUrl}/api/fleet-mcp/oauth/token`, {
      grant_type: "refresh_token",
      client_id: client.client_id,
      refresh_token: readTokens.refresh_token,
      resource: `${baseUrl}/api/fleet-mcp`,
    })
    assert(refreshedRes.ok, "refresh token rotates")
    const refreshed = await refreshedRes.json()
    assert(refreshed.refresh_token !== readTokens.refresh_token, "new refresh token returned")

    const reusedRefresh = await postForm(`${baseUrl}/api/fleet-mcp/oauth/token`, {
      grant_type: "refresh_token",
      client_id: client.client_id,
      refresh_token: readTokens.refresh_token,
      resource: `${baseUrl}/api/fleet-mcp`,
    })
    assert(reusedRefresh.status === 400, "old refresh token cannot be reused")

    const revokeRes = await postForm(`${baseUrl}/api/fleet-mcp/oauth/revoke`, {
      token: refreshed.access_token,
    })
    assert(revokeRes.ok, "revocation endpoint succeeds")

    const revokedCall = await fetch(`${baseUrl}/api/fleet-mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${refreshed.access_token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 14, method: "tools/list" }),
    })
    assert(revokedCall.status === 401, "revoked access token is rejected")

    console.log("fleet-mcp e2e: ok")
  } finally {
    await stopServer(server)
    rmSync(e2eDistDir, { recursive: true, force: true })
    restoreFile(nextEnvPath, originalNextEnv)
    restoreFile(tsconfigPath, originalTsconfig)
  }
}

main().catch((error) => {
  console.error("fleet-mcp e2e: failed")
  console.error(error)
  process.exit(1)
})
