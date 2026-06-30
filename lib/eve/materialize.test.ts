import { describe, it, expect } from "vitest"
import { isSafeRelativeKey, resolveWithinRoot } from "./materialize"
import path from "node:path"

describe("isSafeRelativeKey", () => {
  it("accepts normal relative keys", () => {
    expect(isSafeRelativeKey("agent/agent.ts")).toBe(true)
    expect(isSafeRelativeKey("package.json")).toBe(true)
    expect(isSafeRelativeKey("agent/subagents/r/agent.ts")).toBe(true)
    expect(isSafeRelativeKey("agent/skills/foo.md")).toBe(true)
  })

  it("rejects absolute paths", () => {
    expect(isSafeRelativeKey("/etc/passwd")).toBe(false)
    expect(isSafeRelativeKey("\\windows\\system32")).toBe(false)
  })

  it("rejects traversal with ..", () => {
    expect(isSafeRelativeKey("../x")).toBe(false)
    expect(isSafeRelativeKey("a/../../b")).toBe(false)
    expect(isSafeRelativeKey("foo/../../../bar")).toBe(false)
    expect(isSafeRelativeKey("..")).toBe(false)
    expect(isSafeRelativeKey("a/..")).toBe(false)
  })

  it("rejects empty keys", () => {
    expect(isSafeRelativeKey("")).toBe(false)
  })
})

describe("resolveWithinRoot", () => {
  const root = "/tmp/eve-deploy/agent-1"

  it("resolves safe keys to a path under the root", () => {
    const full = resolveWithinRoot(root, "agent/agent.ts")
    expect(full).toBe(path.resolve(root, "agent/agent.ts"))
    expect(full.startsWith(path.resolve(root))).toBe(true)
  })

  it("throws on traversal that escapes the root", () => {
    expect(() => resolveWithinRoot(root, "../../etc/passwd")).toThrow()
    expect(() => resolveWithinRoot(root, "a/../../../../etc/passwd")).toThrow()
  })

  it("throws on an absolute key that lands outside root", () => {
    expect(() => resolveWithinRoot(root, "/etc/passwd")).toThrow()
  })
})
