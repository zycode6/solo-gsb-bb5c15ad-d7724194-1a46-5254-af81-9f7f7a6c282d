import type { InputEvent, StreamBuild } from '../types'
import { stableStringify } from './compare'
import { resolutionKey } from './model'

/**
 * 可移植修复方案（repair plan）的生成、指纹计算与导入校验。
 *
 * 方案为一份 JSON，绑定到“解析得到的合法事件多重集”：
 * 指纹对每条合法事件按 {流, 序号, 结构化载荷} 规范化后排序，
 * 再对整段规范文本计算 SHA-256。因此：
 *   - 输入行任意重排 → 多重集不变 → 指纹一致，可导入；
 *   - 任一条事件的增删、载荷结构变化或重复次数变化 → 失配拒绝。
 */

export const PLAN_VERSION = 1

/** 一项冲突裁决在方案中的稳定标识 */
export interface PlanResolution {
  stream: string
  sequence: number
  /** 选中候选的稳定标识，即 stableStringify(payload) */
  candidateId: string
}

/** 修复方案文件结构 */
export interface RepairPlan {
  /** 方案格式版本，当前为 1 */
  version: number
  /** 合法事件多重集的 SHA-256（十六进制小写） */
  fingerprint: string
  /** 各流的起始序号（必须覆盖全部流） */
  starts: Record<string, number>
  /** 已裁决的冲突（未列出的冲突视为未裁决） */
  resolutions: PlanResolution[]
}

/** 校验通过后可一次性应用到应用状态的结果 */
export interface AppliedPlan {
  starts: Record<string, number>
  /** resolutionKey(stream, sequence) -> 选中候选 id */
  selections: Record<string, string>
  resolutionCount: number
  streamCount: number
}

export type ImportPlanResult =
  | { ok: true; applied: AppliedPlan }
  | { ok: false; error: string }

const HEX_RE = /^[0-9a-f]{64}$/i
const isInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v)
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/** 流名排序与界面/分析保持一致（locale 感知） */
function compareStreamName(a: string, b: string): number {
  return a.localeCompare(b, 'zh-Hans-CN-u-co-pinyin')
}

/**
 * 单条合法事件的规范化表示。
 * 载荷使用 stableStringify（对象键递归排序），与候选 id 的
 * 结构等价口径一致；整体再 JSON 编码为 [流, 序号, 载荷文本]，
 * 保证各字段之间无分隔符歧义。
 */
function canonicalEventLine(ev: InputEvent): string {
  return JSON.stringify([ev.stream, ev.sequence, stableStringify(ev.payload)])
}

/**
 * 合法事件多重集的规范化文本：逐事件编码后按字典序排序、换行连接。
 * 排序消除了输入行顺序；每条事件（含重复）各占一行，重复次数参与结果。
 */
export function canonicalizeEvents(events: readonly InputEvent[]): string {
  return events.map(canonicalEventLine).sort().join('\n')
}

/** 计算文本的 SHA-256，返回小写十六进制（浏览器 Web Crypto） */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** 合法事件多重集的数据指纹 */
export async function computeFingerprint(
  events: readonly InputEvent[],
): Promise<string> {
  return sha256Hex(canonicalizeEvents(events))
}

/**
 * 生成可移植修复方案。仅收录当前仍然有效的裁决
 * （流/序号为冲突且候选 id 存在），起始序号覆盖全部流。
 */
export async function buildRepairPlan(
  events: readonly InputEvent[],
  builds: Map<string, StreamBuild>,
  starts: Readonly<Record<string, number>>,
  selections: Readonly<Record<string, string>>,
): Promise<RepairPlan> {
  const names = [...builds.keys()].sort(compareStreamName)

  const planStarts: Record<string, number> = {}
  for (const name of names) {
    const b = builds.get(name)!
    planStarts[name] = isInt(starts[name]) ? (starts[name] as number) : b.minSequence
  }

  const resolutions: PlanResolution[] = []
  for (const name of names) {
    const build = builds.get(name)!
    for (const g of build.groups) {
      if (!g.isConflict) continue
      const candidateId = selections[resolutionKey(name, g.sequence)]
      if (
        candidateId !== undefined &&
        g.candidates.some((c) => c.id === candidateId)
      ) {
        resolutions.push({ stream: name, sequence: g.sequence, candidateId })
      }
    }
  }

  return {
    version: PLAN_VERSION,
    fingerprint: await computeFingerprint(events),
    starts: planStarts,
    resolutions,
  }
}

/** 序列化为稳定、可读的 JSON 文本（2 空格缩进） */
export function stringifyPlan(plan: RepairPlan): string {
  return JSON.stringify(plan, null, 2)
}

/**
 * 校验并导入方案。
 *
 * 依次校验：JSON 结构 → 版本 → 指纹字段格式 → 数据指纹一致性
 * → 起始序号（对象、流集合一致、安全整数）→ 裁决列表
 * （数组、字段类型、序号唯一、冲突组存在、候选存在）。
 * 任一项失败都返回错误且不产生任何状态变更；全部通过后由调用方一次性应用。
 */
export async function importRepairPlan(
  text: string,
  events: readonly InputEvent[],
  builds: Map<string, StreamBuild>,
): Promise<ImportPlanResult> {
  if (events.length === 0) {
    return {
      ok: false,
      error: '当前没有已解析的合法事件，请先粘贴并解析 NDJSON 后再导入方案。',
    }
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return {
      ok: false,
      error: `方案文件不是合法 JSON：${e instanceof Error ? e.message : String(e)}`,
    }
  }
  if (!isPlainObject(raw)) {
    return { ok: false, error: '方案必须是一个 JSON 对象。' }
  }

  // 1. 版本
  if (raw.version !== PLAN_VERSION) {
    return {
      ok: false,
      error: `方案版本不受支持：期望 version=${PLAN_VERSION}，实际为 ${JSON.stringify(raw.version)}。`,
    }
  }

  // 2. 指纹格式
  if (typeof raw.fingerprint !== 'string' || !HEX_RE.test(raw.fingerprint)) {
    return {
      ok: false,
      error: '方案缺少有效的 fingerprint（必须为 64 位十六进制 SHA-256 字符串）。',
    }
  }

  // 3. 指纹一致性（行序无关，重复次数/内容变化即失配）
  const expected = raw.fingerprint.toLowerCase()
  const actual = await computeFingerprint(events)
  if (actual !== expected) {
    return {
      ok: false,
      error:
        '数据指纹不匹配：当前输入的合法事件多重集与方案生成时不一致' +
        '（事件增删、流/序号/载荷结构变化或重复次数变化都会失配；仅输入行重排允许）。已拒绝导入，当前状态未改变。',
    }
  }

  // 4. 起始序号
  if (!isPlainObject(raw.starts)) {
    return { ok: false, error: '方案缺少有效的 starts（必须是流名到整数起始序号的对象）。' }
  }
  const startEntries = Object.entries(raw.starts)
  const dataNames = new Set(builds.keys())
  for (const name of startEntries.map(([n]) => n)) {
    if (!dataNames.has(name)) {
      return { ok: false, error: `starts 包含当前数据中不存在的流：${name}。` }
    }
  }
  for (const name of dataNames) {
    if (!Object.prototype.hasOwnProperty.call(raw.starts, name)) {
      return { ok: false, error: `starts 缺少流「${name}」的起始序号。` }
    }
  }
  const nextStarts: Record<string, number> = {}
  for (const [name, value] of startEntries) {
    if (!isInt(value)) {
      return {
        ok: false,
        error: `流「${name}」的起始序号无效：${JSON.stringify(value)}（必须为安全整数）。`,
      }
    }
    nextStarts[name] = value
  }

  // 5. 冲突裁决
  if (!Array.isArray(raw.resolutions)) {
    return { ok: false, error: '方案缺少有效的 resolutions（必须为数组）。' }
  }

  const nextSelections: Record<string, string> = {}
  const seen = new Set<string>()
  for (let i = 0; i < raw.resolutions.length; i++) {
    const where = `resolutions[${i}]`
    const item = raw.resolutions[i]
    if (!isPlainObject(item)) {
      return { ok: false, error: `${where} 必须是对象。` }
    }
    if (typeof item.stream !== 'string' || item.stream === '') {
      return { ok: false, error: `${where}.stream 必须为非空字符串。` }
    }
    if (!isInt(item.sequence)) {
      return {
        ok: false,
        error: `${where}.sequence 必须为安全整数（流「${item.stream}」）。`,
      }
    }
    if (typeof item.candidateId !== 'string' || item.candidateId === '') {
      return {
        ok: false,
        error: `${where}.candidateId 必须为非空字符串（流「${item.stream}」序号 ${item.sequence}）。`,
      }
    }

    const build = builds.get(item.stream)
    if (!build) {
      return { ok: false, error: `${where} 引用了不存在的流：${item.stream}。` }
    }
    const group = build.groups.find((g) => g.sequence === item.sequence)
    if (!group) {
      return {
        ok: false,
        error: `${where} 引用的流「${item.stream}」序号 ${item.sequence} 在当前数据中不存在。`,
      }
    }
    if (!group.isConflict) {
      return {
        ok: false,
        error: `${where} 引用的流「${item.stream}」序号 ${item.sequence} 并非冲突，无需裁决。`,
      }
    }
    if (!group.candidates.some((c) => c.id === item.candidateId)) {
      return {
        ok: false,
        error:
          `${where} 的候选标识在流「${item.stream}」序号 ${item.sequence} 的候选中不存在` +
          '（载荷结构可能已变化）。',
      }
    }

    const dedupeKey = resolutionKey(item.stream, item.sequence)
    if (seen.has(dedupeKey)) {
      return {
        ok: false,
        error: `${where} 对流「${item.stream}」序号 ${item.sequence} 重复给出了裁决。`,
      }
    }
    seen.add(dedupeKey)
    nextSelections[dedupeKey] = item.candidateId
  }

  return {
    ok: true,
    applied: {
      starts: nextStarts,
      selections: nextSelections,
      resolutionCount: raw.resolutions.length,
      streamCount: dataNames.size,
    },
  }
}
