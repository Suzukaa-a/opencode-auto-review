import assert from "node:assert/strict"
import test from "node:test"
import { createReviewerTransport } from "../src/reviewer-transport.js"
import { buildReviewPrompt, buildReviewSystemPrompt } from "../src/policy.js"

function harness() {
  const hooks = new Set<(event: any) => void>()
  const records = new Map<string, any>()
  const entries = new Map<string, any>()
  const storage: any = { get: async (key: string) => entries.get(key), set: async (key: string, value: any) => { entries.set(key, value) } }
  const created: any[] = []
  const requests: any[] = []
  const removed: string[] = []
  const updates: any[] = []
  let run = async () => ({ text: "verdict" })
  let beforeHook: () => Promise<void> = async () => undefined
  const scope = `/test/${Math.random()}`
  const session: any = {
    hook: async (_name: string, callback: any) => { hooks.add(callback); return { dispose: async () => { hooks.delete(callback) } } },
    create: async (input: any) => { created.push(input); const info = { ...input, id: "reviewer-" + created.length }; records.set(info.id, info); return info },
    get: async ({ sessionID }: any) => {
      if (!records.has(sessionID)) throw Object.assign(new Error("missing"), { _tag: "SessionNotFoundError" })
      return records.get(sessionID)
    },
    update: async (input: any) => { updates.push(input) },
    remove: async ({ sessionID }: any) => { removed.push(sessionID) },
    generate: async ({ sessionID }: any) => {
      const event = { sessionID, model: created[Number(sessionID.split("-")[1]) - 1].model, system: [{ text: "project instructions" }], messages: [{ role: "assistant", content: [] }], tools: { shell: {} }, options: {} }
      await beforeHook()
      for (const hook of hooks) hook(event)
      requests.push(structuredClone(event))
      return run()
    },
  }
  return { session, storage, scope, records, created, requests, removed, updates, setBeforeHook: (value: typeof beforeHook) => { beforeHook = value }, setRun: (value: typeof run) => { run = value } }
}

test("system policy stays first and identical while evidence changes after a rebuild", async () => {
  const h = harness()
  const system = buildReviewSystemPrompt()
  const transport = await createReviewerTransport(h.session, system, h.storage, h.scope)
  const signal = new AbortController().signal
  const model = { providerID: "test", id: "reviewer" }
  const first = [JSON.stringify({ type: "review_epoch", epoch: 0 }), JSON.stringify({ type: "user", text: "first" })]
  const rebuilt = [JSON.stringify({ type: "review_epoch", epoch: 1 }), JSON.stringify({ type: "compaction", summary: "rebuilt" })]
  await transport.generate("main", model, buildReviewPrompt(first), signal)
  await transport.generate("main", model, buildReviewPrompt(rebuilt), signal)
  assert.equal(h.created.length, 1)
  assert.match(h.created[0].title, /^\[Auto-review\]/)
  assert.equal(h.created[0].parentID, undefined, "a child would inherit its parent's cache affinity")
  assert.deepEqual(h.created[0].permissions, [{ action: "*", resource: "*", effect: "deny" }])
  for (const request of h.requests) {
    assert.deepEqual(request.system, [{ type: "text", text: system }])
    assert.deepEqual(request.tools, {})
    assert.equal(request.messages.length, 1)
    assert.equal(request.messages[0].role, "user")
  }
  assert.equal(h.requests[0].messages[0].content[0].text, first.join("\n"))
  assert.equal(h.requests[1].messages[0].content[0].text, rebuilt.join("\n"))
  assert.equal(h.requests[0].sessionID, h.requests[1].sessionID)
  await transport.dispose()
  assert.deepEqual(h.removed, [], "the archived reviewer remains available for resume")
})

test("resume reuses the same archived reviewer session and replaces missing or mismatched ones", async () => {
  const h = harness()
  const system = buildReviewSystemPrompt()
  const model = { providerID: "test", id: "reviewer" }
  const signal = new AbortController().signal
  const first = await createReviewerTransport(h.session, system, h.storage, h.scope)
  await first.generate("main", model, buildReviewPrompt([]), signal)
  h.records.get("reviewer-1").time = { archived: 123 }
  await first.dispose()
  const resumed = await createReviewerTransport(h.session, system, h.storage, h.scope)
  await resumed.generate("main", model, buildReviewPrompt([]), signal)
  assert.equal(h.created.length, 1)
  assert.equal(h.requests.at(-1).sessionID, "reviewer-1")
  await resumed.dispose()
  h.records.delete("reviewer-1")
  const missing = await createReviewerTransport(h.session, system, h.storage, h.scope)
  await missing.generate("main", model, buildReviewPrompt([]), signal)
  assert.equal(h.created.length, 2)
  await missing.dispose()
  h.records.get("reviewer-2").metadata["auto-review-main"] = "another-main"
  const mismatched = await createReviewerTransport(h.session, system, h.storage, h.scope)
  await mismatched.generate("main", model, buildReviewPrompt([]), signal)
  assert.equal(h.created.length, 3)
  await mismatched.dispose()
})

test("resume shares reviewer creation while its persistent mapping write is pending", async () => {
  const h = harness()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let firstSet = true
  const storage = { ...h.storage, set: async (key: string, value: any) => {
    if (firstSet) { firstSet = false; await gate }
    await h.storage.set(key, value)
  } }
  const system = buildReviewSystemPrompt()
  const model = { providerID: "test", id: "reviewer" }
  const first = await createReviewerTransport(h.session, system, storage, h.scope)
  const controller = new AbortController()
  const old = first.generate("main", model, buildReviewPrompt([]), controller.signal)
  await new Promise(done => setImmediate(done))
  controller.abort()
  await assert.rejects(old)
  await first.dispose()
  const resumed = await createReviewerTransport(h.session, system, { ...storage }, h.scope)
  const pending = resumed.generate("main", model, buildReviewPrompt([]), new AbortController().signal)
  await new Promise(done => setImmediate(done))
  assert.equal(h.created.length, 1)
  release()
  assert.equal(await pending, "verdict")
  assert.equal(h.requests.at(-1).sessionID, "reviewer-1")
  await resumed.dispose()
})

test("resume waits for the previous instance request to settle before reusing its reviewer", async () => {
  const h = harness()
  let finish!: (value: { text: string }) => void
  h.setRun(() => new Promise(resolve => { finish = resolve }))
  const system = buildReviewSystemPrompt()
  const model = { providerID: "test", id: "reviewer" }
  const signal = new AbortController().signal
  const first = await createReviewerTransport(h.session, system, h.storage, h.scope)
  const pending = first.generate("main", model, buildReviewPrompt([]), signal)
  await new Promise(done => setImmediate(done))
  await first.dispose()
  const resumed = await createReviewerTransport(h.session, system, h.storage, h.scope)
  await assert.rejects(resumed.generate("main", model, buildReviewPrompt([]), signal), /still running/)
  finish({ text: "old" })
  await pending
  await new Promise(done => setImmediate(done))
  h.setRun(async () => ({ text: "resumed" }))
  assert.equal(await resumed.generate("main", model, buildReviewPrompt([]), signal), "resumed")
  assert.equal(h.created.length, 1)
  await resumed.dispose()
})

test("unload blocks a host request that has not reached the isolation hook", async () => {
  const h = harness()
  let release!: () => void
  h.setBeforeHook(() => new Promise<void>(resolve => { release = resolve }))
  const transport = await createReviewerTransport(h.session, buildReviewSystemPrompt(), h.storage, h.scope)
  const pending = transport.generate("main", { providerID: "test", id: "reviewer" }, buildReviewPrompt([]), new AbortController().signal)
  await new Promise(done => setImmediate(done))
  await transport.dispose()
  release()
  await assert.rejects(pending, /disposed/)
  assert.equal(h.requests.length, 0, "no request with inherited project instructions may be sent")
  await assert.rejects(transport.generate("main", { providerID: "test", id: "reviewer" }, buildReviewPrompt([]), new AbortController().signal), /disposed/)
})

test("cancelled generation cannot have its pending evidence replaced before the host settles", async () => {
  const h = harness()
  let finish!: (value: { text: string }) => void
  h.setRun(() => new Promise(resolve => { finish = resolve }))
  const transport = await createReviewerTransport(h.session, buildReviewSystemPrompt(), h.storage, h.scope)
  const controller = new AbortController()
  const model = { providerID: "test", id: "reviewer" }
  const pending = transport.generate("main", model, buildReviewPrompt([]), controller.signal)
  await new Promise(done => setImmediate(done))
  controller.abort()
  await assert.rejects(pending)
  await assert.rejects(transport.generate("main", model, buildReviewPrompt([]), new AbortController().signal), /still running/)
  finish({ text: "late" })
  await new Promise(done => setImmediate(done))
  h.setRun(async () => ({ text: "fresh" }))
  assert.equal(await transport.generate("main", model, buildReviewPrompt([]), new AbortController().signal), "fresh")
  await transport.dispose()
})
