import { describe, expect, test } from "bun:test"
import { collectPages, pageQuery, type PageQuery } from "./paging"

type Row = { id: string }

function fakeServer(pages: Array<{ data: Row[]; next?: string }>) {
  const queries: PageQuery[] = []
  let index = 0
  const fetchPage = async (query: PageQuery) => {
    // This is the contract regression: the real server rejects a cursor page
    // that also carries `order` with "Cursor cannot be combined with order".
    if (query.cursor !== undefined && query.order !== undefined) {
      throw new Error("Cursor cannot be combined with order")
    }
    queries.push(query)
    const page = pages[index]
    index += 1
    if (!page) return { data: [], cursor: {} }
    return { data: page.data, cursor: { next: page.next ?? null } }
  }
  return { fetchPage, queries }
}

describe("pageQuery", () => {
  test("order is only present on the first page", () => {
    expect(pageQuery({ limit: 100, order: "desc" })).toEqual({ limit: 100, order: "desc" })
    expect(pageQuery({ limit: 100, order: "desc" }, "abc")).toEqual({ limit: 100, cursor: "abc" })
  })

  test("filters survive cursor paging, order does not", () => {
    expect(pageQuery({ parentID: "ses_root", limit: 100, order: "desc" }, "c1")).toEqual({
      parentID: "ses_root",
      limit: 100,
      cursor: "c1",
    })
  })
})

describe("collectPages", () => {
  test("collects multiple pages and never combines cursor with order", async () => {
    const { fetchPage, queries } = fakeServer([
      { data: [{ id: "a" }, { id: "b" }], next: "c1" },
      { data: [{ id: "c" }, { id: "d" }], next: "c2" },
      { data: [{ id: "e" }] },
    ])
    const result = await collectPages<Row>(fetchPage, { limit: 100, order: "desc" })
    expect(result.items.map((row) => row.id)).toEqual(["a", "b", "c", "d", "e"])
    expect(result.complete).toBe(true)
    expect(result.pages).toBe(3)
    expect(queries).toEqual([
      { limit: 100, order: "desc" },
      { limit: 100, cursor: "c1" },
      { limit: 100, cursor: "c2" },
    ])
    expect(queries.some((query) => query.cursor !== undefined && query.order !== undefined)).toBe(false)
  })

  test("reports truncation instead of pretending the list is complete", async () => {
    const { fetchPage } = fakeServer([
      { data: [{ id: "a" }], next: "c1" },
      { data: [{ id: "b" }], next: "c2" },
      { data: [{ id: "c" }] },
    ])
    const result = await collectPages<Row>(fetchPage, { limit: 1, order: "desc" }, 2)
    expect(result.items.map((row) => row.id)).toEqual(["a", "b"])
    expect(result.complete).toBe(false)
  })

  test("stops on an empty page", async () => {
    const { fetchPage } = fakeServer([{ data: [], next: "c1" }])
    const result = await collectPages<Row>(fetchPage, { order: "desc" })
    expect(result.items).toEqual([])
    expect(result.complete).toBe(true)
  })
})
