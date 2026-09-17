import type {
  Candidate,
  InputEvent,
  PrefixEvent,
  SequenceGroup,
  StreamAnalysis,
  StreamBuild,
} from '../types'
import { deepEqual, stableStringify } from './compare'

/**
 * 按“流 + 序号”索引裁决结果的键。
 * 用 JSON 数组编码，避免流名含空格等字符造成键碰撞。
 * 值为选中候选的稳定 id（stableStringify 结果）。
 */
export function resolutionKey(stream: string, sequence: number): string {
  return JSON.stringify([stream, sequence])
}

/** 将同结构的事件折叠成候选版本 */
function foldEvents(events: InputEvent[]): Candidate[] {
  const candidates: Candidate[] = []
  for (const ev of events) {
    const id = stableStringify(ev.payload)
    const existing = candidates.find((c) => c.id === id)
    if (existing) {
      existing.lines.push(ev.line)
    } else {
      candidates.push({
        id,
        payload: ev.payload,
        raw: ev.raw,
        lines: [ev.line],
      })
    }
  }
  // 让候选顺序稳定：按首次出现行号（输入顺序）
  candidates.sort((a, b) => a.lines[0] - b.lines[0])
  return candidates
}

/**
 * 按流分组：每个流内部再按序号分组，同序号载荷按结构深比较折叠。
 * deepEqual 仅作为防御性的等价校验，正常情况下 stableStringify
 * 相等与结构相等一致。
 */
export function groupEvents(events: InputEvent[]): Map<string, StreamBuild> {
  const byStream = new Map<string, InputEvent[]>()
  for (const ev of events) {
    const list = byStream.get(ev.stream)
    if (list) list.push(ev)
    else byStream.set(ev.stream, [ev])
  }

  const result = new Map<string, StreamBuild>()
  for (const [name, streamEvents] of byStream) {
    const bySequence = new Map<number, InputEvent[]>()
    for (const ev of streamEvents) {
      const list = bySequence.get(ev.sequence)
      if (list) list.push(ev)
      else bySequence.set(ev.sequence, [ev])
    }

    const sequences = [...bySequence.keys()].sort((a, b) => a - b)
    const groups: SequenceGroup[] = sequences.map((sequence) => {
      const seqEvents = bySequence.get(sequence)!
      const candidates = foldEvents(seqEvents)

      // 结构一致性防御校验：稳定键不同但深比较相等不应发生，
      // 若发生则合并候选行。
      for (let i = 0; i < candidates.length; i++) {
        for (let j = i + 1; j < candidates.length; j++) {
          if (deepEqual(candidates[i].payload, candidates[j].payload)) {
            candidates[i].lines.push(...candidates[j].lines)
            candidates.splice(j, 1)
            j--
          }
        }
      }

      return {
        stream: name,
        sequence,
        candidates,
        allLines: seqEvents.map((e) => e.line).sort((a, b) => a - b),
        isConflict: candidates.length > 1,
      }
    })

    result.set(name, {
      name,
      minSequence: sequences[0],
      maxSequence: sequences[sequences.length - 1],
      groups,
      totalEvents: streamEvents.length,
    })
  }

  return result
}

/**
 * 在给定起始序号与裁决映射下分析单个流：
 * 1. 从 start 起逐序号检查；
 * 2. 缺号 -> 阻断，记录缺口；
 * 3. 冲突未裁决 -> 阻断；
 * 4. 重复项（唯一候选）自动折叠放行；冲突选中版本后放行；
 * 5. 阻断点之后的一切事件都不属于已确认连续前缀。
 *
 * selections 的键为 resolutionKey(stream, sequence)，值为选中候选的稳定 id。
 */
export function analyzeStream(
  build: StreamBuild,
  start: number,
  selections: Readonly<Record<string, string>>,
): StreamAnalysis {
  const bySequence = new Map<number, SequenceGroup>()
  for (const g of build.groups) bySequence.set(g.sequence, g)

  const prefix: PrefixEvent[] = []
  const gaps: number[] = []
  const resolvedConflictSequences = new Set<number>()

  let blockedByGap = false
  let blockedByConflict = false
  let blockingGap: number | null = null
  let blockingConflict: number | null = null

  let seq = start
  outer: for (;;) {
    const group = bySequence.get(seq)

    if (!group) {
      // 起始早于首个观测序号时，逐个前置缺号不逐一列入缺口，
      // 阻断点本身（blockingGap）始终会在缺口列表中高亮；
      // 但它确实阻断（没有任何可确认事件）。
      gaps.push(seq)
      blockedByGap = true
      blockingGap = seq
      break
    }

    if (group.isConflict) {
      const selectedId = selections[resolutionKey(build.name, seq)]
      const chosen =
        selectedId !== undefined
          ? group.candidates.find((c) => c.id === selectedId)
          : undefined
      if (!chosen) {
        blockedByConflict = true
        blockingConflict = seq
        break outer
      }
      resolvedConflictSequences.add(seq)
      prefix.push({
        sequence: seq,
        payload: chosen.payload,
        lines: chosen.lines,
      })
    } else {
      const only = group.candidates[0]
      prefix.push({
        sequence: seq,
        payload: only.payload,
        lines: only.lines,
      })
    }

    if (seq >= build.maxSequence) {
      seq++
      break
    }
    seq++
  }

  // 阻断点之后仍然存在的缺号（用于完整展示“缺口”列表，
  // 这些位置同样无法放行，属于被阻断区域）。前置缺号不逐一枚举。
  const tailStart = Math.max(seq + (blockedByGap ? 1 : 0), build.minSequence)
  if (tailStart <= build.maxSequence) {
    for (let s = tailStart; s <= build.maxSequence; s++) {
      if (!bySequence.has(s)) gaps.push(s)
    }
  }

  return {
    name: build.name,
    start,
    minObserved: build.minSequence,
    maxObserved: build.maxSequence,
    totalEvents: build.totalEvents,
    groups: build.groups,
    prefix,
    nextExpected: seq,
    blockedByGap,
    blockedByConflict,
    gaps,
    blockingGap,
    blockingConflict,
    resolvedConflictSequences,
  }
}

/** 分析全部流，按流名（locale 感知）排序返回 */
export function analyzeAll(
  builds: Map<string, StreamBuild>,
  starts: Readonly<Record<string, number>>,
  selections: Readonly<Record<string, string>>,
): StreamAnalysis[] {
  return [...builds.keys()]
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN-u-co-pinyin'))
    .map((name) => {
      const build = builds.get(name)!
      const start = starts[name] ?? build.minSequence
      return analyzeStream(build, start, selections)
    })
}
