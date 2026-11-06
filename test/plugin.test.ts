import assert from "node:assert/strict"
import test from "node:test"
import plugin from "../src/index.js"
import { buildReviewSystemPrompt } from "../src/policy.js"

const allowText = JSON.stringify({
  decision: "allow",
  risk: "low",
  authorization: "high",
  matched_rules: [],
})

const denyText = JSON.stringify({
  decision: "deny",
  risk: "high",
  authorization: "low",
  reason: "The command may expose environment secrets that the user has not authorized accessing",
  matched_rules: ["secret-access"],
})

const mediumText = JSON.stringify({
  decision: "allow",
  risk: "low",
  authorization: "medium",
  reason: "Relevant but not explicitly authorized",
  matched_rules: [],
})

let nextHarnessID = 0

function createHarness(
  options: Record<string, unknown> = {},
  generate: string | ((input: any, options: { signal?: AbortSignal }) => Promise<{ text: string }>) = allowText,
  context?: () => Promise<any[]>,
  catalogOverride?: unknown,
  storageOverride?: { get: (key: string) => Promise<any>; set: (key: string, value: any) => Promise<void> },
) {
  let evaluate: ((event: any) => Promise<void>) | undefined
  let command: ((input: any) => Promise<void>) | undefined
  let onPrompt: ((event: any) => void) | undefined
  let onContext: ((event: any) => Promise<void> | void) | undefined
  let onCompaction: ((event: any) => Promise<void> | void) | undefined
  let onGenerate: ((event: any) => Promise<void> | void) | undefined
  const reviewers = new Map<string, any>()
  const harnessID = ++nextHarnessID
  let reviewerID = 0
  let generateCalls = 0
  let contextCalls = 0
  let disposed = 0
  let rpcDisposed = 0
  let rpcHandlers: Record<string, (input: any, context: any) => Promise<unknown>> | undefined
  const rpcEvents: { name: string; data: any }[] = []
  const noticeToasts = () => rpcEvents
    .filter((event) => event.name === "notice")
    .map((event) => event.data as { description: string; severity: string })
  let generationSignal: AbortSignal | undefined
  const generatedPrompts: string[] = []
  const synthetic: string[] = []
  const syntheticDescriptions: string[] = []
  const syntheticCalls: Array<{ sessionID?: string; text: string; description?: string; delivery?: string; resume?: boolean | null; metadata?: Record<string, unknown> }> = []
  let commandDescription = ""
  const messages: any[] = [
    { id: "user", type: "user", text: "Read package.json" },
    { id: "assistant", type: "assistant", content: [
      { type: "tool", id: "tool", name: "read", state: { status: "running", input: { path: "package.json" } } },
    ] },
  ]
  const pluginOptions: Record<string, unknown> = { model: "test/reviewer", ...options }
  if (options.model === null) delete pluginOptions.model
  // Session records for notice routing. Tests seed `ses_test` -> "ses_parent" to
  // model a subagent; an unseeded session is treated as a root session.
  const sessions: Record<string, { parentID?: string; agent?: string; title?: string; error?: boolean; hang?: boolean }> = {}
  const sessionInfo = (sessionID: string) => {
    const record = sessions[sessionID]
    if (record?.error) throw new Error(`session lookup failed: ${sessionID}`)
    if (record?.hang) return new Promise<never>(() => undefined)
    return { id: sessionID, ...record }
  }
  const catalogModel: any = { providerID: "test", id: "reviewer", limit: { context: 128_000, input: 120_000, output: 8192 }, variants: [
    { id: "max", settings: { reasoningEffort: "high" }, body: { reasoning: { effort: "high" } } },
  ] }
  const defaultCatalog = (() => {
    // Model the 2.0.4 registry faithfully: transforms are replayed lazily on the
    // next read, not when `transform()` resolves. A synchronous mock would hide a
    // registration that never actually runs.
    let retained: { callback: (editor: any) => void; before: any[] } | undefined
    const editor = () => ({
      get: (provider: string, id: string) => provider === catalogModel.providerID && id === catalogModel.id ? catalogModel : undefined,
      update: (_provider: string, _id: string, update: (draft: any) => void) => update(catalogModel),
    })
    const replay = () => {
      if (!retained) return
      catalogModel.variants = structuredClone(retained.before)
      retained.callback(editor())
    }
    return {
      default: async () => ({ data: catalogModel }),
      list: async () => { replay(); return { data: [catalogModel] } },
      transform: async (callback: (editor: any) => void) => {
        const before = structuredClone(catalogModel.variants)
        retained = { callback, before }
        return {
          dispose: async () => {
            retained = undefined
            catalogModel.variants = structuredClone(before)
          },
        }
      },
    }
  })()
  // OpenCode 2.0.4 exposes the model domain directly on the plugin context and
  // flattens the transform editor (`editor.get`/`editor.update`), replacing
  // 2.0.2's `ctx.catalog.model` nesting.
  const storageEntries = new Map<string, any>()
  const ctx = {
    location: { directory: `/test/${harnessID}` },
    options: pluginOptions,
    storage: storageOverride ?? {
      get: async (key: string) => structuredClone(storageEntries.get(key)),
      set: async (key: string, value: any) => { storageEntries.set(key, structuredClone(value)) },
    },
    permission: {
      hook: async (_name: string, callback: typeof evaluate) => {
        evaluate = callback
        return { dispose: async () => { disposed++ } }
      },
    },
    command: {
      transform: async (callback: (draft: any) => void) => {
        callback({ add: (definition: any) => {
          command = definition.execute
          commandDescription = definition.description
        } })
        return { dispose: async () => undefined }
      },
    },
    session: {
      hook: async (_name: string, callback: typeof onPrompt) => {
        if (_name === "prompt") onPrompt = callback
        if (_name === "context") onContext = callback
        if (_name === "compaction") onCompaction = callback
        if (_name === "generate") onGenerate = callback
        return { dispose: async () => undefined }
      },
      create: async (input: any) => { const info = { ...input, id: `reviewer-${harnessID}-${++reviewerID}` }; reviewers.set(info.id, info); return info },
      update: async () => undefined,
      remove: async ({ sessionID }: any) => { reviewers.delete(sessionID) },
      generate: async ({ sessionID, prompt }: any, requestOptions: { signal?: AbortSignal }) => {
        const selected = reviewers.get(sessionID)
        const event: any = { sessionID, model: selected.model, system: [{ type: "text", text: "UNTRUSTED_PROJECT_SYSTEM" }], messages: [{ role: "user", content: [{ type: "text", text: prompt }] }], tools: { shell: {} }, options: {} }
        await onGenerate!(event)
        assert.deepEqual(event.system, [{ type: "text", text: buildReviewSystemPrompt(Number(pluginOptions.maxReviewTokens ?? 2048)) }])
        assert.deepEqual(event.tools, {})
        const text = `${event.system[0].text}\n${event.messages[0].content[0].text}`
        generateCalls++
        generatedPrompts.push(text)
        generationSignal = requestOptions.signal
        if (typeof generate === "function") return generate({ prompt: text, model: selected.model }, requestOptions)
        return { text: generate }
      },
      context: async () => { contextCalls++; return context ? context() : messages },
      get: async ({ sessionID }: { sessionID: string }) => {
        if (sessionID.startsWith("reviewer-") && !reviewers.has(sessionID)) throw Object.assign(new Error("missing reviewer"), { _tag: "NotFoundError" })
        return reviewers.get(sessionID) ?? sessionInfo(sessionID)
      },
      synthetic: async (input: { sessionID?: string; text: string; description?: string; delivery?: string; resume?: boolean | null; metadata?: Record<string, unknown> }) => {
        syntheticCalls.push(structuredClone(input))
        synthetic.push(input.text)
        if (input.description) syntheticDescriptions.push(input.description)
      },
    },
    experimental: { generate: { text: async (input: any, requestOptions: { signal?: AbortSignal }) => {
      generateCalls++
      generatedPrompts.push(input.prompt)
      generationSignal = requestOptions.signal
      if (typeof generate === "function") return generate(input, requestOptions)
      return { text: generate }
    } } },
    agent: { get: async () => { throw new Error("missing") } },
    model: { ...(catalogOverride ?? defaultCatalog) },
    rpc: {
      register: async (_definition: unknown, handlers: Record<string, (input: any, context: any) => Promise<unknown>>) => {
        rpcHandlers = handlers
        return {
          events: { emit: async (name: string, data: unknown) => { rpcEvents.push({ name, data }) } },
          dispose: async () => { rpcDisposed++ },
        }
      },
    },
  }
  return {
    setScope(directory: string) { ctx.location.directory = directory },
    async setup() {
      const cleanup = await plugin.setup(ctx as any)
      assert.ok(evaluate)
      return cleanup
    },
    async run(patch: Record<string, unknown> = {}) {
      const event = {
        sessionID: "ses_test",
        agent: "build",
        action: "read",
        resources: ["package.json"],
        source: { type: "tool", messageID: "assistant", id: "tool" },
        effect: "ask",
        ...patch,
      }
      await evaluate!(event)
      // Notices are fire-and-forget and may await session lookups before they
      // commit, so settle that chain before callers inspect synthetic output.
      for (let turn = 0; turn < 4; turn++) await new Promise((done) => setImmediate(done))
      return event
    },
    async command(text: string) {
      assert.ok(command)
      await command({ sessionID: "ses_test", prompt: { text }, delivery: "steer" })
      return noticeToasts().at(-1)?.description
    },
    counts: () => ({ generateCalls, contextCalls, disposed }),
    storedJournal: () => structuredClone(storageEntries.get("journal/ses_test")),
    commandDescription: () => commandDescription,
    // Command feedback is an `info` toast now, not a session message.
    visibleStatus: () => noticeToasts().filter((toast) => toast.severity === "info").at(-1)?.description,
    // Nothing may write to the session any more: a session message resumes an
    // idle session. These stay for asserting emptiness.
    visibleMessages: () => syntheticCalls.filter((call) => call.resume === false).map((call) => call.text),
    sessionWrites: () => syntheticCalls.slice(),
    // CLI toasts. Every notice, including a clean approval, is one.
    toasts: () => noticeToasts(),
    messages,
    generationSignal: () => generationSignal,
    generatedPrompts: () => generatedPrompts,
    admitPrompt: (sessionID: string) => onPrompt!({ sessionID }),
    async compact(sessionID = "ses_test", compactionMessages: any[] = []) {
      assert.ok(onCompaction)
      const event = { sessionID, model: {}, system: [], messages: compactionMessages, options: {} }
      await onCompaction(event)
      return event
    },
    async dispatch(sessionID = "ses_test", dispatchMessages: any[] = []) {
      assert.ok(onContext)
      const event = { sessionID, model: {}, system: [], messages: dispatchMessages, options: {} }
      await onContext(event)
      return event
    },
    async rpcStatus() {
      assert.ok(rpcHandlers?.status)
      return rpcHandlers.status(undefined, {})
    },
    async rpcSetEnabled(value: boolean) {
      assert.ok(rpcHandlers?.setEnabled)
      return rpcHandlers.setEnabled({ enabled: value }, {})
    },
    async rpcSetFallback(value: boolean) {
      assert.ok(rpcHandlers?.setFallback)
      return rpcHandlers.setFallback({ humanFallback: value }, {})
    },
    rpcEvents: () => rpcEvents.slice(),
    rpcDisposed: () => rpcDisposed,
    catalogModel,
    sessions,
  }
}

test("a legacy notice body is stripped from the dispatched model request", async () => {
  // This plugin no longer writes session messages, but an install upgraded from an
  // earlier version still has committed notice bodies in its transcript, and the
  // host replays one into later requests as a user message whose only part is
  // empty text. The filter must keep removing that body.
  const harness = createHarness({}, async () => { throw new Error("provider secret") })
  await harness.setup()
  const outcome = await harness.run()
  assert.notEqual(outcome.effect, "allow")
  const replay = { role: "user", id: "notice-1", content: [{ type: "text", text: "" }] }
  const real = { role: "user", id: "user-1", content: [{ type: "text", text: "Read package.json" }] }
  const event = await harness.dispatch("ses_test", [real, replay])
  assert.deepEqual(event.messages, [real], "only the empty notice body is removed")
})

test("a notice committed by an earlier plugin instance is still stripped", async () => {
  // Shape matching is required because a fresh plugin instance has no memory of
  // notices committed before it loaded, yet those bodies remain in the session.
  const harness = createHarness()
  await harness.setup()
  const stale = { role: "user", id: "stale-notice", content: [{ type: "text", text: "" }] }
  const real = { role: "user", id: "user-1", content: [{ type: "text", text: "hello" }] }
  const event = await harness.dispatch("ses_test", [stale, real])
  assert.deepEqual(event.messages, [real])
})

test("meaningful model messages are never stripped", async () => {
  const harness = createHarness()
  await harness.setup()
  const user = { role: "user", id: "u", content: [{ type: "text", text: "do work" }] }
  const multi = { role: "user", id: "m", content: [{ type: "text", text: "" }, { type: "text", text: "keep" }] }
  const media = { role: "user", id: "i", content: [{ type: "media", mediaType: "image/png", data: "x" }] }
  const assistant = { role: "assistant", id: "a", content: [{ type: "text", text: "" }] }
  const empty = { role: "user", id: "e", content: [] }
  // A malformed or absent `text` is not the measured notice shape, so the
  // destructive predicate must not broaden to cover it.
  const nullText = { role: "user", id: "n", content: [{ type: "text", text: null }] }
  const missingText = { role: "user", id: "x", content: [{ type: "text" }] }
  const event = await harness.dispatch("ses_test", [user, multi, media, assistant, empty, nullText, missingText])
  assert.deepEqual(event.messages, [user, multi, media, assistant, empty, nullText, missingText])
})

test("a notice body is stripped from the compaction request too", async () => {
  // V2 dispatches checkpoint summaries through the separate compaction hook, so a
  // notice body must be filtered there as well; filtering only `context` would
  // still leak it into the compaction request.
  const harness = createHarness()
  await harness.setup()
  const replay = { role: "user", id: "notice-1", content: [{ type: "text", text: "" }] }
  const real = { role: "user", id: "user-1", content: [{ type: "text", text: "Read package.json" }] }
  const event = await harness.compact("ses_test", [real, replay])
  assert.deepEqual(event.messages, [real])
})

test("only a valid eligible ask can be auto-allowed", async () => {
  const harness = createHarness()
  const cleanup = await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "allow")
  assert.equal((event as any).message, "Auto-review approved: read.")
  // A silent allow is indistinguishable from no review at all, so every approval
  // emits a CLI toast. The notice must not carry a reason, and an approval must
  // not write to the session (that would resume it).
  const toast = harness.toasts()[0]!
  assert.equal(toast.description, "Auto-review approved read.")
  assert.equal(toast.severity, "success")
  assert.deepEqual(harness.sessionWrites(), [])
  assert.deepEqual(harness.visibleMessages(), [])
  assert.deepEqual(harness.counts(), { generateCalls: 1, contextCalls: 1, disposed: 0 })
  await cleanup?.()
  assert.equal(harness.counts().disposed, 1)
  assert.equal(harness.rpcDisposed(), 1)
})

test("a later review keeps the journal body and carries the prior outcome", async () => {
  const harness = createHarness()
  await harness.setup()
  await harness.run()
  harness.messages[1]!.content[0].state.status = "completed"
  harness.messages.push({ id: "assistant2", type: "assistant", content: [
    { type: "tool", id: "tool2", name: "read", state: { status: "running", input: { path: "README.md" } } },
  ] })
  await harness.run({ source: { type: "tool", messageID: "assistant2", id: "tool2" } })
  const prompts = harness.generatedPrompts()
  assert.equal(prompts.length, 2)
  // The prior verdict is retained, but after the journal body: `runReviewLoop`
  // appends it as an outcome line and the journal carries a compact tail of it.
  assert.match(prompts[1]!, /"type":"review_outcome","code":"allow"/)
  assert.doesNotMatch(prompts[0]!, /"type":"review_outcome"/)
  // The cached prefix is the body, and it must not move: the two prompts share
  // far more than the static policy block alone.
  let common = 0
  while (common < prompts[0]!.length && prompts[0]![common] === prompts[1]![common]) common++
  assert.ok(common > 9_400, `expected a shared body prefix, shared ${common} of ${prompts[0]!.length}`)
})

test("the journal snapshot is persisted, not only kept in memory", async () => {
  // A reload, a host that recreates the plugin, or per-session eviction must not
  // lose the epoch boundary: a rebuild writes a different first line and drops the
  // provider's cached prefix for the whole journal. The snapshot therefore has to
  // outlive the in-memory map.
  const harness = createHarness()
  await harness.setup()
  assert.equal(harness.storedJournal(), undefined)
  await harness.run()
  const first = harness.storedJournal()
  assert.ok(first, "the snapshot must be written to storage")
  assert.equal(first.version, 6)
  assert.ok(Array.isArray(first.body) && first.body.length > 0)

  harness.messages[1]!.content[0].state.status = "completed"
  harness.messages.push({ id: "assistant2", type: "assistant", content: [
    { type: "tool", id: "tool2", name: "read", state: { status: "running", input: { path: "README.md" } } },
  ] })
  await harness.run({ source: { type: "tool", messageID: "assistant2", id: "tool2" } })
  const second = harness.storedJournal()
  // The header line is the cached prefix and must not move; the body grows.
  assert.equal(second.body[0], first.body[0])
  assert.ok(second.body.length >= first.body.length)
  assert.equal(second.epoch, 0)
})

// Seeding helper for the journal tests: a user turn followed by one assistant
// message per tool, the last left running so it can be the pending request.
function seedTranscript(harness: ReturnType<typeof createHarness>, tag: string, count: number) {
  harness.messages.length = 0
  harness.messages.push({ id: "user", type: "user", text: "Read files" })
  for (let index = 0; index < count; index++) {
    harness.messages.push({ id: `${tag}-a-${index}`, type: "assistant", content: [
      { type: "tool", id: `${tag}-t-${index}`, name: "read",
        state: { status: index === count - 1 ? "running" : "completed",
          input: { path: `${"p".repeat(400)}${tag}${index}` } } },
    ] })
  }
}

function runSeeded(harness: ReturnType<typeof createHarness>, tag: string, count: number) {
  seedTranscript(harness, tag, count)
  return harness.run({ source: { type: "tool", messageID: `${tag}-a-${count - 1}`, id: `${tag}-t-${count - 1}` } })
}

test("a recreated instance restores the journal boundary instead of rebuilding", async () => {
  // This asserts the RESTORE path, not merely that a body exists. The model limit is
  // narrowed so the initial selection omits history, which means a rebuild rewrites
  // the header's omission counts. A control instance that cannot read the snapshot
  // must then produce a DIFFERENT header — otherwise the assertion would pass even
  // if restoration were broken.
  const run = (snapshotVisible: boolean) => {
    const entries = new Map<string, any>()
    const storage = {
      get: async (key: string) => snapshotVisible || !key.startsWith("journal/") ? structuredClone(entries.get(key)) : undefined,
      set: async (key: string, value: any) => { entries.set(key, structuredClone(value)) },
    }
    return { entries, storage }
  }
  const narrow = (harness: ReturnType<typeof createHarness>) => {
    harness.catalogModel.limit = { context: 64_000, input: 64_000, output: 1_024 }
  }
  const journalOf = (entries: Map<string, any>) => structuredClone(entries.get("journal/ses_test"))

  // Instance A establishes a boundary whose initial selection omitted history.
  const a = run(true)
  const first = createHarness({}, allowText, undefined, undefined, a.storage)
  narrow(first)
  first.setScope("/test/journal-restore")
  await first.setup()
  await runSeeded(first, "x", 61)
  const snapshot = journalOf(a.entries)
  assert.ok(snapshot, "the first instance must persist a snapshot")
  assert.ok(snapshot.body.some((line: string) => line.includes("review_outcome")), "restored records include the prior outcome")

  // Instance B shares storage and continues the same transcript with more actions.
  const second = createHarness({}, allowText, undefined, undefined, a.storage)
  narrow(second)
  second.setScope("/test/journal-restore")
  await second.setup()
  await runSeeded(second, "x", 61)
  const restored = journalOf(a.entries)
  assert.equal(restored.epoch, snapshot.epoch, "restoring must not start a new epoch")
  assert.equal(restored.body[0], snapshot.body[0], "the restored header must match, not be recomputed")
  assert.deepEqual(restored.body.slice(0, snapshot.body.length), snapshot.body,
    "the retained body must remain the cached prefix")

  // Control: the same continued transcript with the snapshot hidden rebuilds and
  // therefore rewrites the header. This is what makes the assertions above real.
  const lost = run(false)
  const third = createHarness({}, allowText, undefined, undefined, lost.storage)
  narrow(third)
  await third.setup()
  await runSeeded(third, "x", 61)
  const rebuilt = journalOf(lost.entries)
  assert.ok(!rebuilt.body.some((line: string) => line.includes("review_outcome")) || rebuilt.body.length < restored.body.length,
    "without restoration the prior assessment records are absent")
})

test("a hung journal read does not wedge the next same-session review", async () => {
  // The permission hook has a deadline, but the session queue waits for the task to
  // settle. Only the first journal read is made to hang: the archive must keep
  // working, and the next same-session review must actually reach the reviewer
  // instead of being queued behind the stalled one.
  const entries = new Map<string, any>()
  const journalReads: string[] = []
  let hangFirstJournalRead = true
  const storage = {
    get: async (key: string) => {
      if (key.startsWith("journal/")) {
        journalReads.push(key)
        if (hangFirstJournalRead) {
          hangFirstJournalRead = false
          return new Promise<never>(() => undefined)
        }
      }
      return structuredClone(entries.get(key))
    },
    set: async (key: string, value: any) => { entries.set(key, structuredClone(value)) },
  }
  const harness = createHarness({ timeoutMs: 1_000 }, allowText, undefined, undefined, storage)
  await harness.setup()
  const first = await harness.run({ action: "read", resources: ["a.txt"] })
  assert.notEqual(first.effect, "allow", "a stalled restore must not approve")
  const generatedBefore = harness.counts().generateCalls
  const second = await harness.run({ action: "read", resources: ["b.txt"] })
  assert.ok(journalReads.length >= 2, "the second review must attempt its own journal read")
  assert.ok(harness.counts().generateCalls > generatedBefore, "the second review must reach the reviewer")
  assert.equal(second.effect, "allow", "the second review must complete normally")
})

test("a delayed journal write cannot overwrite a newer snapshot", async () => {
  // A write whose review is cancelled still completes, so ordering matters: if a
  // later review's newer snapshot lands first, the delayed write must not be able
  // to overtake it and roll the durable journal back to an older boundary.
  const entries = new Map<string, any>()
  const journalWrites: any[] = []
  let releaseFirst!: () => void
  const gate = new Promise<void>((resolve) => { releaseFirst = resolve })
  let delayFirst = true
  const harness = createHarness({ timeoutMs: 1_000 }, allowText, undefined, undefined, {
    get: async (key: string) => structuredClone(entries.get(key)),
    set: async (key: string, value: any) => {
      if (key.startsWith("journal/")) {
        if (delayFirst) { delayFirst = false; await gate }
        journalWrites.push(structuredClone(value))
      }
      entries.set(key, structuredClone(value))
    },
  })
  await harness.setup()
  // Both reviews complete normally: persistence is off the review path, so a slow
  // write must not turn a valid approval into a deadline timeout.
  const first = await harness.run()
  assert.equal(first.effect, "allow")
  harness.messages[1]!.content[0].state.status = "completed"
  harness.messages.push({ id: "assistant2", type: "assistant", content: [
    { type: "tool", id: "tool2", name: "read", state: { status: "running", input: { path: "SECOND-MARKER.md" } } },
  ] })
  // The second review queues a newer snapshot behind the first.
  const second = await harness.run({ source: { type: "tool", messageID: "assistant2", id: "tool2" } })
  assert.equal(second.effect, "allow")
  assert.equal(journalWrites.length, 0, "both writes must still be waiting on the first")
  releaseFirst()
  for (let turn = 0; turn < 12; turn++) await new Promise((done) => setImmediate(done))
  assert.equal(journalWrites.length, 2, "both snapshots must be written, in order")
  const [older, newer] = journalWrites
  assert.ok(newer.body.length > older.body.length,
    "the second snapshot must be the newer one, so the two are distinguishable")
  const durable = entries.get("journal/ses_test")
  assert.ok(durable, "a snapshot must be persisted")
  // Losing this ordering would let the delayed, older write roll the durable
  // boundary back to where it was before the second review.
  assert.equal(durable.body.length, newer.body.length,
    "the newer snapshot must be the durable one, not the delayed older one")
})

test("resume keeps the exact sent investigation prefix before its snapshot reaches storage", async () => {
  const entries = new Map<string, any>()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let firstWrite = true
  const storage = {
    get: async (key: string) => structuredClone(entries.get(key)),
    set: async (key: string, value: any) => {
      if (key.startsWith("journal/") && firstWrite) { firstWrite = false; await gate }
      entries.set(key, structuredClone(value))
    },
  }
  let calls = 0
  const first = createHarness({}, async () => ({ text: calls++ === 0
    ? JSON.stringify({ decision: "investigate", reason: "Confirm original user scope", requests: [{ type: "history", offset: 0 }] })
    : allowText }), undefined, undefined, storage)
  first.setScope("/test/unflushed")
  const cleanup = await first.setup()
  await first.run()
  const lastSent = first.generatedPrompts().at(-1)!
  await cleanup?.()
  const resumed = createHarness({}, allowText, undefined, undefined, { ...storage })
  resumed.setScope("/test/unflushed")
  const dispose = await resumed.setup()
  assert.equal((await resumed.run()).effect, "allow")
  assert.ok(resumed.generatedPrompts()[0]!.startsWith(lastSent + "\n"))
  assert.match(resumed.generatedPrompts()[0]!, /review_outcome/)
  release()
  for (let i = 0; i < 8; i++) await new Promise(done => setImmediate(done))
  assert.ok(entries.get("journal/ses_test").body.join("\n").includes("reviewer_round"))
  await dispose?.()
})

test("cancelled investigation remains an exact prefix of the next review", async () => {
  let calls = 0
  let finish!: (value: { text: string }) => void
  const harness = createHarness({}, async () => {
    calls++
    if (calls === 1) return { text: JSON.stringify({ decision: "investigate", reason: "Recover original instructions", requests: [{ type: "history", offset: 0 }] }) }
    if (calls === 2) return new Promise(resolve => { finish = resolve })
    return { text: allowText }
  })
  const cleanup = await harness.setup()
  const pending = harness.run()
  while (calls < 2) await new Promise(done => setImmediate(done))
  const sent = harness.generatedPrompts().at(-1)!
  harness.admitPrompt("ses_test")
  assert.equal((await pending).effect, "ask")
  finish({ text: allowText })
  for (let i = 0; i < 5; i++) await new Promise(done => setImmediate(done))
  assert.equal((await harness.run()).effect, "allow")
  assert.ok(harness.generatedPrompts().at(-1)!.startsWith(sent + "\n"))
  await cleanup?.()
})

test("a delayed write from a disposed instance cannot overwrite a newer one", async () => {
  // A plugin reload disposes one instance and creates another in the same process.
  // The disposed instance's outstanding write must not be able to roll the durable
  // journal back after the new instance persisted a newer snapshot.
  const entries = new Map<string, any>()
  const written: any[] = []
  let releaseFirst!: () => void
  const gate = new Promise<void>((resolve) => { releaseFirst = resolve })
  let delayFirst = true
  const storage = {
    get: async (key: string) => structuredClone(entries.get(key)),
    set: async (key: string, value: any) => {
      if (key.startsWith("journal/")) {
        if (delayFirst) { delayFirst = false; await gate }
        written.push(structuredClone(value))
      }
      entries.set(key, structuredClone(value))
    },
  }
  const first = createHarness({}, allowText, undefined, undefined, storage)
  first.setScope("/test/write-order")
  const cleanup = await first.setup()
  await first.run()
  await cleanup?.()

  const second = createHarness({}, allowText, undefined, undefined, { ...storage })
  second.setScope("/test/write-order")
  await second.setup()
  second.messages[1]!.content[0].state.status = "completed"
  second.messages.push({ id: "assistant2", type: "assistant", content: [
    { type: "tool", id: "tool2", name: "read", state: { status: "running", input: { path: "README.md" } } },
  ] })
  const outcome = await second.run({ source: { type: "tool", messageID: "assistant2", id: "tool2" } })
  assert.equal(outcome.effect, "allow")

  releaseFirst()
  for (let turn = 0; turn < 12; turn++) await new Promise((done) => setImmediate(done))
  assert.ok(written.length >= 2, "both reviews must eventually persist")
  const older = written[0]
  const newer = written.at(-1)
  assert.ok(newer.body.length > older.body.length, "the second snapshot must be the newer one")
  assert.equal(entries.get("journal/ses_test").body.length, newer.body.length,
    "the disposed instance's late write must not overwrite the newer snapshot")
})

test("a rejected journal write does not strand a newer snapshot", async () => {
  // The write that fails is dropped, but a newer snapshot published while it was in
  // flight never failed and must still be attempted — without waiting for a third
  // review to republish it.
  const entries = new Map<string, any>()
  const attempts: any[] = []
  const written: any[] = []
  let failFirst!: () => void
  const gate = new Promise<void>((_, reject) => { failFirst = () => reject(new Error("storage down")) })
  let first = true
  const harness = createHarness({}, allowText, undefined, undefined, {
    get: async (key: string) => structuredClone(entries.get(key)),
    set: async (key: string, value: any) => {
      if (key.startsWith("journal/")) {
        attempts.push(structuredClone(value))
        if (first) { first = false; await gate }
        written.push(structuredClone(value))
      }
      entries.set(key, structuredClone(value))
    },
  })
  await harness.setup()
  const firstRun = await harness.run()
  assert.equal(firstRun.effect, "allow")
  harness.messages[1]!.content[0].state.status = "completed"
  harness.messages.push({ id: "assistant2", type: "assistant", content: [
    { type: "tool", id: "tool2", name: "read", state: { status: "running", input: { path: "README.md" } } },
  ] })
  const secondRun = await harness.run({ source: { type: "tool", messageID: "assistant2", id: "tool2" } })
  assert.equal(secondRun.effect, "allow")
  assert.equal(attempts.length, 1, "only the first write has started so far")

  failFirst()
  for (let turn = 0; turn < 12; turn++) await new Promise((done) => setImmediate(done))
  assert.equal(attempts.length, 2, "the newer snapshot must be attempted without another publish")
  assert.ok(attempts[1].body.length > attempts[0].body.length, "the retried snapshot must be the newer one")
  assert.equal(written.length, 1, "only the newer snapshot succeeds")
  assert.equal(entries.get("journal/ses_test").body.length, attempts[1].body.length,
    "the newer snapshot must end up durable")
})

test("a request reviewed again after its first notice still notifies", async () => {
  // The dedupe marker must not permanently suppress a later legitimate review of
  // the same request identity.
  const harness = createHarness()
  await harness.setup()
  const first = await harness.run()
  assert.equal(first.effect, "allow")
  assert.equal(harness.toasts().length, 1)
  // A second evaluation of the identical request happens after the shared review
  // settled, so it reviews again and must notify again.
  const second = await harness.run()
  assert.equal(second.effect, "allow")
  assert.equal(harness.counts().generateCalls, 2, "the settled request must be reviewed again")
  assert.equal(harness.toasts().length, 2, "the second review must notify too")
})

test("denial returns its permission reason in the tool error", async () => {
  const harness = createHarness({}, denyText)
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "deny")
  assert.match((event as any).message, /not authorized accessing/)
  assert.match((event as any).message, /shell expansion/)
  assert.equal(harness.visibleStatus(), undefined)
})

test("medium authorization is allowed and shows its rationale", async () => {
  const harness = createHarness({}, mediumText)
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "allow")
  assert.equal((event as any).message, "Auto-review approved: Relevant but not explicitly authorized")
  // The rationale stays in the permission message, not in the approval notice.
  const toast = harness.toasts()[0]!
  assert.equal(toast.description, "Auto-review approved read.")
  assert.doesNotMatch(toast.description, /Relevant but not explicitly authorized/)
})

test("runtime command toggles auto-review without restarting", async () => {
  const harness = createHarness({ enabled: false })
  await harness.setup()
  assert.match(harness.commandDescription(), /\/auto-review \[on\|off\|toggle\|status\]/)
  assert.match(harness.commandDescription(), /fallback/)
  assert.equal((await harness.run()).effect, "ask")
  assert.equal(await harness.command("on"), "Auto-review is enabled.")
  assert.equal(harness.visibleStatus(), "Auto-review is enabled.")
  assert.equal((await harness.run()).effect, "allow")
  assert.equal(await harness.command("off"), "Auto-review is disabled.")
  assert.equal((await harness.run()).effect, "ask")
  assert.match(await harness.command("invalid") ?? "", /Usage:/)
})

test("host allow and deny decisions and unknown actions do not call the reviewer", async () => {
  const harness = createHarness()
  await harness.setup()
  assert.equal((await harness.run({ effect: "allow" })).effect, "allow")
  assert.equal((await harness.run({ effect: "deny", message: "User forbids this operation" })).effect, "deny")
  assert.equal((await harness.run({ action: "question" })).effect, "ask")
  assert.deepEqual(harness.counts(), { generateCalls: 0, contextCalls: 0, disposed: 0 })
})

test("high-risk exact consent can approve while critical risk cannot", async () => {
  const verdict = { decision: "allow", risk: "high", authorization: "high", reason: "The user explicitly approved the named staging database deletion and data-loss side effect", matched_rules: ["explicit-consent"] }
  const harness = createHarness({}, JSON.stringify(verdict), async () => [
    { id: "user", type: "user", text: "I approve permanently deleting only the staging database demo_staging and its data." },
    { id: "assistant", type: "assistant", content: [
      { type: "tool", id: "tool", name: "shell", state: { status: "running", input: { command: "dropdb demo_staging" } } },
    ] },
  ])
  const cleanup = await harness.setup()
  const event = await harness.run({ action: "shell", resources: ["dropdb demo_staging"] })
  assert.equal(event.effect, "allow")
  assert.match((event as any).message, /named staging database/)
  await cleanup?.()

  const critical = createHarness({ humanFallback: true }, JSON.stringify({ ...verdict, risk: "critical" }))
  const dispose = await critical.setup()
  assert.equal((await critical.run()).effect, "deny")
  await dispose?.()
})

test("human fallback cannot turn classified critical risk into a prompt", async () => {
  const harness = createHarness({ humanFallback: true }, JSON.stringify({
    decision: "ask", risk: "critical", authorization: "high",
    reason: "Credentials would leave for an untrusted destination", matched_rules: ["secret-export"],
  }))
  const cleanup = await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "deny")
  assert.match((event as any).message, /untrusted destination/)
  await cleanup?.()
})

test("distinct permission metadata is reviewed separately and reaches the classifier", async () => {
  const metadataSeen: unknown[] = []
  const harness = createHarness({}, async (input) => {
    const journal = input.prompt.split("\n").filter((line: string) => line.startsWith("{"))
      .map((line: string) => JSON.parse(line))
    metadataSeen.push(journal.findLast((entry: any) => entry.type === "review").permission.metadata)
    return { text: allowText }
  })
  const cleanup = await harness.setup()
  await Promise.all([
    harness.run({ metadata: { operation: "read" } }),
    harness.run({ metadata: { operation: "write" } }),
  ])
  assert.deepEqual(metadataSeen, [{ operation: "read" }, { operation: "write" }])
  await cleanup?.()
})

test("human rules preserve confirmation while reviewer recursion remains ask", async () => {
  const harness = createHarness({
    agent: "auto-reviewer",
    humanReviewRules: [{ action: "shell", resource: "git push *", reason: "Remote changes require confirmation" }],
  })
  await harness.setup()
  const human = await harness.run({ action: "shell", resources: ["git push origin main"] })
  assert.equal(human.effect, "ask")
  assert.match((human as any).message, /Remote changes require confirmation/)
  assert.equal((await harness.run({ agent: "auto-reviewer" })).effect, "ask")
  assert.equal(harness.counts().generateCalls, 0)
})

test("malformed output exhausts bounded repair rounds and denies by default", async () => {
  const harness = createHarness({}, "not json")
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "deny")
  assert.match((event as any).message, /one format repair/)
  assert.equal(harness.counts().generateCalls, 2)
})

test("provider errors deny by default and keep the reason", async () => {
  const harness = createHarness({}, async () => { throw new Error("provider secret") })
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "deny")
  assert.match((event as any).message, /reviewer model call failed/)
  assert.match((event as any).message, /provider secret/)
  assert.match((event as any).message, /not a safety judgment/)
  assert.match((event as any).message, /Adjust the request/)
  assert.equal(harness.counts().generateCalls, 2)
  assert.deepEqual(harness.visibleMessages(), [], "failures must not leave pending synthetic inbox messages")
})

test("enabling the human fallback restores a prompt for the same failure", async () => {
  const harness = createHarness({ humanFallback: true }, async () => { throw new Error("provider secret") })
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "ask")
  assert.match((event as any).message, /human confirmation/)
  assert.doesNotMatch((event as any).message, /Adjust the request/)
})

test("missing reviewer agent uses the OpenCode default model", async () => {
  const harness = createHarness({ model: null })
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "allow")
  assert.equal(harness.counts().generateCalls, 1)
  // The fallback from agent lookup to the catalog default must be visible, not silent.
  assert.match((event as any).message, /auto-review fallback/)
  assert.match((event as any).message, /reviewer agent lookup failed: missing/)
  assert.match((event as any).message, /catalog default model test\/reviewer/)
  assert.deepEqual(harness.visibleMessages(), [])
})

test("an unavailable reviewer model denies with the registration failure instead of silently proceeding", async () => {
  const harness = createHarness({ model: "test/absent" })
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "deny")
  assert.equal(harness.counts().generateCalls, 0)
  assert.match((event as any).message, /could not resolve a reviewer model/)
  assert.match((event as any).message, /test\/absent is not available/)
  assert.deepEqual(harness.visibleMessages(), [])
})

test("a missing reviewer variant reports the registration failure", async () => {
  const harness = createHarness({ model: "test/reviewer#missing" })
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "deny")
  assert.equal(harness.counts().generateCalls, 0)
  assert.match((event as any).message, /variant "missing" is not available/)
  assert.deepEqual(harness.visibleMessages(), [])
})

test("an explicit reviewer ask denies by default and does not emit a fallback notice", async () => {
  const harness = createHarness({}, JSON.stringify({ decision: "ask", risk: "unknown", authorization: "unknown",
    reason: "Confirm the deployment target", matched_rules: [] }))
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "deny")
  assert.match((event as any).message, /Confirm the deployment target/)
  assert.deepEqual(harness.visibleMessages(), [])
})

test("input budget follows current model limits and can exceed the old 64 KiB ceiling", async () => {
  const harness = createHarness()
  harness.catalogModel.limit = { context: 16_000, input: 8000, output: 8192 }
  harness.messages[1].content[0].state.input = { path: "x".repeat(70_000) }
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "deny")
  assert.match((event as any).message, /reviewer model's input budget/)
  assert.equal(harness.counts().generateCalls, 0)
  harness.catalogModel.limit = { context: 256_000, input: 220_000, output: 8192 }
  assert.equal((await harness.run()).effect, "allow")
  assert.ok(Buffer.byteLength(harness.generatedPrompts()[0]!, "utf8") > 65_536)
})

test("a user instruction too large for the reviewer budget denies instead of approving without it", async () => {
  // The governing instruction is mandatory. When it cannot fit, the review is
  // refused rather than falling back to an older instruction that the latest one
  // may have superseded.
  const harness = createHarness()
  harness.catalogModel.limit = { context: 16_000, input: 8000, output: 8192 }
  harness.messages.splice(0, harness.messages.length,
    { id: "first", type: "user", text: "Read package.json" },
    { id: "governing", type: "user", text: `Only read package.json. ${"x".repeat(70_000)}` },
    { id: "assistant", type: "assistant", content: [
      { type: "tool", id: "tool", name: "read", state: { status: "running", input: { path: "package.json" } } },
    ] },
  )
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "deny")
  assert.equal(harness.counts().generateCalls, 0, "the reviewer must not decide without the governing instruction")
})

test("review deadline aborts even a provider that ignores cancellation", async () => {
  const harness = createHarness({ timeoutMs: 1000 }, () => new Promise(() => undefined))
  await harness.setup()
  const started = Date.now()
  const event = await harness.run()
  assert.ok(Date.now() - started >= 900)
  assert.equal(event.effect, "deny")
  assert.equal(harness.counts().generateCalls, 1)
  assert.equal(harness.generationSignal()?.aborted, true)
})

test("cleanup prevents a late review from changing the event", async () => {
  let resolve!: (value: { text: string }) => void
  const deferred = new Promise<{ text: string }>((done) => { resolve = done })
  const harness = createHarness({}, () => deferred)
  const cleanup = await harness.setup()
  const pending = harness.run()
  await new Promise((done) => setImmediate(done))
  await cleanup?.()
  resolve({ text: allowText })
  const event = await pending
  assert.equal(event.effect, "ask")
  assert.equal(harness.generationSignal()?.aborted, true)
})

function aborts(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(new Error("aborted"))
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
  })
}

test("permission evaluation executes multiple evidence rounds before applying a verdict", async () => {
  let round = 0
  const harness = createHarness({}, async ({ prompt }) => {
    round++
    if (round === 1) {
      assert.match(prompt, /"toolID":"prior-read"/)
      return { text: JSON.stringify({ decision: "investigate", reason: "Check the script contents", requests: [
        { type: "tool_result", messageID: "prior", toolID: "prior-read", offset: 0 },
      ] }) }
    }
    if (round === 2) {
      assert.match(prompt, /echo fixture-only/)
      assert.match(prompt, /Check the script contents/)
      return { text: JSON.stringify({ decision: "investigate", reason: "Verify user scope", requests: [
        { type: "history", offset: 0 },
      ] }) }
    }
    assert.equal(round, 3)
    assert.match(prompt, /"type":"evidence","round":2/)
    return { text: allowText }
  })
  harness.messages.splice(1, 0, { id: "prior", type: "assistant", content: [
    { type: "tool", id: "prior-read", name: "read", state: {
      status: "completed", input: { path: "script.sh" }, content: [{ type: "text", text: "echo fixture-only" }],
    } },
  ] })
  await harness.setup()
  assert.equal((await harness.run()).effect, "allow")
  assert.equal(harness.counts().generateCalls, 3)
})

test("an explicit reviewer ask denies by default with its question as the reason", async () => {
  const harness = createHarness({}, JSON.stringify({ decision: "ask", risk: "unknown", authorization: "unknown",
    reason: "Confirm the target deployment environment", matched_rules: [] }))
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "deny")
  assert.match((event as any).message, /Confirm the target deployment environment/)
})

test("turning auto-review off cancels active work and prevents late approval", async () => {
  let resolve!: (value: { text: string }) => void
  const harness = createHarness({}, () => new Promise((done) => { resolve = done }))
  await harness.setup()
  const pending = harness.run()
  await new Promise((done) => setImmediate(done))
  await harness.command("off")
  resolve({ text: allowText })
  assert.equal((await pending).effect, "ask")
  assert.equal(harness.generationSignal()?.aborted, true)
})

test("new user input cancels only that session's outstanding review", async () => {
  const harness = createHarness({}, (_input, { signal }) => aborts(signal!))
  await harness.setup()
  const pending = harness.run()
  await new Promise((done) => setImmediate(done))
  harness.admitPrompt("other-session")
  assert.equal(harness.generationSignal()?.aborted, false)
  harness.admitPrompt("ses_test")
  assert.equal((await pending).effect, "ask")
  assert.equal(harness.generationSignal()?.aborted, true)
})

test("deadline timers deny even when the wall clock moves backwards", async (t) => {
  let now = 10_000
  t.mock.method(Date, "now", () => now)
  const harness = createHarness({ timeoutMs: 1000 }, allowText, async () => new Promise(() => undefined))
  const cleanup = await harness.setup()
  const pending = harness.run()
  now = 9_000
  assert.equal((await pending).effect, "deny")
  await cleanup?.()
})

test("archive capture hooks release when storage hangs and permission review can recover", async () => {
  let hang = true
  const entries = new Map<string, any>()
  const storage = {
    get: async (key: string) => key.startsWith("history/") && hang ? new Promise(() => undefined) : entries.get(key),
    set: async (key: string, value: any) => { entries.set(key, value) },
  }
  const harness = createHarness({ timeoutMs: 1000 }, allowText, undefined, undefined, storage)
  const cleanup = await harness.setup()
  await harness.dispatch("ses_test", [])
  hang = false
  assert.equal((await harness.run()).effect, "allow")
  await cleanup?.()
})

test("a hung context read does not block the next same-session review after its deadline", async () => {
  let hang = true
  const harness = createHarness({ timeoutMs: 1000 }, allowText,
    async () => hang ? new Promise(() => undefined) : harness.messages)
  await harness.setup()
  assert.equal((await harness.run()).effect, "deny")
  hang = false
  await new Promise((done) => setImmediate(done))
  assert.equal((await harness.run()).effect, "allow")
})

test("independent sessions run concurrently while identical in-flight requests share one review", async () => {
  let release!: (result: { text: string }) => void
  const gate = new Promise<{ text: string }>((resolve) => { release = resolve })
  const harness = createHarness({}, () => gate)
  const cleanup = await harness.setup()
  const pending = ["one", "one", "two", "three", "four", "five"].map(sessionID => harness.run({ sessionID }))
  try {
    await new Promise((done) => setImmediate(done))
    assert.equal(harness.counts().generateCalls, 5)
    assert.equal(harness.counts().contextCalls, 5)
    release({ text: allowText })
    assert.ok((await Promise.all(pending)).every(event => event.effect === "allow"))
    // The two identical "one" evaluations share one review, so they must also
    // share one notice: five requests, five toasts, none duplicated.
    assert.equal(harness.counts().generateCalls, 5)
    assert.equal(harness.toasts().length, 5)
  } finally {
    release({ text: allowText })
    await cleanup?.()
  }
})

test("a hung verification read does not permanently wedge shared reviewer-model setup", async () => {
  // The host adapter cannot cancel a registry read, so a read that never settles
  // must still release the shared model initialization; otherwise every later
  // review would wait on the same stuck promise. The registry is modeled as lazy
  // (2.0.4+): `transform` does not run its callback, a read does.
  const selected: any = { providerID: "test", id: "reviewer", limit: { context: 128_000, output: 8192 }, variants: [], body: { max_tokens: 4096 } }
  let hang = true
  let verifications = 0
  let retained: ((editor: any) => void) | undefined
  const modelDomain = {
    transform: async (callback: (editor: any) => void) => {
      retained = callback
      return { dispose: async () => { retained = undefined; selected.variants = [] } }
    },
    list: () => {
      verifications++
      if (hang) return new Promise(() => undefined)
      retained?.({ get: () => selected, update: (_p: string, _m: string, update: (draft: any) => void) => update(selected) })
      return Promise.resolve({ data: [selected] })
    },
    default: async () => ({ data: selected }),
  }
  const harness = createHarness({ timeoutMs: 1000, modelOptions: { body: { max_tokens: 512 } } }, allowText, undefined, modelDomain)
  await harness.setup()
  assert.equal((await harness.run({ sessionID: "one" })).effect, "deny", "a stalled verification must not approve")
  hang = false
  // Retry rather than assume a fixed number of event-loop turns: the stalled
  // attempt is released by its own timeout, which need not land before one
  // setImmediate. Without the bounded registration this never recovers, so the
  // loop still fails the test after the bound.
  let recovered = false
  const giveUpAt = Date.now() + 5_000
  while (!recovered && Date.now() < giveUpAt) {
    recovered = (await harness.run({ sessionID: "two" })).effect === "allow"
    if (!recovered) await new Promise((done) => setTimeout(done, 25))
  }
  assert.ok(recovered, "a later review must retry instead of reusing the stuck initialization")
  assert.ok(verifications >= 2, "the retry must issue its own verification read")
})

test("plugin modelOptions select a derived variant once across concurrent reviews and dispose it", async () => {
  const selected: any = { providerID: "test", id: "reviewer", limit: { context: 128_000, output: 8192 }, variants: [], body: { max_tokens: 4096 } }
  let registrations = 0
  let disposals = 0
  const modelDomain = {
    transform: async (callback: (editor: any) => void) => {
      registrations++
      callback({ get: () => selected, update: (_p: string, _m: string, update: (draft: any) => void) => update(selected) })
      return { dispose: async () => { disposals++; selected.variants = [] } }
    },
    list: async () => ({ data: [selected] }),
  }
  const harness = createHarness({ modelOptions: { body: { max_tokens: 512 } } }, async (input) => {
    assert.equal(input.body, undefined, "unsupported generate fields must not be sent")
    assert.equal(input.model.variant, selected.variants[0].id)
    assert.equal(selected.variants[0].body.max_tokens, 512)
    assert.equal(selected.body.max_tokens, 4096)
    return { text: allowText }
  }, undefined, modelDomain)
  const cleanup = await harness.setup()
  const results = await Promise.all([harness.run({ sessionID: "one" }), harness.run({ sessionID: "two" })])
  assert.ok(results.every((event) => event.effect === "allow"))
  assert.equal(registrations, 1)
  await cleanup?.()
  assert.equal(disposals, 1)
  assert.deepEqual(selected.variants, [])
})

test("an explicit request body is applied to the derived variant, not the base model", async () => {
  // No body is written by default (the cap field is protocol-specific), so a body
  // is only present when the caller names one. It must reach the derived variant
  // while the base model and native variant stay untouched.
  const harness = createHarness({
    model: "test/reviewer#max",
    modelOptions: { body: { max_output_tokens: 2048 } },
  }, async (input) => {
    const variant = harness.catalogModel.variants.find((entry: any) => entry.id === input.model.variant)
    assert.deepEqual(variant.body, { reasoning: { effort: "high" }, max_output_tokens: 2048 })
    assert.deepEqual(variant.settings, { reasoningEffort: "high" })
    assert.equal(harness.catalogModel.variants[0].id, "max")
    assert.equal(harness.catalogModel.variants[0].body.max_output_tokens, undefined)
    return { text: allowText }
  })
  const cleanup = await harness.setup()
  assert.equal((await harness.run()).effect, "allow")
  await cleanup?.()
})

test("the default configuration registers no request overrides", async () => {
  // Registering nothing is deliberate: a guessed output-cap field is protocol
  // specific and would silently leave the reviewer output unbounded. The generate
  // call must therefore carry no request body of its own.
  let registrations = 0
  const selected: any = { providerID: "test", id: "reviewer", limit: { context: 128_000, output: 8192 }, variants: [] }
  const modelDomain = {
    transform: async () => { registrations++; return { dispose: async () => undefined } },
    list: async () => ({ data: [selected] }),
  }
  const harness = createHarness({}, (input) => {
    assert.equal(input.body, undefined, "no request body override is sent by default")
    return Promise.resolve({ text: allowText })
  }, undefined, modelDomain)
  const cleanup = await harness.setup()
  assert.equal((await harness.run()).effect, "allow")
  assert.equal(registrations, 0, "the default must not invent a protocol-specific body")
  await cleanup?.()
})

test("the RPC contract and the slash command share one toggle state and emit state events", async () => {
  const harness = createHarness()
  await harness.setup()
  assert.deepEqual(await harness.rpcStatus(), { enabled: true, humanFallback: false })
  await harness.rpcSetEnabled(false)
  assert.deepEqual(await harness.rpcStatus(), { enabled: false, humanFallback: false })
  assert.equal((await harness.run()).effect, "ask")
  assert.equal(await harness.command("on"), "Auto-review is enabled.")
  assert.deepEqual(await harness.rpcStatus(), { enabled: true, humanFallback: false })
  assert.equal((await harness.run()).effect, "allow")
  assert.deepEqual(harness.rpcEvents().filter((event) => event.name === "state").map((event) => event.name), ["state", "state"])
  assert.deepEqual(harness.rpcEvents().filter((event) => event.name === "state").map((event) => (event.data as { enabled: boolean }).enabled), [false, true])
})

test("the human fallback toggles over RPC and the slash command", async () => {
  // Default: the fallback is off, so a reviewer that cannot approve denies and an
  // unattended session cannot stall on a prompt nobody answers.
  const harness = createHarness({}, async () => { throw new Error("provider secret") })
  await harness.setup()
  const denied = await harness.run()
  assert.equal(denied.effect, "deny")
  assert.match(String((denied as { message?: string }).message), /Adjust the request/)
  assert.doesNotMatch(String((denied as { message?: string }).message), /human confirmation/i)

  assert.deepEqual(await harness.rpcSetFallback(true), { enabled: true, humanFallback: true })
  assert.equal((await harness.run()).effect, "ask")

  assert.equal(await harness.command("fallback off"), "Auto-review human fallback is disabled.")
  assert.equal((await harness.run()).effect, "deny")
  assert.equal(await harness.command("fallback status"), "Auto-review human fallback is disabled.")
  assert.equal(await harness.command("fallback"), "Auto-review human fallback is enabled.")
  assert.equal(await harness.command("fallback bogus"), "Usage: /auto-review fallback [on|off|toggle|status]")
})

test("an explicit human rule still asks when the fallback is off", async () => {
  // A configured rule is a deliberate confirmation requirement, not a fallback.
  const harness = createHarness({ humanReviewRules: [{ action: "read", resource: "*", reason: "always confirm" }] })
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "ask")
  assert.match(String((event as { message?: string }).message), /always confirm/)
})

test("a pre-compaction user restriction still reaches the reviewer", async () => {
  // Authorization is not backlog: user instructions survive the compaction
  // boundary even though the tool history before it does not. Losing them would
  // discard real authorization and remove the guarantee that an automatic
  // approval rests on a disclosed user instruction.
  const harness = createHarness()
  await harness.setup()
  harness.messages.splice(0, harness.messages.length,
    { id: "restriction", type: "user", text: "Only read files under src" },
    { id: "oldTool", type: "assistant", content: [
      { type: "tool", id: "tool-old", name: "read", state: { status: "completed", input: { path: "src/a.ts" },
        content: [{ type: "text", text: "PRE_BOUNDARY_SECRET" }] } },
    ] },
  )
  // The plugin observes the session first; the session then compacts, so the
  // context becomes the summary plus what follows it.
  await harness.dispatch("ses_test", harness.messages)
  harness.messages.splice(0, harness.messages.length,
    { id: "compact", type: "compaction", status: "completed", summary: "Working on the task", recent: "Continue" },
    { id: "user2", type: "user", text: "Read package.json" },
    { id: "assistant", type: "assistant", content: [
      { type: "tool", id: "tool", name: "read", state: { status: "running", input: { path: "package.json" } } },
    ] },
  )
  const event = await harness.run()
  assert.equal(event.effect, "allow")
  const prompt = harness.generatedPrompts()[0]!
  assert.match(prompt, /Only read files under src/, "pre-compaction authorization must survive the boundary")
  assert.doesNotMatch(prompt, /PRE_BOUNDARY_SECRET/, "the pre-compaction tool backlog must not enter the prompt")
})

test("a pre-compaction tool result stays retrievable by id without entering the prompt", async () => {
  // The prompt drops the pre-compaction tool backlog, but evidence is lazily
  // addressable over the whole transcript, so the reviewer can still verify an
  // earlier inspection instead of being forced to ask about material the coding
  // model already saw. This is the shape the live compaction smoke test relies on.
  let round = 0
  const harness = createHarness({}, async () => ({ text: round++ === 0
    ? JSON.stringify({ decision: "investigate", reason: "Verify the earlier inspection",
      requests: [{ type: "tool_result", messageID: "oldTool", toolID: "tool-old", offset: 0 }] })
    : allowText }))
  await harness.setup()
  harness.messages.splice(0, harness.messages.length,
    { id: "restriction", type: "user", text: "Only read files under src" },
    { id: "oldTool", type: "assistant", content: [
      { type: "tool", id: "tool-old", name: "read", state: { status: "completed", input: { path: "src/a.ts" },
        content: [{ type: "text", text: "PRE_BOUNDARY_SECRET" }] } },
    ] },
  )
  await harness.dispatch("ses_test", harness.messages)
  harness.messages.splice(0, harness.messages.length,
    { id: "compact", type: "compaction", status: "completed", summary: "Working on the task", recent: "Continue" },
    { id: "user2", type: "user", text: "Read package.json" },
    { id: "assistant", type: "assistant", content: [
      { type: "tool", id: "tool", name: "read", state: { status: "running", input: { path: "package.json" } } },
    ] },
  )
  const event = await harness.run()
  assert.equal(event.effect, "allow")
  assert.doesNotMatch(harness.generatedPrompts()[0]!, /PRE_BOUNDARY_SECRET/)
  assert.match(harness.generatedPrompts()[1]!, /PRE_BOUNDARY_SECRET/, "the original must come back as evidence")
})

test("a window with no user instruction cannot produce an automatic approval", async () => {
  // The compaction summary is context, not authorization; without a user
  // instruction there is nothing that could authorize the pending action.
  const harness = createHarness()
  await harness.setup()
  harness.messages.splice(0, harness.messages.length,
    { id: "compact", type: "compaction", status: "completed", summary: "Continue the task", recent: "" },
    { id: "assistant", type: "assistant", content: [
      { type: "tool", id: "tool", name: "read", state: { status: "running", input: { path: "package.json" } } },
    ] },
  )
  const event = await harness.run()
  assert.notEqual(event.effect, "allow")
  assert.equal(harness.counts().generateCalls, 0, "the reviewer must not be asked to authorize a request with no user instruction")
})

test("the compaction hook captures original history like the context hook", async () => {
  const harness = createHarness()
  await harness.setup()
  assert.equal(harness.counts().contextCalls, 0)
  await harness.compact()
  assert.equal(harness.counts().contextCalls, 1)
})

test("a compaction the plugin never observed still reviews routine work instead of denying it", async () => {
  // The main session compacted while the plugin was not loaded, so there is no
  // observed pre-compaction prefix. The review window is anchored at that
  // checkpoint and its summary stands in for the earlier instructions, exactly
  // as it does for the coding model, so the session must not be locked into
  // denying every later request for missing history.
  const harness = createHarness()
  await harness.setup()
  harness.messages.splice(0, harness.messages.length,
    { id: "compact", type: "compaction", status: "completed", summary: "The user asked to read package.json", recent: "Continue" },
    { id: "user", type: "user", text: "Read package.json" },
    { id: "assistant", type: "assistant", content: [
      { type: "tool", id: "tool", name: "read", state: { status: "running", input: { path: "package.json" } } },
    ] },
  )
  const event = await harness.run()
  assert.equal(event.effect, "allow")
  assert.deepEqual(harness.sessionWrites(), [])
  assert.equal(harness.toasts().at(-1)!.severity, "success")
})

test("reviewer degradation is reported as a toast and never writes to the session", async () => {
  const harness = createHarness({}, async () => { throw new Error("provider secret") })
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "deny")
  assert.deepEqual(harness.visibleMessages(), [], "failures must not leave pending synthetic inbox messages")
  assert.deepEqual(harness.sessionWrites(), [], "a notice must never write to the session")
  const toasts = harness.toasts()
  assert.equal(toasts.length, 1)
  assert.match(toasts[0]!.description, /reviewer model call failed/)
  assert.match(toasts[0]!.description, /provider secret/)
})

test("a degraded approval emits one toast and no session write", async () => {
  const harness = createHarness({ model: null })
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "allow")
  // The degraded approval gets exactly one notice: describing the fallback, not
  // the fallback notice plus a second plain approval notice.
  const toasts = harness.toasts()
  assert.equal(toasts.length, 1)
  assert.match(toasts[0]!.description, /catalog default model test\/reviewer/)
  assert.deepEqual(harness.sessionWrites(), [])
})

test("a subagent's notice names its origin and never writes to a session", async () => {
  const harness = createHarness({}, async () => { throw new Error("subagent failure") })
  harness.sessions["ses_test"] = { parentID: "ses_parent", agent: "review", title: "Inspect the fixture" }
  harness.sessions["ses_parent"] = { agent: "build" }
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "deny")
  const toasts = harness.toasts()
  assert.equal(toasts.length, 1)
  assert.match(toasts[0]!.description, /review subagent/)
  assert.match(toasts[0]!.description, /Inspect the fixture/)
  assert.match(toasts[0]!.description, /reviewer model call failed/)
  // The wake regression: routing used to post a message into the idle root
  // session, which resumed the parent model.
  assert.deepEqual(harness.sessionWrites(), [])
})

test("a nested subagent notice still names the originating subagent", async () => {
  const harness = createHarness({}, async () => { throw new Error("nested failure") })
  harness.sessions["ses_test"] = { parentID: "ses_mid", agent: "explore" }
  harness.sessions["ses_mid"] = { parentID: "ses_root", agent: "review" }
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "deny")
  const toasts = harness.toasts()
  assert.equal(toasts.length, 1)
  assert.match(toasts[0]!.description, /explore subagent/)
  assert.deepEqual(harness.sessionWrites(), [])
})

test("a root session notice needs no origin annotation", async () => {
  const harness = createHarness({}, async () => { throw new Error("failure") })
  await harness.setup()
  assert.equal((await harness.run()).effect, "deny")
  assert.doesNotMatch(harness.toasts()[0]!.description, /subagent/)
})

test("a session lookup failure still reports the notice without writing to a session", async () => {
  const harness = createHarness({}, async () => { throw new Error("failure") })
  harness.sessions["ses_test"] = { error: true }
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "deny")
  const toasts = harness.toasts()
  assert.equal(toasts.length, 1)})

test("a model fallback is surfaced once even for an approval", async () => {
  const harness = createHarness({ model: null })
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "allow")
  assert.match((event as any).message, /auto-review fallback/)
  const toasts = harness.toasts()
  assert.equal(toasts.length, 1)
  assert.match(toasts[0]!.description, /catalog default model test\/reviewer/)
  assert.deepEqual(harness.visibleMessages(), [])
  assert.deepEqual(harness.sessionWrites(), [])
})

test("every automatic approval leaves a reason-free toast and no session write", async () => {
  const harness = createHarness()
  await harness.setup()
  assert.equal((await harness.run()).effect, "allow")
  const toasts = harness.toasts()
  assert.equal(toasts.length, 1)
  assert.equal(toasts[0]!.description, "Auto-review approved read.")
  assert.equal(toasts[0]!.severity, "success")
  // An approval is toast-only: it must not commit a session message, because that
  // would resume an idle session.
  assert.deepEqual(harness.sessionWrites(), [])
})

test("the status command answers with a toast and writes nothing to the session", async () => {
  const harness = createHarness()
  await harness.setup()
  assert.equal(await harness.command("status"), "Auto-review is enabled.")
  assert.deepEqual(harness.visibleMessages(), [])
  assert.deepEqual(harness.sessionWrites(), [])
  assert.equal(harness.toasts().at(-1)!.severity, "info")
})

test("a session lookup that never settles still delivers the notice", async () => {
  // The origin annotation is best-effort; a stuck session query must not delay the
  // notice forever.
  const harness = createHarness({}, async () => { throw new Error("failure") })
  harness.sessions["ses_test"] = { hang: true }
  await harness.setup()
  const started = Date.now()
  const event = await harness.run()
  assert.equal(event.effect, "deny")
  const giveUpAt = Date.now() + 5_000
  while (harness.toasts().length === 0 && Date.now() < giveUpAt) {
    await new Promise((done) => setTimeout(done, 50))
  }
  assert.ok(Date.now() - started < 5_000, "the notice must not wait on an unbounded lookup")
  assert.equal(harness.toasts().length, 1)
  assert.doesNotMatch(harness.toasts()[0]!.description, /subagent/)
  assert.deepEqual(harness.sessionWrites(), [])
})
