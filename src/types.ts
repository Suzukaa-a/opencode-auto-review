import type { PermissionEvaluation } from "@opencode/plugin/promise/permission"

export interface PermissionSource {
  type: "tool"
  messageID: string
  id: string
}

/** Keep the SDK contract while accepting decoded session/tool identifiers in archived data. */
export interface PermissionEvent extends Pick<PermissionEvaluation, "action" | "resources" | "metadata" | "effect" | "message"> {
  readonly sessionID: string
  readonly agent?: string
  readonly source?: PermissionSource
}

export interface ReviewRequest {
  checkpoint?: string
  context: ReviewContextEntry[]
  /** Stable host identities aligned with context; detects rollback to identical text. */
  sourceIDs?: string[]
  permission: {
    action: string
    resources: readonly string[]
    metadata?: Record<string, unknown>
  }
}

export type ReviewContextEntry =
  | { type: "user"; text: string }
  | { type: "tool"; name: string; input: unknown }
  | { type: "compaction"; summary: string; recent: string }

export interface ReviewDecision {
  decision: "allow" | "deny" | "ask"
  risk: "low" | "medium" | "high" | "critical" | "unknown"
  authorization: "high" | "medium" | "low" | "unknown"
  reason?: string
  matched_rules: string[]
}

/** Complete reviewer journal, retained in sent order within an epoch. */
export interface ReviewerJournalState {
  checkpoint?: string
  version: 6
  epoch: number
  sourceLength: number
  sourceDigest: string
  body: string[]
}
