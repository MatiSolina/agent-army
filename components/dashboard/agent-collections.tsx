"use client"

import { useEffect, useRef, useState, useTransition } from "react"
import Link from "next/link"
import { toast } from "sonner"
import { randomUUID } from "@/lib/uid"
import type {
  AgentSkill,
  AgentSubagent,
  AgentSchedule,
} from "@/lib/db/schema"
import type { ClientConnection } from "@/lib/mcp/client-connection"
import {
  searchSkillsSh,
  getCuratedSkillsSh,
  importSkillFromSh,
  importSkillFromZip,
  type SkillShResult,
} from "@/app/actions/skills"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { DEFAULT_MODEL } from "@/lib/models"
import { ModelSelect } from "@/components/dashboard/model-select"
import { DEFAULT_CRON, LIMITS } from "@/lib/defaults"
import { validateCron } from "@/lib/validation"
import {
  Plus,
  Trash2,
  Sparkles,
  Plug,
  Bot,
  Clock,
  Search,
  Download,
  Upload,
  Loader2,
  Check,
  ExternalLink,
} from "lucide-react"

// ---------- shared primitives ----------

function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string
  htmlFor?: string
  hint?: string
  error?: string | null
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {children}
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground/70">{hint}</p>
      ) : null}
    </div>
  )
}

function ItemCard({
  children,
  onRemove,
}: {
  children: React.ReactNode
  onRemove: () => void
}) {
  return (
    <div className="relative rounded-xl border border-border p-4">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={onRemove}
        className="absolute right-2 top-2 h-7 w-7 text-muted-foreground hover:text-destructive"
        aria-label="Remove item"
      >
        <Trash2 className="h-4 w-4" />
      </Button>
      {children}
    </div>
  )
}

function EmptyState({
  icon: Icon,
  title,
  description,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  description: string
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-12 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-secondary">
        <Icon className="h-5 w-5 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="max-w-sm text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}

function SectionHeader({
  title,
  description,
  onAdd,
  addLabel,
}: {
  title: string
  description: string
  onAdd: () => void
  addLabel: string
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-1">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={onAdd}
        className="gap-1.5"
      >
        <Plus className="h-4 w-4" />
        {addLabel}
      </Button>
    </div>
  )
}

// ---------- Skills ----------

function SkillsShDialog({
  open,
  onOpenChange,
  onImport,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImport: (skill: AgentSkill) => void
}) {
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<SkillShResult[]>([])
  const loadedRef = useRef(false)
  const [isSearching, startSearch] = useTransition()
  const [importingId, setImportingId] = useState<string | null>(null)

  // Load the curated list the first time the dialog opens. Runs on `open`
  // (not the Dialog's onOpenChange) so it fires no matter how the dialog was
  // opened — including the parent button that sets `open` directly.
  useEffect(() => {
    if (!open || loadedRef.current) return
    loadedRef.current = true
    startSearch(async () => {
      try {
        setResults(await getCuratedSkillsSh())
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not load skills.sh")
      }
    })
  }, [open])

  const runSearch = (e: React.FormEvent) => {
    e.preventDefault()
    startSearch(async () => {
      try {
        setResults(await searchSkillsSh(query))
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Search error")
      }
    })
  }

  const handleImport = async (r: SkillShResult) => {
    setImportingId(r.id)
    try {
      const skill = await importSkillFromSh(r.source, r.slug)
      onImport(skill)
      toast.success(`Skill "${skill.name}" added`)
      onOpenChange(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not import the skill")
    } finally {
      setImportingId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import from skills.sh</DialogTitle>
          <DialogDescription>
            Search for a skill in the catalog and add it to this agent. Remember
            to save your changes when done.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={runSearch} className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search skills…"
              aria-label="Search skills on skills.sh"
              className="pl-8"
            />
          </div>
          <Button type="submit" variant="secondary" size="sm" disabled={isSearching}>
            Search
          </Button>
        </form>

        <div className="max-h-80 overflow-y-auto rounded-xl border border-border">
          {isSearching ? (
            <div className="flex items-center justify-center gap-2 py-12 text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading…
            </div>
          ) : results.length === 0 ? (
            <div className="py-12 text-center text-xs text-muted-foreground">
              No results.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {results.map((r) => (
                <li key={r.id} className="flex items-center gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {r.name}
                    </p>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {r.source} · {r.installs.toLocaleString()} installs
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => handleImport(r)}
                    disabled={importingId !== null}
                    className="shrink-0 gap-1.5"
                  >
                    {importingId === r.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Download className="h-4 w-4" />
                    )}
                    Add
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function SkillsEditor({
  value,
  onChange,
}: {
  value: AgentSkill[]
  onChange: (next: AgentSkill[]) => void
}) {
  const [shOpen, setShOpen] = useState(false)
  const [isUploading, startUpload] = useTransition()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const add = () =>
    onChange([
      ...value,
      { id: randomUUID(), name: "", description: "", content: "" },
    ])
  const update = (id: string, patch: Partial<AgentSkill>) =>
    onChange(value.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  const remove = (id: string) => onChange(value.filter((s) => s.id !== id))
  const append = (skill: AgentSkill) => onChange([...value, skill])

  const handleZip = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = "" // allow re-uploading the same file
    if (!file) return
    const formData = new FormData()
    formData.append("file", file)
    startUpload(async () => {
      try {
        const skill = await importSkillFromZip(formData)
        append(skill)
        toast.success(`Skill "${skill.name}" added`)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not read the .zip")
      }
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h3 className="text-sm font-medium text-foreground">Skills</h3>
          <p className="text-xs text-muted-foreground">
            Markdown procedures the agent loads only when they are useful.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip"
            onChange={handleZip}
            className="hidden"
            aria-hidden="true"
            tabIndex={-1}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
            className="gap-1.5"
          >
            {isUploading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Upload className="h-4 w-4" />
            )}
            Upload .zip
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setShOpen(true)}
            className="gap-1.5"
          >
            <Download className="h-4 w-4" />
            Import from skills.sh
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={add}
            className="gap-1.5"
          >
            <Plus className="h-4 w-4" />
            Add skill
          </Button>
        </div>
      </div>

      <SkillsShDialog open={shOpen} onOpenChange={setShOpen} onImport={append} />

      {value.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          title="No skills"
          description="Skills are step-by-step guides (like plan_a_trip.md) that extend what the agent knows how to do."
        />
      ) : (
        <div className="space-y-3">
          {value.map((skill) => (
            <ItemCard key={skill.id} onRemove={() => remove(skill.id)}>
              <div className="grid gap-3 pr-8 sm:grid-cols-2">
                <Field label="Name">
                  <Input
                    value={skill.name}
                    onChange={(e) => update(skill.id, { name: e.target.value })}
                    placeholder="plan_a_trip"
                    className="font-mono"
                  />
                </Field>
                <Field label="Description">
                  <Input
                    value={skill.description}
                    onChange={(e) =>
                      update(skill.id, { description: e.target.value })
                    }
                    placeholder="Plan a complete trip"
                  />
                </Field>
              </div>
              <div className="mt-3">
                <Field label="Content (markdown)">
                  <Textarea
                    value={skill.content}
                    onChange={(e) =>
                      update(skill.id, { content: e.target.value })
                    }
                    placeholder={"## Steps\n1. Ask for the destination\n2. ..."}
                    maxLength={LIMITS.skillContent}
                    className="min-h-32 font-mono text-xs"
                  />
                </Field>
              </div>
            </ItemCard>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------- Tools (assignment of global tools) ----------

function AssignRow({
  selected,
  onToggle,
  title,
  subtitle,
  badge,
}: {
  selected: boolean
  onToggle: () => void
  title: string
  subtitle: string
  badge?: string
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={selected}
      className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors ${
        selected ? "bg-secondary/60" : "hover:bg-secondary/40"
      }`}
    >
      <span
        className={`flex size-4 shrink-0 items-center justify-center rounded border transition-colors ${
          selected
            ? "border-foreground bg-foreground text-background"
            : "border-border"
        }`}
        aria-hidden="true"
      >
        {selected ? <Check className="size-3" /> : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate font-mono text-sm font-medium text-foreground">
            {title}
          </span>
          {badge ? (
            <span className="shrink-0 rounded-md border border-border px-1.5 py-0.5 text-[0.65rem] uppercase tracking-wide text-muted-foreground">
              {badge}
            </span>
          ) : null}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {subtitle}
        </span>
      </span>
    </button>
  )
}

// ---------- Connections (assignment of global MCP connections) ----------

export function ConnectionsAssign({
  available,
  value,
  onChange,
}: {
  available: ClientConnection[]
  value: string[]
  onChange: (next: string[]) => void
}) {
  const toggle = (id: string) =>
    onChange(
      value.includes(id) ? value.filter((x) => x !== id) : [...value, id],
    )

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-sm font-medium text-foreground">MCP Connections</h3>
          <p className="text-xs text-muted-foreground">
            Select the global MCP servers that provide tools to this agent.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          render={<Link href="/mcp" />}
          nativeButton={false}
          className="gap-1.5"
        >
          <ExternalLink className="h-4 w-4" />
          Manage in MCP
        </Button>
      </div>

      {available.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-12 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-secondary">
            <Plug className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">
              No MCP connections yet
            </p>
            <p className="max-w-sm text-xs text-muted-foreground">
              Create reusable MCP connections to assign them to this agent.
            </p>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            render={<Link href="/mcp" />}
            nativeButton={false}
            className="gap-1.5"
          >
            <Plus className="h-4 w-4" />
            Create connection
          </Button>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          <ul className="divide-y divide-border">
            {available.map((conn) => (
              <li key={conn.id}>
                <AssignRow
                  selected={value.includes(conn.id)}
                  onToggle={() => toggle(conn.id)}
                  title={conn.name || "untitled"}
                  subtitle={conn.url || "no url"}
                  badge={conn.transport}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// ---------- Subagents ----------

export function SubagentsEditor({
  value,
  onChange,
}: {
  value: AgentSubagent[]
  onChange: (next: AgentSubagent[]) => void
}) {
  const add = () =>
    onChange([
      ...value,
      {
        id: randomUUID(),
        name: "",
        model: DEFAULT_MODEL,
        instructions: "",
      },
    ])
  const update = (id: string, patch: Partial<AgentSubagent>) =>
    onChange(value.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  const remove = (id: string) => onChange(value.filter((s) => s.id !== id))

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Subagents"
        description="Specialist agents to which the root agent can delegate tasks."
        onAdd={add}
        addLabel="Add subagent"
      />
      {value.length === 0 ? (
        <EmptyState
          icon={Bot}
          title="No subagents"
          description="Create specialists (e.g. a 'researcher') for the main agent to delegate work to."
        />
      ) : (
        <div className="space-y-3">
          {value.map((sa) => (
            <ItemCard key={sa.id} onRemove={() => remove(sa.id)}>
              <div className="grid gap-3 pr-8 sm:grid-cols-2">
                <Field label="Name">
                  <Input
                    value={sa.name}
                    onChange={(e) => update(sa.id, { name: e.target.value })}
                    placeholder="researcher"
                    className="font-mono"
                  />
                </Field>
                <Field label="Model">
                  <ModelSelect
                    value={sa.model}
                    onValueChange={(v) => update(sa.id, { model: v })}
                  />
                </Field>
              </div>
              <div className="mt-3">
                <Field label="Instructions">
                  <Textarea
                    value={sa.instructions}
                    onChange={(e) =>
                      update(sa.id, { instructions: e.target.value })
                    }
                    placeholder="You are an expert researcher in..."
                    maxLength={LIMITS.subagentInstructions}
                    className="min-h-24 text-sm"
                  />
                </Field>
              </div>
            </ItemCard>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------- Schedules ----------

export function SchedulesEditor({
  value,
  onChange,
}: {
  value: AgentSchedule[]
  onChange: (next: AgentSchedule[]) => void
}) {
  const add = () =>
    onChange([
      ...value,
      {
        id: randomUUID(),
        name: "",
        cron: DEFAULT_CRON,
        prompt: "",
        enabled: true,
      },
    ])
  const update = (id: string, patch: Partial<AgentSchedule>) =>
    onChange(value.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  const remove = (id: string) => onChange(value.filter((s) => s.id !== id))

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Schedules"
        description="Recurring work the agent runs automatically according to a cron expression."
        onAdd={add}
        addLabel="Add schedule"
      />
      {value.length === 0 ? (
        <EmptyState
          icon={Clock}
          title="No schedules"
          description="Schedule recurring tasks, such as a daily summary at 9 a.m."
        />
      ) : (
        <div className="space-y-3">
          {value.map((sc) => {
            const cronError = validateCron(sc.cron)
            return (
            <ItemCard key={sc.id} onRemove={() => remove(sc.id)}>
              <div className="grid gap-3 pr-8 sm:grid-cols-2">
                <Field label="Nombre">
                  <Input
                    value={sc.name}
                    onChange={(e) => update(sc.id, { name: e.target.value })}
                    placeholder="resumen-diario"
                    className="font-mono"
                  />
                </Field>
                <Field
                  label="Cron"
                  hint="Standard 5-field format."
                  error={cronError}
                >
                  <Input
                    value={sc.cron}
                    onChange={(e) => update(sc.id, { cron: e.target.value })}
                    placeholder="0 9 * * *"
                    aria-invalid={Boolean(cronError)}
                    className="font-mono"
                  />
                </Field>
              </div>
              <div className="mt-3">
                <Field label="Prompt">
                  <Textarea
                    value={sc.prompt}
                    onChange={(e) => update(sc.id, { prompt: e.target.value })}
                    placeholder="Generate a summary of yesterday's conversations."
                    maxLength={LIMITS.schedulePrompt}
                    className="min-h-20 text-sm"
                  />
                </Field>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <Switch
                  id={`sched-${sc.id}`}
                  checked={sc.enabled}
                  onCheckedChange={(checked) =>
                    update(sc.id, { enabled: checked })
                  }
                />
                <Label
                  htmlFor={`sched-${sc.id}`}
                  className="text-xs text-muted-foreground"
                >
                  {sc.enabled ? "Active" : "Paused"}
                </Label>
              </div>
            </ItemCard>
            )
          })}
        </div>
      )}
    </div>
  )
}
