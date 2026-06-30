import { Skeleton } from "@/components/ui/skeleton"

// Route-scoped fallback for the agent detail editor. The detail page runs 4
// parallel server queries; without this, navigation showed the parent list
// skeleton (rows) — semantically wrong for a tabbed editor. This mirrors the
// AgentEditor's General tab above-the-fold (bordered, padded cards in a 2-col
// grid) so the swap to real content is seamless and doesn't "jump" padding.
export default function AgentDetailLoading() {
  return (
    <div className="space-y-6">
      {/* Breadcrumb + actions */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Skeleton className="h-4 w-16" />
          <span className="text-muted-foreground/40">/</span>
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-5 w-20 rounded-full" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-24" />
          <Skeleton className="h-9 w-24" />
        </div>
      </div>

      {/* Tab strip (line variant: triggers sit on a baseline border) */}
      <div className="flex gap-6 border-b border-border">
        {Array.from({ length: 7 }).map((_, i) => (
          <Skeleton key={i} className="mb-2 h-5 w-20" />
        ))}
      </div>

      {/* General tab content: bordered, padded cards in a 2-col grid */}
      <div className="mt-6 space-y-6">
        <div className="grid gap-6 lg:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <div
              key={i}
              className="space-y-4 rounded-xl border border-border p-5"
            >
              <Skeleton className="h-5 w-32" />
              <div className="space-y-1.5">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-10 w-full" />
              </div>
              <div className="space-y-1.5">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-24 w-full" />
              </div>
            </div>
          ))}
        </div>

        {/* Full-width card below the grid */}
        <div className="space-y-3 rounded-xl border border-border p-5">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-10 w-full max-w-xs" />
        </div>
      </div>
    </div>
  )
}
