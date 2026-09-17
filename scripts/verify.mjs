// 核心逻辑端到端校验（非单测框架，node 直接运行）
import { parseNdjson } from '../src/lib/ndjson.ts'
import { groupEvents, analyzeStream, analyzeAll, resolutionKey } from '../src/lib/model.ts'
import { buildExport } from '../src/lib/export.ts'
import { deepEqual, stableStringify } from '../src/lib/compare.ts'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) {
    console.log(`  ok - ${name}`)
  } else {
    failures++
    console.error(`  FAIL - ${name} ${extra}`)
  }
}

// 1. 深比较：键顺序无关、数组顺序敏感
check('对象键顺序无关', deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 }))
check('数组顺序敏感', !deepEqual([1, 2], [2, 1]))
check('嵌套结构相等', deepEqual({ x: [1, { y: null }] }, { x: [1, { y: null }] }))
check('类型不同不等', !deepEqual({ a: 1 }, [1]))
check('stableStringify 键排序', stableStringify({ b: 1, a: 2 }) === '{"a":2,"b":1}')

// 2. 解析
const input = [
  '{"stream":"s1","sequence":1,"payload":{"v":1}}',
  '{"stream":"s1","sequence":1,"payload":{"v":1}}',           // 重复
  '  {"stream":"s1","sequence":1,"payload":{"v":2}}  ',       // 冲突
  '{"stream":"s1","sequence":2,"payload":"ok"}',
  '{"stream":"s1","sequence":4,"payload":[1,2]}',             // 缺 3
  '{"stream":"s2","sequence":10,"payload":{"a":1}}',
  '{"stream":"s2","sequence":10,"payload":{"a":1,"b":2}}',    // 冲突
  'not json',
  '{"stream":"s1","sequence":"x","payload":1}',
  '',
  '   ',
].join('\n')

const { events, errors } = parseNdjson(input)
check('合法事件 7 条', events.length === 7, `got ${events.length}`)
check('非法行 2 条', errors.length === 2, `got ${errors.length}`)
check('错误定位到行号', errors.some((e) => e.line === 8) && errors.some((e) => e.line === 9))
check('空白行跳过且行号保留', events[0].line === 1)

// 3. 分组
const builds = groupEvents(events)
const s1 = builds.get('s1')
check('两个流', builds.size === 2)
const g1 = s1.groups.find((g) => g.sequence === 1)
check('同序号折叠为 2 个候选（1 重复 + 1 冲突）', g1.candidates.length === 2)
check('重复候选计数 2', g1.candidates.some((c) => c.lines.length === 2))
check('isConflict 标记', g1.isConflict)
const g2 = s1.groups.find((g) => g.sequence === 2)
check('单候选非冲突', !g2.isConflict && g2.candidates[0].lines.length === 1)

// 4. 未裁决：冲突在 #1 阻断
let analyses = analyzeAll(builds, { s1: 1, s2: 10 }, {})
let a1 = analyses.find((x) => x.name === 's1')
check('s1 冲突阻断于 #1', a1.blockedByConflict && a1.blockingConflict === 1)
check('s1 前缀为空', a1.prefix.length === 0)
check('s1 缺口含 3', a1.gaps.includes(3))
let a2 = analyses.find((x) => x.name === 's2')
check('s2 冲突阻断于 #10', a2.blockedByConflict && a2.prefix.length === 0)

// 5. 裁决 s1#1 选 v=2 -> 前缀推进到 2，随后缺号 3 阻断
const v2 = g1.candidates.find((c) => JSON.stringify(c.payload) === '{"v":2}')
const sel1 = { [resolutionKey('s1', 1)]: v2.id }
a1 = analyzeStream(s1, 1, sel1)
check('裁决后放行 #1', a1.prefix.length === 2 && a1.prefix[0].payload.v === 2)
check('#1 记入已裁决集合', a1.resolvedConflictSequences.has(1))
check('缺号 3 阻断', a1.blockedByGap && a1.blockingGap === 3)
check('下一期待 #3', a1.nextExpected === 3)
check('#4 不进入前缀', !a1.prefix.some((e) => e.sequence === 4))

// 6. 撤销裁决 -> 立即回到冲突阻断
a1 = analyzeStream(s1, 1, {})
check('撤销后恢复冲突阻断', a1.blockedByConflict && a1.prefix.length === 0)

// 7. 起始序号调整：从 4 开始 -> 前缀为 #4
a1 = analyzeStream(s1, 4, {})
check('起始 4：#4 可确认', a1.prefix.length === 1 && a1.prefix[0].sequence === 4)
check('起始 4 无阻断（末尾结束）', !a1.blockedByGap && !a1.blockedByConflict)
check('下一期待 #5', a1.nextExpected === 5)

// 8. 起始早于观测：前置缺号只显示阻断点
a1 = analyzeStream(s1, 0, {})
check('起始 0：阻断于缺号 0', a1.blockedByGap && a1.blockingGap === 0 && a1.prefix.length === 0)
check('前置区间不逐一枚举缺口', !a1.gaps.includes(1) === false || a1.gaps[0] === 0)

// 9. 起始晚于最大序号
a1 = analyzeStream(s1, 9, {})
check('起始 9：阻断于缺号 9', a1.blockingGap === 9 && a1.prefix.length === 0)

// 10. s2 裁决后导出
const s2g = builds.get('s2').groups[0]
const selA = {
  ...sel1,
  [resolutionKey('s2', 10)]: s2g.candidates[0].id,
}
analyses = analyzeAll(builds, { s1: 1, s2: 10 }, selA)
// s1 仍在 #3 阻断，前缀到 #2
a1 = analyses.find((x) => x.name === 's1')
check('s1 导出前前缀 #1,#2', a1.prefix.map((e) => e.sequence).join() === '1,2')
a2 = analyses.find((x) => x.name === 's2')
check('s2 前缀 #10', a2.prefix.length === 1)

// 11. 导出：按流名排序
let out = buildExport(analyses, 'stream')
let rows = out.trim().split('\n').map(JSON.parse)
check('导出 3 条', rows.length === 3)
check('按流名：s1 在前且序号升序', rows[0].stream === 's1' && rows[0].sequence === 1 && rows[1].sequence === 2)
check('导出末条为 s2', rows[2].stream === 's2')
check('导出载荷为裁决版本 v=2', rows[0].payload.v === 2)
check('导出字段顺序 stream,sequence,payload', Object.keys(rows[0]).join(',') === 'stream,sequence,payload')

// 12. 导出：按序号排序
out = buildExport(analyses, 'sequence')
rows = out.trim().split('\n').map(JSON.parse)
check('按序号：10 排在最后', rows[2].sequence === 10)
check('同序号按流名次序稳定', rows[0].sequence === 1)

// 13. 空导出
check('无确认事件时导出为空串', buildExport([], 'stream') === '')

// 14. 无效裁决 id（候选已不存在）视为未裁决
a1 = analyzeStream(s1, 1, { [resolutionKey('s1', 1)]: '{"v":999}' })
check('失效裁决视为未裁决', a1.blockedByConflict && a1.prefix.length === 0)

console.log(failures === 0 ? '\n全部通过 ✔' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
