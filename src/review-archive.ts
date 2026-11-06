import type { Plugin } from "@opencode/plugin"
import { KeyedQueue } from "./keyed-queue.js"

interface Message {
  id: string
  type: "user" | "assistant"
  text?: string
  content?: Tool[]
}

interface Tool {
  type: "tool"
  id: string
  name: string
  state: { status: string; input: unknown }
}

interface Archive {
  messages: Message[]
  checkpoints: { id: string; length: number }[]
}

// A cancelled storage write can still finish. Share its guard and the load queue
// across archive instances using the same storage so a replacement cannot race it.
const storageStates = new WeakMap<Plugin.Context["storage"], {
  queue: KeyedQueue
  writes: Map<string, Promise<void>>
}>()

/** Original evidence lives in storage; only a bounded selection enters model context. */
export class ReviewArchive {
  readonly #state: { queue: KeyedQueue; writes: Map<string, Promise<void>> }
  // Sessions this instance has loaded at least once. Distinguishes a checkpoint
  // that formed while we were watching from one we are seeing for the first time.
  readonly #observed = new Set<string>()

  constructor(
    readonly storage: Plugin.Context["storage"],
    readonly context: (sessionID: string, signal: AbortSignal) => Promise<readonly unknown[]>,
  ) {
    let state = storageStates.get(storage)
    if (!state) {
      state = { queue: new KeyedQueue(), writes: new Map() }
      storageStates.set(storage, state)
    }
    this.#state = state
  }

  load(sessionID: string, signal: AbortSignal) {
    return this.#state.queue.run(sessionID, signal, async () => {
      // Do not read a stale manifest or issue a newer write while a cancelled
      // write is still running. Fail promptly; a later load can retry when it ends.
      if (this.#state.writes.has(sessionID)) throw new Error("An earlier archive write is still pending")
      const raw = await abortable(this.context(sessionID, signal), signal)
      const key = `history/${sessionID}`
      const previous = await abortable(this.storage.get(key), signal) as unknown as Archive | undefined
      const checkpoint = raw.filter((message) => record(message) && message.type === "compaction" && message.status === "completed").at(-1) as Record<string, unknown> | undefined
      const id = typeof checkpoint?.id === "string" ? checkpoint.id : undefined
      const known = previous?.checkpoints.findIndex((item) => item.id === id) ?? -1
      const length = !id ? 0 : known >= 0 ? previous!.checkpoints[known]!.length : previous?.messages.length ?? 0
      const prefix = previous?.messages.slice(0, length) ?? []
      const messages = new Map(prefix.map((message) => [message.id, message]))

      for (const message of raw) {
        if (!record(message) || typeof message.id !== "string") continue
        if (message.type === "user" && typeof message.text === "string") {
          messages.set(message.id, { id: message.id, type: "user", text: message.text })
        }
        if (message.type !== "assistant" || !Array.isArray(message.content)) continue
        const tools: Tool[] = []
        for (const part of message.content) {
          if (!record(part) || part.type !== "tool" || typeof part.id !== "string" || typeof part.name !== "string" ||
            !record(part.state) || !record(part.state.input) || typeof part.state.status !== "string") continue
          tools.push({ type: "tool", id: part.id, name: part.name, state: { status: part.state.status, input: part.state.input } })
          if (part.state.status === "completed" || part.state.status === "error") {
            await this.write(sessionID, this.resultKey(sessionID, message.id, part.id), JSON.stringify({
              status: part.state.status,
              content: Array.isArray(part.state.content) ? part.state.content.filter(item => record(item) && item.type === "text") : [],
              error: part.state.error,
            }), signal)
          }
        }
        if (tools.length) messages.set(message.id, { id: message.id, type: "assistant", content: tools })
      }

      const archive: Archive = {
        messages: [...messages.values()],
        checkpoints: !id ? [] : known >= 0
          ? previous!.checkpoints.slice(0, known + 1)
          : [...(previous?.checkpoints ?? []), { id, length }],
      }
      await this.write(sessionID, key, JSON.parse(JSON.stringify(archive)), signal)
      // The checkpoint is background only. Never append the accumulated summary chain.
      const view: unknown[] = [...archive.messages]
      if (checkpoint) view.splice(length, 0, checkpoint)
      // Informational, never latching: this boundary was reconstructed rather
      // than observed as it formed, so originals behind it may be partial. It
      // must not change the decision.
      const reconstructed = id !== undefined && known < 0 && !this.#observed.has(sessionID)
      this.#observed.add(sessionID)
      return { messages: view, reconstructed }
    })
  }

  async result(sessionID: string, messageID: string, toolID: string, signal?: AbortSignal): Promise<string | undefined> {
    signal?.throwIfAborted()
    const operation = this.storage.get(this.resultKey(sessionID, messageID, toolID))
    const result = await (signal ? abortable(operation, signal) : operation)
    return typeof result === "string" ? result : undefined
  }

  private async write(sessionID: string, key: string, value: Parameters<Plugin.Context["storage"]["set"]>[1], signal: AbortSignal) {
    signal.throwIfAborted()
    const operation = this.storage.set(key, value)
    this.#state.writes.set(sessionID, operation)
    // Clearing belongs to the actual write, not the cancelled waiter.
    void operation.finally(() => this.#state.writes.delete(sessionID)).catch(() => undefined)
    await abortable(operation, signal)
  }

  private resultKey(sessionID: string, messageID: string, toolID: string) {
    return `result/${sessionID}/${messageID}/${toolID}`
  }
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort!: () => void
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  try {
    return await Promise.race([operation, cancelled])
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
}

function record(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
