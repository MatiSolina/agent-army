import { describe, it, expect } from "vitest"
import { verifyDrainSignature } from "./verify"

// Reference vector: HMAC-SHA1 of the raw body `{"hello":1}` with secret
// `whsec_test`, hex-encoded (computed independently via node:crypto).
const RAW = '{"hello":1}'
const SECRET = "whsec_test"
const VALID = "1677718ae3f5bdb2d87b9e95ef6abb3025c6d36e"

describe("verifyDrainSignature", () => {
  it("accepts a body whose x-vercel-signature matches the secret", () => {
    expect(verifyDrainSignature(RAW, VALID, SECRET)).toBe(true)
  })

  it("rejects a tampered body", () => {
    expect(verifyDrainSignature('{"hello":2}', VALID, SECRET)).toBe(false)
  })

  it("rejects a wrong or missing signature", () => {
    expect(verifyDrainSignature(RAW, "deadbeef", SECRET)).toBe(false)
    expect(verifyDrainSignature(RAW, null, SECRET)).toBe(false)
    expect(verifyDrainSignature(RAW, "", SECRET)).toBe(false)
  })
})
