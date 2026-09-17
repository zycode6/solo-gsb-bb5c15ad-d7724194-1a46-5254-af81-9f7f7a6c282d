import type { InputEvent, JsonValue, ParseResult } from '../types'

const STREAM_RE = /^[^\n\r]+$/

/**
 * 解析 NDJSON 文本。每行必须是独立的 JSON 对象，且含：
 *   stream: string、sequence: 整数（安全范围内）、payload: 任意 JSON 值
 * 空行/纯空白行被跳过；任何不合法行都会被收集为错误，
 * 其余合法行照常参与处理（部分可用）。
 */
export function parseNdjson(text: string): ParseResult {
  const events: InputEvent[] = []
  const errors: ParseResult['errors'] = []

  const lines = text.split(/\r?\n/)
  lines.forEach((rawLine, index) => {
    const line = index + 1
    const trimmed = rawLine.trim()
    if (trimmed === '') return

    let obj: unknown
    try {
      obj = JSON.parse(trimmed)
    } catch (e) {
      errors.push({
        line,
        message: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}`,
      })
      return
    }

    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      errors.push({ line, message: '每行必须是 JSON 对象' })
      return
    }

    const record = obj as Record<string, unknown>

    if (typeof record.stream !== 'string' || !STREAM_RE.test(record.stream)) {
      errors.push({ line, message: '缺少有效的 stream（必须为非空字符串）' })
      return
    }

    const seq = record.sequence
    if (
      typeof seq !== 'number' ||
      !Number.isInteger(seq) ||
      !Number.isSafeInteger(seq)
    ) {
      errors.push({
        line,
        message: '缺少有效的 sequence（必须为安全整数）',
      })
      return
    }

    if (!('payload' in record)) {
      errors.push({ line, message: '缺少 payload 字段' })
      return
    }

    events.push({
      line,
      stream: record.stream,
      sequence: seq,
      payload: record.payload as JsonValue,
      raw: trimmed,
    })
  })

  return { events, errors }
}
