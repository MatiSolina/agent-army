import { EVE_VERSION, EVE_AI_VERSION } from "./project"

export type EveTarget = {
  latest: string
  target: string
  /** The `ai` peer pin for `target` (the auto-update / pinned-back version). */
  aiPin: string
  /**
   * The `ai` peer pin for `latest` (the CANDIDATE). For a gated bump `target` is
   * pinned BACK to the current version, so its `aiPin` is the OLD ai peer; a
   * preview-test pins the candidate eve and must carry the candidate's ai peer.
   * Equals `aiPin` for a non-gated bump (target === latest).
   */
  latestAiPin: string
  gated: boolean
}

function parse(v: string): [number, number, number] {
  const [a, b, c] = v
    .replace(/^[^\d]*/, "")
    .split(".")
    .map((n) => parseInt(n, 10) || 0)
  return [a, b, c]
}

/**
 * 0.x packages put the breaking change in the MINOR field (eve is 0.16.x). The
 * "breaking position" is the first non-zero semver field: minor for 0.x, major
 * otherwise. Auto-update only across the field BELOW the breaking position:
 * patch for 0.x, minor for >=1.x. Anything that crosses the breaking position
 * is `gated` (needs a manual generator review + full test pass before being
 * offered as a fleet update).
 */
export function compareEve(pin: string, latest: string): { target: string; gated: boolean } {
  const [pMaj, pMin, pPatch] = parse(pin)
  const [lMaj, lMin, lPatch] = parse(latest)
  // latest <= pin → nothing to do; keep the pin, never "downgrade".
  const cmp = lMaj - pMaj || lMin - pMin || lPatch - pPatch
  if (cmp <= 0) return { target: pin, gated: false }
  const breakingChanged = pMaj === 0 ? lMaj !== pMaj || lMin !== pMin : lMaj !== pMaj
  return breakingChanged ? { target: pin, gated: true } : { target: latest, gated: false }
}

/**
 * Decide whether the editor's "Update to <v>" button is offered, using the same
 * gate logic as the fleet auto-update workflow ({@link compareEve}). Never offers
 * a downgrade; offers a patch upgrade outright. A breaking-change (`gated`) bump
 * is normally hidden — UNLESS `eveVerifiedVersion` exactly equals the latest
 * target, i.e. THIS agent already proved the candidate builds + responds in a
 * pinned preview deploy. That per-agent verdict overrides the gate (and only for
 * the version that was actually verified — a stale/different value never does).
 * `agentVersion` null = never deployed → no button.
 */
export function eveUpdateOffer(
  agentVersion: string | null,
  currentTarget: string,
  eveVerifiedVersion?: string | null,
): { show: boolean; to: string } {
  if (!agentVersion) return { show: false, to: currentTarget }
  const { target, gated } = compareEve(agentVersion, currentTarget)
  // A verified gated bump: this agent proved the candidate (currentTarget) in a
  // preview-test, so override the gate and offer it — but ONLY if it is a real
  // forward bump (never a downgrade/no-op). For a gated bump compareEve pins
  // `target` back to agentVersion, so we point the offer at currentTarget here.
  if (
    gated &&
    !!eveVerifiedVersion &&
    eveVerifiedVersion === currentTarget &&
    currentTarget !== agentVersion
  ) {
    return { show: true, to: currentTarget }
  }
  if (gated || target === agentVersion) return { show: false, to: target }
  return { show: true, to: target }
}

/**
 * Resolve the highest patch-compatible eve version + its `ai` peer pin from the
 * npm registry. Falls back to the module consts ({@link EVE_VERSION} /
 * {@link EVE_AI_VERSION}) on any fetch/parse failure so the dashboard never lies
 * about a "behind" state when npm is unreachable. Cached ~1h via fetch revalidate.
 *
 * `zod` is NOT in eve's peerDependencies — keep it a project const, independent
 * of the ai-pin re-resolution here.
 */
export async function resolveLatestEve(): Promise<EveTarget> {
  try {
    const res = await fetch("https://registry.npmjs.org/eve", {
      // Cache ~1h; revalidate works in RSC fetch. Harmless in tests (fetch stubbed).
      next: { revalidate: 3600 },
    })
    if (!res.ok) throw new Error(`registry ${res.status}`)
    const data = (await res.json()) as {
      "dist-tags"?: { latest?: string }
      versions?: Record<string, { peerDependencies?: { ai?: string } }>
    }
    const latest = data["dist-tags"]?.latest
    if (!latest) throw new Error("no dist-tags.latest")
    const { target, gated } = compareEve(EVE_VERSION, latest)
    const aiPin = data.versions?.[target]?.peerDependencies?.ai ?? EVE_AI_VERSION
    const latestAiPin = data.versions?.[latest]?.peerDependencies?.ai ?? EVE_AI_VERSION
    return { latest, target, aiPin, latestAiPin, gated }
  } catch {
    return {
      latest: EVE_VERSION,
      target: EVE_VERSION,
      aiPin: EVE_AI_VERSION,
      latestAiPin: EVE_AI_VERSION,
      gated: false,
    }
  }
}
