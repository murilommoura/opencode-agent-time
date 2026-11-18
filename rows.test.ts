import { describe, expect, test } from "bun:test"
import { summarize, type ModelRef, type Step } from "./aggregate"
import { agentRows, MODEL_ROW_LIMIT, modelRows } from "./rows"

function step(agent: string, start: number, end: number, model?: ModelRef): Step {
  return {
    id: `${agent}-${start}`,
    sessionID: "s",
    agent,
    start,
    end,
    waits: [],
    exact: true,
    complete: true,
    model,
  }
}

// Five participating agents, each with its own model. This is a local fixture
// (no LLM/provider call), matching what the recorder yields per observed step.
const AGENTS = ["root", "orchestrator", "build", "plan", "explore"]
const MODELS: ModelRef[] = [
  { providerID: "fake", id: "m-root" },
  { providerID: "fake", id: "m-orchestrator" },
  { providerID: "fake", id: "m-build" },
  { providerID: "fake", id: "m-plan" },
  { providerID: "fake", id: "m-explore" },
]

function fiveAgentSummary() {
  const durations = [5000, 4000, 3000, 2000, 1000]
  const steps = AGENTS.map((agent, index) => step(agent, 0, durations[index], MODELS[index]))
  return summarize([{ sessionID: "s", steps }])
}

describe("agentRows", () => {
  test("lista todos os 5 agentes, sem truncar e sem linha de resumo", () => {
    const summary = fiveAgentSummary()
    const rows = agentRows(summary)
    expect(rows).toEqual(summary.byAgent)
    expect(rows).toHaveLength(5)
    expect(rows.map((row) => row.agent)).toEqual(AGENTS)
    // No remainder bookkeeping leaked into the agent rows.
    expect(rows.every((row) => Object.keys(row).sort().join(",") === "agent,total")).toBe(true)
  })

  test("preserva ordem, totais e contadores", () => {
    const summary = fiveAgentSummary()
    expect(summary.total).toBe(15000)
    expect(summary.steps).toBe(5)
    expect(agentRows(summary).reduce((acc, row) => acc + row.total, 0)).toBe(summary.total)
    expect(summary.byModel).toHaveLength(5)
  })

  test("lista vazia e agente único continuam corretas", () => {
    expect(agentRows(summarize([{ sessionID: "s", steps: [] }]))).toEqual([])
    const single = summarize([{ sessionID: "s", steps: [step("root", 0, 1500, MODELS[0])] }])
    expect(agentRows(single).map((row) => row.agent)).toEqual(["root"])
  })
})

describe("modelRows (limite de modelos inalterado)", () => {
  test("mantém top-4 e soma o restante em contador", () => {
    const summary = fiveAgentSummary()
    const models = modelRows(summary)
    expect(MODEL_ROW_LIMIT).toBe(4)
    expect(models.top.map((row) => row.id)).toEqual([
      "m-root",
      "m-orchestrator",
      "m-build",
      "m-plan",
    ])
    expect(models.restCount).toBe(1)
    expect(models.restTotal).toBe(1000)
  })
})

describe("tui.tsx", () => {
  test("não renderiza resumo '+N agentes' nem trunca a lista de agentes", async () => {
    const source = await Bun.file(new URL("./tui.tsx", import.meta.url)).text()
    expect(source.includes("agentes")).toBe(false)
    expect(source.includes("byAgent.slice")).toBe(false)
    expect(source.includes("agentRows(")).toBe(true)
  })
})
