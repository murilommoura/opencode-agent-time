import { describe, expect, test } from "bun:test"
import { formatDuration, overlapMs, stepActiveMs, summarize, union, type Step } from "./aggregate"

function step(overrides: Partial<Step> & Pick<Step, "start" | "end">): Step {
  return {
    id: "m1",
    sessionID: "ses_root",
    agent: "orb",
    waits: [],
    exact: true,
    complete: true,
    ...overrides,
  }
}

describe("union / overlap", () => {
  test("merges overlapping and adjacent spans", () => {
    expect(union([[10, 20], [15, 30], [30, 40], [50, 60]])).toEqual([[10, 40], [50, 60]])
  })

  test("overlap clamps to the query window", () => {
    expect(overlapMs(0, 100, [[20, 50], [80, 200]])).toBe(50)
  })
})

describe("stepActiveMs", () => {
  test("busy spans remove suspension inside an exact step", () => {
    expect(stepActiveMs(step({ start: 0, end: 100_000 }), [[0, 2_000], [98_000, 100_000]])).toBe(4_000)
  })

  test("non-exact steps do not pretend to know execution boundaries", () => {
    expect(stepActiveMs(step({ start: 0, end: 10_000, exact: false }), [[0, 1_000]])).toBe(10_000)
  })

  test("subagent wait is subtracted from the parent", () => {
    expect(stepActiveMs(step({ start: 0, end: 9_000, waits: [{ start: 1_000, end: 8_000 }] }))).toBe(2_000)
  })

  test("wait outside the step window does not subtract", () => {
    expect(stepActiveMs(step({ start: 0, end: 1_000, waits: [{ start: 5_000, end: 9_000 }] }))).toBe(1_000)
  })

  test("normal tool time stays inside the step", () => {
    // no waits registered: a shell run is agent execution
    expect(stepActiveMs(step({ start: 0, end: 4_000 }))).toBe(4_000)
  })
})

describe("summarize", () => {
  const parent = step({
    id: "p1",
    sessionID: "ses_parent",
    agent: "orquestrador",
    start: 0,
    end: 10_000,
    waits: [{ start: 2_000, end: 8_000 }],
  })
  const childA = step({ id: "c1", sessionID: "ses_a", agent: "backend", start: 2_000, end: 8_000 })
  const childB = step({ id: "c2", sessionID: "ses_b", agent: "qa", start: 2_000, end: 8_000 })

  test("parallel executions add up, the parent wait is not double counted", () => {
    const summary = summarize([
      { sessionID: "ses_parent", steps: [parent] },
      { sessionID: "ses_a", steps: [childA] },
      { sessionID: "ses_b", steps: [childB] },
    ])
    expect(summary.total).toBe(4_000 + 6_000 + 6_000)
    expect(summary.byAgent).toEqual([
      { agent: "backend", total: 6_000 },
      { agent: "qa", total: 6_000 },
      { agent: "orquestrador", total: 4_000 },
    ])
    expect(summary.estimated).toBe(false)
  })

  test("breakdown always adds up to the total", () => {
    const summary = summarize([{ sessionID: "ses_parent", steps: [parent, childA, childB] }])
    expect(summary.byAgent.reduce((acc, row) => acc + row.total, 0)).toBe(summary.total)
  })

  test("recovered and non-exact steps are flagged, not hidden", () => {
    const summary = summarize([
      { sessionID: "ses_parent", steps: [step({ start: 0, end: 1_000, exact: false, complete: false })] },
    ])
    expect(summary.estimated).toBe(true)
    expect(summary.incomplete).toBe(1)
  })

  test("live step is marked", () => {
    const summary = summarize([{ sessionID: "ses_parent", steps: [step({ start: 0, end: 1_000, live: true })] }])
    expect(summary.live).toBe(true)
  })

  test("reopening does not change the total", () => {
    const sessions = [
      { sessionID: "ses_parent", steps: [parent] },
      { sessionID: "ses_a", steps: [childA] },
      { sessionID: "ses_b", steps: [childB] },
    ]
    expect(summarize(sessions)).toEqual(summarize(sessions))
  })
})

describe("model dimension", () => {
  const claude = { providerID: "anthropic", id: "claude-sonnet" }
  const gpt = { providerID: "openai", id: "gpt-5" }

  const parent = step({
    id: "p1",
    sessionID: "ses_parent",
    agent: "orquestrador",
    start: 0,
    end: 10_000,
    waits: [{ start: 2_000, end: 8_000 }],
  })
  const childA = step({ id: "c1", sessionID: "ses_a", agent: "backend", start: 2_000, end: 8_000 })
  const childB = step({ id: "c2", sessionID: "ses_b", agent: "qa", start: 2_000, end: 8_000 })
  const sessions = (steps: [Step, Step, Step]) => [
    { sessionID: "ses_parent", steps: [steps[0]] },
    { sessionID: "ses_a", steps: [steps[1]] },
    { sessionID: "ses_b", steps: [steps[2]] },
  ]

  test("metadata leaves the agent output and total exactly unchanged", () => {
    const legacy = summarize(sessions([parent, childA, childB]))
    const withModels = summarize(
      sessions([
        { ...parent, model: claude },
        { ...childA, model: gpt },
        { ...childB, model: gpt },
      ]),
    )

    // Regression guard: only the parallel model dimension may change.
    expect(withModels.byAgent).toEqual(legacy.byAgent)
    expect(withModels.total).toBe(legacy.total)
    expect(withModels.estimated).toBe(legacy.estimated)
    expect(withModels.incomplete).toBe(legacy.incomplete)
    expect(withModels.steps).toBe(legacy.steps)
    expect(withModels.live).toBe(legacy.live)
    expect(legacy.byModel).toEqual([])
    expect(withModels.byModel).toEqual([
      { providerID: "openai", id: "gpt-5", total: 12_000 },
      { providerID: "anthropic", id: "claude-sonnet", total: 4_000 },
    ])
  })

  test("different models of the same agent stay separate while the agent is one row", () => {
    const summary = summarize([
      {
        sessionID: "ses",
        steps: [
          step({ id: "a", agent: "backend", start: 0, end: 1_000, model: gpt }),
          step({ id: "b", agent: "backend", start: 1_000, end: 3_000, model: claude }),
        ],
      },
    ])

    expect(summary.byAgent).toEqual([{ agent: "backend", total: 3_000 }])
    expect(summary.byModel).toEqual([
      { providerID: "anthropic", id: "claude-sonnet", total: 2_000 },
      { providerID: "openai", id: "gpt-5", total: 1_000 },
    ])
  })

  test("same model across agents and delegated sessions adds up once per span", () => {
    const summary = summarize(
      sessions([
        { ...parent, model: gpt },
        { ...childA, model: gpt },
        { ...childB, model: gpt },
      ]),
    )

    expect(summary.byAgent).toEqual([
      { agent: "backend", total: 6_000 },
      { agent: "qa", total: 6_000 },
      { agent: "orquestrador", total: 4_000 },
    ])
    expect(summary.byModel).toEqual([{ providerID: "openai", id: "gpt-5", total: 16_000 }])
  })

  test("simultaneous spans of the same model are summed, not collapsed", () => {
    const summary = summarize([
      {
        sessionID: "ses",
        steps: [
          step({ id: "a", agent: "backend", start: 0, end: 5_000, model: gpt }),
          step({ id: "b", agent: "qa", start: 0, end: 5_000, model: gpt }),
        ],
      },
    ])

    expect(summary.total).toBe(10_000)
    expect(summary.byModel).toEqual([{ providerID: "openai", id: "gpt-5", total: 10_000 }])
  })

  test("provider-qualified keys never merge equal model ids from different providers", () => {
    const summary = summarize([
      {
        sessionID: "ses",
        steps: [
          step({ id: "a", agent: "backend", start: 0, end: 1_000, model: { providerID: "provider-a", id: "shared" } }),
          step({ id: "b", agent: "backend", start: 1_000, end: 3_000, model: { providerID: "provider-b", id: "shared" } }),
        ],
      },
    ])

    expect(summary.byModel).toEqual([
      { providerID: "provider-b", id: "shared", total: 2_000 },
      { providerID: "provider-a", id: "shared", total: 1_000 },
    ])
  })

  test("steps without model metadata do not appear in the model section", () => {
    const summary = summarize(sessions([parent, childA, childB]))

    expect(summary.byModel).toEqual([])
    expect(summary.byAgent.reduce((acc, row) => acc + row.total, 0)).toBe(summary.total)
  })

  test("unknown agent does not gain a model-derived agent row", () => {
    const legacy = summarize([{ sessionID: "ses", steps: [step({ agent: "?", start: 0, end: 2_000 })] }])
    const withModel = summarize([
      { sessionID: "ses", steps: [step({ agent: "?", start: 0, end: 2_000, model: gpt })] },
    ])

    expect(withModel.byAgent).toEqual(legacy.byAgent)
    expect(withModel.byAgent).toEqual([{ agent: "?", total: 2_000 }])
    expect(withModel.byModel).toEqual([{ providerID: "openai", id: "gpt-5", total: 2_000 }])
  })
})

describe("activity state", () => {
  test("live flag precedes zero-active steps without changing any number", () => {
    const active = step({ id: "a", agent: "build", start: 0, end: 1_000 })
    const zeroLive = step({ id: "z", agent: "build", start: 2_000, end: 2_000, live: true })
    const baseline = summarize([{ sessionID: "ses", steps: [active] }])
    const withZeroLive = summarize([{ sessionID: "ses", steps: [active, zeroLive] }])

    // Visual-only change: the live flag moves, all measured numbers do not.
    expect(withZeroLive.live).toBe(true)
    expect(withZeroLive.total).toBe(baseline.total)
    expect(withZeroLive.byAgent).toEqual(baseline.byAgent)
    expect(withZeroLive.byModel).toEqual(baseline.byModel)
    expect(withZeroLive.steps).toBe(baseline.steps)
    expect(withZeroLive.estimated).toBe(baseline.estimated)
    expect(withZeroLive.incomplete).toBe(baseline.incomplete)
  })

  test("a fully waiting live step is Running, not idle", () => {
    const waiting = step({
      id: "w",
      agent: "orquestrador",
      start: 0,
      end: 5_000,
      waits: [{ start: 0, end: 5_000 }],
      live: true,
    })
    const summary = summarize([{ sessionID: "ses", steps: [waiting] }])

    expect(summary.total).toBe(0)
    expect(summary.live).toBe(true)
  })

  test("any live child keeps the family active", () => {
    const parent = step({ id: "p", agent: "orquestrador", sessionID: "ses_root", start: 0, end: 10_000 })
    const child = step({
      id: "c",
      agent: "backend",
      sessionID: "ses_child",
      start: 2_000,
      end: 8_000,
      live: true,
    })
    const summary = summarize([
      { sessionID: "ses_root", steps: [parent] },
      { sessionID: "ses_child", steps: [child] },
    ])

    expect(summary.live).toBe(true)
    expect(summary.total).toBe(10_000 + 6_000)
  })

  test("no live step in the family is Paused", () => {
    const summary = summarize([
      { sessionID: "ses_root", steps: [step({ agent: "orquestrador", start: 0, end: 1_000 })] },
      { sessionID: "ses_child", steps: [step({ id: "c", agent: "qa", start: 0, end: 1_000 })] },
    ])

    expect(summary.live).toBe(false)
    expect(summary.total).toBe(2_000)
  })
})

describe("format", () => {
  test("formats compact durations", () => {
    expect(formatDuration(0)).toBe("0s")
    expect(formatDuration(45_000)).toBe("45s")
    expect(formatDuration(90_000)).toBe("1m 30s")
    expect(formatDuration(3_720_000)).toBe("1h 02m")
  })

})
