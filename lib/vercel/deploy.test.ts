import { describe, it, expect } from "vitest"
import {
  buildDeploymentFiles,
  parseDeploymentResponse,
  classifyReadyState,
  extractBuildErrorText,
  extractBuildLogLines,
  parseEnvKeysResponse,
  parseDeploymentsList,
  parseProductionDeploymentId,
  summarizeDeployProgress,
  parseProjectsList,
  flattenDeploymentFiles,
  decodeDeploymentFileBody,
} from "./deploy"

// ---------------------------------------------------------------------------
// buildDeploymentFiles
// ---------------------------------------------------------------------------
describe("buildDeploymentFiles", () => {
  it("maps a file map to the Vercel inline files array shape", () => {
    const result = buildDeploymentFiles({ "package.json": '{"name":"x"}' })
    expect(result).toEqual([
      { file: "package.json", data: '{"name":"x"}', encoding: "utf-8" },
    ])
  })

  it("preserves nested agent/... paths verbatim", () => {
    const result = buildDeploymentFiles({ "agent/agent.ts": "export {}" })
    expect(result[0].file).toBe("agent/agent.ts")
    expect(result[0].data).toBe("export {}")
    expect(result[0].encoding).toBe("utf-8")
  })

  it("preserves data verbatim", () => {
    const contents = "line1\nline2\n  indented"
    const result = buildDeploymentFiles({ "foo.ts": contents })
    expect(result[0].data).toBe(contents)
  })

  it("encoding is always utf-8", () => {
    const result = buildDeploymentFiles({
      "a.ts": "a",
      "b.ts": "b",
      "c.ts": "c",
    })
    for (const entry of result) {
      expect(entry.encoding).toBe("utf-8")
    }
  })

  it("sorts entries by file path ascending", () => {
    const map = {
      "z.ts": "z",
      "agent/agent.ts": "a",
      "package.json": "p",
    }
    const result = buildDeploymentFiles(map)
    expect(result.map((e) => e.file)).toEqual([
      "agent/agent.ts",
      "package.json",
      "z.ts",
    ])
  })

  it("returns empty array for empty map", () => {
    expect(buildDeploymentFiles({})).toEqual([])
  })

  it("security: result contains exactly the input keys, nothing extra", () => {
    const map = { "a.ts": "a", "b.ts": "b" }
    const result = buildDeploymentFiles(map)
    const resultKeys = new Set(result.map((e) => e.file))
    const inputKeys = new Set(Object.keys(map))
    expect(resultKeys).toEqual(inputKeys)
    expect(result.length).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// parseDeploymentResponse
// ---------------------------------------------------------------------------
describe("parseDeploymentResponse", () => {
  it("parses a typical POST response and prefixes missing scheme with https://", () => {
    const json = {
      id: "dpl_abc123",
      url: "my-proj-abc.vercel.app",
      readyState: "QUEUED",
    }
    const result = parseDeploymentResponse(json)
    expect(result.id).toBe("dpl_abc123")
    expect(result.url).toBe("https://my-proj-abc.vercel.app")
    expect(result.readyState).toBe("QUEUED")
  })

  it("parses a READY GET response", () => {
    const json = {
      id: "dpl_xyz",
      url: "my-proj-xyz.vercel.app",
      readyState: "READY",
    }
    const result = parseDeploymentResponse(json)
    expect(result.readyState).toBe("READY")
    expect(result.url).toBe("https://my-proj-xyz.vercel.app")
  })

  it("leaves an already-https:// url unchanged", () => {
    const json = {
      id: "dpl_1",
      url: "https://my-proj.vercel.app",
      readyState: "READY",
    }
    expect(parseDeploymentResponse(json).url).toBe("https://my-proj.vercel.app")
  })

  it("leaves an http:// url unchanged", () => {
    const json = {
      id: "dpl_2",
      url: "http://localhost:3000",
      readyState: "BUILDING",
    }
    expect(parseDeploymentResponse(json).url).toBe("http://localhost:3000")
  })

  it("sets url to empty string when url is absent", () => {
    const json = { id: "dpl_3", readyState: "QUEUED" }
    const result = parseDeploymentResponse(json)
    expect(result.url).toBe("")
  })

  it("throws on non-object input", () => {
    expect(() => parseDeploymentResponse("string")).toThrow(
      "Unexpected Vercel API response"
    )
    expect(() => parseDeploymentResponse(null)).toThrow(
      "Unexpected Vercel API response"
    )
    expect(() => parseDeploymentResponse(42)).toThrow(
      "Unexpected Vercel API response"
    )
    expect(() => parseDeploymentResponse([])).toThrow(
      "Unexpected Vercel API response"
    )
  })

  it("throws when id is missing", () => {
    expect(() =>
      parseDeploymentResponse({ readyState: "READY" })
    ).toThrow("Unexpected Vercel API response")
  })

  it("throws when readyState is missing", () => {
    expect(() =>
      parseDeploymentResponse({ id: "dpl_1" })
    ).toThrow("Unexpected Vercel API response")
  })
})

// ---------------------------------------------------------------------------
// classifyReadyState
// ---------------------------------------------------------------------------
describe("classifyReadyState", () => {
  it("READY → ready", () => {
    expect(classifyReadyState("READY")).toBe("ready")
  })

  it("ERROR → error", () => {
    expect(classifyReadyState("ERROR")).toBe("error")
  })

  it("CANCELED → error", () => {
    expect(classifyReadyState("CANCELED")).toBe("error")
  })

  it("BLOCKED → error", () => {
    expect(classifyReadyState("BLOCKED")).toBe("error")
  })

  it("QUEUED → pending", () => {
    expect(classifyReadyState("QUEUED")).toBe("pending")
  })

  it("INITIALIZING → pending", () => {
    expect(classifyReadyState("INITIALIZING")).toBe("pending")
  })

  it("BUILDING → pending", () => {
    expect(classifyReadyState("BUILDING")).toBe("pending")
  })

  it("unknown value → pending", () => {
    expect(classifyReadyState("UNKNOWN_STATE")).toBe("pending")
  })

  it("lowercase input → still works (case-insensitive)", () => {
    expect(classifyReadyState("ready")).toBe("ready")
    expect(classifyReadyState("error")).toBe("error")
    expect(classifyReadyState("building")).toBe("pending")
  })
})

// ---------------------------------------------------------------------------
// extractBuildErrorText
// ---------------------------------------------------------------------------
describe("extractBuildErrorText", () => {
  it("extracts stderr and fatal events, skips stdout", () => {
    const events = [
      { type: "stdout", text: "stdout line" },
      { type: "stderr", text: "stderr line" },
      { type: "fatal", text: "fatal error" },
      { type: "stdout", text: "another stdout" },
    ]
    const result = extractBuildErrorText(events)
    expect(result).not.toContain("stdout line")
    expect(result).toContain("stderr line")
    expect(result).toContain("fatal error")
  })

  it("joins stderr+fatal text in order", () => {
    const events = [
      { type: "stderr", text: "first" },
      { type: "fatal", text: "second" },
      { type: "stderr", text: "third" },
    ]
    const result = extractBuildErrorText(events)
    expect(result).toBe("first\nsecond\nthird")
  })

  it("returns fallback for empty array", () => {
    expect(extractBuildErrorText([])).toBe("(no build error output)")
  })

  it("returns fallback for non-array input", () => {
    expect(extractBuildErrorText(null)).toBe("(no build error output)")
    expect(extractBuildErrorText("string")).toBe("(no build error output)")
    expect(extractBuildErrorText({ type: "stderr" })).toBe(
      "(no build error output)"
    )
  })

  it("returns fallback when no stderr/fatal events", () => {
    const events = [{ type: "stdout", text: "all good" }]
    expect(extractBuildErrorText(events)).toBe("(no build error output)")
  })

  it("caps output to ~1500 chars", () => {
    const events = [{ type: "stderr", text: "x".repeat(2000) }]
    const result = extractBuildErrorText(events)
    expect(result.length).toBeLessThanOrEqual(1500)
  })
})

// ---------------------------------------------------------------------------
// parseEnvKeysResponse
// ---------------------------------------------------------------------------
describe("parseEnvKeysResponse", () => {
  it("maps the { envs: [...] } shape to {key,target,type} only", () => {
    const json = {
      envs: [
        {
          id: "env_1",
          key: "ACME_TOKEN",
          type: "encrypted",
          target: ["production", "preview"],
          value: "should-never-surface",
        },
      ],
    }
    const result = parseEnvKeysResponse(json)
    expect(result).toEqual([
      { key: "ACME_TOKEN", target: ["production", "preview"], type: "encrypted" },
    ])
  })

  it("never returns the value field (masked-list safety)", () => {
    const json = {
      envs: [{ key: "K", type: "encrypted", target: ["production"], value: "v" }],
    }
    const result = parseEnvKeysResponse(json)
    expect(JSON.stringify(result)).not.toContain("value")
    expect(JSON.stringify(result)).not.toContain('"v"')
  })

  it("accepts a bare array of env entries", () => {
    const json = [
      { key: "A", type: "plain", target: ["preview"] },
      { key: "B", type: "encrypted", target: ["production", "preview"] },
    ]
    const result = parseEnvKeysResponse(json)
    expect(result.map((e) => e.key)).toEqual(["A", "B"])
  })

  it("normalizes a string target to a single-element array", () => {
    const json = { envs: [{ key: "K", type: "encrypted", target: "production" }] }
    expect(parseEnvKeysResponse(json)[0].target).toEqual(["production"])
  })

  it("defaults target to [] when absent", () => {
    const json = { envs: [{ key: "K", type: "encrypted" }] }
    expect(parseEnvKeysResponse(json)[0].target).toEqual([])
  })

  it("skips entries with no string key", () => {
    const json = { envs: [{ type: "encrypted" }, { key: "OK", type: "plain" }] }
    expect(parseEnvKeysResponse(json).map((e) => e.key)).toEqual(["OK"])
  })

  it("returns [] for non-object / null / unexpected input", () => {
    expect(parseEnvKeysResponse(null)).toEqual([])
    expect(parseEnvKeysResponse("nope")).toEqual([])
    expect(parseEnvKeysResponse({ foo: "bar" })).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// parseDeploymentsList
// ---------------------------------------------------------------------------
describe("parseDeploymentsList", () => {
  it("maps the { deployments: [...] } shape to {id,url,state,createdAt,target}", () => {
    const json = {
      deployments: [
        {
          uid: "dpl_1",
          url: "proj-1.vercel.app",
          created: 1700000000000,
          state: "READY",
          target: "production",
        },
      ],
    }
    expect(parseDeploymentsList(json)).toEqual([
      {
        id: "dpl_1",
        url: "proj-1.vercel.app",
        state: "READY",
        createdAt: 1700000000000,
        target: "production",
      },
    ])
  })

  it("uses readyState when state is absent", () => {
    const json = {
      deployments: [
        {
          uid: "dpl_2",
          url: "proj-2.vercel.app",
          created: 1700000000001,
          readyState: "BUILDING",
          target: null,
        },
      ],
    }
    expect(parseDeploymentsList(json)[0].state).toBe("BUILDING")
  })

  it("defaults target to null when absent", () => {
    const json = {
      deployments: [
        { uid: "dpl_3", url: "p3.vercel.app", created: 1, state: "READY" },
      ],
    }
    expect(parseDeploymentsList(json)[0].target).toBeNull()
  })

  it("skips entries without a string uid", () => {
    const json = {
      deployments: [
        { url: "no-uid.vercel.app", created: 1, state: "READY" },
        { uid: "dpl_ok", url: "ok.vercel.app", created: 2, state: "READY" },
      ],
    }
    expect(parseDeploymentsList(json).map((d) => d.id)).toEqual(["dpl_ok"])
  })

  it("returns [] when the shape is wrong", () => {
    expect(parseDeploymentsList(null)).toEqual([])
    expect(parseDeploymentsList("nope")).toEqual([])
    expect(parseDeploymentsList({ foo: "bar" })).toEqual([])
    expect(parseDeploymentsList([])).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// parseProductionDeploymentId
// ---------------------------------------------------------------------------
describe("parseProductionDeploymentId", () => {
  it("returns targets.production.id when it is a string", () => {
    const json = { targets: { production: { id: "dpl_prod", url: "p.vercel.app" } } }
    expect(parseProductionDeploymentId(json)).toBe("dpl_prod")
  })

  it("returns null when production target is absent", () => {
    expect(parseProductionDeploymentId({ targets: {} })).toBeNull()
    expect(parseProductionDeploymentId({})).toBeNull()
  })

  it("returns null when id is not a string", () => {
    const json = { targets: { production: { id: 42 } } }
    expect(parseProductionDeploymentId(json)).toBeNull()
  })

  it("returns null for non-object / null / unexpected input", () => {
    expect(parseProductionDeploymentId(null)).toBeNull()
    expect(parseProductionDeploymentId("nope")).toBeNull()
    expect(parseProductionDeploymentId(42)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// extractBuildLogLines — ordered, human-readable build log tail
// ---------------------------------------------------------------------------
describe("extractBuildLogLines", () => {
  it("returns text from stdout/stderr/command events in order", () => {
    const events = [
      { type: "command", text: "Running build in iad1" },
      { type: "stdout", text: "Installing dependencies…" },
      { type: "stderr", text: "warning: deprecated" },
    ]
    expect(extractBuildLogLines(events)).toEqual([
      "Running build in iad1",
      "Installing dependencies…",
      "warning: deprecated",
    ])
  })

  it("trims trailing newlines and drops blank lines", () => {
    const events = [
      { type: "stdout", text: "line one\n" },
      { type: "stdout", text: "   " },
      { type: "stdout", text: "line two\n\n" },
    ]
    expect(extractBuildLogLines(events)).toEqual(["line one", "line two"])
  })

  it("skips events without string text", () => {
    const events = [
      { type: "stdout" },
      { type: "stdout", text: 42 },
      { type: "stdout", text: "kept" },
    ]
    expect(extractBuildLogLines(events)).toEqual(["kept"])
  })

  it("returns [] for empty / non-array input", () => {
    expect(extractBuildLogLines([])).toEqual([])
    expect(extractBuildLogLines(null)).toEqual([])
    expect(extractBuildLogLines("nope")).toEqual([])
  })

  it("keeps only the last 200 lines", () => {
    const events = Array.from({ length: 250 }, (_, i) => ({
      type: "stdout",
      text: `line ${i}`,
    }))
    const result = extractBuildLogLines(events)
    expect(result).toHaveLength(200)
    expect(result[0]).toBe("line 50")
    expect(result[199]).toBe("line 249")
  })
})

// ---------------------------------------------------------------------------
// summarizeDeployProgress — classify the newest deployment into a UI phase
// ---------------------------------------------------------------------------
describe("summarizeDeployProgress", () => {
  const dep = (over: Partial<{ id: string; url: string; state: string; createdAt: number; target: string | null }>) => ({
    id: "dpl_new",
    url: "new.vercel.app",
    state: "BUILDING",
    createdAt: 2000,
    target: null,
    ...over,
  })

  it("is 'preparing' when no deployment is newer than `sinceMs` yet", () => {
    const stale = dep({ id: "dpl_old", state: "READY", createdAt: 500 })
    const r = summarizeDeployProgress([stale], 1000)
    expect(r.phase).toBe("preparing")
    expect(r.deploymentId).toBeNull()
  })

  it("is 'preparing' when there are no deployments at all", () => {
    const r = summarizeDeployProgress([], 1000)
    expect(r.phase).toBe("preparing")
    expect(r.deploymentId).toBeNull()
  })

  it("is 'building' when the newest deployment is BUILDING", () => {
    const r = summarizeDeployProgress([dep({ state: "BUILDING" })], 1000)
    expect(r.phase).toBe("building")
    expect(r.deploymentId).toBe("dpl_new")
    expect(r.url).toBe("new.vercel.app")
  })

  it("treats QUEUED / INITIALIZING as 'preparing' but exposes the id", () => {
    expect(summarizeDeployProgress([dep({ state: "QUEUED" })], 1000).phase).toBe(
      "preparing",
    )
    const r = summarizeDeployProgress([dep({ state: "INITIALIZING" })], 1000)
    expect(r.phase).toBe("preparing")
    expect(r.deploymentId).toBe("dpl_new")
  })

  it("is 'ready' when the newest deployment is READY", () => {
    const r = summarizeDeployProgress([dep({ state: "READY" })], 1000)
    expect(r.phase).toBe("ready")
  })

  it("is 'error' on ERROR or CANCELED", () => {
    expect(summarizeDeployProgress([dep({ state: "ERROR" })], 1000).phase).toBe(
      "error",
    )
    expect(
      summarizeDeployProgress([dep({ state: "CANCELED" })], 1000).phase,
    ).toBe("error")
  })

  it("uses the newest (first) entry when several are newer than sinceMs", () => {
    const r = summarizeDeployProgress(
      [dep({ id: "dpl_a", createdAt: 3000 }), dep({ id: "dpl_b", createdAt: 2500 })],
      1000,
    )
    expect(r.deploymentId).toBe("dpl_a")
  })
})

// ---------------------------------------------------------------------------
// parseProjectsList
// ---------------------------------------------------------------------------
describe("parseProjectsList", () => {
  it("reads id/name/framework + production deployment from a bare array", () => {
    const { projects, next } = parseProjectsList([
      {
        id: "prj_1",
        name: "content-agent-10d72dc7",
        framework: "eve",
        targets: { production: { id: "dpl_abc" } },
      },
    ])
    expect(next).toBeNull()
    expect(projects).toEqual([
      {
        id: "prj_1",
        name: "content-agent-10d72dc7",
        framework: "eve",
        productionDeploymentId: "dpl_abc",
      },
    ])
  })

  it("reads the {projects,pagination} object form and the next token", () => {
    const { projects, next } = parseProjectsList({
      projects: [{ id: "prj_2", name: "x", framework: null }],
      pagination: { count: 1, next: 1700000000000 },
    })
    expect(projects[0]).toEqual({
      id: "prj_2",
      name: "x",
      framework: null,
      productionDeploymentId: null,
    })
    expect(next).toBe("1700000000000")
  })

  it("drops entries missing id/name and never throws on junk", () => {
    expect(parseProjectsList(null)).toEqual({ projects: [], next: null })
    expect(parseProjectsList([{ id: "prj" }, { name: "y" }]).projects).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// flattenDeploymentFiles
// ---------------------------------------------------------------------------
describe("flattenDeploymentFiles", () => {
  // Mirrors the REAL /v6 tree shape: source under src/, build output under out/.
  const tree = [
    {
      name: "src",
      type: "directory",
      children: [
        { name: "package.json", type: "file", uid: "u_pkg" },
        {
          name: "agent",
          type: "directory",
          children: [{ name: "agent.ts", type: "file", uid: "u_agent" }],
        },
      ],
    },
    {
      name: "out",
      type: "directory",
      children: [{ name: "index", type: "lambda", uid: "u_lambda" }],
    },
  ]

  it("recurses directories and joins name segments into full paths", () => {
    const files = flattenDeploymentFiles(tree)
    expect(files).toContainEqual({ path: "src/package.json", uid: "u_pkg" })
    expect(files).toContainEqual({ path: "src/agent/agent.ts", uid: "u_agent" })
  })

  it("keeps only type:file leaves (skips lambda/middleware/directory)", () => {
    const files = flattenDeploymentFiles(tree)
    expect(files.find((f) => f.path === "out/index")).toBeUndefined()
    expect(files).toHaveLength(2)
  })

  it("tolerates a {files:[...]} wrapper and junk", () => {
    expect(flattenDeploymentFiles({ files: tree }).length).toBe(2)
    expect(flattenDeploymentFiles(null)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// decodeDeploymentFileBody
// ---------------------------------------------------------------------------
describe("decodeDeploymentFileBody", () => {
  const source = 'import { defineAgent } from "eve"\n'
  const b64 = Buffer.from(source, "utf-8").toString("base64")

  it("decodes the verified {data:<base64>} wrapper", () => {
    expect(decodeDeploymentFileBody(JSON.stringify({ data: b64 }))).toBe(source)
  })

  it("decodes a {content:<base64>} wrapper", () => {
    expect(decodeDeploymentFileBody(JSON.stringify({ content: b64 }))).toBe(source)
  })

  it("decodes a bare base64 body", () => {
    expect(decodeDeploymentFileBody(b64)).toBe(source)
  })

  it("returns plain-text bodies verbatim (not base64-shaped)", () => {
    const text = "export default defineAgent({ model: 1 })"
    expect(decodeDeploymentFileBody(text)).toBe(text)
  })
})
