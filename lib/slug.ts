// URL-facing slug for an agent, derived from its name. Same name-normalization
// rule as projectName() (lib/eve/project.ts) minus the id suffix: trim ->
// lowercase -> every run of non-[a-z0-9] becomes "-" -> strip edge "-".
// Names aren't unique, so slugs can collide; resolution is first-match.
// note: pure name slug, no uniqueness suffix — add one if collisions bite.
export function agentSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}
