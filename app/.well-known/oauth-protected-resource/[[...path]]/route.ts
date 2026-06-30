import {
  createProtectedResourceMetadata,
  issuerFromRequest,
} from "@/lib/fleet-mcp/oauth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  return Response.json(createProtectedResourceMetadata(issuerFromRequest(req)), {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "max-age=3600",
    },
  })
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    },
  })
}
