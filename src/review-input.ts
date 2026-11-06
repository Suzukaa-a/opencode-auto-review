import type { PermissionEvent, ReviewContextEntry, ReviewRequest } from "./types.js"

interface MessageInfo {
  id?: string
  type?: string
  content?: readonly unknown[]
  [key: string]: unknown
}

/**
 * Build the review request from the transcript.
 *
 * The request is projected by `reviewWindow`: every user message the plugin
 * captured, a bounded tail of recent prior actions, and tool history after the
 * latest compaction boundary. That keeps authorization and replay-visibility
 * without carrying a tool backlog the coding model has already shed. Evidence is
 * separate and stays lazily addressable over the whole captured transcript, so
 * the reviewer can still recover an original result by ID without that backlog
 * entering the prompt.
 */
export function buildReviewRequest(
  messages: readonly unknown[],
  event: PermissionEvent,
): ReviewRequest | undefined {
  const window = reviewWindow(messages, event)
  if (!window) return
  if (!event.source || event.source.type !== "tool") return

  const sourceIndexes = window.flatMap((message, index) =>
    isRecord(message) && message.type === "assistant" && message.id === event.source!.messageID ? [index] : [],
  )
  if (sourceIndexes.length !== 1) return
  const sourceIndex = sourceIndexes[0]!

  const source = window[sourceIndex] as MessageInfo
  const tool = findToolPart(source.content, event.source.id)
  if (!tool) return
  const currentTool = tool

  const history: ReviewContextEntry[] = []
  const sourceIDs: string[] = []
  let hasUser = false
  let checkpoint: string | undefined
  for (let index = 0; index <= sourceIndex; index++) {
    const message = window[index]
    if (!isRecord(message)) continue
    if (message.type === "compaction" && message.status === "completed" &&
      typeof message.summary === "string" && typeof message.recent === "string") {
      history.push({ type: "compaction", summary: message.summary, recent: message.recent })
      sourceIDs.push(JSON.stringify([message.id, "compaction"]))
      // Only an anchor the reviewer can actually see: a compaction whose summary
      // line was not included must not key the journal epoch.
      if (typeof message.id === "string") checkpoint = message.id
      continue
    }
    if (message.type === "user" && typeof message.text === "string" && message.text.trim()) {
      hasUser = true
      history.push({ type: "user", text: message.text })
      sourceIDs.push(JSON.stringify([message.id, "user"]))
      continue
    }
    if (message.type !== "assistant" || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      // Completed siblings consumed authorization even within the current model turn.
      if (index === sourceIndex && (!isRecord(part) || part.id === event.source.id ||
        !isRecord(part.state) || !["completed", "error"].includes(part.state.status as string))) continue
      const historicalTool = readCompleteToolPart(part)
      if (historicalTool) {
        history.push({ type: "tool", ...historicalTool })
        sourceIDs.push(JSON.stringify([message.id, isRecord(part) ? part.id : undefined]))
      }
    }
  }
  // A permission decision must rest on at least one user instruction. A summary
  // is context, not authorization, so a window without a user cannot approve.
  if (!hasUser) return

  return {
    ...(checkpoint ? { checkpoint } : {}),
    sourceIDs: [...sourceIDs, JSON.stringify([event.source.messageID, event.source.id])],
    context: structuredClone([...history, { type: "tool" as const, name: currentTool.name, input: currentTool.input }]),
    permission: {
      action: event.action,
      resources: [...event.resources],
      ...(event.metadata ? { metadata: structuredClone(event.metadata) } : {}),
    },
  }

}

const PRE_BOUNDARY_TOOL_REFS = 16

/**
 * Project the transcript into the window the review prompt is built from.
 *
 * The coding model sheds its history at a compaction, and the reviewer must not
 * carry the tool backlog the coding model has already shed — a growing verbatim
 * tool history is what pushed the prompt toward the model ceiling and forced a
 * journal rebuild on nearly every review. But two things before the boundary are
 * not backlog:
 *
 * - **User instructions** are the authorization, and dropping them would both
 *   lose real authorization and remove the guarantee that an approval rests on a
 *   disclosed user instruction. Both reference designs keep user intent across
 *   compaction (Codex retains user instructions separately; Claude Code's
 *   classifier reads user messages and strips tool results).
 * - **A bounded tail of prior actions.** Without it, a once-scoped authorization
 *   ("run the deployment once") is invisible after it has been consumed, and the
 *   reviewer cannot tell a first use from a replay. A handful of recent action
 *   references is not a backlog.
 *
 * Tool results are never carried here in any case: evidence holds them, lazily,
 * over the whole captured transcript.
 *
 * Returns `undefined` when the source request cannot be identified.
 */
export function reviewWindow(messages: readonly unknown[], event: PermissionEvent): readonly unknown[] | undefined {
  if (!event.source || event.source.type !== "tool") return
  const sourceIndexes = messages.flatMap((message, index) =>
    isRecord(message) && message.type === "assistant" && message.id === event.source!.messageID ? [index] : [],
  )
  if (sourceIndexes.length !== 1) return
  const compactionIndex = findLatestCompaction(messages, sourceIndexes[0]!)
  if (compactionIndex === undefined) return messages.slice()
  const compaction = messages[compactionIndex]
  // Only a completed checkpoint is a stable boundary. A running one (which the
  // archive already filters out of the view it hands over) keeps the wider
  // window, which is the safe direction.
  if (!isRecord(compaction) || compaction.status !== "completed") return messages.slice()

  const before = messages.slice(0, compactionIndex)
  const actions = before.filter((message) => isRecord(message) && message.type === "assistant" &&
    Array.isArray(message.content) && message.content.some((part) => isRecord(part) && part.type === "tool"))
  const recentActions = new Set(actions.slice(-PRE_BOUNDARY_TOOL_REFS))
  const retained = before.filter((message) => isRecord(message) &&
    ((message.type === "user" && typeof message.text === "string" && message.text.trim()) || recentActions.has(message)))
  return [...retained, ...messages.slice(compactionIndex)]
}

function findLatestCompaction(messages: readonly unknown[], sourceIndex: number): number | undefined {
  for (let index = sourceIndex - 1; index >= 0; index--) {
    const message = messages[index]
    if (isRecord(message) && message.type === "compaction" && ["running", "completed"].includes(message.status as string)) {
      return index
    }
  }
}

function findToolPart(parts: readonly unknown[] | undefined, id: string): { name: string; input: unknown } | undefined {
  if (!parts) return
  const matches = parts.filter((part) => isRecord(part) && part.id === id && part.type === "tool")
  if (matches.length !== 1) return
  return readCompleteToolPart(matches[0])
}

function readCompleteToolPart(value: unknown): { name: string; input: unknown } | undefined {
  if (!isRecord(value) || value.type !== "tool" || typeof value.name !== "string" || !value.name) return
  if (!isRecord(value.state) || !["running", "completed", "error"].includes(value.state.status as string)) return
  if (!isJsonObject(value.state.input)) return
  return { name: value.name, input: value.state.input }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
    Object.values(value).every(isJsonValue)
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0)
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isJsonObject(value)
}
