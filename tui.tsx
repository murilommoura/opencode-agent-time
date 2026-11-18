/** @jsxImportSource @opentui/solid */
// agent-time — TUI-only plugin (cli.json).
//
// Adds a block to the native right sidebar with the agent execution time of the
// current session family (root + recursive descendants), broken down by agent.
//
// Measurement is prospective: only observed server events are recorded.
//
// Precision: time comes from server events (step start/end, tool windows,
// execution busy/idle), persisted by this plugin. Busy spans remove suspensions
// without any duration threshold; subagent waits are removed from the parent
// and counted in the child.
import { Plugin } from "@opencode/plugin/tui"
import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { formatDuration, formatModel, summarize, type Step, type Summary } from "./aggregate"
import { createRecorder, toStep } from "./recorder"
import { agentRows, modelRows } from "./rows"
import { collectPages } from "./paging"
import { statusLabel } from "./status"

type SessionInfo = {
  id: string
  parentID?: string
  agent?: string
}

const PAGE_LIMIT = 100
const MAX_PAGES = 64
const MAX_DEPTH = 8
const MAX_FAMILY = 200

const EMPTY: Summary = {
  total: 0,
  byAgent: [],
  byModel: [],
  estimated: false,
  incomplete: 0,
  live: false,
  steps: 0,
}

function Block(props: { sessionID: string; recorder: ReturnType<typeof createRecorder>; ctx: any }) {
  const ctx = props.ctx
  // Explicit plugin option only. OpenCode 2.3.0 has no TUI locale API, so the
  // default is English and nothing is inferred from LANG/OS/server.
  const locale = ctx.options?.locale
  const [summary, setSummary] = createSignal<Summary>(EMPTY)
  const [phase, setPhase] = createSignal<"loading" | "ready" | "error">("loading")
  const [error, setError] = createSignal("")

  let root = ""
  let infos = new Map<string, SessionInfo>()
  const pending = new Map<string, ReturnType<typeof setTimeout>>()

  const running = (sid: string) => {
    try {
      return ctx.data.session.status(sid) === "running"
    } catch {
      return false
    }
  }

  const recompute = () => {
    try {
      const now = Date.now()
      const sessions = [...infos.entries()]
        .map(([sid, info]) => {
          const stored = props.recorder.get(sid)
          const steps: Step[] = []
          if (stored) {
            const live = running(sid)
            for (const [id, step] of Object.entries(stored.steps)) {
              if (step.x !== true) continue
              const parsed = toStep(sid, id, step, live, now)
              if (parsed) steps.push(parsed)
            }
          }
          return {
            sessionID: sid,
            agent: info.agent ?? stored?.a,
            steps,
            busy: props.recorder.busyFor(sid, running(sid), now),
          }
        })
      setSummary(summarize(sessions))
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause))
      setPhase("error")
    }
  }

  async function ensureSession(sid: string): Promise<SessionInfo> {
    const local = ctx.data.session.get(sid)
    if (local) return { id: sid, parentID: local.parentID, agent: local.agent }
    try {
      const response = await ctx.client.session.get({ sessionID: sid })
      const data = response?.data ?? response
      if (data && typeof data === "object") return data as SessionInfo
    } catch {}
    return { id: sid }
  }

  async function loadFamily(rootID: string, rootInfo: SessionInfo) {
    const seen = new Map<string, SessionInfo>()
    seen.set(rootID, rootInfo)
    let frontier = [rootID]
    for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0 && seen.size < MAX_FAMILY; depth += 1) {
      const next: string[] = []
      for (const sid of frontier) {
        const result = await collectPages<SessionInfo>(
          (query) => ctx.client.session.list({ ...query, parentID: sid }),
          { limit: PAGE_LIMIT, order: "desc" },
          MAX_PAGES,
        )
        if (!result.complete) throw new Error("árvore de sessões incompleta")
        for (const child of result.items) {
          if (!child?.id || seen.has(child.id)) continue
          seen.set(child.id, child)
          next.push(child.id)
        }
      }
      frontier = next
    }
    if (frontier.length > 0 || seen.size >= MAX_FAMILY) throw new Error("limite da árvore de sessões atingido")
    return seen
  }

  async function boot(rootID: string) {
    setPhase("loading")
    setError("")
    try {
      const info = await ensureSession(rootID)
      if (rootID !== root) return
      const loaded = await loadFamily(rootID, info)
      if (rootID !== root) return
      infos = loaded
      recompute()
      setPhase("ready")
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause))
      setPhase("error")
    }
  }

  const scheduleRefresh = (sid: string) => {
    if (!root || infos.has(sid)) return
    if (pending.has("family")) return
    pending.set(
      "family",
      setTimeout(() => {
        pending.delete("family")
        void boot(root)
      }, 1200),
    )
  }

  createEffect(() => {
    const id = props.sessionID
    if (!id) return
    let nextRoot = id
    try {
      nextRoot = ctx.data.session.root(id) ?? id
    } catch {}
    if (nextRoot === root) return
    root = nextRoot
    void boot(nextRoot)
  })

  onMount(() => {
    const tick = setInterval(() => recompute(), 1000)
    const stopRecorder = props.recorder.subscribe((sid) => {
      recompute()
      scheduleRefresh(sid)
    })
    let stopCreated: (() => void) | undefined
    try {
      const off = ctx.data.on("session.created", () => {
        if (!root) return
        if (pending.has("family")) return
        pending.set(
          "family",
          setTimeout(() => {
            pending.delete("family")
            void boot(root)
          }, 1200),
        )
      })
      if (typeof off === "function") stopCreated = off
    } catch {}
    onCleanup(() => {
      clearInterval(tick)
      stopRecorder()
      if (stopCreated) stopCreated()
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
    })
  })

  const rows = () => {
    const value = summary()
    const models = modelRows(value)
    return {
      agents: agentRows(value),
      modelTop: models.top,
      modelRestTotal: models.restTotal,
      modelRestCount: models.restCount,
    }
  }

  const totalText = () => {
    const value = summary()
    if (value.total === 0) return "—"
    return `${value.estimated ? "~" : ""}${formatDuration(value.total)}`
  }

  const statusText = () => statusLabel(summary().live, locale)

  return (
    <box flexDirection="column">
      <text>
        <b>Agent time</b>
        <span fg={ctx.theme.text.muted}>  </span>
        <span fg={ctx.theme.text.feedback.success.base}>{totalText()}</span>
        <span fg={summary().live ? ctx.theme.text.feedback.success.base : ctx.theme.text.muted}>
          {` ${statusText()}`}
        </span>
      </text>
      <Show when={phase() === "error"}>
        <text fg={ctx.theme.text.feedback.error.base}>erro: {error()}</text>
      </Show>
      <Show when={phase() === "ready"}>
        <For each={rows().agents}>
          {(row) => (
            <text>
              <span fg={ctx.theme.text.muted}>{"  " + row.agent.slice(0, 14).padEnd(15)}</span>
              <span fg={ctx.theme.text.base}>{formatDuration(row.total)}</span>
            </text>
          )}
        </For>
        <Show when={rows().modelTop.length > 0}>
          <text>
            <span fg={ctx.theme.text.muted}>Model</span>
          </text>
          <For each={rows().modelTop}>
            {(row) => (
              <text>
                <span fg={ctx.theme.text.muted}>{"  " + formatModel(row).slice(0, 21).padEnd(22)}</span>
                <span fg={ctx.theme.text.base}>{formatDuration(row.total)}</span>
              </text>
            )}
          </For>
          <Show when={rows().modelRestCount > 0}>
            <text>
              <span fg={ctx.theme.text.muted}>{`  +${rows().modelRestCount} modelos`.padEnd(17)}</span>
              <span fg={ctx.theme.text.base}>{formatDuration(rows().modelRestTotal)}</span>
            </text>
          </Show>
        </Show>
      </Show>
    </box>
  )
}

export default Plugin.define({
  id: "agent-time",
  async setup(ctx: any) {
    const recorder = createRecorder({
      storage: ctx.storage,
      on: (name: string, handler: (event: any) => void) => ctx.data.on(name, handler),
    })
    const unregister = ctx.ui.slot({
      prepend: "sidebar.content",
      render: (props: { sessionID: string }) => (
        <Block sessionID={props.sessionID} recorder={recorder} ctx={ctx} />
      ),
    })
    return () => {
      try {
        if (typeof unregister === "function") unregister()
      } catch {}
      recorder.dispose()
    }
  },
})
