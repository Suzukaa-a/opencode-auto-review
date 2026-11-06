import assert from "node:assert/strict"
import test from "node:test"
import { parseReviewResponse } from "../src/response.js"

const valid = {
  decision: "allow",
  risk: "low",
  authorization: "high",
  reason: "The requested read is narrow and directly authorized",
  matched_rules: ["project-read"],
}

test("accepts a matrix-consistent allow", () => {
  assert.deepEqual(parseReviewResponse(`  ${JSON.stringify(valid)}\n`), valid)
  assert.deepEqual(parseReviewResponse(JSON.stringify({
    decision: "allow", risk: "low", authorization: "high", matched_rules: [],
  })), { decision: "allow", risk: "low", authorization: "high", matched_rules: [] })
})

test("a bare allow is never upgraded to a fabricated risk/authorization assessment", () => {
  assert.equal(parseReviewResponse('{"decision":"allow"}'), undefined)
})

test("rejects contradictory allows as protocol errors", () => {
  for (const patch of [
    { risk: "high", authorization: "medium" },
    { risk: "unknown" },
    { authorization: "low" },
    { authorization: "unknown" },
  ]) {
    assert.equal(parseReviewResponse(JSON.stringify({ ...valid, ...patch })), undefined)
  }
})

test("high-risk approval requires exact authorization and an explicit rationale", () => {
  const approved = { ...valid, risk: "high", authorization: "high", reason: "The user explicitly approved deleting the named staging database after seeing the data-loss risk" }
  assert.deepEqual(parseReviewResponse(JSON.stringify(approved)), approved)
  const { reason: _reason, ...withoutReason } = approved
  assert.equal(parseReviewResponse(JSON.stringify(withoutReason)), undefined)
  assert.deepEqual(parseReviewResponse(JSON.stringify({ ...approved, risk: "critical" })), { ...approved, risk: "critical", decision: "deny" })
})

test("critical risk always becomes a denial rather than a confirmation", () => {
  const pending = { ...valid, decision: "ask", risk: "critical", reason: "Credentials would leave for an untrusted destination" }
  assert.deepEqual(parseReviewResponse(JSON.stringify(pending)), { ...pending, decision: "deny" })
})

test("confirmation preserves the known risk and authorization", () => {
  const pending = { ...valid, decision: "ask", risk: "high", authorization: "medium", reason: "Confirm deletion of the named database" }
  assert.deepEqual(parseReviewResponse(JSON.stringify(pending)), pending)
})

test("rejects malformed or expanded responses", () => {
  const cases = [
    "",
    `\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``,
    `${JSON.stringify(valid)} trailing`,
    JSON.stringify({ ...valid, decision: "escalate" }),
    JSON.stringify({ ...valid, extra: true }),
    `{"decision":"deny","decision":"allow","risk":"low","authorization":"high","reason":"ok","matched_rules":[]}`,
  ]
  for (const value of cases) assert.equal(parseReviewResponse(value), undefined)
})
