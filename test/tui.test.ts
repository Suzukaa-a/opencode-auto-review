import assert from "node:assert/strict"
import test from "node:test"
import tui from "../src/tui.js"

// tsx transpiles TSX with the classic runtime, while the plugin's JSX targets
// Solid (@opentui/solid) and is normally executed by the host. Tests only need
// the component body to run so it registers its keymap layer, so provide a
// minimal element factory rather than mounting a renderer.
;(globalThis as { React?: unknown }).React = {
  createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
  Fragment: Symbol("Fragment"),
}

/** A stateful fake RPC server so the TUI state is real, not just handler capture. */
function harness(options: { enabled?: boolean; failSwitch?: boolean } = {}) {
  let enabled = options.enabled ?? true
  let humanFallback = true
  let failStatus = false
  const statusCalls: Array<{ input: unknown; options: any }> = []
  const toasts: any[] = []
  const connectedHandlers: Array<() => void> = []
  const createdHandlers: Array<(event: any) => void> = []
  const sessions = new Map<string, any>()
  const archived: string[] = []
  const eventHandlers = new Map<string, (event: any) => void>()
  let selectReplies: string[] = []
  const commands: any[] = []
  let slotClaim: any
  const client: any = {
    status: async (input: unknown, callOptions: any) => {
      statusCalls.push({ input, options: callOptions })
      if (failStatus) throw new Error("offline")
      return { enabled, humanFallback }
    },
    setEnabled: async (input: any) => {
      if (options.failSwitch) throw new Error("offline")
      enabled = input.enabled
      return { enabled, humanFallback }
    },
    setFallback: async (input: any) => {
      if (options.failSwitch) throw new Error("offline")
      humanFallback = input.humanFallback
      return { enabled, humanFallback }
    },
    events: { on: (name: string, handler: (event: any) => void) => { eventHandlers.set(name, handler); return () => undefined } },
  }
  const context: any = {
    options: {},
    location: { directory: "/repo", workspaceID: "ws" },
    client: { rpc: () => client, session: {
      get: async ({ sessionID }: any) => sessions.get(sessionID),
      update: async ({ sessionID, archived: value }: any) => {
        if (value) { sessions.get(sessionID).time.archived = 1; archived.push(sessionID) }
      },
    } },
    data: { session: { list: () => [...sessions.values()] }, on: (name: string, handler: any) => {
      if (name === "server.connected") connectedHandlers.push(handler)
      if (name === "session.created") createdHandlers.push(handler)
      return () => undefined
    } },
    ui: {
      toast: { show: (toast: any) => toasts.push(toast) },
      slot: (claim: any) => { slotClaim = claim; return () => undefined },
      router: { current: () => ({ type: "session", sessionID: "ses" }) },
      dialog: { select: async () => selectReplies.shift() },
    },
    keymap: { layer: (callback: () => any) => { commands.push(...callback().commands); return () => undefined } },
    theme: { text: { action: { primary: { base: "#fff" } } } },
  }
  return {
    context, toasts, statusCalls, commands, sessions, archived,
    created: (sessionID: string, location = context.location) => createdHandlers.forEach(handler => handler({ data: { sessionID }, location })),
    setReply: (value: string | undefined) => { if (value !== undefined) selectReplies.push(value) },
    setFailStatus: (value: boolean) => { failStatus = value },
    serverState: () => enabled,
    serverFallback: () => humanFallback,
    emitNotice: (data: unknown, location?: unknown) => eventHandlers.get("notice")?.({ data, location }),
    connect: () => connectedHandlers.forEach((handler) => handler()),
    // The host renders a slot claim inside a component, which is where the
    // keymap layer must be registered. Invoking render exercises that path.
    renderSlot: () => {
      const element = slotClaim.render({ mode: "normal" })
      // The stub factory only records the element; invoke the component the
      // way a renderer would so its body (and keymap registration) runs.
      if (element && typeof element.type === "function") element.type(element.props)
    },
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

test("the authenticated client archives only marked reviewer sessions", async () => {
  const h = harness()
  h.sessions.set("old-review", { id: "old-review", metadata: { "opencode-auto-review": true }, time: {} })
  h.sessions.set("main", { id: "main", metadata: {}, time: {} })
  const cleanup = await tui.setup(h.context)
  await tick()
  assert.deepEqual(h.archived, ["old-review"])
  h.sessions.set("new-review", { id: "new-review", metadata: { "opencode-auto-review": true }, time: {} })
  h.created("new-review")
  h.created("main")
  await tick()
  assert.deepEqual(h.archived, ["old-review", "new-review"])
  h.sessions.set("other", { id: "other", metadata: { "opencode-auto-review": true }, time: {} })
  h.created("other", { directory: "/other", workspaceID: "ws" })
  await tick()
  assert.deepEqual(h.archived, ["old-review", "new-review"])
  await cleanup?.()
})

test("the footer command shows the RPC-confirmed state and reflects a real switch", async () => {
  const h = harness({ enabled: true })
  const cleanup = await tui.setup(h.context)
  h.renderSlot()
  const run = h.commands.find((command) => command.id === "auto-review.toggle")!.run
  await tick()
  assert.deepEqual(h.statusCalls[0]!.options, { location: { directory: "/repo", workspace: "ws" } })

  h.setReply("status")
  await run()
  assert.equal(h.toasts.at(-1)!.message, "Auto-review is enabled (human fallback on).")

  const toastsBefore = h.toasts.length
  h.setReply("off")
  await run()
  assert.equal(h.serverState(), false, "the switch must reach the server")
  assert.equal(h.toasts.length, toastsBefore, "a confirmed switch is not an error")

  h.setReply("status")
  await run()
  assert.equal(h.toasts.at(-1)!.message, "Auto-review is disabled (human fallback on).")
  await cleanup?.()
})

test("a reviewer notice is rendered as a toast with its severity", async () => {
  const h = harness()
  const cleanup = await tui.setup(h.context)
  h.renderSlot()
  await tick()
  h.emitNotice({ description: "Auto-review approved read.", severity: "success" })
  assert.equal(h.toasts.at(-1)!.message, "Auto-review approved read.")
  assert.equal(h.toasts.at(-1)!.variant, "success")
  h.emitNotice({ description: "Auto-review notice (shell): needs confirmation", severity: "warning" })
  assert.equal(h.toasts.at(-1)!.variant, "warning")
  // Malformed payloads are ignored instead of rendering an empty toast.
  const before = h.toasts.length
  h.emitNotice({ severity: "warning" })
  h.emitNotice(undefined)
  assert.equal(h.toasts.length, before)
  await cleanup?.()
})

test("a notice from another location is ignored", async () => {
  // RPC events reach every connected client, so a notice from another project must
  // not appear while the user is viewing this one.
  const h = harness()
  const cleanup = await tui.setup(h.context)
  h.renderSlot()
  await tick()
  h.emitNotice({ description: "elsewhere", severity: "success" }, { directory: "/other", workspaceID: "ws" })
  assert.equal(h.toasts.length, 0)
  h.emitNotice({ description: "here", severity: "success" }, { directory: "/repo", workspaceID: "ws" })
  assert.equal(h.toasts.at(-1)!.message, "here")
  await cleanup?.()
})

test("the human fallback can be switched from the palette", async () => {
  const h = harness()
  const cleanup = await tui.setup(h.context)
  h.renderSlot()
  const run = h.commands.find((command) => command.id === "auto-review.toggle")!.run
  await tick()
  // First select chooses the fallback flow, second turns it off.
  h.setReply("fallback")
  h.setReply("off")
  await run()
  assert.equal(h.serverFallback(), false, "the fallback switch must reach the server")
  assert.match(h.toasts.at(-1)!.message, /Human fallback is off/)
  await cleanup?.()
})

test("a switch that cannot be confirmed toasts and keeps the previous state", async () => {
  const h = harness({ enabled: true, failSwitch: true })
  const cleanup = await tui.setup(h.context)
  h.renderSlot()
  const run = h.commands.find((command) => command.id === "auto-review.toggle")!.run
  await tick()

  h.setReply("off")
  await run()
  assert.equal(h.serverState(), true, "a failed switch must not change server state")
  assert.match(h.toasts.at(-1)!.message, /Could not confirm auto-review mode/)
  assert.equal(h.toasts.at(-1)!.variant, "warning")

  h.setReply("status")
  await run()
  assert.equal(h.toasts.at(-1)!.message, "Auto-review is enabled (human fallback on).", "status must not report the failed guess")
  await cleanup?.()
})

test("a status query that cannot be confirmed is never reported as the current state", async () => {
  const h = harness({ enabled: true })
  const cleanup = await tui.setup(h.context)
  h.renderSlot()
  const run = h.commands.find((command) => command.id === "auto-review.toggle")!.run
  await tick()
  h.setFailStatus(true)
  h.setReply("status")
  await run()
  assert.match(h.toasts.at(-1)!.message, /status is unavailable/)
  await cleanup?.()
})

test("reconnect re-queries the authoritative state", async () => {
  const h = harness({ enabled: false })
  const cleanup = await tui.setup(h.context)
  await tick()
  h.connect()
  await tick()
  assert.ok(h.statusCalls.length >= 2)
  await cleanup?.()
})

test("setup never registers a keymap layer outside the component tree", async () => {
  // The host only provides the keymap context to rendered components. setup
  // runs outside it, so touching keymap there would fail plugin load with
  // "Keymap.Provider is missing".
  const h = harness()
  h.context.keymap.layer = () => { throw new Error("Keymap.Provider is missing") }
  const cleanup = await tui.setup(h.context)
  await cleanup?.()
})
