import { describe, it, expect } from "vitest"
import {
  SUGGESTED_MODELS,
  DEFAULT_MODEL,
  getModelLabel,
  mapGatewayModels,
  filterModels,
} from "@/lib/models"

describe("SUGGESTED_MODELS", () => {
  it("is a non-empty list of {id,label,provider}", () => {
    expect(SUGGESTED_MODELS.length).toBeGreaterThan(0)
    for (const m of SUGGESTED_MODELS) {
      expect(typeof m.id).toBe("string")
      expect(typeof m.label).toBe("string")
      expect(typeof m.provider).toBe("string")
    }
  })

  it("defaults to a free-tier-friendly model that is in the shortlist", () => {
    // Most users run on Vercel's free AI Gateway tier, so a new agent must work
    // out of the box without paid credits.
    expect(DEFAULT_MODEL).toBe("anthropic/claude-haiku-4.5")
    expect(SUGGESTED_MODELS.some((m) => m.id === DEFAULT_MODEL)).toBe(true)
  })
})

describe("getModelLabel", () => {
  it("returns the label for a suggested model", () => {
    const m = SUGGESTED_MODELS[0]
    expect(getModelLabel(m.id)).toBe(m.label)
  })

  it("falls back to the raw id for unknown (dynamic) models", () => {
    expect(getModelLabel("some/unknown-model")).toBe("some/unknown-model")
  })
})

describe("mapGatewayModels", () => {
  it("maps {id,name} to {id,label,provider} deriving provider from the id prefix", () => {
    const out = mapGatewayModels([
      { id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
      { id: "openai/gpt-5-mini" }, // no name -> label falls back to id
    ])
    expect(out).toContainEqual({
      id: "anthropic/claude-sonnet-4.6",
      label: "Claude Sonnet 4.6",
      provider: "anthropic",
    })
    expect(out).toContainEqual({
      id: "openai/gpt-5-mini",
      label: "openai/gpt-5-mini",
      provider: "openai",
    })
  })

  it("excludes non-language models (embeddings, image, etc.)", () => {
    const out = mapGatewayModels([
      { id: "openai/text-embedding-3", name: "Embed", modelType: "embedding" },
      { id: "openai/gpt-5", name: "GPT-5", modelType: "language" },
    ])
    expect(out.map((m) => m.id)).toEqual(["openai/gpt-5"])
  })

  it("sorts by provider then label", () => {
    const out = mapGatewayModels([
      { id: "openai/z", name: "Z" },
      { id: "anthropic/b", name: "B" },
      { id: "anthropic/a", name: "A" },
    ])
    expect(out.map((m) => m.id)).toEqual([
      "anthropic/a",
      "anthropic/b",
      "openai/z",
    ])
  })
})

describe("filterModels", () => {
  const models = [
    { id: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6", provider: "anthropic" },
    { id: "openai/gpt-5-mini", label: "GPT-5 mini", provider: "openai" },
  ]

  it("returns everything when the query is blank", () => {
    expect(filterModels(models, "  ")).toEqual(models)
  })

  it("matches on label, case-insensitively", () => {
    expect(filterModels(models, "sonnet").map((m) => m.id)).toEqual([
      "anthropic/claude-sonnet-4.6",
    ])
  })

  it("matches on the id (provider/slug) too", () => {
    expect(filterModels(models, "gpt-5").map((m) => m.id)).toEqual([
      "openai/gpt-5-mini",
    ])
  })

  it("returns [] when nothing matches", () => {
    expect(filterModels(models, "zzz")).toEqual([])
  })
})
