import crypto from "node:crypto"

// Verifies the `x-vercel-signature` header on a Vercel Drain delivery: an
// HMAC-SHA1 of the raw request body, hex-encoded, keyed by the drain's
// signature secret (docs: /docs/drains/security). Constant-time compare to
// avoid leaking the expected digest via timing.
export function verifyDrainSignature(
  rawBody: string,
  signature: string | null | undefined,
  secret: string,
): boolean {
  if (!signature) return false
  const expected = crypto
    .createHmac("sha1", secret)
    .update(Buffer.from(rawBody, "utf-8"))
    .digest("hex")
  const a = Buffer.from(expected, "utf-8")
  const b = Buffer.from(signature, "utf-8")
  // timingSafeEqual throws on length mismatch, so guard first.
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
