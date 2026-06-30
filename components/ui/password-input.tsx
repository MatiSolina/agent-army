"use client"

import * as React from "react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { Eye, EyeOff } from "lucide-react"

/**
 * Password field with a show/hide toggle. Used for secret credentials
 * (Kapso API key, webhook secret, MCP tokens) so users can verify what
 * they typed without exposing it permanently.
 */
function PasswordInput({
  className,
  ...props
}: React.ComponentProps<typeof Input>) {
  const [visible, setVisible] = React.useState(false)
  return (
    <div className="relative">
      <Input
        type={visible ? "text" : "password"}
        className={cn("pr-9", className)}
        {...props}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={() => setVisible((v) => !v)}
        className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        aria-label={visible ? "Ocultar" : "Mostrar"}
        aria-pressed={visible}
        tabIndex={-1}
      >
        {visible ? (
          <EyeOff className="h-3.5 w-3.5" />
        ) : (
          <Eye className="h-3.5 w-3.5" />
        )}
      </Button>
    </div>
  )
}

export { PasswordInput }
