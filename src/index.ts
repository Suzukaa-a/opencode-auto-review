import { Plugin } from "@opencode/plugin"
import { createHash } from "node:crypto"
import { KeyedQueue } from "./keyed-queue.js"
import { createReviewerTransport } from "./reviewer-transport.js"
import { captureEvidence } from "./evidence.js"
import { runReviewLoop, type ReviewOutcome } from "./review-loop.js"
import { assertReviewerBody, registerModelOptions, type ReviewerModel } from "./model-options.js"
import { ReviewArchive } from "./review-archive.js"
import { estimateTokens, inputTokenBudget } from "./context-budget.js"
import {
  buildReviewSystemPrompt,
  findHumanReviewReason,
  isEligibleAction,
  parseOptions,
} from "./policy.js"
import { buildReviewRequest } from "./review-input.js"
import { prepareReviewJournal } from "./reviewer-journal.js"
import { AutoReview } from "./rpc.js"
import type { PermissionEvent, ReviewerJournalState, ReviewRequest } from "./types.js"

const FAILURE_MESSAGE = "The request could not be verified for automatic approval."
const REVIEWER_FAILURE_MESSAGE = "Automatic review did not return a complete valid decision. This is not a safety judgment about the requested action."

/**
 * Where the reviewer journal snapshot for a session is persisted. It must outlive
 * the in-memory map: a lost snapshot rebuilds the journal, and a rebuild writes a
 * different first line, which invalidates the provider's cached prefix for the
 * whole journal.
 */
function journalKey(sessionID: string): string {
  return `journal/${sessionID}`
}

/**
 * Journal persistence.
 *
 * It is deliberately **best-effort and off the review path**: the in-memory map is
 * authoritative for the running instance, so a storage failure must never turn a
 * valid approval into a timeout or block the next review in the session.
 *
 * Ordering is what makes it safe. The queue holds at most one snapshot per session
 * (the newest, so a single hung or failing session cannot accumulate a backlog),
 * and a single drain loop per session writes them one at a time — a newer snapshot
 * can never be overtaken by an older write that finishes later, whether the late
 * write comes from this instance or from one that has already been recreated. The
 * state is at module scope precisely so a recreated instance in the same process
 * shares the same queue and drain loop. The bound is per session: each session
 * with an outstanding write contributes at most one pending entry and one drain
 * flag, so the total is proportional to sessions with unflushed snapshots, not to
 * the number of reviews.
 */
type JournalWrite = { storage: Plugin.Context["storage"]; sessionID: string; snapshot: ReviewerJournalState }
const journalPending = new Map<string, JournalWrite>()
const journalDraining = new Set<string>()
const latestJournals = new Map<string, { snapshot: ReviewerJournalState; owner: symbol }>()

function publishJournal(key: string, storage: Plugin.Context["storage"], sessionID: string, snapshot: ReviewerJournalState, owner: symbol): void {
  const copy = structuredClone(snapshot)
  latestJournals.delete(key)
  latestJournals.set(key, { snapshot: copy, owner })
  if (latestJournals.size > 128) latestJournals.delete(latestJournals.keys().next().value!)
  journalPending.set(key, { storage, sessionID, snapshot: copy })
  void drainJournal(key)
}

async function drainJournal(key: string): Promise<void> {
  if (journalDraining.has(key)) return
  journalDraining.add(key)
  try {
    for (;;) {
      const write = journalPending.get(key)
      if (!write) return
      journalPending.delete(key)
      try { await write.storage.set(journalKey(write.sessionID), JSON.parse(JSON.stringify(write.snapshot))) }
      catch { continue }
    }
  } finally { journalDraining.delete(key) }
}

/** How the CLI presents a reviewer notice. */
type NoticeSeverity = "success" | "info" | "warning" | "error"

export default Plugin.define({
  id: "opencode-auto-review",
  async setup(ctx) {
    const options = parseOptions(ctx.options)
    const scope = JSON.stringify([ctx.location.directory, ctx.location.workspaceID ?? null])
    const transport = await createReviewerTransport(ctx.session, buildReviewSystemPrompt(options.maxReviewTokens), ctx.storage, scope)
    let enabled = options.enabled
    let humanFallback = options.humanFallback
    let model: ReviewerModel | undefined
    let modelNotices: string[] = []
    let pendingModel: Promise<{ model: ReviewerModel | undefined; notices: string[] }> | undefined
    const modelController = new AbortController()
    let modelRegistration: { dispose(): Promise<void> } | undefined
    const inFlight = new Map<string, Promise<ReviewOutcome>>()
    const activeControllers = new Map<AbortController, string>()
    const reviewerQueue = new KeyedQueue()
    const reviewerStates = new Map<string, ReviewerJournalState>()
    const archive = new ReviewArchive(ctx.storage, (sessionID, signal) =>
      raceWithAbort(ctx.session.context({ sessionID }, { signal }), signal))
    let disposed = false
    const diagnose = (data: Record<string, string>) => {
      if (options.debug) console.info(`opencode-auto-review ${JSON.stringify(data)}`)
    }

    // The authoritative toggle state is shared with the TUI over RPC. Emitting
    // the state event keeps every client in sync regardless of which code path
    // (slash command or RPC call) performed the change.
    let emitState: () => void = () => undefined
    const setEnabled = (next: boolean): boolean => {
      if (disposed) return enabled
      if (enabled === next) return enabled
      enabled = next
      if (!enabled) for (const controller of activeControllers.keys()) controller.abort()
      emitState()
      return enabled
    }
    // With fallback off, a decision that needs a human is a deny instead of a
    // prompt, so an unattended session cannot stall on a question nobody answers.
    const setHumanFallback = (next: boolean): boolean => {
      if (disposed) return humanFallback
      if (humanFallback === next) return humanFallback
      humanFallback = next
      emitState()
      return humanFallback
    }

    const rpcRegistration = await ctx.rpc.register(AutoReview, {
      status: async () => ({ enabled, humanFallback }),
      setEnabled: async (input) => {
        const requested = (input as { enabled?: unknown } | undefined)?.enabled
        if (typeof requested === "boolean") setEnabled(requested)
        return { enabled, humanFallback }
      },
      setFallback: async (input) => {
        const requested = (input as { humanFallback?: unknown } | undefined)?.humanFallback
        if (typeof requested === "boolean") setHumanFallback(requested)
        return { enabled, humanFallback }
      },
    })
    emitState = () => {
      void rpcRegistration.events.emit("state", { enabled, humanFallback }).catch(() => undefined)
    }
    let emitNotice: (description: string, severity: NoticeSeverity) => void = () => undefined
    emitNotice = (description, severity) => {
      void rpcRegistration.events.emit("notice", { description, severity }).catch(() => undefined)
    }

    // Reviewer notices are delivered to the CLI as a toast over the plugin RPC
    // contract and are never written to the session.
    //
    // Every session-writing option either wakes the coding model or leaks into
    // it. `session.synthetic` with `resume: true` (the default) resumes an idle
    // session and adds a model turn; `resume: false` parks the body in the bottom
    // inbox, where the next prompt promotes it into the transcript. The host also
    // replays a committed notice body into later model requests as a user
    // message. OpenCode V1 had an ignored, no-reply session message for exactly
    // this use; V2 removed it (opencode#48644), so a CLI toast is the only
    // supported surface that is visible without touching the session.
    //
    // The accepted cost is that a notice is transient and needs a connected CLI:
    // a headless `opencode run` has no notification surface at all. The
    // permission event itself remains the authoritative record, and its message
    // still carries the reason inline in whatever client asked.
    //
    // Concurrent identical evaluations share one review (see `reviewRequest`), so
    // they must also share one notice. Keyed by request identity, and cleared when
    // a fresh review starts so a later legitimate review still notifies.
    const notified = new Set<string>()

    const postNotice = (
      request: string,
      description: string,
      sessionID: string,
      severity: NoticeSeverity,
    ): void => {
      if (disposed) return
      if (notified.has(request)) return
      notified.add(request)
      // Bound the marker set; request identities are unique per evaluation and a
      // stale marker only matters until that request is reviewed again.
      if (notified.size > 512) notified.delete(notified.values().next().value!)
      void describeOrigin(sessionID, request)
        .then((origin) => {
          if (disposed) return
          emitNotice(origin ? `${description} (from ${origin})` : description, severity)
        })
        .catch((error) => diagnose({ action: "notice", request, outcome: "notice_failed", reason: describeError(error) }))
    }

    // Every automatic approval leaves a trace: a silent allow is indistinguishable
    // from no review at all. The notice deliberately carries no reason, so an
    // ordinary approval cannot be mistaken for a considered risk judgement. The
    // permission message keeps whatever rationale the reviewer supplied.
    const notifyApproval = (sessionID: string, action: string, request: string): void => {
      diagnose({ action, request, outcome: "notice_approved" })
      postNotice(request, `Auto-review approved ${action}.`, sessionID, "success")
    }

    const notifyReview = (
      sessionID: string,
      action: string,
      request: string,
      reason: string,
    ): void => {
      const detail = `Auto-review notice (${action}): ${reason.trim()}`
      diagnose({ action, request, outcome: "notice", reason: detail })
      postNotice(request, detail, sessionID, "warning")
    }

    // A subagent runs in its own child session, so the notice names the
    // originating subagent to stay attributable. Successful lookups are cached
    // because a child session's identity is stable; failures are not cached, so a
    // transient lookup error cannot bury every later notice. The lookup is bounded
    // because a notice is best-effort: a session query that never settles must not
    // delay the notice forever.
    const NOTICE_ORIGIN_TIMEOUT_MS = 1_000
    const noticeOrigins = new Map<string, string | undefined>()
    async function describeOrigin(sessionID: string, request: string): Promise<string | undefined> {
      if (noticeOrigins.has(sessionID)) return noticeOrigins.get(sessionID)
      let timer: ReturnType<typeof setTimeout> | undefined
      let timedOut = false
      try {
        const reviewed = await Promise.race([
          ctx.session.get({ sessionID }),
          new Promise<undefined>((resolve) => {
            timer = setTimeout(() => { timedOut = true; resolve(undefined) }, NOTICE_ORIGIN_TIMEOUT_MS)
          }),
        ])
        if (timedOut) {
          diagnose({ action: "notice_route", request, outcome: "timeout" })
          return undefined
        }
        const origin = reviewed?.parentID ? sessionOrigin(reviewed) : undefined
        if (!disposed) {
          noticeOrigins.set(sessionID, origin)
          if (noticeOrigins.size > 256) noticeOrigins.delete(noticeOrigins.keys().next().value!)
        }
        return origin
      } catch (error) {
        diagnose({ action: "notice_route", request, outcome: "failed", reason: describeError(error) })
        return undefined
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    function sessionOrigin(session: { agent?: string; title?: string } | undefined): string {
      const agent = typeof session?.agent === "string" && session.agent.trim() ? session.agent.trim() : undefined
      const title = typeof session?.title === "string" && session.title.trim() ? session.title.trim() : undefined
      return [agent ? `${agent} subagent` : "subagent", title ? `"${title}"` : undefined].filter(Boolean).join(" ")
    }

    const commandRegistration = await ctx.command.transform((draft) => {
      draft.add({
        name: "auto-review",
        description: "Usage: /auto-review [on|off|toggle|status] or /auto-review fallback [on|off|toggle|status]",
        execute: async ({ prompt }) => {
          const [scope, argument] = prompt.text.trim().toLowerCase().split(/\s+/)
          if (scope === "fallback" || scope === "human") {
            const action = argument || "toggle"
            if (action === "on" || action === "enable") setHumanFallback(true)
            else if (action === "off" || action === "disable") setHumanFallback(false)
            else if (action === "toggle") setHumanFallback(!humanFallback)
            else if (action !== "status") {
              showStatus("Usage: /auto-review fallback [on|off|toggle|status]")
              return
            }
            showStatus(`Auto-review human fallback is ${humanFallback ? "enabled" : "disabled"}.`)
            return
          }
          const action = scope || "toggle"
          if (action === "on" || action === "enable") setEnabled(true)
          else if (action === "off" || action === "disable") setEnabled(false)
          else if (action === "toggle") setEnabled(!enabled)
          else if (action !== "status") {
            showStatus("Usage: /auto-review [on|off|toggle|status]")
            return
          }
          showStatus(`Auto-review is ${enabled ? "enabled" : "disabled"}.`)
        },
      })
    })

    const promptRegistration = await ctx.session.hook("prompt", (event) => {
      // A new user turn invalidates authorization being assessed for the old one.
      for (const [controller, sessionID] of activeControllers) {
        if (sessionID === event.sessionID) controller.abort()
      }
    })

    // Capture committed originals before model dispatch, including compaction requests.
    //
    // This plugin no longer writes any session message. The filter below only
    // cleans up a notice body left in the transcript by an earlier version, which
    // committed notices with `session.synthetic`. The host replays such a body into
    // later model requests as a user message, so an upgraded install must strip it
    // before dispatch (see `isNoticeBody`). The archive reads the session context
    // independently, where a notice is a `synthetic` message rather than a `user`
    // one, so this does not affect authorization.
    //
    // Both history-consuming dispatch hooks filter: V2 dispatches the agent loop
    // through `context` and checkpoint summaries through the separate `compaction`
    // hook, so filtering only `context` would still leak a notice into the
    // compaction request.
    const dropNoticeBodies = (event: { messages?: unknown }): void => {
      const messages = event.messages
      if (!Array.isArray(messages)) return
      const kept = messages.filter((message) => !isNoticeBody(message))
      if (kept.length !== messages.length) event.messages = kept
    }

    async function captureArchive(sessionID: string): Promise<void> {
      const signal = AbortSignal.any([modelController.signal, AbortSignal.timeout(options.timeoutMs)])
      try {
        await raceWithAbort(archive.load(sessionID, signal), signal)
      } catch (error) {
        diagnose({ action: "archive_capture", sessionID, outcome: "failed", reason: describeError(error) })
      }
    }

    const contextRegistration = await ctx.session.hook("context", async (event) => {
      if (disposed) return
      await captureArchive(event.sessionID)
      dropNoticeBodies(event)
    })

    // V2 dispatches checkpoint summaries through the separate compaction hook, so
    // capture the same originals there to keep authorization completeness intact.
    const compactionRegistration = await ctx.session.hook("compaction", async (event) => {
      if (disposed) return
      await captureArchive(event.sessionID)
      dropNoticeBodies(event)
    })

    const registration = await ctx.permission.hook("evaluate", async (event) => {
      if (!enabled) return
      if (event.effect !== "ask") return
      if (disposed) return
      if (!event.source || event.source.type !== "tool") return
      if (event.agent === options.agent) return
      if (!isEligibleAction(event.action, options.actions)) return

      const humanReason = findHumanReviewReason(event.action, event.resources, options.humanReviewRules)
      if (humanReason) {
        // An explicit user rule is a deliberate confirmation requirement, not a
        // fallback, so it asks even when the fallback is disabled.
        diagnose({ action: event.action, outcome: "human_rule" })
        askHuman(event as PermissionEvent, humanReason)
        return
      }

      const controller = new AbortController()
      const deadline = Date.now() + options.timeoutMs
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; controller.abort() }, options.timeoutMs)
      activeControllers.set(controller, event.sessionID)
      const key = requestIdentity(event as PermissionEvent)
      try {
        diagnose({ action: event.action, request: key, outcome: "started" })
        const outcome = await raceWithAbort(reviewRequest(key, event as PermissionEvent, controller.signal, deadline), controller.signal)
        if (disposed || !enabled || controller.signal.aborted) return
        if (Date.now() >= deadline) {
          notifyReview(event.sessionID, event.action, key, "Automatic review reached its deadline")
          conclude(event as PermissionEvent, "Automatic review reached its deadline")
          return
        }
        diagnose({ action: event.action, request: key, outcome: outcome.code })
        const notices = outcome.notices ?? []
        // Reviewer degradation is surfaced once, as a toast.
        const degraded = degradationReasons(outcome, notices)
        if (outcome.decision?.decision === "allow") {
          // A degraded approval already gets one notice describing the fallback, so
          // it must not also emit the plain approval notice.
          if (degraded.length) notifyReview(event.sessionID, event.action, key, degraded.join("; "))
          else notifyApproval(event.sessionID, event.action, key)
          event.effect = "allow"
          event.message = withNotices(outcome.decision.reason ? `Auto-review approved: ${outcome.decision.reason}` : `Auto-review approved: ${event.action}.`, notices)
          return
        }
        if (degraded.length) notifyReview(event.sessionID, event.action, key, degraded.join("; "))
        if (outcome.decision?.decision === "deny") denyPolicy(event as PermissionEvent, outcome.decision.reason ?? FAILURE_MESSAGE, notices)
        else conclude(event as PermissionEvent, outcome.decision?.reason ?? outcome.message ?? REVIEWER_FAILURE_MESSAGE, notices)
      } catch {
        if (!disposed) {
          const aborted = controller.signal.aborted
          if (aborted && !timedOut) {
            // Cancellation is not a verdict. A new user turn or a disabled plugin
            // must leave the event exactly as the host decided it; concluding here
            // would turn a cancelled review into a denial.
            diagnose({ action: event.action, outcome: "cancelled" })
          } else {
            const message = timedOut ? "Automatic review reached its deadline" : REVIEWER_FAILURE_MESSAGE
            diagnose({ action: event.action, outcome: timedOut ? "timeout" : "failure" })
            notifyReview(event.sessionID, event.action, key, message)
            conclude(event as PermissionEvent, message)
          }
        }
      } finally {
        activeControllers.delete(controller)
        clearTimeout(timer)
      }
    })

    function reviewRequest(key: string, event: PermissionEvent, signal: AbortSignal, deadline: number): Promise<ReviewOutcome> {
      const existing = inFlight.get(key)
      if (existing) return existing
      // A fresh review for this request identity may notify again; the previous
      // notice for the same identity must not suppress it. Concurrent evaluations
      // of one request still share the single notice, because they join the review
      // created here instead of clearing this marker.
      notified.delete(key)
      const review = reviewerQueue.run(event.sessionID, signal, async (): Promise<ReviewOutcome> => {
        const loaded = await loadReviewRequest(event, signal)
        if (!loaded) return { code: "incomplete_request", message: "Automatic review could not identify the complete tool request" }
        return await generateReview(event.sessionID, loaded.request, loaded.evidence, signal, deadline) ?? {
          code: "review_failure", message: REVIEWER_FAILURE_MESSAGE,
        }
      })
      inFlight.set(key, review)
      void review.finally(() => inFlight.delete(key)).catch(() => undefined)
      return review
    }

    async function generateReview(
      sessionID: string,
      request: ReviewRequest,
      evidence: ReturnType<typeof captureEvidence>,
      signal: AbortSignal,
      deadline: number,
    ): Promise<ReviewOutcome | undefined> {
      const resolved = await raceWithAbort(getModel(), signal)
      if (signal.aborted) return
      const notices = resolved.notices
      if (!resolved.model) {
        return { code: "model_unavailable", message: "Automatic review could not resolve a reviewer model", notices }
      }
      const selectedModel = resolved.model
      const catalog = await raceWithAbort(ctx.model.list({}, { signal }), signal)
      const info = catalog.data.find((item) => item.providerID === selectedModel.providerID && item.id === selectedModel.id)
      // Availability is validated here rather than only inside the override
      // registration, because the default configuration registers nothing: without
      // this an unknown model or variant would fall through to a misleading
      // "input budget" error instead of the real reason.
      if (!info) {
        return { code: "model_unavailable",
          message: `Automatic review could not resolve a reviewer model: reviewer model ${selectedModel.providerID}/${selectedModel.id} is not available`,
          notices }
      }
      const variant = info.variants.find((item) => item.id === selectedModel.variant)
      if (selectedModel.variant && !variant) {
        return { code: "model_unavailable",
          message: `Automatic review could not resolve a reviewer model: reviewer variant "${selectedModel.variant}" is not available for ${selectedModel.providerID}/${selectedModel.id}`,
          notices }
      }
      assertReviewerBody(info.body)
      assertReviewerBody(variant?.body)
      const maxInputTokens = inputTokenBudget(info.limit, { ...info.body, ...variant?.body })
      if (!maxInputTokens) return { code: "context_limit", message: "Reviewer model has no usable input budget after reserving output tokens", notices }
      // The in-memory map is authoritative for this instance. Storage is the
      // surviving copy across a reload or a recreated instance, and because a lost
      // snapshot rebuilds the journal — which rewrites the header line and
      // invalidates the provider's cached prefix for the whole journal — it is
      // worth reading. Both waits race the review signal: a storage operation that
      // never settles must not hold this session's queue open, or one stalled read
      // would wedge every later review in the session.
      const memoryKey = JSON.stringify([scope, sessionID])
      const owner = Symbol("review journal")
      let current: ReviewerJournalState | undefined = latestJournals.get(memoryKey)?.snapshot ?? reviewerStates.get(sessionID)
      if (!current) {
        const restored = await raceWithAbort(ctx.storage.get(journalKey(sessionID)), signal)
          .catch(() => undefined) as ReviewerJournalState | undefined
        current = latestJournals.get(memoryKey)?.snapshot ?? reviewerStates.get(sessionID) ?? restored
      }
      const prepared = prepareReviewJournal(
        current,
        request,
        Math.floor(maxInputTokens * 0.75) - estimateTokens(JSON.stringify(evidence.index)),
        options.maxReviewTokens,
      )
      if (!prepared) {
        return { code: "context_limit", message: "The review window (user instructions, recent actions, and the current request) does not fit the reviewer model's input budget", notices }
      }
      const { prompt: _prompt, lines, ...state } = prepared
      const outcome = await runReviewLoop({
        lines,
        evidence,
        options,
        maxInputTokens,
        signal,
        deadline,
        generate: (prompt) => generateText(sessionID, prompt, selectedModel, signal),
        onJournal: (sent) => publishJournal(memoryKey, ctx.storage, sessionID, { ...state, body: [...sent] }, owner),
        onRound: (round, outcome) => diagnose({ sessionID, round: String(round), outcome }),
      })
      if (latestJournals.get(memoryKey)?.owner === owner) {
        // Keep every sent line plus the investigation and outcome in place. The
        // next review extends this exact prefix instead of rebuilding its tail.
        const saved = { ...state, body: outcome.lines }
        reviewerStates.delete(sessionID)
        reviewerStates.set(sessionID, saved)
        // Bound retained session state. Evicted sessions restore from storage when
        // possible, otherwise they rebuild.
        if (reviewerStates.size > 128) reviewerStates.delete(reviewerStates.keys().next().value!)
        // Best-effort: the in-memory map above is authoritative for this instance,
        // so persistence is off the review path. Awaiting it would let a slow or
        // hung storage turn a valid approval into a deadline timeout.
        publishJournal(memoryKey, ctx.storage, sessionID, saved, owner)
      }
      return notices.length ? { ...outcome, notices } : outcome
    }

    async function generateText(
      sessionID: string,
      prompt: string,
      selectedModel: ReviewerModel,
      signal: AbortSignal,
    ): Promise<{ text?: string; timedOut: boolean; error?: string }> {
      try {
        const text = await transport.generate(sessionID, selectedModel, prompt, signal)
        return { text, timedOut: false }
      } catch (error) {
        return { timedOut: signal.aborted, error: describeError(error) }
      }
    }

    async function getModel(): Promise<{ model: ReviewerModel | undefined; notices: string[] }> {
      if (model) return { model, notices: modelNotices }
      const pending = pendingModel ??= (async () => {
        const notices: string[] = []
        const selected = await resolveModel(ctx, options.agent, options.model, options.timeoutMs, modelController.signal, notices)
        if (!selected || disposed || !options.modelOptions) return { model: selected, notices }
        // Registration verification issues a registry read that the host cannot
        // cancel, so bound it: a read that never settles must not leave the shared
        // `pendingModel` promise unresolved, which would wedge every later review.
        const controller = new AbortController()
        const onParentAbort = () => controller.abort()
        modelController.signal.addEventListener("abort", onParentAbort, { once: true })
        const timer = setTimeout(() => controller.abort(), options.timeoutMs)
        try {
          const registered = await registerModelOptions(ctx.model, selected, options.modelOptions, controller.signal)
          if ("error" in registered) {
            notices.push(registered.error)
            return { model: undefined, notices }
          }
          if (disposed) {
            await registered.dispose()
            return { model: undefined, notices }
          }
          modelRegistration = registered
          return { model: registered.model, notices }
        } finally {
          clearTimeout(timer)
          modelController.signal.removeEventListener("abort", onParentAbort)
        }
      })()
      try {
        const resolved = await pending
        model = resolved.model
        modelNotices = resolved.notices
        return resolved
      } finally {
        pendingModel = undefined
      }
    }

    async function loadReviewRequest(event: PermissionEvent, signal: AbortSignal) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const retained = await raceWithAbort(archive.load(event.sessionID, signal), signal)
        const messages = retained.messages
        if (signal.aborted) return
        // Informational only: a reconstructed boundary is still a valid window
        // anchor, so it must never change the decision.
        if (retained.reconstructed) diagnose({ action: event.action, outcome: "archive_checkpoint_reconstructed" })
        // The prompt is projected by `buildReviewRequest` (user instructions, a
        // bounded tail of recent actions, and post-compaction tool history);
        // evidence stays lazily addressable over the whole captured transcript so
        // an original result can still be recovered by ID without entering the
        // prompt.
        const request = buildReviewRequest(messages, event)
        if (request) {
          return { request, evidence: captureEvidence(messages, event, {
            result: (messageID, toolID) => archive.result(event.sessionID, messageID, toolID, signal),
          }) }
        }
        if (attempt < 3) await delay(25 * 2 ** attempt, signal)
      }
    }

    // Command feedback is a `notice` toast too. It used to be a session message,
    // which resumed an idle session: `/auto-review status` from a user who was
    // reading the transcript woke the coding model for a one-line reply.
    function showStatus(text: string): void {
      emitNotice(text, "info")
    }

    function denyPolicy(event: PermissionEvent, reason: string, notices: readonly string[] = [], fromFallback = false): void {
      event.effect = "deny"
      event.message = withNotices(fromFallback ? fallbackDenialMessage(reason) : denialMessage(reason), notices)
    }

    function askHuman(event: PermissionEvent, reason: string, notices: readonly string[] = []): void {
      event.effect = "ask"
      event.message = withNotices(`Auto-review requires human confirmation: ${reason.trim()}`, notices)
    }

    // A decision that needs a human is an `ask` by default. With `humanFallback`
    // disabled the plugin must stay terminal: a prompt nobody answers blocks the
    // session indefinitely during unattended work. Converting to `deny` keeps the
    // loop moving, because the coding model receives the reason as a tool error and
    // can adjust the call or continue without it.
    function conclude(event: PermissionEvent, reason: string, notices: readonly string[] = []): void {
      if (humanFallback) askHuman(event, reason, notices)
      else denyPolicy(event, reason, notices, true)
    }

    return async () => {
      disposed = true
      modelController.abort()
      inFlight.clear()
      for (const controller of activeControllers.keys()) controller.abort()
      reviewerQueue.clear()
      reviewerStates.clear()
      noticeOrigins.clear()
      notified.clear()
      await transport.dispose()
      await registration.dispose()
      await commandRegistration.dispose()
      await promptRegistration.dispose()
      await contextRegistration.dispose()
      await compactionRegistration.dispose()
      await rpcRegistration.dispose()
      await modelRegistration?.dispose()
    }
  },
})

function denialMessage(reason: string): string {
  return `Auto-review denied: ${reason.trim()} Do not retry unchanged or bypass this decision with obfuscation, indirection, shell expansion, or hidden output.`
}

/**
 * Denial used when the human fallback is disabled. The reviewer could not
 * approve, and no human will answer, so the coding model is told to adjust or
 * continue instead of waiting. It must not learn that a prompt was skipped.
 */
function fallbackDenialMessage(reason: string): string {
  return `Auto-review did not approve this: ${reason.trim()} Adjust the request to one that is clearly authorized, or continue without it. Do not retry it unchanged or bypass this decision with obfuscation, indirection, shell expansion, or hidden output.`
}

/**
 * The model-facing form of a legacy committed synthetic notice.
 *
 * This plugin no longer writes session messages, so nothing here is produced any
 * more. A notice committed by an earlier version carries its text in
 * `description` and leaves `text` empty, but the host still replays it into later
 * model requests as a `user` message whose only parts are empty text (verified on
 * OpenCode 2.0.6; the host does not drop an empty synthetic body on its own). The
 * `context` hook removes exactly that shape before dispatch so an upgraded
 * install cannot leak the old notice into the coding model's context.
 *
 * Matching on shape rather than a message id also strips notices committed by an
 * earlier plugin instance, which a per-instance id set could not know about.
 * No meaningful message is all-empty text, so this cannot drop real content.
 */
function isNoticeBody(message: { role?: unknown; content?: unknown }): boolean {
  if (message.role !== "user") return false
  const content = message.content
  if (!Array.isArray(content) || content.length === 0) return false
  return content.every((part) => {
    if (typeof part !== "object" || part === null) return false
    const candidate = part as { type?: unknown; text?: unknown }
    if (candidate.type !== "text" && candidate.type !== "input_text") return false
    return candidate.text === ""
  })
}

/** Surface reviewer degradation instead of hiding it behind an otherwise normal decision. */
function withNotices(message: string, notices: readonly string[]): string {
  const unique = [...new Set(notices.map((notice) => notice.trim()).filter(Boolean))]
  return unique.length ? `${message} [auto-review fallback: ${unique.join("; ")}]` : message
}

/** Reasons the reviewer could not reach a verdict on its own, for user-visible surfacing. */
function degradationReasons(outcome: ReviewOutcome, notices: readonly string[]): string[] {
  const reasons = [...notices]
  if (!outcome.decision && outcome.code !== "aborted") {
    reasons.push(outcome.message?.trim() || `automatic review ended without a decision (${outcome.code})`)
  }
  return [...new Set(reasons.map((reason) => reason.trim()).filter(Boolean))]
}

function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : ""
  const clean = raw.replace(/\s+/g, " ").trim().slice(0, 300)
  return clean || "unknown error"
}

function requestIdentity(event: PermissionEvent): string {
  return createHash("sha256").update(JSON.stringify([
    event.sessionID,
    event.source?.messageID,
    event.source?.id,
    event.action,
    event.resources,
    event.metadata,
  ])).digest("hex")
}

async function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw new Error("automatic review aborted")
  let rejectAbort!: (error: Error) => void
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject
  })
  const onAbort = () => rejectAbort(new Error("automatic review aborted"))
  signal.addEventListener("abort", onAbort, { once: true })
  try {
    return await Promise.race([operation, aborted])
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("automatic review aborted"))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error("automatic review aborted"))
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

async function resolveModel(
  ctx: Plugin.Context,
  agentID: string,
  configured: string | undefined,
  timeoutMs: number,
  parentSignal: AbortSignal,
  notices: string[],
): Promise<ReviewerModel | undefined> {
  if (parentSignal.aborted) return
  if (configured) return parseModel(configured)
  const controller = new AbortController()
  const onParentAbort = () => controller.abort()
  parentSignal.addEventListener("abort", onParentAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    try {
      const agent = await raceWithAbort(ctx.agent.get({ agentID }, { signal: controller.signal }), controller.signal)
      if (agent.data.model) {
        notices.push(`no reviewer model configured; using the "${agentID}" agent model ${agent.data.model.providerID}/${agent.data.model.id}`)
        return copyModel(agent.data.model)
      }
    } catch (error) {
      notices.push(`reviewer agent lookup failed: ${describeError(error)}`)
    }
    if (controller.signal.aborted) return
    try {
      const fallback = await raceWithAbort(ctx.model.default({}, { signal: controller.signal }), controller.signal)
      if (fallback.data) {
        notices.push(`no reviewer model configured; using the catalog default model ${fallback.data.providerID}/${fallback.data.id}`)
        return copyModel(fallback.data)
      }
    } catch (error) {
      notices.push(`reviewer default model lookup failed: ${describeError(error)}`)
    }
  } finally {
    clearTimeout(timer)
    parentSignal.removeEventListener("abort", onParentAbort)
  }
}

function parseModel(value: string): ReviewerModel | undefined {
  const slash = value.indexOf("/")
  if (slash <= 0 || slash === value.length - 1) return
  const providerID = value.slice(0, slash)
  const modelAndVariant = value.slice(slash + 1)
  const hash = modelAndVariant.lastIndexOf("#")
  if (hash < 0) return { providerID, id: modelAndVariant }
  const id = modelAndVariant.slice(0, hash)
  const variant = modelAndVariant.slice(hash + 1)
  if (!id || !variant) return
  return { providerID, id, variant }
}

function copyModel(model: ReviewerModel): ReviewerModel {
  return {
    providerID: model.providerID,
    id: model.id,
    ...(model.variant ? { variant: model.variant } : {}),
  }
}
