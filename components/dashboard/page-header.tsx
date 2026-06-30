export function PageHeader({
  title,
  description,
  action,
}: {
  title: React.ReactNode
  description?: string
  action?: React.ReactNode
}) {
  return (
    <div className="mb-8 flex flex-col gap-4 border-b border-border pb-6 sm:flex-row sm:items-end sm:justify-between">
      <div className="max-w-2xl">
        <h1 className="text-2xl font-medium tracking-tight text-foreground text-balance">
          {title}
        </h1>
        {description && (
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground text-pretty">
            {description}
          </p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}
