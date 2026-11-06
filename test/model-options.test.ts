import assert from "node:assert/strict"
import test from "node:test"
import { parseOptions } from "../src/policy.js"
import { registerModelOptions } from "../src/model-options.js"

function catalog() {
  const source = { providerID: "p", id: "m", body: { max_tokens: 8192 }, variants: [{ id: "low",
    settings: { reasoningEffort: "low", nested: { keep: true, change: 1 }, list: [1, 2] },
    body: { max_tokens: 2048, reasoning: { effort: "low", summary: "auto" } }, headers: { "x-fixture": "keep" },
  }] }
  let current: any = structuredClone(source)
  let transform: ((editor: any) => void) | undefined
  const replay = () => {
    current = structuredClone(source)
    // 2.0.4 flattens the model editor: `editor.get`/`editor.update`.
    transform?.({
      get: (provider: string, id: string) => provider === "p" && id === "m" ? current : undefined,
      update: (_provider: string, _id: string, update: (draft: any) => void) => update(current),
    })
  }
  const api = {
    transform: async (callback: (editor: any) => void) => {
      transform = callback
      replay()
      return { dispose: async () => { transform = undefined; replay() } }
    },
  }
  return { api: api as any, source, current: () => current, replay }
}

test("no request body is written by default; an explicit body passes through unchanged", () => {
  // The output-cap field is protocol-specific, and `body` is a raw HTTP overlay,
  // so the plugin does not guess one. Anything the user names is sent verbatim.
  assert.deepEqual(parseOptions({}).modelOptions, undefined)
  assert.deepEqual(parseOptions(undefined).modelOptions, undefined)
  assert.deepEqual(parseOptions({ maxReviewTokens: 1024 }).modelOptions, undefined)
  assert.deepEqual(parseOptions({ modelOptions: { settings: { reasoningEffort: "low" } } }).modelOptions,
    { settings: { reasoningEffort: "low" } })
  for (const key of ["input", "messages", "system", "instructions", "tools", "tool_choice", "previous_response_id", "conversation"]) {
    assert.throws(() => parseOptions({ modelOptions: { body: { [key]: "override" } } }), /cannot override/)
  }
  for (const body of [{ max_output_tokens: 512 }, { max_completion_tokens: 512 }, {}]) {
    assert.deepEqual(parseOptions({ modelOptions: { body } }).modelOptions?.body, body)
  }
})

test("derived reviewer variant deep-merges overrides without changing original model or variant", async () => {
  const c = catalog()
  const options = { settings: { nested: { change: 2 }, list: [3] }, body: { max_tokens: 128, reasoning: { effort: "minimal" } } }
  const registered = await registerModelOptions(c.api, { providerID: "p", id: "m", variant: "low" }, options)
  if ("error" in registered) throw new Error(registered.error)
  assert.match(registered.model.variant!, /^opencode-auto-review-/)
  assert.deepEqual(c.current().body, c.source.body)
  assert.deepEqual(c.current().variants[0], c.source.variants[0])
  const derived = c.current().variants[1]
  assert.deepEqual(derived.settings, { reasoningEffort: "low", nested: { keep: true, change: 2 }, list: [3] })
  assert.deepEqual(derived.body, { max_tokens: 128, reasoning: { effort: "minimal", summary: "auto" } })
  assert.deepEqual(derived.headers, { "x-fixture": "keep" })
  options.body.max_tokens = 999
  c.replay()
  assert.equal(c.current().variants.length, 2)
  assert.equal(c.current().variants[1].body.max_tokens, 128)
  await registered.dispose()
  assert.deepEqual(c.current(), c.source)
})
