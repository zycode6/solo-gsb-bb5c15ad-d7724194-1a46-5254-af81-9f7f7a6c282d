// 全局领域类型

/** 一条通过 NDJSON 解析并校验后的输入事件 */
export interface InputEvent {
  /** 输入框中的行号（从 1 开始，空行不参与编号，因此即文本行号） */
  line: number
  stream: string
  sequence: number
  /** 已解析的 JSON 载荷，可以是任意 JSON 值（对象/数组/基本类型） */
  payload: JsonValue
  /** payload 在该行对应的原始 JSON 文本，用于候选展示 */
  raw: string
}

/** 可在 JSON 中出现的值 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

/** 单行解析错误 */
export interface ParseError {
  line: number
  message: string
}

/** NDJSON 解析结果 */
export interface ParseResult {
  events: InputEvent[]
  errors: ParseError[]
}

/**
 * 同一 stream + sequence 下，按结构深比较折叠后的一个载荷版本。
 * id 为稳定序列化结果，既是去重键也是裁决选择键。
 */
export interface Candidate {
  id: string
  payload: JsonValue
  /** 该载荷第一次出现的原始文本 */
  raw: string
  /** 具备相同结构载荷的输入行号 */
  lines: number[]
}

/** 同一 stream + sequence 的全部观测 */
export interface SequenceGroup {
  stream: string
  sequence: number
  candidates: Candidate[]
  /** 所有观测行号（含折叠掉的重复项） */
  allLines: number[]
  /** candidates.length > 1 即冲突 */
  isConflict: boolean
}

/** 构建阶段得到的每个流的分组信息 */
export interface StreamBuild {
  name: string
  minSequence: number
  maxSequence: number
  groups: SequenceGroup[]
  /** 输入中观测到的事件总条数（折叠前） */
  totalEvents: number
}

/** 已确认的连续前缀中的一个事件 */
export interface PrefixEvent {
  sequence: number
  payload: JsonValue
  /** 来自输入的行号；折叠后可能有多个 */
  lines: number[]
}

/** 单个流在给定起始序号与裁决下的完整分析结果 */
export interface StreamAnalysis {
  name: string
  start: number
  minObserved: number
  maxObserved: number
  totalEvents: number
  groups: SequenceGroup[]
  /** 已确认且连续的前缀事件（从 start 开始） */
  prefix: PrefixEvent[]
  /** 前缀之后首个未满足的序号 */
  nextExpected: number
  /** 阻断原因：缺号 */
  blockedByGap: boolean
  /** 阻断原因：未裁决冲突 */
  blockedByConflict: boolean
  /** 前缀之后的缺号列表（升序、去重，仅在观测范围/起始之间有意义） */
  gaps: number[]
  /** 导致阻断的缺号（若有） */
  blockingGap: number | null
  /** 导致阻断的冲突序号（若有） */
  blockingConflict: number | null
  /** 是否已裁决（存在选择）的冲突集合，按序号索引 */
  resolvedConflictSequences: Set<number>
}

/** 导出排序方式 */
export type ExportOrder = 'stream' | 'sequence'
