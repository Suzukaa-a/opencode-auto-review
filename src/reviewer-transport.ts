import { createHash } from "node:crypto"
import type { Plugin } from "@opencode/plugin"
import type { SessionGenerate } from "@opencode/plugin/promise/session"
import type { ReviewerModel } from "./model-options.js"

type Pending = { owner: symbol; evidence: string; model: ReviewerModel; prepared: boolean }
// Host calls can outlive a plugin instance. A resumed transport must not claim a
// reviewer ID until the old call settles; only its owning hook may frame it.
const running = new Map<string, Pending>()
const creating = new Map<string, Promise<string>>()

/** Persistent empty sessions provide native system messages and stable cache affinity. */
export async function createReviewerTransport(session: Plugin.Context["session"], system: string, storage: Plugin.Context["storage"], scope: string) {
  const sessions = new Map<string, Promise<string>>()
  const owned = new Set<string>()
  const owner = Symbol("reviewer transport")
  let disposed = false
  let hookDisposed = false
  const releaseHook = async () => {
    if (!disposed || [...running.values()].some(request => request.owner === owner) || hookDisposed) return
    hookDisposed = true
    await hook.dispose()
    owned.clear()
  }
  const hook = await session.hook("generate", (event: SessionGenerate) => {
    const request = running.get(event.sessionID)
    if (request?.owner !== owner) return
    if (disposed) throw new Error("Reviewer transport disposed")
    if (!sameModel(event.model, request.model)) throw new Error("Reviewer session model changed")
    event.system = [{ type: "text", text: system }]
    event.messages = [{ role: "user", content: [{ type: "text", text: request.evidence }] }]
    event.tools = {}
    request.prepared = true
  })

  async function restore(mainID: string, model: ReviewerModel, key: string): Promise<string> {
    const saved = await storage.get(key)
    if (typeof saved === "string") {
      let info: Awaited<ReturnType<typeof session.get>> | undefined
      try { info = await session.get({ sessionID: saved }) }
      catch (error) {
        if (!["NotFoundError", "SessionNotFoundError"].includes((error as { _tag?: string })._tag ?? "")) throw error
      }
      if (info?.metadata?.["opencode-auto-review"] === true && info.metadata["auto-review-main"] === mainID &&
        info.model && sameModel(info.model, model)) {
        owned.add(info.id)
        return info.id
      }
    }
    const info = await session.create({ model, title: "[Auto-review] " + mainID,
      metadata: { "opencode-auto-review": true, "auto-review-main": mainID },
      permissions: [{ action: "*", resource: "*", effect: "deny" }] })
    try { await storage.set(key, info.id) }
    catch (error) { await session.remove({ sessionID: info.id }); throw error }
    owned.add(info.id)
    return info.id
  }

  return {
    async generate(mainID: string, model: ReviewerModel, prompt: string, signal: AbortSignal): Promise<string> {
      if (disposed) throw new Error("Reviewer transport disposed")
      signal.throwIfAborted()
      const prefix = system + "\n"
      if (!prompt.startsWith(prefix)) throw new Error("Reviewer policy does not match the fixed system prompt")
      const key = "reviewer/" + createHash("sha256").update(JSON.stringify([mainID, model.providerID, model.id, model.variant ?? "default"])).digest("hex")
      let creation = sessions.get(key)
      if (!creation) {
        const creationKey = JSON.stringify([scope, key])
        creation = creating.get(creationKey)
        if (!creation) {
          creation = restore(mainID, model, key)
          creating.set(creationKey, creation)
          void creation.finally(() => { if (creating.get(creationKey) === creation) creating.delete(creationKey) }).catch(() => undefined)
        }
        sessions.set(key, creation)
        void creation.catch(() => { if (sessions.get(key) === creation) sessions.delete(key) })
      }
      const id = await abortable(creation, signal)
      if (disposed) throw new Error("Reviewer transport disposed")
      signal.throwIfAborted()
      owned.add(id)
      if (running.has(id)) throw new Error("An earlier reviewer generation is still running")
      const request = { owner, evidence: prompt.slice(prefix.length), model, prepared: false }
      running.set(id, request)
      const operation = session.generate({ sessionID: id, prompt: request.evidence }, { signal })
        .then((result) => {
          if (!request.prepared) throw new Error("Reviewer system-message hook did not run")
          return result.text
        })
      void operation.finally(async () => {
        if (running.get(id) === request) running.delete(id)
        await releaseHook()
      }).catch(() => undefined)
      return abortable(operation, signal)
    },
    async dispose() {
      disposed = true
      // The durable reviewer stays available for main-session resume. Only this
      // instance's hook is released, after its outstanding host request settles.
      await releaseHook()
    },
  }
}

function sameModel(left: { providerID: string; id: string; variant?: string | undefined }, right: ReviewerModel): boolean {
  return left.providerID === right.providerID && left.id === right.id &&
    (left.variant ?? "default") === (right.variant ?? "default")
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let onAbort!: () => void
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
  })
  try { return await Promise.race([operation, cancelled]) }
  finally { signal.removeEventListener("abort", onAbort) }
}
