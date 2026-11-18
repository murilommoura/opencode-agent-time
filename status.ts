// Status labels for the agent-time sidebar block.
//
// OpenCode 2.3.0 does not expose a TUI locale/i18n API. The default UI is
// English, so English is the supported fallback. Portuguese is opt-in through
// the plugin's explicit `options.locale` in cli.json; it is never inferred
// from LANG, the OS, or the connected server.

export type StatusLocale = "en" | "pt"

export type StatusLabels = {
  running: string
  paused: string
}

export const STATUS_LABELS: Record<StatusLocale, StatusLabels> = {
  en: { running: "Running", paused: "Paused" },
  pt: { running: "Em execução", paused: "Pausado" },
}

/** Normalize an explicit plugin option. Unknown values fall back to English. */
export function normalizeLocale(value: unknown): StatusLocale {
  if (typeof value !== "string") return "en"
  const tag = value.trim().toLowerCase().replace(/_/g, "-")
  if (tag === "pt" || tag === "pt-br" || tag === "pt-pt") return "pt"
  return "en"
}

/** Short status text: Running while any family step is live, else Paused. */
export function statusLabel(live: boolean, locale?: unknown): string {
  const labels = STATUS_LABELS[normalizeLocale(locale)]
  return live ? labels.running : labels.paused
}
