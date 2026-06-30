import { sql } from "drizzle-orm"
import { db } from "@/lib/db"

/**
 * Fixed-window rate limit, backed by Postgres so it holds across serverless
 * instances (this stack has no KV/Redis; an in-memory counter would reset per
 * instance). One atomic upsert per check — the window resets in-place when it
 * has rolled over, so a key's row never grows.
 *
 * Returns true if the call is ALLOWED, false if it should be throttled.
 *
 * note: fixed-window, not sliding — a burst straddling a window boundary can
 * briefly allow up to ~2x `limit`. Fine for abuse-bounding these endpoints;
 * swap for a sliding window only if precise smoothing is ever needed.
 *
 * Fails OPEN: a limiter DB error returns true (allowed) so a limiter hiccup
 * never takes down the protected endpoint.
 */
export async function rateLimitOk(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  try {
    const res = await db.execute(sql`
      INSERT INTO rate_limits (key, count, "windowStart")
      VALUES (${key}, 1, now())
      ON CONFLICT (key) DO UPDATE SET
        count = CASE
          WHEN rate_limits."windowStart" < now() - make_interval(secs => ${windowSeconds})
          THEN 1 ELSE rate_limits.count + 1 END,
        "windowStart" = CASE
          WHEN rate_limits."windowStart" < now() - make_interval(secs => ${windowSeconds})
          THEN now() ELSE rate_limits."windowStart" END
      RETURNING count
    `)
    const rows = (res as unknown as { rows: Array<{ count: number }> }).rows
    const count = rows?.[0]?.count ?? 1
    return count <= limit
  } catch {
    return true
  }
}

/** Best-effort client IP from proxy headers (Vercel sets x-forwarded-for). */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for")
  if (xff) return xff.split(",")[0]!.trim()
  return req.headers.get("x-real-ip") ?? "unknown"
}
