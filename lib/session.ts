import { cache } from "react"
import { createSupabaseServerClient } from "@/lib/supabase/server"

// Single-operator install. Login (Supabase Auth) is an access GATE, not a
// per-user data boundary: all data lives under one logical owner, so
// getUserId()/requireUserId() return a constant. Only the configured operator
// email is allowed past the gate.
export const DEMO_USER_ID = "demo-user"

const OPERATOR_EMAIL = process.env.FLEET_OPERATOR_EMAIL?.trim().toLowerCase()
// Fail closed: on a deployed (production/preview) build, an unset operator email
// must reject everyone, not accept any authenticated Supabase user. Local dev
// (NODE_ENV !== "production") stays open for convenience.
const IS_DEPLOYED = process.env.NODE_ENV === "production"

export type SessionUser = { id: string; email: string; name: string }

export async function getUserId() {
  return DEMO_USER_ID
}

/**
 * The authenticated operator (access gate), or null. Rejects non-operator emails.
 *
 * Wrapped in React `cache()` so the network `auth.getUser()` validation runs at
 * most ONCE per request, no matter how many entry points call requireUserId().
 * Without this, a single page render fanned out into ~4 sequential cross-region
 * round-trips to Supabase Auth (the Vercel fn is in iad1, Supabase in us-west-2),
 * which is what made saving feel slow. cache() dedupes them within one render.
 */
export const getSessionUser = cache(async function getSessionUser(): Promise<
  SessionUser | null
> {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null
  // Fail closed: deployed builds with no configured operator reject all access.
  if (!OPERATOR_EMAIL) {
    if (IS_DEPLOYED) return null
  } else if (user.email?.toLowerCase() !== OPERATOR_EMAIL) {
    // Operator gate: only the configured email gets in.
    return null
  }
  return {
    id: user.id,
    email: user.email ?? "",
    name: (user.user_metadata?.name as string | undefined) ?? user.email ?? "Operator",
  }
})

/** Require an authenticated operator for server-side entry points. */
export async function requireSessionUser(): Promise<SessionUser> {
  const user = await getSessionUser()
  if (!user) throw new Error("Unauthorized")
  return user
}

/** Access-gated logical owner id. Single-operator, so the data boundary stays constant. */
export async function requireUserId() {
  await requireSessionUser()
  return DEMO_USER_ID
}
