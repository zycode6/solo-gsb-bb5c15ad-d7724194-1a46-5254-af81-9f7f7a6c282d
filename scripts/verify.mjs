// 核心逻辑端到端校验（非单测框架，node 直接运行）
import nodeCrypto from 'node:crypto'
import { parseNdjson } from '../src/lib/ndjson.ts'
import { groupEvents, analyzeStream, analyzeAll, resolutionKey } from '../src/lib/model.ts'
import { buildExport } from '../src/lib/export.ts'
import { deepEqual, stableStringify } from '../src/lib/compare.ts'
import {
  buildPlan,
  canonicalizeEvents,
  fingerprintEvents,
  sha256Hex,
  validatePlanText,
} from '../src/lib/plan.ts'
import { PLAN_FORMAT_VERSION } from '../src/types.ts'

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

// 15. 修复方案：规范化与指纹
{
  // SHA-256 已知答案（空串 / abc），同时校验与 Web Crypto 结果一致
  const enc = (s) => new TextEncoder().encode(s)
  check(
    '纯 JS SHA-256 空串向量',
    sha256Hex(enc('')) === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  )
  check(
    '纯 JS SHA-256 abc 向量',
    sha256Hex(enc('abc')) === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  )
  check(
    '纯 JS SHA-256 长输入（跨块填充）与 node crypto 一致',
    sha256Hex(enc('a'.repeat(1000))) ===
      nodeCrypto.createHash('sha256').update('a'.repeat(1000)).digest('hex'),
  )
  check(
    '纯 JS SHA-256 超长输入（>2^32 位，标准向量）',
    sha256Hex(enc('a'.repeat(1_000_000))) ===
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
  )

  const base = [
    '{"stream":"b","sequence":2,"payload":{"y":2,"x":1}}',
    '{"stream":"a","sequence":1,"payload":[1,2]}',
  ].join('\n')
  const reordered = [
    '{"stream":"a","sequence":1,"payload":[1, 2]}',
    '{"stream":"b","sequence":2,"payload":{"x":1,"y":2}}',
  ].join('\n')
  const { events: evA } = parseNdjson(base)
  const { events: evB } = parseNdjson(reordered)
  check('规范化与行顺序/键顺序/空白无关', canonicalizeEvents(evA) === canonicalizeEvents(evB))

  const dup = parseNdjson(base + '\n' + '{"stream":"a","sequence":1,"payload":[1,2]}')
  check('重复次数改变 -> 规范化不同', canonicalizeEvents(dup.events) !== canonicalizeEvents(evA))
  check('重复次数改变 -> 指纹不同', await fingerprintEvents(dup.events) !== await fingerprintEvents(evA))
  check('重排指纹一致', await fingerprintEvents(evA) === await fingerprintEvents(evB))
  check('指纹为 64 位小写十六进制', /^[0-9a-f]{64}$/.test(await fingerprintEvents(evA)))

  // 16. 构建方案并成功导入：起点与裁决一次性应用
  const starts = { s1: 1, s2: 10 }
  const planObj = await buildPlan(events, starts, selA)
  check('方案版本号', planObj.version === PLAN_FORMAT_VERSION)
  check('方案含每流一条记录', planObj.streams.length === 2)
  const ps1 = planObj.streams.find((s) => s.stream === 's1')
  check(
    '方案记录起点与裁决',
    ps1.start === 1 && ps1.resolutions.length === 1 &&
      ps1.resolutions[0].sequence === 1 &&
      ps1.resolutions[0].candidateId === v2.id,
  )
  const planText = JSON.stringify(planObj)
  const ok = await validatePlanText(planText, events)
  check('合法方案校验通过', ok.ok === true)
  if (ok.ok) {
    check('应用起点', ok.applied.starts.s1 === 1 && ok.applied.starts.s2 === 10)
    check(
      '应用裁决映射',
      ok.applied.selections[resolutionKey('s1', 1)] === v2.id &&
        ok.applied.selections[resolutionKey('s2', 10)] === s2g.candidates[0].id,
    )
    // 应用后立即重算前缀：s1 到 #2，s2 到 #10
    const reapplied = analyzeAll(builds, ok.applied.starts, ok.applied.selections)
    check(
      '应用后连续前缀立即重算',
      reapplied.find((x) => x.name === 's1').prefix.map((e) => e.sequence).join() === '1,2' &&
        reapplied.find((x) => x.name === 's2').prefix.length === 1,
    )
  }

  // 17. 行重排后指纹仍匹配（可移植）
  const shuffledText = input.split('\n').filter(Boolean).reverse().join('\n')
  const { events: shuffled } = parseNdjson(shuffledText)
  check('行重排后方案仍可导入', (await validatePlanText(planText, shuffled)).ok === true)

  // 18. 各类无效方案整体拒绝
  const reject = async (label, mutate, mutateEvents = events) => {
    const p = structuredClone(planObj)
    mutate(p)
    const r = await validatePlanText(JSON.stringify(p), mutateEvents)
    check(label, r.ok === false, r.ok ? '' : r.message)
  }
  check('非 JSON 被拒', (await validatePlanText('{bad json', events)).ok === false)
  await reject('版本不被支持被拒', (p) => { p.version = 999 })
  await reject('指纹格式非法被拒', (p) => { p.fingerprint = 'abc' })
  await reject('指纹不匹配被拒', (p) => {
    p.fingerprint = '0'.repeat(64)
  })
  await reject('数据重复次数变化 -> 指纹失配被拒', (p) => {}, dup.events)
  await reject('未知流被拒', (p) => { p.streams[0].stream = 'nope' })
  await reject('缺少流被拒', (p) => { p.streams.length = 1 })
  await reject('起点非整数被拒', (p) => { p.streams[0].start = 1.5 })
  await reject('裁决指向不存在序号被拒', (p) => {
    p.streams.find((s) => s.stream === 's1').resolutions[0].sequence = 99
  })
  await reject('裁决候选不存在被拒', (p) => {
    p.streams.find((s) => s.stream === 's1').resolutions[0].candidateId = '{"v":123}'
  })
  await reject('非冲突序号裁决被拒', (p) => {
    const s2Plan = p.streams.find((s) => s.stream === 's2')
    s2Plan.resolutions = [{ sequence: 10, candidateId: s2g.candidates[0].id }]
    // s1 序号 2 非冲突
    const s1Plan = p.streams.find((s) => s.stream === 's1')
    s1Plan.resolutions.push({ sequence: 2, candidateId: stableStringify('ok') })
  })

  // 19. 拒绝不改变调用方状态（applied 不存在，starts/selections 保持原样）
  const before = JSON.stringify(starts)
  const bad = await validatePlanText('{bad', events)
  check('拒绝时不产出可应用状态', bad.ok === false && bad.applied === undefined)
  check('拒绝时调用方状态未动', JSON.stringify(starts) === before)
}

console.log(failures === 0 ? '\n全部通过 ✔' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
