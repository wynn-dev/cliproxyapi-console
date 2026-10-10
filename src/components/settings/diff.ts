export type DiffLine =
  | { type: 'equal'; text: string; oldNo: number; newNo: number }
  | { type: 'delete'; text: string; oldNo: number }
  | { type: 'insert'; text: string; newNo: number }

export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

type Op = 'equal' | 'delete' | 'insert'

/** Beyond this many edits a full replace is as readable as a minimal diff, and much cheaper. */
const MAX_EDITS = 4000

/** Myers' O((N+M)·D) shortest edit script over two line arrays (common prefix/suffix trimmed first). */
function editScript(a: string[], b: string[]): Op[] {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const head: Op[] = Array(start).fill('equal')
  const tail: Op[] = Array(a.length - endA).fill('equal')
  const x0 = a.slice(start, endA)
  const y0 = b.slice(start, endB)
  const n = x0.length
  const m = y0.length
  if (n === 0 || m === 0) return [...head, ...Array<Op>(n).fill('delete'), ...Array<Op>(m).fill('insert'), ...tail]

  const max = Math.min(n + m, MAX_EDITS)
  const off = max + 1
  const v = new Int32Array(2 * max + 3)
  // trace[d] holds v[-d..d] as it was before step d, which is all backtracking needs.
  const trace: Int32Array[] = []
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(off - d, off + d + 1))
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1
      let y = x - k
      while (x < n && y < m && x0[x] === y0[y]) {
        x++
        y++
      }
      v[off + k] = x
      if (x >= n && y >= m) return [...head, ...backtrack(trace, n, m), ...tail]
    }
  }
  return [...head, ...Array<Op>(n).fill('delete'), ...Array<Op>(m).fill('insert'), ...tail]
}

function backtrack(trace: Int32Array[], n: number, m: number): Op[] {
  const ops: Op[] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d > 0; d--) {
    const v = trace[d]
    const at = (k: number) => v[k + d]
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push('equal')
      x--
      y--
    }
    if (x === prevX) {
      ops.push('insert')
      y--
    } else {
      ops.push('delete')
      x--
    }
  }
  while (x > 0 && y > 0) {
    ops.push('equal')
    x--
    y--
  }
  return ops.reverse()
}

export function splitLines(text: string) {
  if (!text) return []
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Unified line diff grouped into hunks with `context` unchanged lines around each change. */
export function diffLines(before: string, after: string, context = 3): DiffHunk[] {
  const a = splitLines(before)
  const b = splitLines(after)
  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  for (const op of editScript(a, b)) {
    if (op === 'equal') lines.push({ type: 'equal', text: a[i++], oldNo: i, newNo: ++j })
    else if (op === 'delete') lines.push({ type: 'delete', text: a[i++], oldNo: i })
    else lines.push({ type: 'insert', text: b[j++], newNo: j })
  }

  const groups: DiffLine[][] = []
  let group: DiffLine[] | undefined
  let last = -1
  for (let idx = 0; idx < lines.length; idx++) {
    if (lines[idx].type === 'equal') continue
    if (group && idx - last <= context * 2 + 1) {
      group.push(...lines.slice(last + 1, idx + 1))
    } else {
      group?.push(...lines.slice(last + 1, last + 1 + context))
      group = lines.slice(Math.max(0, idx - context), idx + 1)
      groups.push(group)
    }
    last = idx
  }
  group?.push(...lines.slice(last + 1, last + 1 + context))
  return groups.map(toHunk)
}

function toHunk(lines: DiffLine[]): DiffHunk {
  const oldLines = lines.filter((l) => l.type !== 'insert').length
  const newLines = lines.filter((l) => l.type !== 'delete').length
  let oldStart = 0
  let newStart = 0
  for (const l of lines) {
    if (!oldStart && l.type !== 'insert') oldStart = l.oldNo
    if (!newStart && l.type !== 'delete') newStart = l.newNo
  }
  return { oldStart, oldLines, newStart, newLines, lines }
}

export function diffStats(hunks: DiffHunk[]) {
  let added = 0
  let removed = 0
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.type === 'insert') added++
      else if (l.type === 'delete') removed++
    }
  }
  return { added, removed }
}
