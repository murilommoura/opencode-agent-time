import { describe, expect, test } from "bun:test"
import { STATUS_LABELS, normalizeLocale, statusLabel } from "./status"

describe("normalizeLocale", () => {
  test("accepts the explicit Portuguese tags", () => {
    for (const value of ["pt", "pt-BR", "pt-br", "pt_BR", " pt-PT "]) {
      expect(normalizeLocale(value)).toBe("pt")
    }
  })

  test("English and unknown values fall back to English", () => {
    for (const value of [undefined, null, "", "en", "en-US", "es", "pt-XX", 7, {}]) {
      expect(normalizeLocale(value)).toBe("en")
    }
  })
})

describe("statusLabel", () => {
  test("English is the default", () => {
    expect(statusLabel(true)).toBe("Running")
    expect(statusLabel(false)).toBe("Paused")
    expect(statusLabel(true, "en-US")).toBe("Running")
    expect(statusLabel(false, "unknown")).toBe("Paused")
  })

  test("Portuguese is explicit and complete", () => {
    expect(statusLabel(true, "pt-BR")).toBe("Em execução")
    expect(statusLabel(false, "pt-BR")).toBe("Pausado")
    expect(statusLabel(true, "pt")).toBe("Em execução")
    expect(statusLabel(false, "pt-PT")).toBe("Pausado")
  })

  test("central map keeps both labels", () => {
    expect(STATUS_LABELS.en).toEqual({ running: "Running", paused: "Paused" })
    expect(STATUS_LABELS.pt).toEqual({ running: "Em execução", paused: "Pausado" })
  })

  test("zero-total composition is explicit", () => {
    expect(`— ${statusLabel(false, "en")}`).toBe("— Paused")
    expect(`— ${statusLabel(true, "en")}`).toBe("— Running")
    expect(`— ${statusLabel(false, "pt-BR")}`).toBe("— Pausado")
    expect(`— ${statusLabel(true, "pt-BR")}`).toBe("— Em execução")
  })
})
