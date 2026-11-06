import type { PermissionEvent } from "./types.js"

export type EvidenceRequest =
  | { type: "history"; offset: number }
  | { type: "tool_result"; messageID: string; toolID: string; offset: number }

/** Immutable, session-local evidence. Never executes a tool under review. */
export function captureEvidence(messages: readonly unknown[], event: PermissionEvent, archive?: {
  result: (messageID: string, toolID: string) => Promise<string | undefined>
}) {
  const end = messages.findIndex((message) => record(message) && message.id === event.source?.messageID)
  const history: unknown[] = []
  const results = new Map<string, string>()
  const tools: { messageID: string; toolID: string; name: string }[] = []
  for (const message of messages.slice(0, Math.max(0, end + 1))) {
    if (!record(message)) continue
    if (message.type === "user" && typeof message.text === "string" && message.text.trim()) {
      history.push({ type: "user", text: message.text })
    }
    if (message.type !== "assistant" || typeof message.id !== "string" || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (!record(part) || part.type !== "tool" || typeof part.id !== "string" || typeof part.name !== "string" || !record(part.state)) continue
      if (message.id === event.source?.messageID && (part.id === event.source.id ||
        !["completed", "error"].includes(part.state.status as string))) continue
      const ref = { messageID: message.id, toolID: part.id, name: part.name }
      history.push({ type: "tool", ...ref, input: part.state.input })
      if (part.state.status !== "completed" && part.state.status !== "error") continue
      tools.push(ref)
      results.set(JSON.stringify([message.id, part.id]), JSON.stringify({
        status: part.state.status,
        content: Array.isArray(part.state.content) ? part.state.content.filter((item) => record(item) && item.type === "text") : [],
        error: part.state.error,
      }))
    }
  }
  // Serialize now: mutable runtime messages must not change an in-flight review.
  const entries = history.map((entry) => JSON.stringify(entry))
  return {
    authorization: history.flatMap((entry, offset) => record(entry) && entry.type === "user" && typeof entry.text === "string"
      ? [{ offset, text: entry.text }] : []),
    index: { type: "evidence_index", historyEntries: entries.length, tools: tools.slice(-64), omittedTools: Math.max(0, tools.length - 64) },
    read(request: EvidenceRequest): unknown {
      if (request.type === "history") {
        const page = entries.slice(request.offset, request.offset + 8).map((entry) => JSON.parse(entry))
        return { entries: page, next: request.offset + page.length < entries.length ? request.offset + page.length : null }
      }
      // The index is the captured boundary: an archive lookup cannot expose future calls.
      if (!results.has(JSON.stringify([request.messageID, request.toolID]))) return { error: "No completed result in the captured parent history" }
      const page = (result: string | undefined) => result === undefined ? { error: "Original tool result is unavailable" } : {
        text: result.slice(request.offset, request.offset + 4000),
        next: request.offset + 4000 < result.length ? request.offset + 4000 : null,
      }
      return archive ? archive.result(request.messageID, request.toolID).then(page)
        : page(results.get(JSON.stringify([request.messageID, request.toolID])))
    },
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
