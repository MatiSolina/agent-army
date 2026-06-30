"use client"

import { useEffect, useState } from "react"
import { Search, ChevronDown } from "lucide-react"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  SUGGESTED_MODELS,
  getModelLabel,
  filterModels,
  type Model,
} from "@/lib/models"
import { getGatewayModels, hasGatewayCredits } from "@/app/actions/models"

function ModelOption({ m }: { m: Model }) {
  return (
    <SelectItem value={m.id}>
      {m.label} <span className="text-muted-foreground">· {m.provider}</span>
    </SelectItem>
  )
}

/**
 * Model picker shared by the create dialog and the agent editor. Shows the
 * curated `SUGGESTED_MODELS` instantly, then appends every other AI Gateway
 * model once `getGatewayModels()` resolves (degrades to suggested-only on error).
 */
export function ModelSelect({
  value,
  onValueChange,
  id,
  ariaLabelledby,
}: {
  value: string
  onValueChange: (value: string) => void
  id?: string
  ariaLabelledby?: string
}) {
  const [all, setAll] = useState<Model[]>([])
  // Whether the team has paid AI credits. Only used to decide if the long
  // "All models" list starts collapsed (free tier) or expanded. null = still
  // probing → don't collapse yet.
  const [hasCredits, setHasCredits] = useState<boolean | null>(null)

  useEffect(() => {
    let active = true
    getGatewayModels().then((m) => {
      if (active) setAll(m)
    })
    hasGatewayCredits().then((c) => {
      if (active) setHasCredits(c)
    })
    return () => {
      active = false
    }
  }, [])

  const [query, setQuery] = useState("")
  const [showAllModels, setShowAllModels] = useState(false)

  const suggestedIds = new Set(SUGGESTED_MODELS.map((m) => m.id))
  const rest = all.filter((m) => !suggestedIds.has(m.id))
  const shownSuggested = filterModels(SUGGESTED_MODELS, query)
  const shownRest = filterModels(rest, query)

  // base-ui resolves the trigger label from `items`, so every selectable value
  // must appear here — including a gateway model that is the current value but
  // hasn't loaded yet.
  const items = [...SUGGESTED_MODELS, ...rest].map((m) => ({
    value: m.id,
    label: `${m.label} · ${m.provider}`,
  }))
  if (!items.some((i) => i.value === value)) {
    items.push({ value, label: getModelLabel(value) })
  }

  return (
    <Select
      items={items}
      value={value}
      onValueChange={(v) => onValueChange(v ?? value)}
      onOpenChange={(open) => {
        if (!open) setQuery("")
      }}
    >
      <SelectTrigger id={id} aria-labelledby={ariaLabelledby} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {rest.length > 0 && (
          <div className="sticky top-0 z-10 bg-popover p-1">
            <div className="flex items-center gap-2 rounded-md border border-border px-2 focus-within:border-ring">
              <Search className="size-3.5 shrink-0 text-muted-foreground" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                // Stop base-ui's typeahead from stealing keystrokes.
                onKeyDown={(e) => e.stopPropagation()}
                placeholder="Search models…"
                // The global `*:focus-visible` box-shadow ring (globals.css) looks
                // like a stray box on this borderless input — suppress it; the
                // wrapper's focus-within border is the focus cue instead.
                className="h-7 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground focus-visible:shadow-none"
              />
            </div>
          </div>
        )}
        {shownSuggested.length > 0 && (
          <SelectGroup>
            <SelectLabel>Suggested</SelectLabel>
            {shownSuggested.map((m) => (
              <ModelOption key={m.id} m={m} />
            ))}
          </SelectGroup>
        )}
        {shownRest.length > 0 && (
          <>
            {shownSuggested.length > 0 && <SelectSeparator />}
            {/* On the free tier the full list is mostly credit-only noise, so
                collapse it behind a toggle (always expanded while searching). */}
            {hasCredits === false && !query && !showAllModels ? (
              <button
                type="button"
                onClick={() => setShowAllModels(true)}
                onKeyDown={(e) => e.stopPropagation()}
                className="flex w-full items-center justify-between px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                <span>All models ({rest.length})</span>
                <ChevronDown className="size-3.5" />
              </button>
            ) : (
              <SelectGroup>
                <SelectLabel>All models</SelectLabel>
                {shownRest.map((m) => (
                  <ModelOption key={m.id} m={m} />
                ))}
              </SelectGroup>
            )}
          </>
        )}
        {query && shownSuggested.length === 0 && shownRest.length === 0 && (
          <p className="px-3 py-3 text-center text-xs text-muted-foreground">
            No models match “{query}”.
          </p>
        )}
      </SelectContent>
    </Select>
  )
}
