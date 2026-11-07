/** Run async work with a fixed concurrency limit, preserving input order. */
export async function mapLimit(items, limit, fn) {
  const list = Array.from(items || [])
  if (!list.length) return []
  const width = Math.max(1, Math.min(Number(limit) || 1, list.length))
  const results = new Array(list.length)
  let cursor = 0

  async function worker() {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= list.length) return
      results[index] = await fn(list[index], index)
    }
  }

  await Promise.all(Array.from({ length: width }, () => worker()))
  return results
}
