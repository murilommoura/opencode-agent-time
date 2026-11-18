// Pure aggregation for the agent-time TUI plugin.
//
// Only event-observed steps are aggregated.
//
// Model:
// - One assistant step (message turn) has an exact start/end taken from server
//   events. Time is counted only while the session was busy, so suspensions and
//   user-idle gaps never inflate the total.
// - Waiting for a subagent is removed from the parent (the subagent tool window
//   is observed live) and counted in the child session, so parallel executions
//   add up exactly once per agent.
// - Normal tool execution stays inside the step: it is agent execution.

export type Wait = { start: number; end: number }

// Provider-qualified model identity. The provider is part of the key so the
// same model id from different providers is never merged.
export type ModelRef = { providerID: string; id: string }

export type Step = {
  id: string
  sessionID: string
  agent: string
  start: number
  end: number
  waits: Wait[]
  // Execution (busy) boundaries covering the whole step are known.
  exact: boolean
  // false when the step was recovered without its end event.
  complete: boolean
  // Still running, end === now.
  live?: boolean
  // Model observed for this step. Absent when the runtime did not report it
  // (for example an old snapshot or an event without model metadata).
  model?: ModelRef
}

export type BusySpan = [number, number]

/** Union of overlapping/adjacent spans, sorted. */
export function union(spans: Array<[number, number]>): BusySpan[] {
  const sorted = spans
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .sort((x, y) => x[0] - y[0])
  const out: BusySpan[] = []
  for (const [a, b] of sorted) {
    const last = out[out.length - 1]
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

/** Total overlap between [start, end] and the union of spans. */
export function overlapMs(start: number, end: number, spans: Array<[number, number]>): number {
  if (end <= start) return 0
  let total = 0
  for (const [a, b] of union(spans)) {
    const lo = Math.max(start, a)
    const hi = Math.min(end, b)
    if (hi > lo) total += hi - lo
  }
  return total
}

/**
 * Time the agent was executing inside one step.
 *
 * Busy spans are applied only to exact steps (event-observed execution
 * boundaries). They remove suspensions without any duration threshold.
 */
export function stepActiveMs(step: Step, busy?: BusySpan[]): number {
  if (step.end <= step.start) return 0
  const spanned =
    step.exact && busy && busy.length > 0
      ? overlapMs(step.start, step.end, busy)
      : step.end - step.start
  const waited = overlapMs(step.start, step.end, step.waits.map((wait) => [wait.start, wait.end] as [number, number]))
  return Math.max(0, spanned - waited)
}

export type ModelTotal = {
  providerID: string
  id: string
  total: number
}

export type Summary = {
  total: number
  byAgent: Array<{ agent: string; total: number }>
  // Parallel dimension over the exact same active spans as `byAgent`; it is
  // never added to the agent view. Steps without model metadata are omitted.
  byModel: ModelTotal[]
  estimated: boolean
  incomplete: number
  live: boolean
  steps: number
}

/** Stable internal key: keeps provider and model id separate. */
export function modelKey(model: ModelRef): string {
  return `${model.providerID}\u0000${model.id}`
}

/** Human-readable provider-qualified model name. */
export function formatModel(model: ModelRef): string {
  return `${model.providerID}/${model.id}`
}

export type SessionInput = {
  sessionID: string
  agent?: string
  steps: Step[]
  busy?: BusySpan[]
}

export function summarize(sessions: SessionInput[]): Summary {
  const byAgent = new Map<string, number>()
  const byModel = new Map<string, ModelTotal>()
  let total = 0
  let estimated = false
  let incomplete = 0
  let live = false
  let steps = 0

  for (const session of sessions) {
    for (const step of session.steps) {
      const active = stepActiveMs(step, session.busy)
      // Visual-only flag: an open live step is Running even before it has
      // accumulated a millisecond (or while it is fully waiting). Numeric
      // totals below still ignore zero-active steps.
      if (step.live) live = true
      if (active <= 0) continue
      steps += 1
      total += active
      byAgent.set(step.agent, (byAgent.get(step.agent) ?? 0) + active)
      if (step.model) {
        const key = modelKey(step.model)
        const entry = byModel.get(key) ?? { providerID: step.model.providerID, id: step.model.id, total: 0 }
        entry.total += active
        byModel.set(key, entry)
      }
      if (!step.exact || !step.complete) estimated = true
      if (!step.complete) incomplete += 1
    }
  }

  return {
    total,
    byAgent: [...byAgent.entries()]
      .map(([agent, value]) => ({ agent, total: value }))
      .sort((a, b) => b.total - a.total),
    byModel: [...byModel.values()].sort(
      (a, b) => b.total - a.total || a.providerID.localeCompare(b.providerID) || a.id.localeCompare(b.id),
    ),
    estimated,
    incomplete,
    live,
    steps,
  }
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`
  return `${seconds}s`
}
