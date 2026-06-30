// Small client/server-safe unique id helper.
export function randomUUID(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID()
  }
  // Fallback for older runtimes.
  return "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36)
}

/**
 * Re-id any item whose `id` already appeared earlier in the array. Guards
 * against legacy/seed data with duplicate ids, which breaks React keys and
 * makes id-based update/remove hit multiple rows at once.
 */
export function withUniqueIds<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>()
  return items.map((item) => {
    if (seen.has(item.id)) return { ...item, id: randomUUID() }
    seen.add(item.id)
    return item
  })
}
