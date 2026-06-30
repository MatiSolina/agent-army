// Lightweight client-side validators for free-text config fields.
// Returns `null` when valid, or a human-readable error message.

/**
 * Validate that a string is parseable JSON describing an object
 * (a JSON Schema). Empty strings are allowed (treated as "no schema").
 */
export function validateJsonSchema(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return "Invalid JSON: check the syntax."
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "The schema must be a JSON object."
  }
  return null
}

/**
 * Validate a standard 5-field cron expression (minute hour dom month dow).
 * Accepts wildcards, lists (1,2), ranges (1-5), and steps (e.g. every-N).
 *
 * This is editor-side validation only. Runtime cron *matching* no longer lives
 * in the dashboard — each agent is deployed as its own Eve project and Eve wires
 * its own Vercel Cron per schedule. We only validate the expression the operator
 * types so it is well-formed before it is compiled into the deployed agent.
 */
export function validateCron(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return "Cron expression is required."

  const fields = trimmed.split(/\s+/)
  if (fields.length !== 5) {
    return "Cron must have 5 fields: minute hour day month weekday."
  }

  const ranges: [number, number][] = [
    [0, 59], // minute
    [0, 23], // hour
    [1, 31], // day of month
    [1, 12], // month
    [0, 7], // day of week (0 and 7 = Sunday)
  ]

  const isFieldValid = (field: string, min: number, max: number): boolean => {
    return field.split(",").every((part) => {
      // step: "*/n" or "a-b/n"
      const [rangePart, stepPart] = part.split("/")
      if (stepPart !== undefined) {
        const step = Number(stepPart)
        if (!Number.isInteger(step) || step <= 0) return false
      }
      if (rangePart === "*") return true
      // range: "a-b"
      if (rangePart.includes("-")) {
        const [a, b] = rangePart.split("-").map(Number)
        return (
          Number.isInteger(a) &&
          Number.isInteger(b) &&
          a >= min &&
          b <= max &&
          a <= b
        )
      }
      // single number
      const n = Number(rangePart)
      return Number.isInteger(n) && n >= min && n <= max
    })
  }

  for (let i = 0; i < 5; i++) {
    const [min, max] = ranges[i]
    if (!isFieldValid(fields[i], min, max)) {
      return `Cron field ${i + 1} is out of range or has an invalid format.`
    }
  }
  return null
}
