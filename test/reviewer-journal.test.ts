import assert from "node:assert/strict"
import test from "node:test"
import { prepareReviewJournal } from "../src/reviewer-journal.js"
import { buildReviewPrompt, buildReviewSystemPrompt } from "../src/policy.js"
import { estimateTokens } from "../src/context-budget.js"
import type { ReviewRequest } from "../src/types.js"

const user = { type: "user" as const, text: "Inspect files" }
const tool = (path: string) => ({ type: "tool" as const, name: "read", input: { path } })
const request = (context: ReviewRequest["context"]): ReviewRequest => ({ context, permission: { action: "read", resources: ["a.ts"] } })

test("the complete prior request and investigation remain the next request's exact prefix", () => {
  const first = prepareReviewJournal(undefined, request([user, tool("a.ts")]), 20_000)!
  const sent = [...first.lines,
    JSON.stringify({ type: "evidence_index", historyEntries: 1, tools: [] }),
    JSON.stringify({ type: "reviewer_round", decision: "investigate", requests: [{ type: "history", offset: 0 }] }),
    JSON.stringify({ type: "evidence", request: { type: "history", offset: 0 }, result: { entries: [user] } }),
    JSON.stringify({ type: "review_outcome", code: "allow" }),
  ]
  const second = prepareReviewJournal({ ...first, body: sent }, request([user, tool("a.ts"), tool("b.ts")]), 20_000)!
  assert.equal(second.epoch, first.epoch)
  assert.ok(second.prompt.startsWith(buildReviewPrompt(sent) + "\n"))
  assert.deepEqual(second.lines.slice(0, sent.length), sent)
  assert.equal(JSON.parse(second.lines.at(-1)!).tool.input.path, "b.ts")
})

test("parallel and repeated evaluations append assessment records without changing the sent prefix", () => {
  const first = prepareReviewJournal(undefined, request([user, tool("a.ts")]), 20_000)!
  const parallel = prepareReviewJournal(first, request([user, tool("b.ts")]), 20_000)!
  const repeated = prepareReviewJournal(parallel, request([user, tool("b.ts")]), 20_000)!
  assert.ok(parallel.prompt.startsWith(first.prompt + "\n"))
  assert.ok(repeated.prompt.startsWith(parallel.prompt + "\n"))
  assert.equal(repeated.epoch, 0)
})

test("new restrictions and completed actions append in their original order", () => {
  const first = prepareReviewJournal(undefined, request([user, tool("a.ts")]), 20_000)!
  const next = prepareReviewJournal(first, request([user, tool("a.ts"),
    { type: "user", text: "Deploy once" }, { type: "tool", name: "shell", input: { command: "deploy --once" } },
    { type: "user", text: "Stop deployments" }, tool("b.ts"),
  ]), 20_000)!
  const appended = next.lines.slice(first.lines.length).map(line => JSON.parse(line))
  assert.deepEqual(appended.slice(0, 4), [tool("a.ts"),
    { type: "user", text: "Deploy once" }, { type: "tool", name: "shell", input: { command: "deploy --once" } },
    { type: "user", text: "Stop deployments" },
  ])
})

test("persisted complete journals restore their exact sent prefix", () => {
  const first = prepareReviewJournal(undefined, request([user, tool("a.ts")]), 20_000)!
  const persisted = JSON.parse(JSON.stringify({ ...first, body: [...first.lines, JSON.stringify({ type: "review_outcome", code: "deny" })] }))
  const next = prepareReviewJournal(persisted, request([user, tool("a.ts"), tool("b.ts")]), 20_000)!
  assert.deepEqual(next.lines.slice(0, persisted.body.length), persisted.body)
})

test("compaction and rollback rebuild journal while fixed system remains identical", () => {
  const first = prepareReviewJournal(undefined, request([user, tool("a.ts")]), 20_000)!
  const compacted = prepareReviewJournal(first, { ...request([user, { type: "compaction", summary: "short", recent: "read" }, tool("b.ts")]), checkpoint: "cp1" }, 20_000)!
  assert.equal(compacted.epoch, first.epoch + 1)
  const rolledBack = prepareReviewJournal(compacted, request([{ type: "user", text: "Different branch" }, tool("c.ts")]), 20_000)!
  assert.equal(rolledBack.epoch, compacted.epoch + 1)
  assert.doesNotMatch(rolledBack.prompt, /b\.ts/)
  for (const item of [first, compacted, rolledBack]) assert.ok(item.prompt.startsWith(buildReviewSystemPrompt() + "\n"))
})

test("rollback to identical commands with new tool identities discards old evidence", () => {
  const context = [user, tool("same.ts"), tool("pending.ts")]
  const first = prepareReviewJournal(undefined, { ...request(context), sourceIDs: ["u", "tool-A", "pending-A"] }, 20_000)!
  const prior = { ...first, body: [...first.lines, JSON.stringify({ type: "evidence", result: { text: "OLD_BRANCH_RESULT" } })] }
  const next = prepareReviewJournal(prior, { ...request(context), sourceIDs: ["u", "tool-B", "pending-B"] }, 20_000)!
  assert.equal(next.epoch, first.epoch + 1)
  assert.doesNotMatch(next.prompt, /OLD_BRANCH_RESULT/)
})

test("budget exhaustion rebuilds instead of editing previously sent records", () => {
  const budget = estimateTokens(buildReviewPrompt([])) + 2_500
  let state = prepareReviewJournal(undefined, request([user, tool("a.ts")]), budget)!
  const history: ReviewRequest["context"] = [user]
  let rebuilt = false
  for (let i = 0; i < 30; i++) {
    history.push(tool("p".repeat(120) + i))
    const next = prepareReviewJournal(state, request([...history, tool("pending.ts")]), budget)!
    assert.ok(estimateTokens(next.prompt) <= budget)
    if (next.epoch === state.epoch) assert.ok(next.prompt.startsWith(state.prompt + "\n"))
    else { assert.equal(next.epoch, state.epoch + 1); rebuilt = true }
    state = next
  }
  assert.ok(rebuilt)
})

test("new epoch selection keeps the governing instruction and marks omissions", () => {
  const base = estimateTokens(buildReviewPrompt([]))
  const context: ReviewRequest["context"] = [
    { type: "user", text: "FIRST_CONSTRAINT" },
    { type: "user", text: "MIDDLE_" + "m".repeat(500) },
    { type: "user", text: "LATEST_REQUEST" }, tool("a.ts"),
  ]
  const prepared = prepareReviewJournal(undefined, request(context), base + 300)!
  assert.match(prepared.prompt, /FIRST_CONSTRAINT/)
  assert.match(prepared.prompt, /LATEST_REQUEST/)
  assert.match(prepared.lines[0]!, /"users":1/)
  assert.equal(prepareReviewJournal(undefined, request([user, { type: "user", text: "x".repeat(3_000) }, tool("a.ts")]), base + 200), undefined)
})

test("fresh epoch leaves headroom and prioritizes user instructions", () => {
  const budget = estimateTokens(buildReviewPrompt([])) + 8_000
  const prepared = prepareReviewJournal(undefined, request([user,
    ...Array.from({ length: 60 }, (_, i) => tool("p".repeat(300) + i)),
    { type: "user", text: "Never access secrets" }, tool("a.ts"),
  ]), budget)!
  assert.match(prepared.prompt, /Never access secrets/)
  assert.ok(estimateTokens(prepared.prompt) < budget * 0.95)
})

test("older persistence shapes rebuild and shrinking budgets stay bounded", () => {
  const budget = estimateTokens(buildReviewPrompt([])) + 5_000
  const context = [user, ...Array.from({ length: 40 }, (_, i) => tool("p".repeat(300) + i)), tool("a.ts")]
  const previous = prepareReviewJournal(undefined, request(context), budget)!
  const old = { ...previous, version: 5, sealed: true, outcomes: [] }
  assert.equal(prepareReviewJournal(old, request(context), budget)!.epoch, 0)
  const smaller = prepareReviewJournal(previous, request(context), budget - 4_000)!
  assert.equal(smaller.epoch, previous.epoch + 1)
  assert.ok(estimateTokens(smaller.prompt) <= budget - 4_000)
})
