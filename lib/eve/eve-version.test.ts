import { describe, it, expect, vi, afterEach } from "vitest"
import { compareEve, resolveLatestEve, eveUpdateOffer } from "./eve-version"
import { EVE_VERSION, EVE_AI_VERSION } from "./project"

describe("compareEve (0.x: minor is the breaking position)", () => {
  it("allows a patch bump", () => {
    expect(compareEve("0.16.0", "0.16.2")).toEqual({ target: "0.16.2", gated: false })
  })
  it("gates a minor bump on a 0.x package", () => {
    expect(compareEve("0.16.0", "0.17.0")).toEqual({ target: "0.16.0", gated: true })
  })
  it("gates a major bump", () => {
    expect(compareEve("0.16.0", "1.0.0")).toEqual({ target: "0.16.0", gated: true })
  })
  it("treats an equal/older latest as not gated, no change", () => {
    expect(compareEve("0.16.2", "0.16.2")).toEqual({ target: "0.16.2", gated: false })
    expect(compareEve("0.16.2", "0.16.1")).toEqual({ target: "0.16.2", gated: false })
  })
  it(">=1.x uses major as the breaking position", () => {
    expect(compareEve("1.4.0", "1.9.0")).toEqual({ target: "1.9.0", gated: false })
    expect(compareEve("1.4.0", "2.0.0")).toEqual({ target: "1.4.0", gated: true })
  })
})

describe("eveUpdateOffer", () => {
  it("hides the button when the agent was never deployed", () => {
    expect(eveUpdateOffer(null, "0.16.2")).toEqual({ show: false, to: "0.16.2" })
  })
  it("hides the button when the agent is already on the target", () => {
    expect(eveUpdateOffer("0.16.2", "0.16.2")).toEqual({ show: false, to: "0.16.2" })
  })
  it("hides the button on a downgrade (target older than the agent pin)", () => {
    // The bug: agent on 0.16.2, repo targets 0.16.0 -> must NOT offer a downgrade.
    expect(eveUpdateOffer("0.16.2", "0.16.0")).toEqual({ show: false, to: "0.16.2" })
  })
  it("offers a patch upgrade to the target", () => {
    expect(eveUpdateOffer("0.16.0", "0.16.2")).toEqual({ show: true, to: "0.16.2" })
  })
  it("hides the button when the target crosses a breaking change (gated)", () => {
    expect(eveUpdateOffer("0.16.0", "0.17.0")).toEqual({ show: false, to: "0.16.0" })
  })

  describe("eveVerifiedVersion gate override (preview-test verdict)", () => {
    it("un-gates a gated bump when eveVerifiedVersion === the latest target", () => {
      // Agent verified 0.17 in a pinned preview → offer the Update even though
      // 0.17 is a gated (breaking) bump from 0.16.
      expect(eveUpdateOffer("0.16.0", "0.17.0", "0.17.0")).toEqual({
        show: true,
        to: "0.17.0",
      })
    })

    it("does NOT un-gate when the verified version differs from the target", () => {
      // Stale verdict from a different gated version (0.17) must not un-gate 0.18.
      expect(eveUpdateOffer("0.16.0", "0.18.0", "0.17.0")).toEqual({
        show: false,
        to: "0.16.0",
      })
    })

    it("does NOT un-gate when the verified version is stale (equals the agent pin)", () => {
      // A leftover verified value equal to the agent's own pin is not the target.
      expect(eveUpdateOffer("0.16.0", "0.17.0", "0.16.0")).toEqual({
        show: false,
        to: "0.16.0",
      })
    })

    it("still hides on a downgrade even if a verified version is present", () => {
      expect(eveUpdateOffer("0.16.2", "0.16.0", "0.16.0")).toEqual({
        show: false,
        to: "0.16.2",
      })
    })

    it("a null verified version leaves the gate intact", () => {
      expect(eveUpdateOffer("0.16.0", "0.17.0", null)).toEqual({
        show: false,
        to: "0.16.0",
      })
    })
  })
})

describe("resolveLatestEve", () => {
  afterEach(() => vi.restoreAllMocks())

  it("reads dist-tags.latest + that version's peerDependencies.ai", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          "dist-tags": { latest: "0.16.2" },
          versions: { "0.16.2": { peerDependencies: { ai: "^7.1.0" } } },
        }),
      }),
    )
    const r = await resolveLatestEve()
    expect(r).toEqual({
      latest: "0.16.2",
      target: "0.16.2",
      aiPin: "^7.1.0",
      latestAiPin: "^7.1.0",
      gated: false,
    })
  })

  it("resolves latestAiPin from the CANDIDATE (latest), not the pinned-back target", async () => {
    // Gated bump: target pins back to EVE_VERSION (0.16.0) but the candidate is
    // 0.17.0 with a NEWER ai peer. The preview-test pins the candidate eve, so it
    // must carry the candidate's ai peer — aiPin (target's) would be the old one.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          "dist-tags": { latest: "0.17.0" },
          versions: {
            "0.16.0": { peerDependencies: { ai: "^7.0.0" } },
            "0.17.0": { peerDependencies: { ai: "^8.0.0" } },
          },
        }),
      }),
    )
    const r = await resolveLatestEve()
    expect(r.gated).toBe(true)
    expect(r.target).toBe(EVE_VERSION)
    // aiPin tracks the pinned-back target; latestAiPin tracks the real candidate.
    expect(r.aiPin).toBe("^7.0.0")
    expect(r.latestAiPin).toBe("^8.0.0")
  })

  it("falls back to the pinned consts when the fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")))
    const r = await resolveLatestEve()
    expect(r).toEqual({
      latest: EVE_VERSION,
      target: EVE_VERSION,
      aiPin: EVE_AI_VERSION,
      latestAiPin: EVE_AI_VERSION,
      gated: false,
    })
  })

  it("falls back the ai pin to EVE_AI_VERSION when the version has no ai peer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ "dist-tags": { latest: "0.16.2" }, versions: { "0.16.2": {} } }),
      }),
    )
    const r = await resolveLatestEve()
    expect(r.aiPin).toBe(EVE_AI_VERSION)
  })
})
