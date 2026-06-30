import { type NextRequest } from "next/server"
import { updateSession } from "@/lib/supabase/middleware"

export async function proxy(request: NextRequest) {
  return await updateSession(request)
}

export const config = {
  matcher: [
    // Everything except Next internals, static assets, and the Workflow DevKit's
    // internal paths (.well-known/workflow/*). Intercepting those breaks
    // workflow execution/resumption (esp. on Next 16 proxy.ts).
    "/((?!_next/static|_next/image|favicon.ico|.well-known/workflow/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
}
