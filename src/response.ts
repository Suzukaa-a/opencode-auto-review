import type { ReviewDecision } from "./types.js"

const DECISIONS = new Set(["allow", "deny", "ask"])
const RISKS = new Set(["low", "medium", "high", "critical", "unknown"])
const AUTHORIZATIONS = new Set(["high", "medium", "low", "unknown"])
const MAX_REASON_BYTES = 2048
const MAX_RULES = 16
const MAX_RULE_BYTES = 64

export function parseReviewResponse(text: string): ReviewDecision | undefined {
  if (Buffer.byteLength(text, "utf8") > 16_384) return
  const trimmed = text.trim()
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return

  let value: unknown
  try {
    value = new StrictJsonParser(trimmed).parse()
  } catch {
    return
  }
  if (!isRecord(value)) return

  const keys = Object.keys(value)
  const allowed = new Set(["authorization", "decision", "matched_rules", "reason", "risk"])
  if (keys.some((key) => !allowed.has(key))) return
  if (["authorization", "decision", "matched_rules", "risk"].some((key) => !keys.includes(key))) return
  if (!DECISIONS.has(value.decision as string)) return
  if (!RISKS.has(value.risk as string)) return
  if (!AUTHORIZATIONS.has(value.authorization as string)) return
  if (value.reason !== undefined && (typeof value.reason !== "string" || value.reason.trim() === "")) return
  if (typeof value.reason === "string" && Buffer.byteLength(value.reason, "utf8") > MAX_REASON_BYTES) return
  const unsafeText = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u
  if (typeof value.reason === "string" && unsafeText.test(value.reason)) return
  if (!Array.isArray(value.matched_rules) || value.matched_rules.length > MAX_RULES) return
  if (value.matched_rules.some((rule) => typeof rule !== "string" || rule === "" || Buffer.byteLength(rule, "utf8") > MAX_RULE_BYTES)) return

  const authorizedRisk = ["low", "medium"].includes(value.risk as string)
    ? ["high", "medium"].includes(value.authorization as string)
    : value.risk === "high" && value.authorization === "high"
  const inconsistentAllow = value.decision === "allow" && value.risk !== "critical" && !authorizedRisk
  if (inconsistentAllow) return
  // A classified critical action is terminal even when the reviewer requests a prompt.
  const decision = (value.risk === "critical" ? "deny" : value.decision) as ReviewDecision["decision"]
  const reason = value.reason
  if ((decision !== "allow" || value.authorization === "medium" || value.risk === "high") &&
    typeof reason !== "string") return

  return {
    decision,
    risk: value.risk as ReviewDecision["risk"],
    authorization: value.authorization as ReviewDecision["authorization"],
    ...(typeof reason === "string" ? { reason } : {}),
    matched_rules: [...value.matched_rules] as string[],
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export class StrictJsonParser {
  #index = 0

  constructor(readonly text: string) {}

  parse(): unknown {
    const value = this.#value()
    this.#space()
    if (this.#index !== this.text.length) throw new SyntaxError("trailing JSON data")
    return value
  }

  #value(): unknown {
    this.#space()
    const char = this.text[this.#index]
    if (char === "{") return this.#object()
    if (char === "[") return this.#array()
    if (char === '"') return this.#string()
    if (char === "t") return this.#literal("true", true)
    if (char === "f") return this.#literal("false", false)
    if (char === "n") return this.#literal("null", null)
    return this.#number()
  }

  #object(): Record<string, unknown> {
    this.#index++
    const value: Record<string, unknown> = Object.create(null)
    const keys = new Set<string>()
    this.#space()
    if (this.text[this.#index] === "}") {
      this.#index++
      return value
    }
    while (true) {
      this.#space()
      if (this.text[this.#index] !== '"') throw new SyntaxError("object key must be a string")
      const key = this.#string()
      if (keys.has(key)) throw new SyntaxError("duplicate object key")
      keys.add(key)
      this.#space()
      if (this.text[this.#index++] !== ":") throw new SyntaxError("missing colon")
      value[key] = this.#value()
      this.#space()
      const delimiter = this.text[this.#index++]
      if (delimiter === "}") return value
      if (delimiter !== ",") throw new SyntaxError("invalid object delimiter")
    }
  }

  #array(): unknown[] {
    this.#index++
    const value: unknown[] = []
    this.#space()
    if (this.text[this.#index] === "]") {
      this.#index++
      return value
    }
    while (true) {
      value.push(this.#value())
      this.#space()
      const delimiter = this.text[this.#index++]
      if (delimiter === "]") return value
      if (delimiter !== ",") throw new SyntaxError("invalid array delimiter")
    }
  }

  #string(): string {
    const start = this.#index++
    while (this.#index < this.text.length) {
      const char = this.text[this.#index++]
      if (char === "\\") {
        this.#index++
        continue
      }
      if (char === '"') return JSON.parse(this.text.slice(start, this.#index)) as string
    }
    throw new SyntaxError("unterminated string")
  }

  #number(): number {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.text.slice(this.#index))
    if (!match) throw new SyntaxError("invalid JSON value")
    this.#index += match[0].length
    const value = Number(match[0])
    if (!Number.isFinite(value)) throw new SyntaxError("non-finite number")
    return value
  }

  #literal<T>(text: string, value: T): T {
    if (!this.text.startsWith(text, this.#index)) throw new SyntaxError("invalid literal")
    this.#index += text.length
    return value
  }

  #space(): void {
    while (/\s/u.test(this.text[this.#index] ?? "")) this.#index++
  }
}
