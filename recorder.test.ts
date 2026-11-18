import { describe, expect, test } from "bun:test"
import { summarize } from "./aggregate"
import { createRecorder, normalize, toStep, type Timeline } from "./recorder"

function harness(initial?: unknown) {
  let value: Timeline = (initial as Timeline) ?? { v: 1, sessions: {} }
  const handlers = new Map<string, (event: any) => void>()
  let clock = 1_000
  const recorder = createRecorder({
    storage: {
      store: (_key, options) => [
        () => (value ?? options.initial),
        (mutate: (draft: Timeline) => void) => {
          const draft = structuredClone(value)
          mutate(draft)
          value = draft
          return Promise.resolve()
        },
      ],
    },
    on: (type, handler) => {
      handlers.set(type, handler)
      return () => handlers.delete(type)
    },
    now: () => clock,
  })
  const emit = (type: string, data: Record<string, unknown>, created: number) => {
    clock = created
    const handler = handlers.get(type)
    if (!handler) throw new Error(`no handler for ${type}`)
    handler({ type, data, created })
  }
  return { recorder, emit, value: () => value, handlers, setClock: (at: number) => (clock = at) }
}

const SID = "ses_root"
const MID = "msg_1"

function toolStart(h: ReturnType<typeof harness>, sid: string, mid: string, id: string, name: string, at: number) {
  // real v2.3.0 contract: the name is delivered here
  h.emit("session.tool.input.started", { sessionID: sid, assistantMessageID: mid, id, name }, at)
}

function toolRun(h: ReturnType<typeof harness>, sid: string, mid: string, id: string, at: number) {
  // real v2.3.0 contract: no `name` on this event
  h.emit("session.tool.called", { sessionID: sid, assistantMessageID: mid, id }, at)
}

function toolEnd(h: ReturnType<typeof harness>, sid: string, mid: string, id: string, at: number, failed = false) {
  h.emit(failed ? "session.tool.failed" : "session.tool.success", { sessionID: sid, assistantMessageID: mid, id }, at)
}

describe("recorder", () => {
  test("real contract: subagent wait uses the name from input.started (QA regression)", () => {
    const h = harness()
    h.emit("session.execution.started", { sessionID: SID }, 0)
    h.emit("session.step.started", { sessionID: SID, assistantMessageID: MID, agent: "orquestrador", started: 0 }, 0)
    toolStart(h, SID, MID, "t1", "subagent", 2_000)
    toolRun(h, SID, MID, "t1", 2_000)
    toolEnd(h, SID, MID, "t1", 5_000)
    h.emit("session.step.ended", { sessionID: SID, assistantMessageID: MID }, 5_000)
    h.emit("session.execution.succeeded", { sessionID: SID }, 5_000)

    const stored = h.recorder.get(SID)!.steps[MID]
    expect(stored.w).toEqual([[2_000, 5_000, "t1"]])
    const step = toStep(SID, MID, stored, false, 0)!
    const summary = summarize([{ sessionID: SID, steps: [step], busy: h.recorder.busyFor(SID, false, 0) }])
    expect(summary.total).toBe(2_000)
  })

  test("real contract: called without input.started cannot infer a subagent", () => {
    const h = harness()
    h.emit("session.execution.started", { sessionID: SID }, 0)
    h.emit("session.step.started", { sessionID: SID, assistantMessageID: MID, agent: "orquestrador", started: 0 }, 0)
    toolRun(h, SID, MID, "t1", 2_000)
    toolEnd(h, SID, MID, "t1", 5_000)
    h.emit("session.step.ended", { sessionID: SID, assistantMessageID: MID }, 5_000)
    h.emit("session.execution.succeeded", { sessionID: SID }, 5_000)

    const stored = h.recorder.get(SID)!.steps[MID]
    expect(stored.w ?? []).toEqual([])
    const summary = summarize([
      { sessionID: SID, steps: [toStep(SID, MID, stored, false, 0)!], busy: h.recorder.busyFor(SID, false, 0) },
    ])
    expect(summary.total).toBe(5_000)
  })

  test("open subagent wait is discounted progressively in live reads", () => {
    const h = harness()
    h.emit("session.execution.started", { sessionID: SID }, 0)
    h.emit("session.step.started", { sessionID: SID, assistantMessageID: MID, agent: "orquestrador", started: 0 }, 0)
    toolStart(h, SID, MID, "t1", "subagent", 1_000)
    toolRun(h, SID, MID, "t1", 1_000)

    const stored = h.recorder.get(SID)!.steps[MID]
    const at4s = toStep(SID, MID, stored, true, 4_000)!
    expect(at4s.waits).toEqual([{ start: 1_000, end: 4_000 }])
    expect(at4s.end).toBe(4_000)
    const live4 = summarize([{ sessionID: SID, steps: [at4s], busy: h.recorder.busyFor(SID, true, 4_000) }])
    expect(live4.total).toBe(1_000)

    const at5s = toStep(SID, MID, stored, true, 5_000)!
    const live5 = summarize([{ sessionID: SID, steps: [at5s], busy: h.recorder.busyFor(SID, true, 5_000) }])
    expect(live5.total).toBe(1_000)

    toolEnd(h, SID, MID, "t1", 5_000)
    h.emit("session.step.ended", { sessionID: SID, assistantMessageID: MID }, 6_000)
    h.emit("session.execution.succeeded", { sessionID: SID }, 6_000)
    const done = toStep(SID, MID, h.recorder.get(SID)!.steps[MID], false, 0)!
    const after = summarize([{ sessionID: SID, steps: [done], busy: h.recorder.busyFor(SID, false, 0) }])
    expect(after.total).toBe(2_000)
  })

  test("pending tools survive a reload and close on success", () => {
    const first = harness()
    first.emit("session.execution.started", { sessionID: SID }, 0)
    first.emit("session.step.started", { sessionID: SID, assistantMessageID: MID, agent: "orquestrador", started: 0 }, 0)
    toolStart(first, SID, MID, "t1", "subagent", 1_000)
    toolRun(first, SID, MID, "t1", 1_000)
    first.recorder.flush()

    expect(first.value().sessions[SID].tools).toEqual({ t1: { m: MID, n: "subagent", s: 1_000, r: 1_000 } })
    expect(first.value().sessions[SID].steps[MID].w).toEqual([[1_000, null, "t1"]])

    const second = harness(JSON.parse(JSON.stringify(first.value())))
    expect(second.recorder.get(SID)!.tools).toEqual({ t1: { m: MID, n: "subagent", s: 1_000, r: 1_000 } })

    toolEnd(second, SID, MID, "t1", 5_000)
    second.emit("session.step.ended", { sessionID: SID, assistantMessageID: MID }, 6_000)
    second.emit("session.execution.succeeded", { sessionID: SID }, 6_000)

    const stored = second.recorder.get(SID)!.steps[MID]
    expect(stored.w).toEqual([[1_000, 5_000, "t1"]])
    expect(second.recorder.get(SID)!.tools).toEqual({})
    const summary = summarize([
      { sessionID: SID, steps: [toStep(SID, MID, stored, false, 0)!], busy: second.recorder.busyFor(SID, false, 0) },
    ])
    expect(summary.total).toBe(2_000)
  })

  for (const firstID of ["a", "b"]) {
    for (const failed of [false, true]) {
      for (const reloadAt of ["never", "before return", "after return"]) {
        test(`same-ms concurrent calls: ${firstID} ${failed ? "fails" : "returns"} first, reload ${reloadAt}`, () => {
          let h = harness()
          const lastID = firstID === "a" ? "b" : "a"
          h.emit("session.execution.started", { sessionID: SID }, 1_000)
          h.emit("session.step.started", { sessionID: SID, assistantMessageID: MID, agent: "parent", started: 1_000 }, 1_000)
          for (const id of ["a", "b"]) {
            toolStart(h, SID, MID, id, id === "a" ? "subagent" : "task", 2_000)
            toolRun(h, SID, MID, id, 2_000)
          }
          const reload = () => {
            h.recorder.dispose()
            h = harness(JSON.parse(JSON.stringify(h.value())))
          }
          const totalAt = (at: number) => summarize([{
            sessionID: SID,
            steps: [toStep(SID, MID, h.recorder.get(SID)!.steps[MID], true, at)!],
            busy: h.recorder.busyFor(SID, true, at),
          }]).total
          if (reloadAt === "before return") reload()
          toolEnd(h, SID, MID, firstID, 3_000, failed)
          if (reloadAt === "after return") reload()

          // Exact second-QA-FAIL regression: the other same-ms tool is pending.
          expect(totalAt(4_000)).toBe(1_000)
          expect(totalAt(5_000)).toBe(1_000)
          expect(Object.keys(h.recorder.get(SID)!.tools!)).toEqual([lastID])
          expect(h.recorder.get(SID)!.steps[MID].w).toEqual([
            [2_000, firstID === "a" ? 3_000 : null, "a"],
            [2_000, firstID === "b" ? 3_000 : null, "b"],
          ])

          toolEnd(h, SID, MID, lastID, 6_000, !failed)
          expect(totalAt(7_000)).toBe(2_000)
          h.emit("session.step.ended", { sessionID: SID, assistantMessageID: MID }, 7_000)
          h.emit("session.execution.succeeded", { sessionID: SID }, 7_000)
          expect(totalAt(9_000)).toBe(2_000)
          h.recorder.dispose()
        })
      }
    }
  }

  for (const terminal of ["session.step.failed", "session.execution.failed", "session.execution.interrupted"]) {
    test(`same-ms pending waits close on ${terminal}, late results cannot reopen them`, () => {
      const first = harness()
      first.emit("session.execution.started", { sessionID: SID }, 1_000)
      first.emit("session.step.started", { sessionID: SID, assistantMessageID: MID, agent: "parent", started: 1_000 }, 1_000)
      for (const id of ["a", "b"]) {
        toolStart(first, SID, MID, id, "subagent", 2_000)
        toolRun(first, SID, MID, id, 2_000)
      }
      first.recorder.dispose()
      const h = harness(JSON.parse(JSON.stringify(first.value())))
      h.emit(terminal, { sessionID: SID, assistantMessageID: MID }, 4_000)
      toolEnd(h, SID, MID, "b", 5_000, true)
      toolEnd(h, SID, MID, "a", 6_000)
      const stored = h.recorder.get(SID)!
      expect(stored.tools).toEqual({})
      expect(stored.steps[MID].w).toEqual([[2_000, 4_000, "a"], [2_000, 4_000, "b"]])
      expect(summarize([{
        sessionID: SID,
        steps: [toStep(SID, MID, stored.steps[MID], false, 9_000)!],
        busy: h.recorder.busyFor(SID, false, 9_000),
      }]).total).toBe(1_000)
      h.recorder.dispose()
    })
  }

  test("repeated called for one toolID cannot create a second wait", () => {
    const h = harness()
    h.emit("session.execution.started", { sessionID: SID }, 1_000)
    h.emit("session.step.started", { sessionID: SID, assistantMessageID: MID, started: 1_000 }, 1_000)
    toolStart(h, SID, MID, "a", "subagent", 2_000)
    toolRun(h, SID, MID, "a", 2_000)
    toolRun(h, SID, MID, "a", 2_500)
    toolEnd(h, SID, MID, "a", 3_000)
    expect(h.recorder.get(SID)!.steps[MID].w).toEqual([[2_000, 3_000, "a"]])
    h.recorder.dispose()
  })

  test("nested/concurrent subagents: parent wait is the union, children add up", () => {
    const h = harness()
    h.emit("session.execution.started", { sessionID: SID }, 0)
    h.emit("session.step.started", { sessionID: SID, assistantMessageID: MID, agent: "orquestrador", started: 0 }, 0)
    toolStart(h, SID, MID, "a", "subagent", 1_000)
    toolRun(h, SID, MID, "a", 1_000)
    toolStart(h, SID, MID, "b", "subagent", 3_000)
    toolRun(h, SID, MID, "b", 3_000)
    toolEnd(h, SID, MID, "a", 4_000)
    toolEnd(h, SID, MID, "b", 8_000)
    h.emit("session.step.ended", { sessionID: SID, assistantMessageID: MID }, 10_000)
    h.emit("session.execution.succeeded", { sessionID: SID }, 10_000)

    const parent = toStep(SID, MID, h.recorder.get(SID)!.steps[MID], false, 0)!
    const parentTotal = summarize([{ sessionID: SID, steps: [parent], busy: h.recorder.busyFor(SID, false, 0) }])
    // unit 1s..8s => 7s wait, parent active 3s
    expect(parentTotal.total).toBe(3_000)

    const childA: any = {
      id: "ca",
      sessionID: "ses_a",
      agent: "backend",
      start: 1_000,
      end: 4_000,
      waits: [],
      exact: true,
      complete: true,
    }
    const childB: any = {
      id: "cb",
      sessionID: "ses_b",
      agent: "qa",
      start: 3_000,
      end: 8_000,
      waits: [],
      exact: true,
      complete: true,
    }
    const all = summarize([
      { sessionID: SID, steps: [parent], busy: h.recorder.busyFor(SID, false, 0) },
      { sessionID: "ses_a", steps: [childA] },
      { sessionID: "ses_b", steps: [childB] },
    ])
    expect(all.total).toBe(3_000 + 3_000 + 5_000)
    expect(Object.fromEntries(all.byAgent.map((row) => [row.agent, row.total]))).toEqual({
      qa: 5_000,
      backend: 3_000,
      orquestrador: 3_000,
    })
  })

  test("tool failure closes the open wait like success", () => {
    const h = harness()
    h.emit("session.execution.started", { sessionID: SID }, 0)
    h.emit("session.step.started", { sessionID: SID, assistantMessageID: MID, agent: "backend", started: 0 }, 0)
    toolStart(h, SID, MID, "t1", "subagent", 1_000)
    toolRun(h, SID, MID, "t1", 1_000)
    toolEnd(h, SID, MID, "t1", 3_000, true)
    h.emit("session.step.ended", { sessionID: SID, assistantMessageID: MID }, 4_000)
    h.emit("session.execution.succeeded", { sessionID: SID }, 4_000)
    const stored = h.recorder.get(SID)!.steps[MID]
    expect(stored.w).toEqual([[1_000, 3_000, "t1"]])
    const summary = summarize([
      { sessionID: SID, steps: [toStep(SID, MID, stored, false, 0)!], busy: h.recorder.busyFor(SID, false, 0) },
    ])
    expect(summary.total).toBe(2_000)
  })

  test("cancelled execution closes the open wait", () => {
    const h = harness()
    h.emit("session.execution.started", { sessionID: SID }, 0)
    h.emit("session.step.started", { sessionID: SID, assistantMessageID: MID, agent: "backend", started: 0 }, 0)
    toolStart(h, SID, MID, "t1", "subagent", 1_000)
    toolRun(h, SID, MID, "t1", 1_000)
    h.emit("session.execution.interrupted", { sessionID: SID }, 3_000)

    const stored = h.recorder.get(SID)!.steps[MID]
    expect(stored.w).toEqual([[1_000, 3_000, "t1"]])
    expect(stored.tools ?? {}).toEqual({})
    const summary = summarize([
      { sessionID: SID, steps: [toStep(SID, MID, stored, false, 0)!], busy: h.recorder.busyFor(SID, false, 0) },
    ])
    expect(summary.total).toBe(1_000)
    expect(summary.estimated).toBe(true)
  })

  test("suspension between two busy spans is removed without any threshold", () => {
    const h = harness()
    h.emit("session.execution.started", { sessionID: SID }, 1_000)
    h.emit("session.step.started", { sessionID: SID, assistantMessageID: MID, agent: "backend", started: 1_000 }, 1_000)
    h.emit("session.execution.succeeded", { sessionID: SID }, 5_000)
    h.emit("session.execution.started", { sessionID: SID }, 99_000)
    h.emit("session.step.ended", { sessionID: SID, assistantMessageID: MID }, 100_000)
    h.emit("session.execution.succeeded", { sessionID: SID }, 100_000)

    const step = toStep(SID, MID, h.recorder.get(SID)!.steps[MID], false, 0)!
    const summary = summarize([{ sessionID: SID, steps: [step], busy: h.recorder.busyFor(SID, false, 0) }])
    expect(summary.total).toBe(4_000 + 1_000)
  })

  test("recovery after a crash ends at the last observed activity, never at now", () => {
    const h = harness()
    h.emit("session.execution.started", { sessionID: SID }, 1_000)
    h.emit("session.step.started", { sessionID: SID, assistantMessageID: MID, agent: "qa", started: 1_000 }, 1_000)
    h.emit("session.step.first-token", { sessionID: SID, assistantMessageID: MID }, 1_500)
    toolStart(h, SID, MID, "t1", "shell", 2_000)
    h.setClock(9_999_999)

    const stored = h.recorder.get(SID)!.steps[MID]
    expect(stored.e).toBeUndefined()
    const idle = toStep(SID, MID, stored, false, 9_999_999)!
    expect(idle.end).toBe(2_000)
    expect(idle.complete).toBe(false)
    const live = toStep(SID, MID, stored, true, 10_000)!
    expect(live.end).toBe(10_000)
    expect(live.live).toBe(true)
  })

  test("a step started without a busy span is not treated as exact", () => {
    const h = harness()
    h.emit("session.step.started", { sessionID: SID, assistantMessageID: MID, agent: "qa", started: 1_000 }, 1_000)
    h.emit("session.step.ended", { sessionID: SID, assistantMessageID: MID }, 2_000)
    const stored = h.recorder.get(SID)!.steps[MID]
    expect(stored.x).toBe(false)
    const step = toStep(SID, MID, stored, false, 0)!
    expect(step.exact).toBe(false)
    const summary = summarize([{ sessionID: SID, steps: [step], busy: [[1_000, 2_000]] }])
    expect(summary.estimated).toBe(true)
    expect(summary.total).toBe(1_000)
  })

  test("normal tools stay as execution, only subagent windows become waits", () => {
    const h = harness()
    h.emit("session.execution.started", { sessionID: SID }, 1_000)
    h.emit("session.step.started", { sessionID: SID, assistantMessageID: MID, agent: "devops", started: 1_000 }, 1_000)
    toolStart(h, SID, MID, "t1", "shell", 1_500)
    toolRun(h, SID, MID, "t1", 1_500)
    toolEnd(h, SID, MID, "t1", 4_500)
    h.emit("session.step.ended", { sessionID: SID, assistantMessageID: MID }, 5_000)
    h.emit("session.execution.succeeded", { sessionID: SID }, 5_000)
    const stored = h.recorder.get(SID)!.steps[MID]
    expect(stored.w ?? []).toEqual([])
    const summary = summarize([
      { sessionID: SID, steps: [toStep(SID, MID, stored, false, 0)!], busy: h.recorder.busyFor(SID, false, 0) },
    ])
    expect(summary.total).toBe(4_000)
  })

  test("normalize retains complete and partial stored measurements", () => {
    const dirty = normalize({
      v: 1,
      sessions: {
        ok: {
          steps: {
            exact: { a: "qa", s: 5, e: 6, x: true, c: true },
            partialEvent: { a: "qa", s: 7, e: 8, x: false, c: false },
            currentFormat: { a: "qa", s: 9, e: 10, x: true, c: true },
          },
          busy: [[1, 2]],
        },
        bad: null,
      },
    })
    expect(Object.keys(dirty.sessions)).toEqual(["ok"])
    expect(Object.keys(dirty.sessions.ok.steps).sort()).toEqual(["currentFormat", "exact", "partialEvent"])
  })

  test("normalize keeps an open wait and a pending tool", () => {
    const dirty = normalize({
      v: 1,
      sessions: {
        s: {
          steps: { m: { a: "orquestrador", s: 1, x: true, w: [[3, null, "t"]] } },
          busy: [[1, null]],
          tools: { t: { m: "m", n: "subagent", s: 2, r: 3 } },
        },
      },
    })
    expect(dirty.sessions.s.steps.m.w).toEqual([[3, null, "t"]])
    expect(dirty.sessions.s.tools).toEqual({ t: { m: "m", n: "subagent", s: 2, r: 3 } })
  })

  test("dispose unsubscribes every server event", () => {
    const { handlers, recorder } = harness()
    expect(handlers.size).toBe(13)
    recorder.dispose()
    expect(handlers.size).toBe(0)
  })
})

describe("model metadata", () => {
  const gpt = { providerID: "openai", id: "gpt-5" }
  const claude = { providerID: "anthropic", id: "claude-sonnet" }

  function observed(mid: string, options: { model?: object; agent?: string } = {}) {
    const h = harness()
    h.emit("session.execution.started", { sessionID: SID }, 0)
    h.emit(
      "session.step.started",
      {
        sessionID: SID,
        assistantMessageID: mid,
        started: 0,
        ...(options.agent === undefined ? {} : { agent: options.agent }),
        ...(options.model === undefined ? {} : { model: options.model }),
      },
      0,
    )
    h.emit("session.step.ended", { sessionID: SID, assistantMessageID: mid }, 2_000)
    h.emit("session.execution.succeeded", { sessionID: SID }, 2_000)
    const stored = h.recorder.get(SID)!.steps[mid]
    const step = toStep(SID, mid, stored, false, 0)!
    const summary = summarize([{ sessionID: SID, steps: [step], busy: h.recorder.busyFor(SID, false, 0) }])
    return { h, stored, step, summary }
  }

  test("real v2.3.0 step model is stored without changing the agent view", () => {
    const legacy = observed(MID, { agent: "backend" })
    const modeled = observed(MID, { agent: "backend", model: gpt })

    expect(modeled.stored.p).toBe("openai")
    expect(modeled.stored.i).toBe("gpt-5")
    expect(modeled.step.model).toEqual(gpt)
    expect(modeled.summary.byAgent).toEqual(legacy.summary.byAgent)
    expect(modeled.summary.total).toBe(legacy.summary.total)
    expect(legacy.summary.byModel).toEqual([])
    expect(modeled.summary.byModel).toEqual([{ providerID: "openai", id: "gpt-5", total: 2_000 }])

    legacy.h.recorder.dispose()
    modeled.h.recorder.dispose()
  })

  test("partial or invalid model metadata is ignored, never guessed", () => {
    const partial = observed(MID, { agent: "backend", model: { providerID: "openai" } })
    const invalid = observed(MID, { agent: "backend", model: { providerID: 7, id: "gpt-5" } })
    const empty = observed(MID, { agent: "backend", model: { providerID: "", id: "" } })

    expect(partial.step.model).toBeUndefined()
    expect(invalid.step.model).toBeUndefined()
    expect(empty.step.model).toBeUndefined()
    expect(partial.summary.byAgent).toEqual(invalid.summary.byAgent)
    expect(partial.summary.byModel).toEqual([])
    expect(invalid.summary.byModel).toEqual([])
    expect(empty.summary.byModel).toEqual([])

    partial.h.recorder.dispose()
    invalid.h.recorder.dispose()
    empty.h.recorder.dispose()
  })

  test("unknown agent is not invented by the model dimension", () => {
    const legacy = observed(MID, {})
    const modeled = observed(MID, { model: gpt })

    expect(modeled.step.agent).toBe("?")
    expect(modeled.summary.byAgent).toEqual(legacy.summary.byAgent)
    expect(modeled.summary.byAgent).toEqual([{ agent: "?", total: 2_000 }])
    expect(modeled.summary.byModel).toEqual([{ providerID: "openai", id: "gpt-5", total: 2_000 }])

    legacy.h.recorder.dispose()
    modeled.h.recorder.dispose()
  })

  test("delegated child model and parent model persist across a JSON reload", () => {
    const first = harness()
    first.emit("session.execution.started", { sessionID: SID }, 0)
    first.emit(
      "session.step.started",
      { sessionID: SID, assistantMessageID: MID, agent: "orquestrador", started: 0, model: claude },
      0,
    )
    toolStart(first, SID, MID, "t1", "subagent", 1_000)
    toolRun(first, SID, MID, "t1", 1_000)
    const child = "ses_child"
    first.emit("session.execution.started", { sessionID: child }, 1_000)
    first.emit(
      "session.step.started",
      { sessionID: child, assistantMessageID: "msg_child", agent: "backend", started: 1_000, model: gpt },
      1_000,
    )
    first.emit("session.step.ended", { sessionID: child, assistantMessageID: "msg_child" }, 5_000)
    first.emit("session.execution.succeeded", { sessionID: child }, 5_000)
    toolEnd(first, SID, MID, "t1", 5_000)
    first.emit("session.step.ended", { sessionID: SID, assistantMessageID: MID }, 6_000)
    first.emit("session.execution.succeeded", { sessionID: SID }, 6_000)
    first.recorder.flush()

    const snapshot = JSON.parse(JSON.stringify(first.value()))
    first.recorder.dispose()
    const second = harness(snapshot)

    const parentStep = toStep(SID, MID, second.recorder.get(SID)!.steps[MID], false, 0)!
    const childStep = toStep(child, "msg_child", second.recorder.get(child)!.steps.msg_child, false, 0)!
    const summary = summarize([
      { sessionID: SID, steps: [parentStep], busy: second.recorder.busyFor(SID, false, 0) },
      { sessionID: child, steps: [childStep], busy: second.recorder.busyFor(child, false, 0) },
    ])

    expect(parentStep.model).toEqual(claude)
    expect(childStep.model).toEqual(gpt)
    expect(summary.byAgent).toEqual([
      { agent: "backend", total: 4_000 },
      { agent: "orquestrador", total: 2_000 },
    ])
    expect(summary.byModel).toEqual([
      { providerID: "openai", id: "gpt-5", total: 4_000 },
      { providerID: "anthropic", id: "claude-sonnet", total: 2_000 },
    ])
    expect(summary.total).toBe(6_000)
    second.recorder.dispose()
  })

  test("new snapshots keep model metadata while old snapshots still normalize", () => {
    const normalized = normalize({
      v: 1,
      sessions: {
        s: {
          steps: {
            old: { a: "qa", s: 1, e: 2, x: true, c: true },
            new: { a: "qa", s: 3, e: 4, x: true, c: true, p: "openai", i: "gpt-5" },
          },
          busy: [],
        },
      },
    } as Timeline)

    expect(normalized.sessions.s.steps.old.p).toBeUndefined()
    expect(normalized.sessions.s.steps.old.i).toBeUndefined()
    expect(normalized.sessions.s.steps.new.p).toBe("openai")
    expect(normalized.sessions.s.steps.new.i).toBe("gpt-5")
    expect(toStep("s", "old", normalized.sessions.s.steps.old, false, 0)!.model).toBeUndefined()
    expect(toStep("s", "new", normalized.sessions.s.steps.new, false, 0)!.model).toEqual(gpt)
  })
})
