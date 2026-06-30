import { Skeleton } from "@/components/ui/skeleton"

export default function DashboardLoading() {
  return (
    <div>
      {/* Page header */}
      <div className="mb-8 flex flex-col gap-4 border-b border-border pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-3">
          <Skeleton className="h-8 w-44" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <Skeleton className="h-8 w-32 shrink-0" />
      </div>

      {/* List rows */}
      <div className="overflow-hidden rounded-xl border border-border">
        <div className="divide-y divide-border">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-3.5">
              <Skeleton className="h-9 w-9 shrink-0 rounded-md" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-56 max-w-full" />
              </div>
              <Skeleton className="hidden h-6 w-24 sm:block" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
