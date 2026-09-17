import type { JsonValue } from '../types'

/**
 * 按 JSON 结构深比较两个已解析的值。
 * - 对象按键排序后递归比较，因此键顺序不影响相等性；
 * - 数组按位置递归比较；
 * - 数字按值比较（NaN 视为相等，与 JSON.parse 实际产出无关，仅为完备性）。
 */
export function deepEqual(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true

  if (typeof a === 'number' && typeof b === 'number') {
    return Number.isNaN(a) && Number.isNaN(b)
  }

  const aIsArray = Array.isArray(a)
  const bIsArray = Array.isArray(b)
  if (aIsArray !== bIsArray) return false

  if (aIsArray && bIsArray) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false
    }
    return true
  }

  if (
    a === null ||
    b === null ||
    typeof a !== 'object' ||
    typeof b !== 'object'
  ) {
    return false
  }

  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false

  for (const key of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false
    if (
      !deepEqual(
        (a as Record<string, JsonValue>)[key],
        (b as Record<string, JsonValue>)[key],
      )
    ) {
      return false
    }
  }
  return true
}

/**
 * 生成稳定的 JSON 序列化文本：对象键递归排序。
 * 结构相等的载荷必然产生相同字符串，用作候选的唯一标识。
 */
export function stableStringify(value: JsonValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']'
  }
  const entries = Object.keys(value)
    .sort()
    .map((k) => JSON.stringify(k) + ':' + stableStringify(value[k]))
  return '{' + entries.join(',') + '}'
}

/** 美观格式化载荷，供界面展示 */
export function prettyJson(value: JsonValue): string {
  return JSON.stringify(value, null, 2)
}
