// Pagination helper for the OpenCode v2 client contract.
//
// `SessionMessagesQuery`/cursor pages must not combine `order` with `cursor`
// ("Do not combine with order"). Sending both fails with:
//   Cursor cannot be combined with order
//
// `order` is therefore sent only on the first page; every cursor page carries
// only the cursor (plus stable filters such as `parentID`/`limit`/`type`).

export type Page<T> = {
  data?: T[]
  cursor?: { next?: string | null }
}

export type PageQuery = {
  cursor?: string
  order?: "asc" | "desc"
  limit?: number
  [key: string]: unknown
}

export type PageBase = Omit<PageQuery, "cursor">

/** Build the query for one page, never mixing cursor with order. */
export function pageQuery(base: PageBase, cursor?: string): PageQuery {
  if (cursor === undefined) {
    return { ...base }
  }
  const { order: _order, ...rest } = base
  return { ...rest, cursor }
}

export type CollectResult<T> = {
  items: T[]
  complete: boolean
  pages: number
}

/**
 * Collect every page until the cursor is exhausted.
 *
 * `complete` is false when `maxPages` was reached with a cursor still
 * available (the caller must not present a truncated list as exact).
 */
export async function collectPages<T>(
  fetchPage: (query: PageQuery) => Promise<Page<T>>,
  base: PageBase,
  maxPages = 64,
): Promise<CollectResult<T>> {
  const items: T[] = []
  let cursor: string | undefined
  let pages = 0
  while (pages < maxPages) {
    const response = await fetchPage(pageQuery(base, cursor))
    pages += 1
    const batch = Array.isArray(response?.data) ? response.data : []
    items.push(...batch)
    const next = response?.cursor?.next ?? undefined
    if (!next || batch.length === 0) return { items, complete: true, pages }
    cursor = next
  }
  return { items, complete: false, pages }
}
