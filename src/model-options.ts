import { createHash } from "node:crypto"
import type { Model, Plugin } from "@opencode/plugin"

export interface ModelOptions {
  settings?: Record<string, unknown>
  body?: Record<string, unknown>
}

export interface ReviewerModel {
  id: string
  providerID: string
  variant?: string
}

export function parseModelOptions(value: unknown): ModelOptions | undefined {
  if (value === undefined) return
  if (!object(value) || Object.keys(value).some((key) => key !== "settings" && key !== "body") ||
    Object.values(value).some((entry) => !object(entry))) {
    throw new TypeError("modelOptions must contain settings/body objects")
  }
  assertReviewerBody(value.body as Record<string, unknown> | undefined)
  return value as ModelOptions
}

/** Raw provider overlays must not replace the isolated request framing. */
export function assertReviewerBody(body: Record<string, unknown> | undefined): void {
  const structural = ["input", "messages", "system", "instructions", "tools", "tool_choice", "previous_response_id", "conversation", "contents", "systemInstruction", "system_instruction", "model"]
  const key = structural.find((key) => body && Object.hasOwn(body, key))
  if (key) throw new TypeError(`Reviewer request body cannot override ${key}`)
}

/** Add a reviewer-only variant; never alter the base model or an existing variant. */
export async function registerModelOptions(
  modelDomain: Plugin.Context["model"],
  model: ReviewerModel,
  options: ModelOptions,
  signal?: AbortSignal,
): Promise<{ model: ReviewerModel; dispose(): Promise<void> } | { error: string }> {
  const overrides = structuredClone(options)
  const id = `opencode-auto-review-${createHash("sha256").update(JSON.stringify([model, overrides])).digest("hex").slice(0, 16)}` as Model.Variant["id"]
  let reason: string | undefined
  let applied = false
  const registration = await modelDomain.transform((editor) => {
    const original = editor.get(model.providerID, model.id)
    if (!original) {
      reason = `reviewer model ${model.providerID}/${model.id} is not available`
      return
    }
    const inherited = original.variants.find((variant) => String(variant.id) === model.variant)
    // An invalid selected variant must not silently fall back to the base model.
    if (model.variant && !inherited) {
      reason = `reviewer variant "${model.variant}" is not available for ${model.providerID}/${model.id}`
      return
    }
    editor.update(model.providerID, model.id, (draft) => {
      draft.variants = [
        ...draft.variants.filter((variant) => variant.id !== id),
        {
          ...structuredClone(inherited ?? {}),
          id,
          ...(overrides.settings ? { settings: merge(inherited?.settings ?? {}, overrides.settings) } : {}),
          ...(overrides.body ? { body: merge(inherited?.body ?? {}, overrides.body) } : {}),
        },
      ]
    })
    applied = true
  })
  // OpenCode 2.0.4 replays transforms lazily, so the callback above may not have
  // run yet when `transform()` resolves; a registry read is what triggers the
  // replay. Without this, `applied` would always read false and every
  // modelOptions registration would be discarded. 2.0.2 ran the callback
  // synchronously, in which case `applied` is already true and no extra read is
  // needed.
  //
  // The read is raced against `signal` because the host adapter drops request
  // options and cannot cancel it: a registry read that never settles must still
  // release the caller, or one stalled read would wedge reviewer-model setup for
  // every later review.
  if (!applied) {
    try {
      await raceWithAbort(modelDomain.list({}), signal)
    } catch (error) {
      // A failed or cancelled read means the registration is unverified, even if
      // the callback managed to edit a draft before the failure.
      await registration.dispose()
      return { error: reason ?? `reviewer model options could not be verified: ${describeFailure(error)}` }
    }
  }
  // Returning an unregistered variant id would silently drop the requested overrides.
  if (!applied) {
    await registration.dispose()
    return { error: reason ?? `reviewer model options for ${model.providerID}/${model.id} could not be applied` }
  }
  return { model: { ...model, variant: id }, dispose: () => registration.dispose() }
}

/** Bound a host call that may never settle; the adapter cannot honor the signal itself. */
function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return operation
  if (signal.aborted) return Promise.reject(new Error("automatic review aborted"))
  let rejectAbort!: (error: Error) => void
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject
  })
  const onAbort = () => rejectAbort(new Error("automatic review aborted"))
  signal.addEventListener("abort", onAbort, { once: true })
  return Promise.race([operation, aborted]).finally(() => signal.removeEventListener("abort", onAbort))
}

function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : ""
  return message.replace(/\s+/g, " ").trim().slice(0, 200) || "unknown error"
}

function merge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(override)])].map((key) => {
    if (!Object.hasOwn(override, key)) return [key, structuredClone(base[key])]
    const value = override[key]
    return [key, object(base[key]) && object(value) ? merge(base[key], value) : structuredClone(value)]
  }))
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
