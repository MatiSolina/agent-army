import { describe, it, expect, vi, afterEach } from "vitest"
import { fetchCuratedSkillsSh, fetchSearchSkillsSh } from "@/app/actions/skills"

// Server actions ("use server") can't be imported into vitest without the
// Next transform mangling them, so the fetch logic lives in pure helpers and
// the "use server" wrappers just call them. This file tests the helpers.

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
