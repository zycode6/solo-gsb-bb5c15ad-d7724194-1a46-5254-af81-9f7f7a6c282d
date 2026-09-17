import type {
  AppliedPlan,
  InputEvent,
  PlanResolution,
  PlanStream,
  PlanValidation,
  RepairPlan,
} from '../types'
import { PLAN_FORMAT_VERSION } from '../types'
import { groupEvents, resolutionKey } from './model'
import { stableStringify } from './compare'

/**
 * 对“合法事件多重集”做规范化编码：
 * 1. 每条合法事件编码为 [stream, sequence, stableStringify(payload)]
 *    的紧凑 JSON（对象键序被归一化，故载荷键序不影响）；
 * 2. 事件之间按该编码文本排序——多重集与顺序无关，故输入行重排不改变结果；
 * 3. 每条编码保留出现次数，重复次数变化会改变输出。
 * 行号不参与编码。
 */
export function canonicalizeEvents(events: readonly InputEvent[]): string {
  return (
    events
      .map(
        (ev) =>
          JSON.stringify([ev.stream, ev.sequence, stableStringify(ev.payload)]),
      )
      .sort()
      .join('\n')
  )
}

const HEX = '0123456789abcdef'

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) {
    out += HEX[b >> 4] + HEX[b & 0x0f]
  }
  return out
}

// SHA-256 轮常量（FIPS 180-4）
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

/**
 * 纯 JS 的 SHA-256 兜底实现：当页面运行在非安全上下文
 * （如以局域网 IP 经 HTTP 访问，crypto.subtle 不可用）时使用。
 */
export function sha256Hex(input: Uint8Array): string {
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ])

  const bitLen = input.length * 8
  const blockCount = (((input.length + 8) >> 6) + 1)
  const buf = new Uint8Array(blockCount * 64)
  buf.set(input)
  buf[input.length] = 0x80
  const view = new DataView(buf.buffer)
  // 长度始终在 32 位内（输入为文本，超限在实际中不可能）
  view.setUint32(buf.length - 4, bitLen >>> 0)
  view.setUint32(buf.length - 8, Math.floor(bitLen / 0x100000000))

  const w = new Uint32Array(64)
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))

  for (let off = 0; off < buf.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]
      const y = w[i - 2]
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }

    let a = H[0], b = H[1], c = H[2], d = H[3]
    let e = H[4], f = H[5], g = H[6], h = H[7]

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      h = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }

    H[0] = (H[0] + a) >>> 0
    H[1] = (H[1] + b) >>> 0
    H[2] = (H[2] + c) >>> 0
    H[3] = (H[3] + d) >>> 0
    H[4] = (H[4] + e) >>> 0
    H[5] = (H[5] + f) >>> 0
    H[6] = (H[6] + g) >>> 0
    H[7] = (H[7] + h) >>> 0
  }

  const out = new Uint8Array(32)
  const outView = new DataView(out.buffer)
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, H[i])
  return toHex(out)
}

/**
 * 计算合法事件多重集的 SHA-256 指纹（小写十六进制）。
 * 优先使用 Web Crypto；非安全上下文下退化为内置纯 JS 实现。
 */
export async function fingerprintEvents(
  events: readonly InputEvent[],
): Promise<string> {
  const data = new TextEncoder().encode(canonicalizeEvents(events))
  const subtle = globalThis.crypto?.subtle
  if (subtle) {
    const digest = await subtle.digest('SHA-256', data)
    return toHex(new Uint8Array(digest))
  }
  return sha256Hex(data)
}

/**
 * 基于当前合法事件、起始序号与裁决映射构建可移植修复方案。
 * 仅写入仍有效的裁决（流/序号/候选存在），与重新解析时的清理口径一致。
 */
export async function buildPlan(
  events: readonly InputEvent[],
  starts: Readonly<Record<string, number>>,
  selections: Readonly<Record<string, string>>,
): Promise<RepairPlan> {
  const builds = groupEvents(events as InputEvent[])
  const streams: PlanStream[] = [...builds.keys()]
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN-u-co-pinyin'))
    .map((name) => {
      const build = builds.get(name)!
      const resolutions: PlanResolution[] = []
      for (const g of build.groups) {
        if (!g.isConflict) continue
        const candidateId = selections[resolutionKey(name, g.sequence)]
        if (candidateId !== undefined && g.candidates.some((c) => c.id === candidateId)) {
          resolutions.push({ sequence: g.sequence, candidateId })
        }
      }
      resolutions.sort((a, b) => a.sequence - b.sequence)
      return {
        stream: name,
        start: starts[name] ?? build.minSequence,
        resolutions,
      }
    })

  return {
    version: PLAN_FORMAT_VERSION,
    fingerprint: await fingerprintEvents(events),
    streams,
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isSafeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v)
}

/**
 * 用当前合法事件校验方案文本。校验顺序：
 * JSON 语法 → 版本 → 指纹 → 流集合 → 整数起点 → 候选存在性。
 * 任一项无效即整体拒绝（返回错误信息，不产生任何状态变更）。
 */
export async function validatePlanText(
  text: string,
  events: readonly InputEvent[],
): Promise<PlanValidation> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return {
      ok: false,
      message: `方案不是合法 JSON：${e instanceof Error ? e.message : String(e)}`,
    }
  }

  if (!isPlainObject(raw)) {
    return { ok: false, message: '方案根节点必须是 JSON 对象' }
  }

  if (raw.version !== PLAN_FORMAT_VERSION) {
    return {
      ok: false,
      message:
        typeof raw.version === 'number'
          ? `不支持的方案版本 ${raw.version}，本工具仅支持版本 ${PLAN_FORMAT_VERSION}`
          : '缺少有效的 version 字段',
    }
  }

  if (
    typeof raw.fingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/.test(raw.fingerprint)
  ) {
    return { ok: false, message: '缺少有效的 fingerprint（须为 64 位小写十六进制 SHA-256）' }
  }

  const actualFingerprint = await fingerprintEvents(events)
  if (raw.fingerprint !== actualFingerprint) {
    return {
      ok: false,
      message:
        '数据指纹不匹配：当前解析出的合法事件与方案导出时不一致（事件内容、流、序号或重复次数有变化），已拒绝导入',
    }
  }

  if (!Array.isArray(raw.streams)) {
    return { ok: false, message: '缺少有效的 streams 数组' }
  }

  const builds = groupEvents(events as InputEvent[])
  const nextStarts: Record<string, number> = {}
  const nextSelections: Record<string, string> = {}
  const seenStreams = new Set<string>()

  for (const [i, entry] of raw.streams.entries()) {
    const where = `streams[${i}]`
    if (!isPlainObject(entry)) {
      return { ok: false, message: `${where} 必须是对象` }
    }
    if (typeof entry.stream !== 'string' || entry.stream === '') {
      return { ok: false, message: `${where}.stream 必须为非空字符串` }
    }
    const stream = entry.stream
    if (seenStreams.has(stream)) {
      return { ok: false, message: `流 "${stream}" 在方案中重复出现` }
    }
    seenStreams.add(stream)

    const build = builds.get(stream)
    if (!build) {
      return { ok: false, message: `方案中的流 "${stream}" 在当前数据中不存在` }
    }

    if (!isSafeInt(entry.start)) {
      return { ok: false, message: `流 "${stream}" 的 start 必须是安全整数` }
    }

    if (!Array.isArray(entry.resolutions)) {
      return { ok: false, message: `流 "${stream}" 的 resolutions 必须是数组` }
    }

    const seenSeq = new Set<number>()
    const groupsBySeq = new Map(build.groups.map((g) => [g.sequence, g]))
    for (const [j, r] of entry.resolutions.entries()) {
      const rWhere = `流 "${stream}" 的 resolutions[${j}]`
      if (!isPlainObject(r)) {
        return { ok: false, message: `${rWhere} 必须是对象` }
      }
      if (!isSafeInt(r.sequence)) {
        return { ok: false, message: `${rWhere}.sequence 必须是安全整数` }
      }
      if (seenSeq.has(r.sequence)) {
        return { ok: false, message: `${rWhere}：序号 ${r.sequence} 的裁决重复` }
      }
      seenSeq.add(r.sequence)

      if (typeof r.candidateId !== 'string' || r.candidateId === '') {
        return { ok: false, message: `${rWhere}.candidateId 必须为非空字符串` }
      }

      const group = groupsBySeq.get(r.sequence)
      if (!group) {
        return {
          ok: false,
          message: `${rWhere}：流 "${stream}" 中不存在序号 ${r.sequence} 的事件`,
        }
      }
      if (!group.isConflict) {
        return {
          ok: false,
          message: `${rWhere}：流 "${stream}" 序号 ${r.sequence} 并非冲突，无需裁决`,
        }
      }
      if (!group.candidates.some((c) => c.id === r.candidateId)) {
        return {
          ok: false,
          message: `${rWhere}：所选候选在流 "${stream}" 序号 ${r.sequence} 中不存在（候选稳定标识已失效）`,
        }
      }

      nextSelections[resolutionKey(stream, r.sequence)] = r.candidateId
    }

    nextStarts[stream] = entry.start
  }

  for (const name of builds.keys()) {
    if (!seenStreams.has(name)) {
      return { ok: false, message: `方案缺少当前数据中的流 "${name}"（流集合必须完全一致）` }
    }
  }

  const applied: AppliedPlan = { starts: nextStarts, selections: nextSelections }
  return {
    ok: true,
    plan: raw as unknown as RepairPlan,
    applied,
  }
}
