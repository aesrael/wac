export const MAX_CHUNK_SIZE = 4000

export function softFormat(text: string): string {
  return text
    .replace(/```[a-zA-Z0-9_-]*\n/g, "```\n")
    .replace(/^###+\s+(.*)$/gm, "*$1*")
    .replace(/^##\s+(.*)$/gm, "*$1*")
    .replace(/^#\s+(.*)$/gm, "*$1*")
    .replace(/\*\*([^*]+)\*\*/g, "*$1*")
    .replace(/__([^_]+)__/g, "*$1*")
    .replace(/^[-*]\s+/gm, "• ")
    .replace(/^\s*\d+[.)]\s+/gm, "• ")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 $2")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function splitMatches(text: string, from: number, upTo: number, regex: RegExp): number {
  let match: RegExpExecArray | null
  let last = -1
  regex.lastIndex = from
  let guard = 0
  while ((match = regex.exec(text)) && match.index <= upTo && guard++ < 10000) {
    const position = match.index + match[0].length
    if (position <= upTo) last = position
  }
  return last
}

function codeFenceRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  const fence = /^```/gm
  const positions: number[] = []
  let match: RegExpExecArray | null
  while ((match = fence.exec(text))) positions.push(match.index)
  for (let i = 0; i + 1 < positions.length; i += 2) ranges.push([positions[i], positions[i + 1]])
  if (positions.length % 2 === 1) ranges.push([positions[positions.length - 1], text.length])
  return ranges
}

function isForbidden(position: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([start, end]) => position > start && position < end)
}

// Prefix parity of single backticks outside fenced ranges, computed once per
// input so per-cut checks are O(1). Triple-fence ticks are part of ranges and
// excluded from the parity count.
function inlineParityPrefix(text: string, ranges: Array<[number, number]>): Uint8Array {
  const parity = new Uint8Array(text.length + 1)
  let odd = 0
  const inFence = (i: number) => ranges.some(([s, e]) => i >= s && i < e)
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "`" && !inFence(i)) {
      // skip ticks that are part of a ``` run (fence boundaries may sit
      // exactly on range edges, so guard locally too)
      const run3 = text.startsWith("```", i) || (i >= 2 && text.startsWith("```", i - 2)) || (i >= 1 && text.startsWith("```", i - 1))
      if (!run3) odd ^= 1
    }
    parity[i + 1] = odd
  }
  return parity
}

export function chunk(text: string, max: number = MAX_CHUNK_SIZE): string[] {
  const input = text.trim()
  if (input.length === 0) return []
  if (input.length <= max) return [input]

  const fences = codeFenceRanges(input)
  const parity = inlineParityPrefix(input, fences)
  const isSplitForbidden = (pos: number) => isForbidden(pos, fences) || parity[Math.min(pos, input.length)] === 1
  const chunks: string[] = []

  let start = 0
  while (start < input.length) {
    const budget = max
    const end = Math.min(start + budget, input.length)

    if (end >= input.length) {
      chunks.push(input.slice(start))
      break
    }

    const paragraph = splitMatches(input, start, end, /\n\s*\n/g)
    const line = input.lastIndexOf("\n", end)
    const sentence = splitMatches(input, start, end, /[.!?]\s+/g)
    const space = input.lastIndexOf(" ", end)

    const budgetCut = start + budget
    let cut = budgetCut
    let found = false
    for (const candidate of [paragraph, line, sentence, space]) {
      if (candidate > start && candidate <= end) {
        cut = candidate
        found = true
        break
      }
    }
    if (!found) cut = budgetCut

    if (isSplitForbidden(cut)) {
      // Scan back at most 512 chars — O(1) per cut, avoids O(n·budget) stalls
      // on large code responses. If nothing allowed nearby (e.g. deep inside a
      // long fence), fall back to the full-budget cut instead of a tiny split.
      let adjusted = -1
      const floor = Math.max(start + 1, cut - 512)
      for (let pos = cut - 1; pos >= floor; pos--) {
        if (!isSplitForbidden(pos)) {
          adjusted = pos
          break
        }
      }
      cut = adjusted > start ? adjusted : budgetCut
    }

    if (cut <= start) cut = start + budget
    chunks.push(input.slice(start, cut))
    if (cut >= input.length) break
    start = cut
  }

  return chunks
}

export function withSuffix(chunks: string[]): string[] {
  if (chunks.length <= 1) return chunks
  return chunks.map((c, i) => `${c}\n\n(${i + 1}/${chunks.length})`)
}