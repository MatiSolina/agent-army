import { createFleetMcpOAuthService } from "@/lib/fleet-mcp/oauth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(req: Request) {
  const form = await req.formData()
  const token = String(form.get("token") ?? "")
  if (token) {
    const service = createFleetMcpOAuthService(req)
    await service.revokeToken(token)
  }
  return new Response(null, { status: 200 })
}
