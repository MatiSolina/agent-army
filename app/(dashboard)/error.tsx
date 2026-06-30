"use client"

import { useEffect } from "react"
import { Button } from "@/components/ui/button"
import { AlertTriangle, RotateCw } from "lucide-react"

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <div className="flex min-h-[60svh] flex-col items-center justify-center gap-5 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-secondary">
        <AlertTriangle className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
      </div>
      <div className="space-y-1.5">
        <h2 className="text-lg font-medium text-foreground">
          Something went wrong
        </h2>
        <p className="max-w-md text-sm text-muted-foreground">
          We could not load this section. It may be a temporary database
          connection issue. Please try again.
        </p>
        {error.digest && (
          <p className="pt-1 font-mono text-xs text-muted-foreground/60">
            ref: {error.digest}
          </p>
        )}
      </div>
      <Button onClick={reset} variant="secondary" className="gap-2">
        <RotateCw className="h-4 w-4" aria-hidden="true" />
        Try again
      </Button>
    </div>
  )
}
