// Sidebar row presentation, kept pure so it can be tested without a TUI.
//
// Agents are a mandatory full list: every participating agent appears in the
// sidebar. Only the parallel model dimension stays compact (top-N plus a
// summary row).

import type { Summary } from "./aggregate"

export const MODEL_ROW_LIMIT = 4

export type AgentRows = Summary["byAgent"]

/** All participating agents, in aggregation order (no truncation, no summary). */
export function agentRows(summary: Summary): AgentRows {
  return summary.byAgent
}

export type ModelRows = {
  top: Summary["byModel"]
  restCount: number
  restTotal: number
}

/** Compact model dimension: top-N plus the aggregated remainder. */
export function modelRows(summary: Summary): ModelRows {
  const top = summary.byModel.slice(0, MODEL_ROW_LIMIT)
  const rest = summary.byModel.slice(MODEL_ROW_LIMIT)
  return {
    top,
    restCount: rest.length,
    restTotal: rest.reduce((acc, row) => acc + row.total, 0),
  }
}
