"use client"

import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

/**
 * Hardened, double-confirmation delete dialog for an agent. Deleting an agent
 * tears down its Vercel project (the production runtime), which cannot be
 * undone, so we make the operator type the agent's exact name AND the word
 * "delete" before the destructive button enables. Mirrors Vercel's own
 * "Delete Project" modal.
 */
const CONFIRM_WORD = "delete"

export function DeleteAgentDialog({
  open,
  onOpenChange,
  agentName,
  onConfirm,
  loading = false,
  imported = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  agentName: string
  onConfirm: () => void
  loading?: boolean
  /** Imported agents are only UNLINKED; their Vercel project is never deleted. */
  imported?: boolean
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open &&
        (imported ? (
          <RemoveImportedDialogContent
            agentName={agentName}
            onClose={() => onOpenChange(false)}
            onConfirm={onConfirm}
            loading={loading}
          />
        ) : (
          <DeleteAgentDialogContent
            agentName={agentName}
            onClose={() => onOpenChange(false)}
            onConfirm={onConfirm}
            loading={loading}
          />
        ))}
    </Dialog>
  )
}

/**
 * Removing an IMPORTED agent only unlinks it from agent-army; its Vercel
 * deployment keeps running and is the operator's to delete. Low-friction
 * single-confirm (re-importable anytime), NOT the hardened type-to-confirm
 * teardown used for agent-army-owned agents.
 */
function RemoveImportedDialogContent({
  agentName,
  onClose,
  onConfirm,
  loading,
}: {
  agentName: string
  onClose: () => void
  onConfirm: () => void
  loading: boolean
}) {
  return (
    <DialogContent showCloseButton={false} className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Remove imported agent</DialogTitle>
        <DialogDescription>
          This removes{" "}
          <span className="font-medium text-foreground">{agentName}</span> from
          agent-army only.{" "}
          <span className="font-medium text-foreground">
            Its Vercel deployment is NOT deleted
          </span>{" "}
          and keeps running — to delete it for good, remove the project in Vercel
          yourself. You can re-import it here anytime.
        </DialogDescription>
      </DialogHeader>

      <DialogFooter className="mt-1">
        <Button type="button" variant="outline" onClick={onClose} disabled={loading}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="destructive"
          onClick={onConfirm}
          disabled={loading}
        >
          {loading ? "Removing…" : "Remove from agent-army"}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}

function DeleteAgentDialogContent({
  agentName,
  onClose,
  onConfirm,
  loading,
}: {
  agentName: string
  onClose: () => void
  onConfirm: () => void
  loading: boolean
}) {
  const [nameInput, setNameInput] = useState("")
  const [wordInput, setWordInput] = useState("")

  const nameMatches = nameInput === agentName
  const wordMatches = wordInput.trim().toLowerCase() === CONFIRM_WORD
  const canDelete = nameMatches && wordMatches && !loading

  return (
    <DialogContent showCloseButton={false} className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Delete agent</DialogTitle>
        <DialogDescription>
          This permanently deletes{" "}
          <span className="font-medium text-foreground">{agentName}</span> and
          its deployed Vercel project — the production runtime, its deployments,
          domains and environment variables.{" "}
          <span className="font-medium text-foreground">
            This cannot be undone.
          </span>
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        <div className="space-y-1.5">
          <p className="text-xs font-normal text-muted-foreground">
            To confirm, type{" "}
            <span className="select-text font-medium text-foreground">
              {agentName}
            </span>
          </p>
          <Input
            id="delete-agent-name"
            autoComplete="off"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            disabled={loading}
          />
        </div>
        <div className="space-y-1.5">
          <p className="text-xs font-normal text-muted-foreground">
            To confirm, type{" "}
            <span className="select-text font-medium text-foreground">
              {CONFIRM_WORD}
            </span>
          </p>
          <Input
            id="delete-agent-word"
            autoComplete="off"
            value={wordInput}
            onChange={(e) => setWordInput(e.target.value)}
            disabled={loading}
          />
        </div>
      </div>

      <DialogFooter className="mt-1">
        <Button
          type="button"
          variant="outline"
          onClick={onClose}
          disabled={loading}
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="destructive"
          onClick={onConfirm}
          disabled={!canDelete}
        >
          {loading ? "Deleting…" : "Delete agent"}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
