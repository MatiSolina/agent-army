// Model selection for agents. Every value is a plain AI Gateway model id
// ("provider/model") passed straight through to the gateway.
//
// SUGGESTED_MODELS is a small curated shortlist shown first in the picker; the
// full "all models" list is fetched live from the gateway (see
// `app/actions/models.ts`). Eve recommends Sonnet 4.6 as the default agent model.

export type Model = { id: string; label: string; provider: string }

// Default is Haiku 4.5: empirically the cleanest model on Vercel's free AI tier
// (consistently usable, not even rate-limited). note: we deliberately do NOT
// flag/block individual models for the free tier: probing showed the gateway's
// "no access" vs "rate-limited" verdict is unstable per model (only Sonnet 4.6
// was consistently hard-blocked), so a static blocklist would just rot. The
// picker collapses the long list on the free tier; the runtime error explains
// any model that's gated.
export const SUGGESTED_MODELS: Model[] = [
  { id: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5", provider: "anthropic" },
  { id: "zai/glm-5.2", label: "GLM 5.2", provider: "zai" },
  { id: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6", provider: "anthropic" },
  { id: "anthropic/claude-opus-4.8", label: "Claude Opus 4.8", provider: "anthropic" },
  { id: "google/gemini-3.5-flash", label: "Gemini 3.5 Flash", provider: "google" },
]

export const DEFAULT_MODEL = "anthropic/claude-haiku-4.5"

export function getModelLabel(id: string) {
  return SUGGESTED_MODELS.find((m) => m.id === id)?.label ?? id
}

/** Filter models by a free-text query against label + id (case-insensitive). */
export function filterModels(models: Model[], query: string): Model[] {
  const q = query.trim().toLowerCase()
  if (!q) return models
  return models.filter((m) =>
    `${m.label} ${m.id}`.toLowerCase().includes(q),
  )
}

/**
 * Map raw AI Gateway models (`gateway.getAvailableModels().models`) to our
 * `Model` shape: provider is the id prefix, label falls back to the id.
 * Only language models are kept (the gateway also returns embedding/image/video/
 * reranking models, which an agent can't use). Inputs with no `modelType` are
 * kept so the mapper stays usable on bare {id,name} fixtures.
 * Pure: kept here (not in the "use server" action) so it can be unit-tested
 * and reused. Sorted by provider then label.
 */
export function mapGatewayModels(
  raw: { id: string; name?: string; modelType?: string | null }[],
): Model[] {
  return raw
    .filter((m) => (m.modelType ? m.modelType === "language" : true))
    .map((m) => ({
      id: m.id,
      label: m.name ?? m.id,
      provider: m.id.split("/")[0] ?? "",
    }))
    .sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label),
    )
}
