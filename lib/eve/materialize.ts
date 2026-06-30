import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

/**
 * Write a `{ relativePath: contents }` file map (e.g. from `buildEveProject`)
 * to disk under `targetDir`, with two layers of path-traversal defence.
 *
 * Layer 1 — `isSafeRelativeKey`: a pure string check (no fs) that rejects
 * absolute paths and any `..` segment. Unit-testable in isolation.
 * Layer 2 — `resolveWithinRoot`: resolves each key against the root and asserts
 * the result stays inside it (defence in depth, catches platform-specific edge
 * cases the string check might miss).
 */

/**
 * Reject keys that could escape the target dir: absolute paths, `..` segments,
 * or empty keys. Pure + synchronous so it is unit-testable without fs.
 */
export function isSafeRelativeKey(key: string): boolean {
  if (!key || key.startsWith("/") || key.startsWith("\\")) return false
  if (path.isAbsolute(key)) return false
  // Reject any literal ".." segment in the RAW key (before normalization, which
  // could collapse "a/.." to "." and hide the traversal intent).
  if (key.split(/[\\/]/).some((seg) => seg === "..")) return false
  // Defence in depth: normalization must not surface a leading "..".
  const normalized = path.normalize(key)
  if (normalized === "..") return false
  if (normalized.startsWith(".." + path.sep) || normalized.startsWith("../")) {
    return false
  }
  return true
}

/**
 * Resolve `key` against `root` and assert containment. Throws if the resolved
 * path escapes the root.
 */
export function resolveWithinRoot(root: string, key: string): string {
  const resolvedRoot = path.resolve(root)
  const full = path.resolve(resolvedRoot, key)
  const rel = path.relative(resolvedRoot, full)
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new Error(`Unsafe path key escapes target dir: ${key}`)
  }
  return full
}

/**
 * Materialise the file map under `targetDir`. Does NOT clean the directory —
 * the caller is responsible for using a fresh temp dir. Returns the list of
 * absolute paths written.
 */
export async function materialize(
  targetDir: string,
  files: Record<string, string>,
): Promise<string[]> {
  const written: string[] = []
  for (const [key, contents] of Object.entries(files)) {
    if (!isSafeRelativeKey(key)) {
      throw new Error(`Unsafe path key: ${key}`)
    }
    const full = resolveWithinRoot(targetDir, key)
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, contents, "utf8")
    written.push(full)
  }
  return written
}
