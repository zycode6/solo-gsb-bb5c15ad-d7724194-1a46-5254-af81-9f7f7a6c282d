import type { ExportOrder, JsonValue, StreamAnalysis } from '../types'

export interface ExportRow {
  stream: string
  sequence: number
  payload: JsonValue
}

/**
 * 仅收集各流“已确认连续前缀”中的事件。
 * - stream：先按流名升序，再按序号升序；
 * - sequence：全局按序号升序，再按流名升序。
 * 输出为每行一个 JSON 对象（紧凑格式）的 NDJSON。
 */
export function buildExport(
  analyses: StreamAnalysis[],
  order: ExportOrder,
): string {
  const rows: ExportRow[] = []
  for (const analysis of analyses) {
    for (const ev of analysis.prefix) {
      rows.push({ stream: analysis.name, sequence: ev.sequence, payload: ev.payload })
    }
  }

  rows.sort((a, b) => {
    if (order === 'stream') {
      const byName = a.stream.localeCompare(b.stream, 'zh-Hans-CN-u-co-pinyin')
      return byName !== 0 ? byName : a.sequence - b.sequence
    }
    return a.sequence !== b.sequence
      ? a.sequence - b.sequence
      : a.stream.localeCompare(b.stream, 'zh-Hans-CN-u-co-pinyin')
  })

  // 显式按 stream / sequence / payload 顺序构造对象，保证导出文本字段顺序稳定
  return (
    rows
      .map((r) =>
        JSON.stringify({
          stream: r.stream,
          sequence: r.sequence,
          payload: r.payload,
        }),
      )
      .join('\n') + (rows.length ? '\n' : '')
  )
}
