import { describe, it, expect, vi, afterEach } from "vitest"
import {
  fetchCuratedSkillsSh,
  fetchSearchSkillsSh,
  fetchSkillDetailSh,
} from "@/lib/skills/skills-sh"

// These helpers live OUTSIDE any "use server" file on purpose: in a "use
// server" module, every export becomes a client-callable server action, which
// would let the client call them directly and skip the requireSessionUser()
// gate that the action wrappers enforce. Here they're plain server-only
// helpers, callable from the authenticated server actions but not from the
// client.

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })

describe("fetchCuratedSkillsSh", () => {
  afterEach(() => vi.restoreAllMocks())

  it("returns [] instead of throwing when skills.sh responds 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 401 })),
    )
    const out = await fetchCuratedSkillsSh()
    expect(out).toEqual([])
  })

  it("returns [] instead of throwing when the network fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNRESET")
      }),
    )
    const out = await fetchCuratedSkillsSh()
    expect(out).toEqual([])
  })

  it("flattens the nested curated groups into a flat result list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ok({
          data: [
            {
              skills: [
                { id: "1", slug: "s1", name: "One", source: "a/b", installs: 5 },
                { id: "2", slug: "s2", name: "Two", source: "c/d", installs: 0 },
              ],
            },
          ],
        }),
      ),
    )
    const out = await fetchCuratedSkillsSh()
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ slug: "s1", name: "One", source: "a/b" })
  })
})

describe("fetchSearchSkillsSh", () => {
  afterEach(() => vi.restoreAllMocks())

  it("returns [] instead of throwing when skills.sh responds 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 401 })),
    )
    const out = await fetchSearchSkillsSh("refund")
    expect(out).toEqual([])
  })

  it("returns [] for a blank query without calling fetch", async () => {
    const f = vi.fn(async () => ok({ data: [] }))
    vi.stubGlobal("fetch", f)
    const out = await fetchSearchSkillsSh("   ")
    expect(out).toEqual([])
    expect(f).not.toHaveBeenCalled()
  })
})

describe("fetchSkillDetailSh", () => {
  afterEach(() => vi.restoreAllMocks())

  it("returns null instead of throwing when skills.sh responds 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 401 })),
    )
    const out = await fetchSkillDetailSh("anthropics/skills", "refund")
    expect(out).toBeNull()
  })

  it("returns null instead of throwing when the network fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNRESET")
      }),
    )
    const out = await fetchSkillDetailSh("anthropics/skills", "refund")
    expect(out).toBeNull()
  })

  it("returns null when the skill has no SKILL.md", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ok({ files: [{ path: "README.md", contents: "# hi" }] }),
      ),
    )
    const out = await fetchSkillDetailSh("anthropics/skills", "refund")
    expect(out).toBeNull()
  })

  it("returns null when SKILL.md has no name frontmatter", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ok({
          files: [
            {
              path: "SKILL.md",
              contents: "---\ndescription: no name here\n---\nbody",
            },
          ],
        }),
      ),
    )
    const out = await fetchSkillDetailSh("anthropics/skills", "refund")
    expect(out).toBeNull()
  })

  it("returns a parsed AgentSkill when SKILL.md is valid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ok({
          files: [
            {
              path: "SKILL.md",
              contents:
                "---\nname: refund\ndescription: handles refunds\n---\n# Refund\nsteps here",
            },
          ],
        }),
      ),
    )
    const out = await fetchSkillDetailSh("anthropics/skills", "refund")
    expect(out).toMatchObject({
      name: "refund",
      description: "handles refunds",
    })
    expect(out?.content).toContain("# Refund")
  })
})
