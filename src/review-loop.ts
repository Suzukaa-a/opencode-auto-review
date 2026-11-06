import { buildReviewPrompt, type PluginOptions } from "./policy.js"
import { parseReviewResponse, StrictJsonParser } from "./response.js"
import type { captureEvidence, EvidenceRequest } from "./evidence.js"
import type { ReviewDecision } from "./types.js"
import { estimateTokens } from "./context-budget.js"

export interface ReviewOutcome {
  decision?: ReviewDecision
  message?: string
  code: string
  /** Reviewer-side degradation to surface to the user instead of hiding it. */
  notices?: string[]
}

interface StageResult { text?: string; timedOut: boolean; error?: string }

/**
 * Reason text shared by every "the reviewer could not approve" path. It must not
 * promise a human: with the human fallback disabled the same reason becomes a
 * denial, and a message that says confirmation is coming would both mislead the
 * coding model and tell it a permission boundary was relaxed.
 */
const REVIEW_FAILURE_NOTE = "This is not a safety judgment about the requested action."

/** Evidence-driven review: finish immediately when supported, investigate only as needed. */
export async function runReviewLoop(input: {
  lines: readonly string[]
  evidence: ReturnType<typeof captureEvidence>
  options: PluginOptions
  maxInputTokens: number
  signal: AbortSignal
  deadline: number
  generate: (prompt: string, timeoutMs: number) => Promise<StageResult>
  onJournal?: (lines: readonly string[]) => void
  onRound?: (round: number, outcome: string) => void
}): Promise<ReviewOutcome & { lines: string[] }> {
  const { options, signal } = input
  const lines = [...input.lines]
  const finish = (outcome: ReviewOutcome) => {
    lines.push(JSON.stringify({ type: "review_outcome", ...outcome }))
    return { ...outcome, lines }
  }
  const unavailable = (code: string, message: string) => finish({ code, message })
  const seen = new Set<string>()
  const disclosedUsers = new Set<string>()
  for (const line of lines) {
    const entry = JSON.parse(line)
    if (entry.type === "user" && typeof entry.text === "string") disclosedUsers.add(entry.text)
    if (entry.type === "evidence" && entry.request?.type === "history" && Array.isArray(entry.result?.entries)) {
      for (const user of entry.result.entries) {
        if (user.type === "user" && typeof user.text === "string") disclosedUsers.add(user.text)
      }
    }
  }
  // A single deadline covers all model rounds, not a new full timeout per round.
  const deadline = input.deadline
  let repairs = 0
  let recoveries = 0
  lines.push(JSON.stringify(input.evidence.index))
  for (let round = 1; ; round++) {
    if (signal.aborted) return unavailable("aborted", "Automatic review was cancelled")
    const prompt = buildReviewPrompt(lines, options.maxReviewTokens)
    if (estimateTokens(prompt) > input.maxInputTokens) {
      return unavailable("context_limit", "Review evidence exceeds the model input budget")
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) return unavailable("timeout", "Automatic review reached its deadline")
    // Capture the exact send before waiting: cancellation cannot erase it.
    input.onJournal?.(lines)
    const result = await input.generate(prompt, remaining)
    if (signal.aborted) return unavailable("aborted", "Automatic review was cancelled")
    if (Date.now() >= deadline) return unavailable("timeout", "Automatic review reached its deadline")
    if (!result.text?.trim()) {
      const code = result.timedOut ? "timeout" : result.error ? "provider_failure" : "empty_response"
      input.onRound?.(round, code)
      if (result.timedOut) return unavailable("timeout", "Automatic review reached its deadline")
      // Retry generation only, never the pending operation. All attempts share the deadline.
      if (recoveries++ < 1) {
        lines.push(JSON.stringify({ type: "reviewer_round", round, status: code,
          feedback: "The reviewer returned no decision. Return the required JSON decision concisely; finish the final JSON within the output budget." }))
        continue
      }
      return unavailable(code, result.error
        ? `Automatic review could not complete because the reviewer model call failed (${result.error}). ${REVIEW_FAILURE_NOTE}`
        : `Automatic review returned empty output after one recovery attempt. ${REVIEW_FAILURE_NOTE}`)
    }
    // Validate before retaining model text; arbitrary output never becomes protocol.
    const decision = parseReviewResponse(result.text)
    if (decision) {
      if (decision.decision === "allow" && input.evidence.authorization.some((entry) => !disclosedUsers.has(entry.text))) {
        return unavailable("incomplete_authorization", "Original user instructions were omitted from the reviewed context, so the review could not confirm authorization")
      }
      input.onRound?.(round, decision.decision)
      return finish({ code: decision.decision, decision })
    }
    const investigation = parseInvestigation(result.text)
    input.onRound?.(round, investigation ? "investigate" : "invalid_response")
    if (investigation) {
      lines.push(JSON.stringify({ type: "reviewer_round", round, ...investigation }))
      for (const request of investigation.requests) {
        const key = JSON.stringify(request)
        if (seen.has(key)) return unavailable("stalled", "Reviewer repeated an evidence request without making progress")
        seen.add(key)
        const evidence = JSON.stringify({ type: "evidence", round, request, result: await input.evidence.read(request) })
        // Never silently truncate a fact and then approve based on a partial fact.
        if (estimateTokens(buildReviewPrompt([...lines, evidence], options.maxReviewTokens)) > input.maxInputTokens) {
          return unavailable("context_limit", "Requested evidence exceeds the model input budget")
        }
        lines.push(evidence)
        if (request.type === "history") {
          for (const entry of input.evidence.authorization) {
            if (entry.offset >= request.offset && entry.offset < request.offset + 8) disclosedUsers.add(entry.text)
          }
        }
      }
    } else {
      if (repairs++ >= 1) return unavailable("review_failure", "Automatic review returned invalid decisions after one format repair")
      lines.push(JSON.stringify({ type: "reviewer_round", round, status: "invalid_response", feedback: "Return a valid final decision or an investigate request using the specified JSON schema" }))
    }
  }
}

export function parseInvestigation(text: string): { decision: "investigate"; reason: string; requests: EvidenceRequest[] } | undefined {
  if (Buffer.byteLength(text, "utf8") > 16_384) return
  try {
    const value = new StrictJsonParser(text.trim()).parse() as Record<string, unknown>
    if (!value || Object.keys(value).sort().join(",") !== "decision,reason,requests" || value.decision !== "investigate" ||
      typeof value.reason !== "string" || !value.reason.trim() || value.reason.length > 2048 ||
      !Array.isArray(value.requests) || value.requests.length < 1 || value.requests.length > 4) return
    const requests: EvidenceRequest[] = []
    for (const request of value.requests) {
      if (!request || !Number.isSafeInteger(request.offset) || request.offset < 0) return
      if (request.type === "history" && Object.keys(request).sort().join(",") === "offset,type") {
        requests.push({ type: "history", offset: request.offset })
      } else if (request.type === "tool_result" && Object.keys(request).sort().join(",") === "messageID,offset,toolID,type" &&
        typeof request.messageID === "string" && request.messageID.length > 0 && request.messageID.length <= 256 &&
        typeof request.toolID === "string" && request.toolID.length > 0 && request.toolID.length <= 256) {
        requests.push({ type: "tool_result", messageID: request.messageID, toolID: request.toolID, offset: request.offset })
      } else return
    }
    return { decision: "investigate", reason: value.reason, requests }
  } catch { return }
}
