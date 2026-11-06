import assert from "node:assert/strict"
import test from "node:test"
import { ReviewArchive } from "../src/review-archive.js"
import { captureEvidence } from "../src/evidence.js"
import { buildReviewRequest } from "../src/review-input.js"
import { prepareReviewJournal } from "../src/reviewer-journal.js"
import type { PermissionEvent } from "../src/types.js"
import { estimateTokens } from "../src/context-budget.js"

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function fixture() {
  const values = new Map<string, any>()
  let context: unknown[] = []
  const storage: any = { get: async (key: string) => structuredClone(values.get(key)), set: async (key: string, value: any) => { values.set(key, structuredClone(value)) } }
  return { values, set: (messages: unknown[]) => { context = messages }, create: () => new ReviewArchive(storage, async () => structuredClone(context)) }
}
for (const blocked of ["context", "storage read"] as const) {
  test("cancelling a hung " + blocked + " releases the archive queue", { timeout: 2_000 }, async () => {
    const entered = gate()
    const blockedOperation = gate()
    const values = new Map<string, any>()
    let hang = true
    let messages: unknown[] = [user("old", "Old instruction")]
    const pause = async () => {
      if (!hang) return
      hang = false
      entered.resolve()
      await blockedOperation.promise
    }
    const storage: any = {
      get: async (key: string) => {
        if (blocked === "storage read") await pause()
        return structuredClone(values.get(key))
      },
      set: async (key: string, value: any) => { values.set(key, structuredClone(value)) },
    }
    const archive = new ReviewArchive(storage, async () => {
      const snapshot = structuredClone(messages)
      if (blocked === "context") await pause()
      return snapshot
    })
    const controller = new AbortController()
    const first = archive.load("s", controller.signal)
    const cancelled = assert.rejects(first, { name: "AbortError" })
    await entered.promise
    controller.abort()
    await cancelled
    messages = [user("new", "New restriction")]
    const second = await archive.load("s", signal)
    assert.deepEqual(second.messages, messages)
    blockedOperation.resolve()
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(values.get("history/s").messages, messages, "the late read must not resume the cancelled load and overwrite the new snapshot")
  })
}

for (const blocked of ["history/s", "result/s/original/tool-original"]) {
  test("cancelling a hung write to " + blocked + " preserves storage order", { timeout: 2_000 }, async () => {
    const entered = gate()
    const blockedOperation = gate()
    const persisted = gate()
    const values = new Map<string, any>()
    let hang = true
    let messages: unknown[] = [user("root", "Inspect only"), tool("original", "old evidence")]
    const storage: any = {
      get: async (key: string) => structuredClone(values.get(key)),
      set: async (key: string, value: any) => {
        const delayed = key === blocked && hang
        if (delayed) {
          hang = false
          entered.resolve()
          await blockedOperation.promise
        }
        values.set(key, structuredClone(value))
        if (delayed) persisted.resolve()
      },
    }
    const create = () => new ReviewArchive(storage, async () => structuredClone(messages))
    const archive = create()
    const controller = new AbortController()
    const first = archive.load("s", controller.signal)
    const cancelled = assert.rejects(first, { name: "AbortError" })
    await entered.promise
    controller.abort()
    await cancelled
    messages = [user("replacement", "Do not publish"), tool("original", "new evidence")]
    // These settle while the old write is still blocked. A replacement instance
    // must also refuse to read stale history or race the unfinished write.
    await assert.rejects(archive.load("s", signal), /archive write is still pending/)
    const replacement = create()
    await assert.rejects(replacement.load("s", signal), /archive write is still pending/)
    assert.deepEqual((await replacement.load("other", signal)).messages.map((entry: any) => entry.id), ["replacement", "original"])
    blockedOperation.resolve()
    await persisted.promise
    await new Promise<void>((resolve) => setImmediate(resolve))
    const loaded = await replacement.load("s", signal)
    assert.match(JSON.stringify(loaded.messages), /Do not publish/)
    assert.doesNotMatch(JSON.stringify(values.get("history/s")), /Inspect only/)
    assert.match(await replacement.result("s", "original", "tool-original") ?? "", /new evidence/)
    assert.match(JSON.stringify((await create().load("s", signal)).messages), /Do not publish/)
  })
}

test("a hung tool-result read can be cancelled and retried", { timeout: 2_000 }, async () => {
  const entered = gate()
  let hang = true
  const archive = new ReviewArchive({
    get: async () => {
      if (!hang) return "original evidence"
      entered.resolve()
      return new Promise<never>(() => undefined)
    },
    set: async () => undefined,
  } as any, async () => [])
  const controller = new AbortController()
  const reading = archive.result("s", "message", "tool", controller.signal)
  const cancelled = assert.rejects(reading, { name: "AbortError" })
  await entered.promise
  controller.abort()
  await cancelled
  hang = false
  assert.equal(await archive.result("s", "message", "tool", signal), "original evidence")
})

const signal = new AbortController().signal
const user = (id: string, text: string) => ({ id, type: "user", text })
const tool = (id: string, text?: string) => ({ id, type: "assistant", content: [{ type: "tool", id: `tool-${id}`, name: "read", state: {
  status: text === undefined ? "running" : "completed", input: { path: "fixture.txt" }, ...(text === undefined ? {} : { content: [{ type: "text", text }] }),
} }] })
const checkpoint = (id: string, summary = "Summary is not authorization") => ({ id, type: "compaction", status: "completed", summary, recent: "" })
const event = (id: string): PermissionEvent => ({ sessionID: "s", action: "read", resources: ["fixture.txt"], effect: "ask", source: { type: "tool", messageID: id, id: `tool-${id}` } })

test("a compaction drops the tool backlog but keeps user authorization", async () => {
  const f = fixture()
  const archive = f.create()
  const result = "ORIGINAL_INSPECTION_".repeat(10_000)
  f.set([user("root", "Never publish private files"), tool("original", result)])
  const initial = await archive.load("s", signal)
  let journal = prepareReviewJournal(undefined, buildReviewRequest(initial.messages, event("original"))!, 16_000)!
  assert.match(journal.prompt, /Never publish private files/, "before any compaction the window is the full history")
  for (let n = 1; n <= 3; n++) {
    f.set([checkpoint(`cp${n}`, `Summary ${n} ${"x".repeat(20_000)}`), user(`u${n}`, `Inspect file ${n}`),
      tool(`h${n}`, n === 3 ? "window evidence" : undefined), tool(`a${n}`)])
    const retained = await archive.load("s", signal)
    assert.equal(retained.messages.filter((message: any) => message.type === "compaction").length, 1)
    journal = prepareReviewJournal(journal, buildReviewRequest(retained.messages, event(`a${n}`))!, 16_000)!
    // Each compaction rebases the tool history; user authorization survives it.
    assert.equal(journal.epoch, n)
    assert.ok(estimateTokens(journal.prompt) <= 16_000)
    assert.match(journal.prompt, new RegExp(`Summary ${n}`))
    assert.match(journal.prompt, /Never publish private files/)
  }
  assert.ok(!JSON.stringify(f.values.get("history/s")).includes("ORIGINAL_INSPECTION_"), "large results must stay outside the history manifest")
  const restarted = f.create()
  const retained = await restarted.load("s", signal)
  const request = buildReviewRequest(retained.messages, event("a3"))!
  // The prompt keeps the pre-compaction tool backlog out, but evidence stays
  // addressable over the whole transcript, so the reviewer can still retrieve an
  // original result by ID when the decision depends on that inspection.
  assert.doesNotMatch(JSON.stringify(request.context), /ORIGINAL_INSPECTION_/)
  const evidence = captureEvidence(retained.messages, event("a3"), { result: (messageID, toolID) => restarted.result("s", messageID, toolID) })
  assert.match(JSON.stringify(await evidence.read({ type: "tool_result", messageID: "h3", toolID: "tool-h3", offset: 0 })), /window evidence/)
  assert.match(JSON.stringify(await evidence.read({ type: "tool_result", messageID: "original", toolID: "tool-original", offset: 0 })), /ORIGINAL_INSPECTION_/)
})

test("a reconstructed boundary is reported without changing the review", async () => {
  const f = fixture()
  f.set([user("u", "Inspect only")])
  const observed = await f.create().load("s", signal)
  assert.equal(observed.reconstructed, false, "a session with no checkpoint is not a reconstruction")
  // The session compacts while the plugin is not loading, so the boundary is
  // unknown to us. It is still a valid anchor; the flag is informational only.
  f.set([checkpoint("unknown"), user("recent", "Continue"), tool("new")])
  const loaded = await f.create().load("s", signal)
  assert.equal(loaded.reconstructed, true)
  assert.ok(buildReviewRequest(loaded.messages, event("new")))

  // A checkpoint that forms while this instance is watching is not a
  // reconstruction, even though it is also new to the archive's record.
  const watcher = f.create()
  await watcher.load("s", signal)
  f.set([checkpoint("observed"), user("later", "Continue"), tool("new")])
  assert.equal((await watcher.load("s", signal)).reconstructed, false)
})

test("the archive only ever anchors on a completed checkpoint", async () => {
  // A running compaction is not a stable boundary. The archive filters it out of
  // the view it hands over, so production anchors on the latest completed one.
  const f = fixture()
  f.set([checkpoint("done"), { id: "run", type: "compaction", status: "running", summary: "s", recent: "r" },
    user("u", "Continue"), tool("new")])
  const loaded = await f.create().load("s", signal)
  assert.equal(loaded.messages.some((message: any) => message.status === "running"), false)
  assert.equal(buildReviewRequest(loaded.messages, event("new"))?.checkpoint, "done")
})

test("returning to an earlier checkpoint drops later authorization instead of resurrecting it", async () => {
  const f = fixture()
  const archive = f.create()
  f.set([user("root", "Inspect only")])
  await archive.load("s", signal)
  f.set([checkpoint("cp1"), user("grant", "You may publish"), tool("old", "old branch evidence")])
  await archive.load("s", signal)
  f.set([checkpoint("cp2"), user("later", "Continue")])
  await archive.load("s", signal)
  f.set([checkpoint("cp1"), user("replacement", "Do not publish"), tool("new")])
  const retained = await archive.load("s", signal)
  assert.doesNotMatch(JSON.stringify(retained.messages), /You may publish|old branch evidence|Continue/)
  assert.match(JSON.stringify(retained.messages), /Do not publish/)
  const evidence = captureEvidence(retained.messages, event("new"), { result: (messageID, toolID) => archive.result("s", messageID, toolID) })
  assert.match(JSON.stringify(await evidence.read({ type: "tool_result", messageID: "old", toolID: "tool-old", offset: 0 })), /No completed result/)

  // A checkpoint the plugin never observed is still a valid window anchor: the
  // review proceeds from the main session's own compaction boundary instead of
  // being denied for pre-compaction history it no longer carries.
  const fresh = fixture()
  fresh.set([checkpoint("unknown"), user("recent", "Continue"), tool("new")])
  const loaded = await fresh.create().load("s", signal)
  const request = buildReviewRequest(loaded.messages, event("new"))
  assert.equal(request?.checkpoint, "unknown")
  assert.deepEqual(request?.context[0], { type: "compaction", summary: "Summary is not authorization", recent: "" })

  f.set([checkpoint("created-while-unloaded"), user("recent", "Continue"), tool("new")])
  assert.ok(buildReviewRequest((await f.create().load("s", signal)).messages, event("new")),
    "a checkpoint the plugin never observed must still be reviewable")
})
