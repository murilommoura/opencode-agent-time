// Live event recorder for the agent-time plugin.
//
// Only observed server events are recorded; no session history is fetched.
//
// No runtime imports: unit-tested with `bun test`.
import type { BusySpan, Step } from "./aggregate"

// Tool identity is independent of its timestamp: concurrent calls can start
// in the same millisecond. It survives JSON storage and recorder reloads.
export type StoredWait = [number, number | null, string?]

export type StoredTool = {
  // assistant message id that emitted the call
  m: string
  // tool name (only `session.tool.input.started` carries it in v2.3.0)
  n: string
  // input.started timestamp
  s: number
  // session.tool.called timestamp (actual execution start)
  r?: number
}

export type StoredStep = {
  a: string
  s?: number
  e?: number
  // last observed activity inside the step (token/tool), used only to close a
  // step recovered after a crash; never a guessed duration.
  l?: number
  x?: boolean
  c?: boolean
  // subagent wait windows; `null` end means the subagent is still running and
  // the window grows progressively in live reads.
  w?: StoredWait[]
  // provider-qualified model observed on session.step.started (v2.3.0).
  // Stored separately so old snapshots without it remain readable.
  p?: string
  i?: string
}

export type StoredSession = {
  a?: string
  n?: number
  steps: Record<string, StoredStep>
  busy: Array<[number, number | null]>
  idle?: number
  // pending tool calls, persisted so a reload keeps the dedup/discount state
  tools?: Record<string, StoredTool>
}

export type Timeline = { v: 1; sessions: Record<string, StoredSession> }

export type RecorderDeps = {
  storage: {
    store: (key: string, options: { initial: Timeline }) => [unknown, (mutate: (draft: Timeline) => void) => unknown]
  }
  on: (type: string, handler: (event: any) => void) => unknown
  now?: () => number
}

const SUBAGENT_TOOLS = new Set(["subagent", "task"])
const MAX_SESSIONS = 400
const MAX_STEPS = 60_000
const FLUSH_DELAY = 600

function emptySession(at: number): StoredSession {
  return { steps: {}, busy: [], n: at }
}

export function normalize(value: unknown): Timeline {
  const out: Timeline = { v: 1, sessions: {} }
  if (!value || typeof value !== "object") return out
  const source = value as Timeline
  const sessions = source.sessions
  if (!sessions || typeof sessions !== "object") return out
  for (const [sid, raw] of Object.entries(sessions)) {
    if (!raw || typeof raw !== "object") continue
    const entry = raw as StoredSession
    const session: StoredSession = { steps: {}, busy: [], n: 0 }
    session.a = typeof entry.a === "string" ? entry.a : undefined
    session.n = typeof entry.n === "number" ? entry.n : 0
    session.idle = typeof entry.idle === "number" ? entry.idle : undefined
    if (Array.isArray(entry.busy)) {
      for (const span of entry.busy) {
        if (!Array.isArray(span) || typeof span[0] !== "number") continue
        session.busy.push([span[0], typeof span[1] === "number" ? span[1] : null])
      }
    }
    if (entry.tools && typeof entry.tools === "object") {
      const tools: Record<string, StoredTool> = {}
      for (const [id, tool] of Object.entries(entry.tools)) {
        if (!tool || typeof tool !== "object") continue
        const value = tool as StoredTool
        if (typeof value.m !== "string" || typeof value.s !== "number") continue
        tools[id] = {
          m: value.m,
          n: typeof value.n === "string" ? value.n : "tool",
          s: value.s,
          r: typeof value.r === "number" ? value.r : undefined,
        }
      }
      if (Object.keys(tools).length > 0) session.tools = tools
    }
    if (entry.steps && typeof entry.steps === "object") {
      for (const [mid, step] of Object.entries(entry.steps)) {
        if (!step || typeof step !== "object") continue
        const value = step as StoredStep
        if (typeof value.s !== "number") continue
        session.steps[mid] = {
          a: typeof value.a === "string" ? value.a : "?",
          s: value.s,
          e: typeof value.e === "number" ? value.e : undefined,
          l: typeof value.l === "number" ? value.l : undefined,
          x: value.x === true,
          c: value.c === true,
          p: typeof value.p === "string" && value.p.length > 0 ? value.p : undefined,
          i: typeof value.i === "string" && value.i.length > 0 ? value.i : undefined,
          w: Array.isArray(value.w)
            ? value.w
                .filter(
                  (pair): pair is StoredWait =>
                    Array.isArray(pair) &&
                    typeof pair[0] === "number" &&
                    (pair[1] === null || typeof pair[1] === "number"),
                )
                .map((pair) => [pair[0], pair[1], pair[2]] as StoredWait)
            : undefined,
        }
      }
    }
    out.sessions[sid] = session
  }
  return out
}

/**
 * Convert a stored record into a Step.
 *
 * An unfinished step is capped at `now` only while the session is running.
 * When the session is idle (crash/restart), it ends at the last observed
 * activity, never at "now": reopening cannot inflate the total.
 */
export function toStep(sid: string, id: string, stored: StoredStep, running: boolean, now: number): Step | null {
  if (typeof stored.s !== "number") return null
  let end = stored.e
  if (end === undefined) {
    if (running) end = now
    else {
      const closed = (stored.w ?? []).flatMap((wait) => (wait[1] === null ? [] : [wait[1]]))
      end = Math.max(stored.s, stored.l ?? stored.s, ...closed)
    }
  }
  const stepEnd = Math.max(end, stored.s)
  // An open subagent wait is subtracted progressively in live reads: the
  // parent's active time stops growing until the child returns. Once the step
  // is closed, the wait is capped by the step end.
  const waits = (stored.w ?? [])
    .map(([start, waitEnd]) => ({ start, end: waitEnd ?? Math.min(stepEnd, now) }))
    .filter((wait) => wait.end > wait.start)
  const live = stored.e === undefined && stored.x === true && running
  return {
    id,
    sessionID: sid,
    agent: stored.a || "?",
    start: stored.s,
    end: stepEnd,
    waits,
    exact: stored.x === true,
    complete: stored.c === true || live,
    live,
    model:
      typeof stored.p === "string" && stored.p.length > 0 && typeof stored.i === "string" && stored.i.length > 0
        ? { providerID: stored.p, id: stored.i }
        : undefined,
  }
}

export function createRecorder(deps: RecorderDeps) {
  const nowFn = deps.now ?? (() => Date.now())
  const [stored, update] = deps.storage.store("timeline", { initial: { v: 1, sessions: {} } })
  const data = normalize(typeof stored === "function" ? (stored as () => unknown)() : stored)
  const listeners = new Set<(sid: string) => void>()
  const offs: Array<() => void> = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const session = (sid: string): StoredSession => {
    let existing = data.sessions[sid]
    if (!existing) {
      existing = emptySession(nowFn())
      data.sessions[sid] = existing
    }
    existing.n = nowFn()
    return existing
  }

  function prune() {
    const entries = Object.entries(data.sessions)
    const steps = entries.reduce((acc, [, value]) => acc + Object.keys(value.steps).length, 0)
    if (entries.length <= MAX_SESSIONS && steps <= MAX_STEPS) return
    entries.sort((a, b) => (b[1].n ?? 0) - (a[1].n ?? 0))
    const keep: Record<string, StoredSession> = {}
    let count = 0
    for (const [sid, value] of entries) {
      if (Object.keys(keep).length >= MAX_SESSIONS || count >= MAX_STEPS) break
      keep[sid] = value
      count += Object.keys(value.steps).length
    }
    data.sessions = keep
  }

  function write() {
    prune()
    const result = update((draft: Timeline) => {
      draft.v = 1
      draft.sessions = data.sessions
    })
    if (result && typeof (result as Promise<unknown>).catch === "function") {
      ;(result as Promise<unknown>).catch(() => {})
    }
  }

  function flushNow() {
    try {
      write()
    } catch {}
  }

  function flush() {
    if (disposed) return
    timer = undefined
    flushNow()
  }

  function schedule() {
    if (timer !== undefined || disposed) return
    timer = setTimeout(flush, FLUSH_DELAY)
    if (typeof (timer as any)?.unref === "function") (timer as any).unref()
  }

  function touch(sid: string, notify = true) {
    session(sid)
    if (notify) {
      for (const listener of listeners) {
        try {
          listener(sid)
        } catch {}
      }
    }
    schedule()
  }

  function closeWait(st: StoredStep, at: number) {
    for (const wait of st.w ?? []) {
      if (wait[1] === null) wait[1] = Math.max(at, wait[0])
    }
  }

  function openWait(st: StoredStep, start: number, id: string) {
    st.w ??= []
    if (!st.w.some((wait) => wait[2] === id)) st.w.push([start, null, id])
  }

  function dropTools(current: StoredSession, mid?: string) {
    if (!current.tools) return
    for (const [id, tool] of Object.entries(current.tools)) {
      if (mid === undefined || tool.m === mid) delete current.tools[id]
    }
  }

  function handle(event: any) {
    try {
      const type = event?.type
      if (typeof type !== "string" || !type.startsWith("session.")) return
      const payload = event.data ?? {}
      const sid = payload.sessionID
      if (typeof sid !== "string") return
      const current = session(sid)
      const created = typeof event.created === "number" ? event.created : nowFn()

      switch (type) {
        case "session.step.started": {
          const mid = payload.assistantMessageID
          if (typeof mid !== "string") return
          const start = typeof payload.started === "number" ? payload.started : created
          const st = (current.steps[mid] ??= { a: payload.agent ?? current.a ?? "?", s: start })
          st.a = payload.agent ?? st.a ?? current.a ?? "?"
          st.s = start
          st.l = Math.max(st.l ?? start, start)
          st.x = current.busy.some(([, end]) => end === null)
          st.c = false
          // v2.3.0 sends `model: { providerID, id, variant? }` on the step
          // event itself. Keep only the provider-qualified identity; never
          // derive it from session state/history, which could misattribute a
          // model selected between steps.
          const model = payload.model
          if (model && typeof model === "object") {
            if (typeof model.providerID === "string" && model.providerID.length > 0) st.p = model.providerID
            if (typeof model.id === "string" && model.id.length > 0) st.i = model.id
          }
          if (payload.agent) current.a = payload.agent
          touch(sid)
          return
        }
        case "session.step.first-token":
        case "session.step.streamed": {
          const mid = payload.assistantMessageID
          if (typeof mid !== "string") return
          const st = current.steps[mid]
          if (!st) return
          st.l = Math.max(st.l ?? created, created)
          schedule()
          return
        }
        case "session.step.ended":
        case "session.step.failed": {
          const mid = payload.assistantMessageID
          if (typeof mid !== "string") return
          const st = current.steps[mid]
          if (!st) return
          st.e = created
          st.l = Math.max(st.l ?? created, created)
          st.c = st.x === true
          // the turn is over: no subagent call from this step can still be
          // awaited, so any open wait ends here
          closeWait(st, created)
          dropTools(current, mid)
          touch(sid)
          return
        }
        case "session.tool.input.started": {
          // v2.3.0 carries the tool name here, not in session.tool.called.
          const mid = payload.assistantMessageID
          const id = payload.id
          if (typeof mid !== "string" || typeof id !== "string") return
          current.tools ??= {}
          current.tools[id] = {
            m: mid,
            n: typeof payload.name === "string" ? payload.name : "tool",
            s: created,
          }
          const st = current.steps[mid]
          if (st) st.l = Math.max(st.l ?? created, created)
          schedule()
          return
        }
        case "session.tool.called": {
          const mid = payload.assistantMessageID
          const id = payload.id
          if (typeof mid !== "string" || typeof id !== "string") return
          current.tools ??= {}
          const tool = (current.tools[id] ??= { m: mid, n: "tool", s: created })
          tool.m = mid
          tool.r ??= created
          const st = current.steps[mid]
          if (!st) return
          st.l = Math.max(st.l ?? created, created)
          // the parent starts waiting when the tool actually runs; the window
          // stays open (and is subtracted progressively) until it returns
          if (SUBAGENT_TOOLS.has(tool.n)) openWait(st, tool.r, id)
          touch(sid)
          return
        }
        case "session.tool.success":
        case "session.tool.failed": {
          const id = payload.id
          if (typeof id !== "string") return
          const tool = current.tools?.[id]
          if (!tool) return
          delete current.tools![id]
          const st = current.steps[tool.m]
          if (!st) return
          st.l = Math.max(st.l ?? created, created)
          if (SUBAGENT_TOOLS.has(tool.n)) {
            const start = tool.r ?? tool.s
            const wait = st.w?.find((entry) => entry[1] === null && entry[2] === id)
            if (wait) wait[1] = Math.max(created, wait[0])
            else if (start < created) st.w = [...(st.w ?? []), [start, created, id]]
          }
          touch(sid)
          return
        }
        case "session.execution.started": {
          current.busy.push([created, null])
          current.idle = undefined
          touch(sid)
          return
        }
        case "session.execution.succeeded":
        case "session.execution.failed":
        case "session.execution.interrupted": {
          for (let index = current.busy.length - 1; index >= 0; index -= 1) {
            if (current.busy[index][1] === null) {
              current.busy[index] = [current.busy[index][0], created]
              break
            }
          }
          current.idle = created
          for (const st of Object.values(current.steps)) {
            closeWait(st, created)
            if (st.e === undefined) {
              st.e = created
              st.l = Math.max(st.l ?? created, created)
              st.c = false
            }
          }
          // pending tools belong to the execution that just ended; a later
          // success/failure cannot be awaited anymore
          dropTools(current)
          touch(sid)
          return
        }
        default:
          return
      }
    } catch {}
  }

  for (const name of [
    "session.step.started",
    "session.step.first-token",
    "session.step.streamed",
    "session.step.ended",
    "session.step.failed",
    "session.tool.input.started",
    "session.tool.called",
    "session.tool.success",
    "session.tool.failed",
    "session.execution.started",
    "session.execution.succeeded",
    "session.execution.failed",
    "session.execution.interrupted",
  ]) {
    try {
      const off = deps.on(name, handle)
      if (typeof off === "function") offs.push(off as () => void)
    } catch {}
  }

  return {
    session,
    get: (sid: string) => data.sessions[sid],
    touch,
    subscribe(listener: (sid: string) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    busyFor(sid: string, running: boolean, at: number): BusySpan[] {
      const current = data.sessions[sid]
      if (!current) return []
      const spans: BusySpan[] = []
      for (const [start, end] of current.busy) {
        if (typeof end === "number") spans.push([start, end])
        else if (running) spans.push([start, at])
      }
      return spans
    },
    flush: flushNow,
    dispose() {
      for (const off of offs) {
        try {
          off()
        } catch {}
      }
      offs.length = 0
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      flushNow()
      disposed = true
    },
    snapshot: () => data,
  }
}
