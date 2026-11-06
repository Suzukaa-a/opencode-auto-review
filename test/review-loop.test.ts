import assert from "node:assert/strict"
import test from "node:test"
import { runReviewLoop, parseInvestigation } from "../src/review-loop.js"
import { captureEvidence } from "../src/evidence.js"
import { buildReviewPrompt, parseOptions } from "../src/policy.js"
import { estimateTokens } from "../src/context-budget.js"
import type { PermissionEvent } from "../src/types.js"

const options = parseOptions({})

const event: PermissionEvent = { sessionID: "s", action: "shell", resources: ["test"], effect: "ask",
  source: { type: "tool", messageID: "current", id: "pending" } }
const messages = [
  { type: "user", text: "Test the project" },
  { type: "assistant", id: "prior", content: [{ type: "tool", id: "read", name: "read", state: {
    status: "completed", input: { path: "package.json" }, content: [{ type: "text", text: "fixture result" }],
  } }] },
  { type: "assistant", id: "current" },
  { type: "user", text: "FUTURE_USER" },
]
const investigate = JSON.stringify({ decision: "investigate", reason: "Inspect prior read", requests: [
  { type: "tool_result", messageID: "prior", toolID: "read", offset: 0 },
] })

async function run(responses: string[], source = messages, maxInputTokens = 16_000) {
  let calls = 0
  const prompts: string[] = []
  const result = await runReviewLoop({
    lines: [JSON.stringify({ type: "user", text: "Test the project" }), JSON.stringify({ type: "review", tool: { name: "shell", input: { command: "npm test" } } })],
    evidence: captureEvidence(source, event), options, signal: new AbortController().signal,
    deadline: Date.now() + options.timeoutMs,
    maxInputTokens,
    generate: async (prompt) => { prompts.push(prompt); return { text: responses[calls++ % responses.length]!, timedOut: false } },
  })
  return { result, calls, prompts }
}

test("completed sibling results are retrievable while pending and later results stay hidden", async () => {
  const source = [
    { type: "user", text: "Run exactly once" },
    { type: "assistant", id: "current", content: [
      { type: "tool", id: "first", name: "shell", state: { status: "completed", input: { command: "charge 100" }, content: [{ type: "text", text: "charged" }] } },
      { type: "tool", id: "pending", name: "shell", state: { status: "running", input: { command: "charge 100" } } },
    ] },
    { type: "assistant", id: "future", content: [{ type: "tool", id: "later", name: "shell", state: { status: "completed", input: {}, content: [] } }] },
  ]
  const evidence = captureEvidence(source, event)
  assert.deepEqual(evidence.index.tools, [{ messageID: "current", toolID: "first", name: "shell" }])
  const result = await evidence.read({ type: "tool_result", messageID: "current", toolID: "first", offset: 0 }) as { text: string }
  assert.match(result.text, /charged/)
  assert.deepEqual(await evidence.read({ type: "tool_result", messageID: "future", toolID: "later", offset: 0 }), { error: "No completed result in the captured parent history" })
})

test("repeated evidence requests terminate rather than spin", async () => {
  const { result, calls } = await run([investigate, investigate])
  assert.equal(result.code, "stalled")
  assert.equal(result.decision, undefined)
  assert.equal(calls, 2)
})

test("investigation can exceed six rounds but stops before evidence exceeds the model input budget", async () => {
  const source = structuredClone(messages)
  source[1]!.content![0]!.state.content[0]!.text = "x".repeat(24_000)
  const pages = Array.from({ length: 7 }, (_, index) => JSON.stringify({ decision: "investigate", reason: "Read the next evidence page", requests: [
    { type: "tool_result", messageID: "prior", toolID: "read", offset: index * 4000 },
  ] }))
  const { result, calls } = await run([...pages, JSON.stringify({ decision: "allow", risk: "low", authorization: "high", matched_rules: [] })], source)
  assert.equal(result.decision?.decision, "allow")
  assert.equal(calls, 8)
  const small = await run(pages, source, estimateTokens(buildReviewPrompt([])) + 700)
  assert.equal(small.result.code, "context_limit")
  assert.equal(small.calls, 1, "oversized evidence must not trigger another model call")
})

test("malformed output is repaired using feedback in the next round", async () => {
  const { result, prompts } = await run(['not json', JSON.stringify({
    decision: "allow", risk: "medium", authorization: "high", matched_rules: [],
  })])
  assert.equal(result.decision?.decision, "allow")
  assert.match(prompts[1]!, /invalid_response/)
})

test("empty and whitespace output recover without involving the user", async () => {
  for (const empty of ["", "  \n"]) {
    const { result, calls, prompts } = await run([empty, JSON.stringify({
      decision: "allow", risk: "low", authorization: "high", matched_rules: [],
    })])
    assert.equal(result.decision?.decision, "allow")
    assert.equal(calls, 2)
    assert.match(prompts[1]!, /empty_response/)
  }
})

test("persistent empty output stops after one recovery attempt", async () => {
  const { result, calls } = await run([""])
  assert.equal(result.code, "empty_response")
  assert.equal(result.decision, undefined)
  assert.equal(calls, 2)
})

test("provider failure can recover within the original deadline", async () => {
  let calls = 0
  const result = await runReviewLoop({
    lines: [JSON.stringify({ type: "user", text: "Test the project" })],
    evidence: captureEvidence(messages, event), options, maxInputTokens: 16_000,
    signal: new AbortController().signal, deadline: Date.now() + options.timeoutMs,
    generate: async () => ++calls === 1 ? { timedOut: false, error: "temporary provider failure" }
      : { timedOut: false, text: JSON.stringify({ decision: "allow", risk: "low", authorization: "high", matched_rules: [] }) },
  })
  assert.equal(result.decision?.decision, "allow")
  assert.equal(calls, 2)
})

test("a timed out generation is not retried", async () => {
  let calls = 0
  const result = await runReviewLoop({
    lines: [], evidence: captureEvidence(messages, event), options, maxInputTokens: 16_000,
    signal: new AbortController().signal, deadline: Date.now() + options.timeoutMs,
    generate: async () => { calls++; return { timedOut: true } },
  })
  assert.equal(result.code, "timeout")
  assert.equal(calls, 1)
})

test("evidence is a snapshot and cannot access pending tools or future users", () => {
  const source = structuredClone(messages)
  const evidence = captureEvidence(source, event)
  source[0]!.text = "CHANGED"
  const history = JSON.stringify(evidence.read({ type: "history", offset: 0 }))
  assert.match(history, /Test the project/)
  assert.doesNotMatch(history, /FUTURE_USER|CHANGED/)
  assert.match(JSON.stringify(evidence.read({ type: "tool_result", messageID: "prior", toolID: "read", offset: 0 })), /fixture result/)
  assert.match(JSON.stringify(evidence.read({ type: "tool_result", messageID: "current", toolID: "pending", offset: 0 })), /No completed result/)
})

test("evidence request parser rejects executable and ambiguous requests", () => {
  for (const request of [
    { type: "shell", command: "echo unexpected", offset: 0 },
    { type: "history", offset: -1 },
    { type: "history", offset: 0, extra: true },
  ]) assert.equal(parseInvestigation(JSON.stringify({ decision: "investigate", reason: "why", requests: [request] })), undefined)
  assert.equal(parseInvestigation('{"decision":"investigate","reason":"a","reason":"b","requests":[]}'), undefined)
})

test("an allow is rejected when a real user instruction was never disclosed to the reviewer", async () => {
  const allow = JSON.stringify({ decision: "allow", risk: "low", authorization: "high", matched_rules: [] })
  const evidence = captureEvidence(messages, event)
  const rejected = await runReviewLoop({
    lines: [JSON.stringify({ type: "review", tool: { name: "shell", input: { command: "npm test" } } }),
      JSON.stringify({ type: "evidence", request: { type: "tool_result" }, result: {
        entries: [{ type: "user", text: "Test the project" }],
      } })],
    evidence, options, signal: new AbortController().signal,
    deadline: Date.now() + options.timeoutMs,
    maxInputTokens: 16_000,
    generate: async () => ({ text: allow, timedOut: false }),
  })
  // The user instruction is in the captured window, but the reviewer only met it
  // inside untrusted tool output, so it cannot authorize the action.
  assert.equal(rejected.code, "incomplete_authorization")
  assert.equal(rejected.decision, undefined)

  const accepted = await runReviewLoop({
    lines: [JSON.stringify({ type: "user", text: "Test the project" }),
      JSON.stringify({ type: "review", tool: { name: "shell", input: { command: "npm test" } } })],
    evidence, options, signal: new AbortController().signal,
    deadline: Date.now() + options.timeoutMs,
    maxInputTokens: 16_000,
    generate: async () => ({ text: allow, timedOut: false }),
  })
  assert.equal(accepted.decision?.decision, "allow")
})

test("recovering omitted original user messages can support automatic approval", async () => {
  let calls = 0
  const result = await runReviewLoop({
    lines: [JSON.stringify({ type: "review", tool: { name: "shell", input: { command: "npm test" } } })],
    evidence: captureEvidence(messages, event), options, signal: new AbortController().signal,
    deadline: Date.now() + options.timeoutMs,
    maxInputTokens: 16_000,
    generate: async () => ({ text: calls++ === 0
      ? JSON.stringify({ decision: "investigate", reason: "Recover omitted user restrictions", requests: [{ type: "history", offset: 0 }] })
      : JSON.stringify({ decision: "allow", risk: "low", authorization: "high", matched_rules: [] }), timedOut: false }),
  })
  assert.equal(result.decision?.decision, "allow")
  assert.equal(calls, 2)
})

test("old history offsets cannot disclose a new restriction in the current snapshot", async () => {
  const current = [
    { type: "user", text: "New restriction: do not deploy" },
    ...messages,
  ]
  const stale = JSON.stringify({ type: "evidence", request: { type: "history", offset: 0 }, result: { entries: [{ type: "user", text: "Test the project" }] } })
  const common = { lines: [stale], evidence: captureEvidence(current, event), options, maxInputTokens: 16_000,
    signal: new AbortController().signal, deadline: Date.now() + options.timeoutMs }
  const rejected = await runReviewLoop({ ...common, generate: async () => ({ text: JSON.stringify({ decision: "allow", risk: "low", authorization: "high", matched_rules: [] }), timedOut: false }) })
  assert.equal(rejected.code, "incomplete_authorization")
  let round = 0
  const recovered = await runReviewLoop({ ...common, generate: async () => ({ text: round++ === 0
    ? JSON.stringify({ decision: "investigate", reason: "Read current user restrictions", requests: [{ type: "history", offset: 0 }] })
    : JSON.stringify({ decision: "allow", risk: "low", authorization: "high", matched_rules: [] }), timedOut: false }) })
  assert.equal(recovered.code, "allow")
})

test("one deadline includes preparation and every model round", async (t) => {
  let now = 10_000
  t.mock.method(Date, "now", () => now)
  const deadline = now + options.timeoutMs
  now += 5000 // Time already spent loading context/model before entering the loop.
  const budgets: number[] = []
  const result = await runReviewLoop({
    lines: [JSON.stringify({ type: "user", text: "Test the project" })],
    evidence: captureEvidence(messages, event), options, maxInputTokens: 16_000,
    signal: new AbortController().signal, deadline,
    generate: async (_prompt, timeoutMs) => {
      budgets.push(timeoutMs)
      if (budgets.length === 1) {
        now += 40_000
        return { text: investigate, timedOut: false }
      }
      now += 45_001
      return { text: JSON.stringify({ decision: "allow", risk: "low", authorization: "high", matched_rules: [] }), timedOut: false }
    },
  })
  assert.deepEqual(budgets, [85_000, 45_000])
  assert.equal(result.code, "timeout")
  assert.equal(result.decision, undefined)
})
