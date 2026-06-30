"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { authClient } from "@/lib/auth-client"
import {
  Bot,
  Radio,
  Plug,
  Activity,
  BookOpen,
  Menu,
  X,
  LogOut,
} from "lucide-react"

const nav = [
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/channels", label: "Channels", icon: Radio },
  { href: "/mcp", label: "MCP", icon: Plug },
  { href: "/observability", label: "Observability", icon: Activity },
  { href: "/how-it-works", label: "How it works", icon: BookOpen },
]

function Brand({ collapsible = false }: { collapsible?: boolean }) {
  return (
    <Link
      href="/agents"
      aria-label="Agent Army"
      className="flex items-center gap-3 pl-[15px] pr-3"
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-md border border-border bg-secondary font-mono text-[0.8rem] font-semibold tracking-tight text-foreground">
        AA
      </span>
      <span
        className={cn(
          "whitespace-nowrap font-mono text-sm font-medium tracking-tight text-foreground",
          // On the collapsed rail, hide the wordmark until hover-expand.
          collapsible &&
            "opacity-0 transition-opacity duration-200 group-hover/sidebar:opacity-100",
        )}
      >
        Agent Army
      </span>
    </Link>
  )
}

function NavLinks({
  onNavigate,
  collapsible = false,
}: {
  onNavigate?: () => void
  collapsible?: boolean
}) {
  const pathname = usePathname()
  return (
    <nav className="flex flex-col gap-1">
      {nav.map((item) => {
        const active =
          pathname === item.href || pathname.startsWith(item.href + "/")
        const Icon = item.icon
        return (
          <Link
            key={item.href}
            href={item.href}
            prefetch
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            title={collapsible ? item.label : undefined}
            className="group/row flex items-center gap-3 pl-[15px] pr-3 text-sm"
          >
            {/* Fixed-size icon box: keeps icons centered in the rail and gives
                the active/hover highlight a consistent square shape. */}
            <span
              className={cn(
                "grid size-10 shrink-0 place-items-center rounded-md transition-colors",
                active
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground group-hover/row:bg-secondary/60 group-hover/row:text-foreground",
              )}
            >
              <Icon className="size-[18px]" aria-hidden="true" />
            </span>
            <span
              className={cn(
                "whitespace-nowrap transition-colors",
                active
                  ? "text-foreground"
                  : "text-muted-foreground group-hover/row:text-foreground",
                // Hide label on the collapsed rail; reveal on hover-expand.
                collapsible &&
                  "opacity-0 transition-opacity duration-200 group-hover/sidebar:opacity-100",
              )}
            >
              {item.label}
            </span>
          </Link>
        )
      })}
    </nav>
  )
}

function SidebarContent({
  onNavigate,
  collapsible = false,
  userName,
  userEmail,
}: {
  onNavigate?: () => void
  collapsible?: boolean
  userName?: string
  userEmail?: string
}) {
  const router = useRouter()
  const initial = (userName || userEmail || "?").trim().charAt(0).toUpperCase()

  const signOut = async () => {
    await authClient.signOut()
    router.push("/sign-in")
    router.refresh()
  }

  return (
    <div className="flex h-full flex-col gap-6 py-4">
      <Brand collapsible={collapsible} />
      <div>
        <p
          className={cn(
            "mb-1.5 pl-[19px] text-[0.7rem] font-medium uppercase tracking-[0.12em] text-muted-foreground",
            collapsible &&
              "opacity-0 transition-opacity duration-200 group-hover/sidebar:opacity-100",
          )}
        >
          Dashboard
        </p>
        <NavLinks onNavigate={onNavigate} collapsible={collapsible} />
      </div>
      {/* Signed-in user + sign out. Avatar always visible on the rail; name +
          sign-out reveal on hover-expand. */}
      <div className="mt-auto flex items-center gap-3 pl-[15px] pr-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-md border border-border bg-secondary text-sm font-medium text-foreground">
          {initial}
        </span>
        <div
          className={cn(
            "min-w-0 flex-1",
            collapsible &&
              "opacity-0 transition-opacity duration-200 group-hover/sidebar:opacity-100",
          )}
        >
          {userName ? (
            <p className="truncate text-sm font-medium text-foreground">
              {userName}
            </p>
          ) : null}
          {userEmail ? (
            <p className="truncate text-xs text-muted-foreground">{userEmail}</p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={signOut}
          aria-label="Sign out"
          title="Sign out"
          className={cn(
            "shrink-0 text-muted-foreground transition-colors hover:text-foreground",
            collapsible &&
              "opacity-0 transition-opacity duration-200 group-hover/sidebar:opacity-100",
          )}
        >
          <LogOut className="size-4" />
        </button>
      </div>
    </div>
  )
}

export function Sidebar({
  userName,
  userEmail,
}: {
  userName?: string
  userEmail?: string
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const drawerRef = useRef<HTMLElement>(null)

  // Close on Escape and return focus to the trigger.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        setOpen(false)
      }
    }
    document.addEventListener("keydown", onKey)
    // Move focus into the drawer for keyboard users.
    drawerRef.current?.focus()
    return () => document.removeEventListener("keydown", onKey)
  }, [open])

  const close = () => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  return (
    <>
      {/* Mobile top bar */}
      <div className="fixed inset-x-0 top-0 z-30 flex items-center justify-between border-b border-border bg-background/80 px-4 py-3 backdrop-blur-md md:hidden">
        <Brand />
        <Button
          ref={triggerRef}
          variant="ghost"
          size="icon"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          aria-controls="mobile-sidebar"
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </Button>
      </div>

      {/* Mobile drawer (always mounted for smooth transitions) */}
      <div
        className={cn(
          "fixed inset-0 z-40 md:hidden",
          open ? "pointer-events-auto" : "pointer-events-none",
        )}
        aria-hidden={!open}
      >
        <div
          className={cn(
            "absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity duration-200",
            open ? "opacity-100" : "opacity-0",
          )}
          onClick={close}
          aria-hidden="true"
        />
        <aside
          id="mobile-sidebar"
          ref={drawerRef}
          tabIndex={-1}
          aria-label="Navigation"
          className={cn(
            // h-dvh (not h-full): the drawer is absolute inside a fixed parent
            // whose %-height doesn't reliably resolve on iOS, leaving the rail
            // short and the user block floating mid-screen. dvh pins it to the
            // live viewport so mt-auto pushes the footer to the real bottom.
            "absolute left-0 top-0 h-dvh w-64 border-r border-border bg-background outline-none transition-transform duration-200 ease-out",
            open ? "translate-x-0" : "-translate-x-full",
          )}
        >
          <SidebarContent
            onNavigate={close}
            userName={userName}
            userEmail={userEmail}
          />
        </aside>
      </div>

      {/* Desktop sidebar: collapsed icon rail (~70px) that expands on hover (~240px). */}
      <aside
        className="group/sidebar fixed inset-y-0 left-0 z-30 hidden w-[70px] overflow-hidden border-r border-border bg-sidebar transition-[width] duration-200 ease-out hover:w-60 md:block"
        aria-label="Navigation"
      >
        <SidebarContent
          collapsible
          userName={userName}
          userEmail={userEmail}
        />
      </aside>
    </>
  )
}
