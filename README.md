# OpenCode Auto Review

Automatically reviews **OpenCode V2** permission prompts for unattended work. Routine authorized work proceeds automatically. High-risk operations need explicit consent covering the exact target and side effects; critical-risk operations are denied.

Targets **OpenCode V2 2.2.5**, the stable release verified on November 5, 2026. Upgrade the host together with the plugin.

## Install

```sh
opencode2 plugin add opencode-auto-review
```

## Configure

Choose a reviewer model in `opencode.json(c)`. Replace the example with an available model; `#variant` is optional.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-auto-review",
      "options": {
        "model": "provider/model#variant"
      }
    }
  ]
}
```

The model is optional: the plugin falls back to the `auto-reviewer` agent's model, then OpenCode's default. Notices are CLI toasts, so nothing is ever written to the session and an idle session is never resumed. Notices never change the permission decision. Reviews use separate sessions titled `[Auto-review] …`; their requests and replies do not enter your conversation. The connected TUI archives these sessions automatically. Resuming the same coding session reuses its reviewer session and saved review journal; compaction rebuilds only the journal, keeping the fixed system policy.

Automatic review is enabled by default, with a **90-second deadline per request**. Use `humanReviewRules` for operations that must always ask you, and `humanFallback: true` to ask when automatic review cannot approve. See [configuration](DESIGN.md#configuration) for the available options and provider output limits.

## Usage

`/auto-review [on|off|toggle|status]`, or the palette's **Toggle Auto-review**. The TUI reads and changes this state over the plugin RPC contract instead of parsing session text; the slash command keeps its explicit status output.

The plugin handles eligible requests that would otherwise ask for permission. It reviews each request against the task the main conversation is actually working on: your instructions are kept across a compaction, while the tool history before it is dropped so the reviewer carries no backlog the coding model has already shed. Recent actions are kept so a once-only instruction is not replayed, and an earlier tool result can still be retrieved by ID when a decision depends on it. Use `humanReviewRules` for mandatory confirmation and host `deny` rules for prohibited operations. Host `ask` rules are eligible for automatic review. Its feedback is limited to permission and safety decisions.

The reviewer reads your instructions, so treat the reviewer model as part of the session's trust boundary: pick one you would trust with the session's user text, especially when it is a different provider from the coding model.

By default, a request the reviewer cannot approve becomes a **denial** with a reason the coding model can act on. Use `/auto-review fallback on` to prompt instead. An explicit `humanReviewRules` entry always prompts.

## Development

```sh
npm install
npm run check
npm test
```

Optional live verification:

```sh
AUTO_REVIEW_SMOKE_MODEL=provider/model npm run test:smoke
```

See [DESIGN.md](DESIGN.md) for the review architecture and further verification scenarios.

## License

MIT
