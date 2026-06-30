import type { XmcpConfig } from "xmcp"

const config: XmcpConfig = {
  http: {
    endpoint: "/api/fleet-mcp",
  },
  stdio: false,
  experimental: {
    adapter: "nextjs",
  },
  paths: {
    tools: "mcp/tools",
    prompts: false,
    resources: false,
  },
  typescript: {
    skipTypeCheck: true,
  },
}

export default config
