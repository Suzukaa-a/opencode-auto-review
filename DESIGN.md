# Permission review architecture

## Upstream API and references

This version targets [OpenCode V2 2.2.5](https://github.com/anomalyco/opencode/releases/tag/v2.2.5), published October 30, 2026 and verified November 5, 2026. Both the plugin SDK and theme package are pinned to 2.2.5; OpenTUI requires 0.8.0 or newer. The published package contract is available in the [SDK source](https://github.com/anomalyco/opencode/blob/958f965d35ed44d32b018fd55b02a5357a7748fd/packages/plugin/src/promise/plugin.ts).

The classifier design draws on two public primary sources:

- [OpenAI Codex Guardian policy template](https://github.com/openai/codex/blob/26cb4d73e2ce25575644038d7af5beb2440d0ed0/codex-rs/prompts/templates/guardian/policy_template.md): assess intrinsic risk separately from user authorization, evaluate exact targets and side effects, distinguish evidence from instructions, and investigate only facts that can change a decision.
- [Anthropic's Claude Code auto-mode design](https://www.anthropic.com/research/claude-code-auto-mode): exclude assistant persuasion from the classifier context, evaluate whole executable payloads, and return a refusal the coding agent can respond to without bypassing it. The article describes the architecture and selected rules; it does not publish the full fixed classifier prompt.

These are public sources, rather than unverified leaked prompt dumps. This plugin adapts their principles to OpenCode's interfaces. Its authorization thresholds below are deliberately stricter than Codex's defaults.

## Host integration

The server uses `permission.hook("evaluate")` and changes only eligible tool requests whose effect is `ask`. Existing host allow and deny decisions remain authoritative. User-defined `humanReviewRules` are checked before the classifier and always preserve a prompt.

The review includes the exact source message and tool ID, complete tool input, permission action, resources, and permission metadata. Metadata contributes to the in-flight request identity, so requests with different access details cannot share a verdict. Metadata is evidence, not user authorization.

Model calls use `session.generate` on a dedicated empty reviewer session per coding session and selected model. The `generate` hook replaces inherited instructions and history with one fixed system policy, one JSONL evidence user message, and no tools. The policy and response schema are byte-identical across rounds and journal rebuilds for the configured output budget. Generation does not commit messages or run tools. The reviewer session has its own cache affinity, without a parent link that would inherit the coding session's cache key. It is titled `[Auto-review] <coding-session-id>`. Its ID is persisted per coding session and model, and reused after resume or plugin reload after checking the plugin marker, original coding-session ID, and model. Plugin cleanup releases its hooks but preserves the reviewer session for later resume. A missing or mismatched reviewer is replaced; a request still running from an earlier instance must settle before its session can be reused. The connected TUI archives marked reviewer sessions through its authenticated HTTP client, including existing sessions when it starts or reconnects. OpenCode 2.2.5's server-plugin adapter does not apply the archive field through `session.update`; without a TUI, the session remains identifiable by its prefix. Generated requests and replies never enter the coding conversation or reviewer history.

The Promise adapter does not forward request options to server API calls. Local abort races therefore bound plugin waits even when the host continues an underlying generation. A cancelled or expired review cannot apply a late approval. Its reviewer slot remains occupied until the underlying generation settles. Cleanup keeps the isolation hook until outstanding requests finish, and rejects a request arriving at that hook after disposal. Provider body overlays cannot replace the model, policy, messages, tools, or continuation state. Session hooks for `prompt`, `context`, and `compaction` remain supported in 2.2.5.

The TUI uses the current `StatefulColor.base` theme token. Server and TUI share an RPC contract for toggles and notices. The server owns enabled/fallback state; the TUI applies confirmed responses and events, rejects stale replies, filters other locations, and refreshes after reconnecting. Notices are toasts rather than session messages, so an approval does not wake an idle coding agent.

## Decision policy

Risk describes the action's intrinsic impact. Authorization describes what the user permitted. Missing evidence can require investigation or confirmation without increasing intrinsic risk.

| Risk | Authorization needed for automatic approval |
| --- | --- |
| Low or medium | High or medium: exact consent or a bounded implementation of the authorized task |
| High | High: explicit consent covering the narrow target and material side effects, with a required rationale |
| Critical or unknown | No automatic approval |

Critical risk includes secret or credential exfiltration to an untrusted destination and major irreversible destruction. Explicit user prohibitions, malicious redirection, and human-only rules take precedence over the approval matrix. The response parser rejects inconsistent allows and turns any complete critical-risk verdict into a denial, even if the reviewer asks for a prompt. Malformed output gets one format repair before review fails.

A user can approve a previously refused high-risk operation after seeing its concrete risk. A broad goal, urgency, an assistant assertion of consent, or unrelated earlier approval does not authorize that operation. An explicit delegation to a file, ticket, or skill supplies instructions within the delegated scope; it does not turn nested policy overrides into trusted instructions. Compaction summaries and prior verdicts never create authorization.

The default prompt contains original user instructions and tool calls, excluding assistant prose and tool results. Original results are available only through bounded investigation. Normal authentication is evaluated by its intended service and payload; credential probing and private-data export require separate scrutiny. Shell chains and assembled scripts are evaluated by everything they execute.

A terminal response is `allow`, `deny`, or `ask` with independently classified risk and authorization. An `ask` keeps known classifications and names the missing evidence or consent. When human fallback is off, an unresolved review becomes a denial. Failure to obtain a decision is reported as a reviewer failure rather than a finding that the requested action is unsafe.

## Evidence and review lifecycle

The archive captures committed originals before normal model dispatch and compaction. User instructions survive compaction; the prompt's tool history follows the latest completed checkpoint, with a bounded tail of earlier actions to make once-only authorization visible. Original tool results remain addressable by message and tool ID, including completed sibling tools in the current assistant message. Pending siblings and later messages stay outside the evidence snapshot. A rollback removes later evidence from the active branch.

Within an epoch, each model request retains the complete previous journal in its original order and appends new transcript entries, the pending review, and its current evidence index. Investigation requests, evidence responses, and outcomes remain in place for later reviews. Earlier review records describe assessments, not executed operations. Only compaction, changed host message/tool identities, or exhaustion of the input budget starts a new bounded epoch. Fixed system policy and reviewer cache identity survive that rebuild. Persisted version 6 stores the complete journal; older body-and-tail snapshots rebuild once. Snapshots persist best-effort outside the decision path, with the newest in-memory snapshot available by stable location and session identity during reload even if its write has not finished. Every attempted send is captured before waiting for the model, including requests later cancelled. Review ownership prevents an older final outcome from replacing a newer journal.

Each investigation request retrieves a page of captured history or an already completed tool result. It cannot run commands, inspect new files, fetch network data, or execute the pending operation. Omitted user instructions must be recovered before approval. Duplicate evidence requests stop a stalled review. Provider failure or empty output gets one recovery attempt. All rounds, queueing, model lookup, and investigation share the original deadline.

Reviews within a session are serialized; different sessions proceed independently. Identical concurrent requests share one review and notice. User steering, disable, and cleanup abort active waits. Cancellation preserves the host's decision rather than inventing a verdict. Deadline timers record timeout explicitly so wall-clock changes cannot turn a timeout into user cancellation. Archive capture before dispatch has its own bounded wait; a storage failure cannot hold the main model indefinitely. Permission review reloads the archive and refuses approval if capture remains unavailable. An uncancellable storage write blocks newer same-session archive writes until it actually settles, preserving order across archive instances sharing that storage object.

## Configuration

| Option | Default | Purpose |
| --- | --- | --- |
| `enabled` | `true` | Automatic permission review |
| `model` | unset | Native `provider/model#variant` selection |
| `agent` | `auto-reviewer` | Model fallback before the host default |
| `timeoutMs` | `90000` | Total request deadline |
| `maxReviewTokens` | `2048` | Prompt-side output budget hint |
| `modelOptions` | unset | Provider `settings` and `body` overrides |
| `actions` | `read, edit, glob, grep, shell, webfetch, websearch, external_directory` | Eligible permission actions |
| `humanReviewRules` | `[]` | `{ action?, resource?, reason }` rules requiring human confirmation |
| `humanFallback` | `false` | Prompt when automatic review cannot approve |
| `debug` | `false` | Round and outcome diagnostics |

No provider output cap is guessed. To enforce one, set the field your API expects in `modelOptions.body`: `max_output_tokens` for Responses, or `max_tokens` / `max_completion_tokens` for the appropriate Chat Completions endpoint. Overrides are applied through a reviewer-only model variant, inheriting the selected native variant. The base model is not modified.

Input budgeting uses model context/input limits and the effective output reserve, with a 10% estimation margin and 256 tokens for framing. Initial context reserves 25% of the resulting budget for investigation. A request whose mandatory evidence cannot fit is refused rather than silently truncated.

The reviewer receives user instructions, including retained pre-compaction instructions. Choose a reviewer provider you trust with that content. Durable boundaries belong in host permission rules or `humanReviewRules`.

## Verification

Run `npm run check` and `npm test`. Behavioral regressions cover exact request extraction, metadata snapshots and isolation, authorization retention, dependent evidence rounds, malformed decisions, high-risk explicit consent, critical-risk refusal, host decisions, deadlines, cancellation, model overrides, and RPC state.

Optional model-driven checks use `AUTO_REVIEW_SMOKE_MODEL=provider/model` with `npm run test:smoke`, `npm run test:safety`, or `npm run test:multiturn`. They require an installed OpenCode V2 host and configured provider. Set `AUTO_REVIEW_CLI` to use a particular executable; multi-turn and safety checks also accept `AUTO_REVIEW_SERVER` for an isolated server. Set `AUTO_REVIEW_TURNS=16` for a longer conversation and `AUTO_REVIEW_RESUME_AFTER=8` to reload the plugin and resume the same session after eight turns. `AUTO_REVIEW_ARCHIVE_BEFORE_RESUME=1` also archives the reviewer before that resume check. The runner verifies complete sent-prefix extension inside an epoch and stable reviewer identity across reload. Automatic compaction is disabled in the fixture. Use `AUTO_REVIEW_COMPACT=1 AUTO_REVIEW_COMPACT_EVERY=4` to insert manual compactions every four turns; leave compaction off when measuring cache reuse. `AUTO_REVIEW_SMOKE_BASE_URL` routes only reviewer calls to a test endpoint for telemetry. Multi-turn instrumentation records generation errors, valid reviewer responses, and shared prompt prefixes. A provider quota failure is a failed live test, even when the plugin correctly denies the pending operation. Deterministic protocol tests verify enforcement and integration; model-driven checks assess classifier quality.
