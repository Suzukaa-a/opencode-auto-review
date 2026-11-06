/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { createSignal, Show } from "solid-js"
import { AutoReview } from "./rpc.js"
import { createAutoReviewController } from "./tui-state.js"

export default Plugin.define({
  id: "opencode-auto-review.tui",
  setup(ctx) {
    const [enabled, setEnabled] = createSignal(ctx.options.enabled !== false)
    // Must match `parseOptions()`: the server default is off.
    const [fallback, setFallback] = createSignal(ctx.options.humanFallback === true)
    const rpc = ctx.client.rpc(AutoReview)
    let disposed = false
    const toast = (message: string) => {
      if (!disposed) ctx.ui.toast.show({ message, variant: "warning", duration: 4_000 })
    }

    // Reviewer notices arrive over RPC and are shown as a toast. They are never
    // committed to the session, so a notice cannot resume an idle session or enter
    // the coding model's context. Events from another location are ignored, the
    // same way the state controller ignores them.
    const activeLocation = ctx.location
    const isLocal = (location: { directory?: string; workspaceID?: string } | undefined): boolean => {
      if (!activeLocation || !location) return true
      return location.directory === activeLocation.directory && location.workspaceID === activeLocation.workspaceID
    }
    const stopNotices = rpc.events.on("notice", (event) => {
      if (disposed || !isLocal(event.location)) return
      const data = event.data as { description?: unknown; severity?: unknown } | undefined
      if (typeof data?.description !== "string" || !data.description) return
      const severity = data.severity
      const variant = severity === "success" || severity === "info" || severity === "warning" || severity === "error" ? severity : "info"
      ctx.ui.toast.show({ message: data.description, variant, duration: variant === "success" ? 3_000 : 6_000 })
    })

    // Only confirmed RPC responses or events move the signal; the controller
    // keeps the authoritative state and discards stale status responses.
    const controller = createAutoReviewController({
      client: rpc,
      location: ctx.location,
      initial: ctx.options.enabled !== false,
      initialFallback: ctx.options.humanFallback === true,
      onChange: (value) => setEnabled(value),
      onFallbackChange: (value) => setFallback(value),
      toast,
    })
    controller.start()
    // A reconnect may have missed state events; re-query the authoritative state.
    // The TUI client uses the authenticated HTTP API. Unlike the server plugin
    // adapter in 2.2.5, this path applies the archived field.
    const archiveReviewer = async (sessionID: string): Promise<void> => {
      try {
        const session = await ctx.client.session.get({ sessionID })
        if (disposed || session.metadata?.["opencode-auto-review"] !== true || session.time.archived) return
        await ctx.client.session.update({ sessionID, archived: true })
      } catch {
        if (!disposed) toast("Could not archive an auto-review session. It remains marked [Auto-review].")
      }
    }
    const archiveExisting = () => {
      for (const session of ctx.data.session.list()) {
        if (session.metadata?.["opencode-auto-review"] === true && !session.time.archived) void archiveReviewer(session.id)
      }
    }
    const stopCreated = ctx.data.on("session.created", (event) => {
      if (!disposed && isLocal(event.location)) void archiveReviewer(event.data.sessionID)
    })
    archiveExisting()
    const stopConnected = ctx.data.on("server.connected", () => {
      void controller.refresh()
      archiveExisting()
    })

    // A keymap layer is owned by the calling Solid component. `setup` runs
    // outside the keymap provider tree, so registering here would throw
    // "Keymap.Provider is missing"; register from a rendered component instead.
    const Status = (props: { mode: string }) => {
      ctx.keymap.layer(() => ({
        mode: "global",
        priority: 10,
        commands: [{
          id: "auto-review.toggle",
          title: "Toggle Auto-review",
          group: "Auto-review",
          palette: true,
          suggested: true,
          enabled: () => ctx.ui.router.current().type === "session",
          run: async () => {
            const route = ctx.ui.router.current()
            if (route.type !== "session") {
              ctx.ui.toast.show({ message: "Open a session to change auto-review mode", variant: "warning" })
              return
            }
            if (disposed) return
            const action = await ctx.ui.dialog.select({
              title: "Auto-review mode",
              options: [
                { title: "Enable", value: "on", description: "Automatically review permission requests" },
                { title: "Disable", value: "off", description: "Use normal OpenCode permission handling" },
                { title: "Human fallback", value: "fallback", description: "When off, a decision needing a human is denied instead of prompting, so unattended work cannot stall" },
                { title: "Show status", value: "status" },
              ],
            })
            if (!action || disposed) return
            if (action === "status") {
              const confirmed = await controller.refresh()
              if (disposed) return
              if (!confirmed) {
                toast("Auto-review status is unavailable right now.")
                return
              }
              ctx.ui.toast.show({
                message: `Auto-review is ${controller.enabled() ? "enabled" : "disabled"} (human fallback ${controller.humanFallback() ? "on" : "off"}).`,
              })
              return
            }
            if (action === "fallback") {
              // Refresh first so the suggested value matches the server state.
              await controller.refresh()
              if (disposed) return
              const choice = await ctx.ui.dialog.select({
                title: "Human fallback",
                current: controller.humanFallback() ? "on" : "off",
                options: [
                  { title: "On", value: "on", description: "Escalate to a human prompt when a decision needs confirmation" },
                  { title: "Off", value: "off", description: "Deny instead of prompting, so unattended work cannot stall" },
                ],
              })
              if (!choice || disposed) return
              const confirmed = await controller.setFallback(choice === "on")
              if (confirmed) {
                ctx.ui.toast.show({ message: `Human fallback is ${controller.humanFallback() ? "on" : "off"}.` })
              }
              return
            }
            await controller.setEnabled(action === "on")
          },
        }],
        bindings: ["auto-review.toggle"],
      }))

      return (
        <Show when={enabled() && props.mode === "normal"}>
          <text fg={ctx.theme.text.action.primary.base}>
            <b>Auto Mode</b>
          </text>
        </Show>
      )
    }

    const removeStatus = ctx.ui.slot({
      append: "prompt.footer.status",
      render: ({ mode }) => <Status mode={mode} />,
    })

    return () => {
      disposed = true
      stopConnected()
      stopCreated()
      stopNotices()
      controller.dispose()
      removeStatus()
    }
  },
})
