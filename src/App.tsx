import { useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { ExportOrder } from './types'
import { parseNdjson } from './lib/ndjson'
import { analyzeAll, groupEvents, resolutionKey } from './lib/model'
import { buildExport } from './lib/export'
import { buildPlan, validatePlanText } from './lib/plan'
import { StreamCard } from './components/StreamCard'
import { SAMPLE } from './sample'

interface PlanMessage {
  kind: 'ok' | 'error'
  text: string
}

export function App() {
  const [text, setText] = useState('')
  const [parsedEvents, setParsedEvents] = useState<ReturnType<typeof parseNdjson>['events']>([])
  const [parseErrors, setParseErrors] = useState<ReturnType<typeof parseNdjson>['errors']>([])
  const [starts, setStarts] = useState<Record<string, number>>({})
  // 裁决映射：resolutionKey(stream, sequence) -> 选中候选的稳定 id
  const [selections, setSelections] = useState<Record<string, string>>({})
  const [order, setOrder] = useState<ExportOrder>('stream')
  const [copied, setCopied] = useState(false)
  const [planBusy, setPlanBusy] = useState(false)
  const [planMessage, setPlanMessage] = useState<PlanMessage | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const hasData = parsedEvents.length > 0

  const handleParse = () => {
    const result = parseNdjson(text)
    setParsedEvents(result.events)
    setParseErrors(result.errors)

    const builds = groupEvents(result.events)

    // 重新解析：保留旧起始序号，新流默认取其最小观测序号
    setStarts((prev) => {
      const next: Record<string, number> = {}
      for (const [name, b] of builds) {
        next[name] =
          prev[name] !== undefined && Number.isSafeInteger(prev[name])
            ? prev[name]
            : b.minSequence
      }
      return next
    })

    // 清理已不存在（流/序号/载荷结构失效）的裁决
    setSelections((prev) => {
      const next: Record<string, string> = {}
      for (const b of builds.values()) {
        for (const g of b.groups) {
          const rKey = resolutionKey(b.name, g.sequence)
          const selectedId = prev[rKey]
          if (
            selectedId !== undefined &&
            g.candidates.some((c) => c.id === selectedId)
          ) {
            next[rKey] = selectedId
          }
        }
      }
      return next
    })
    setCopied(false)
    setPlanMessage(null)
  }

  const handleLoadSample = () => {
    setText(SAMPLE)
  }

  const handleClearAll = () => {
    setText('')
    setParsedEvents([])
    setParseErrors([])
    setStarts({})
    setSelections({})
    setCopied(false)
    setPlanMessage(null)
  }

  const handleStartChange = (stream: string, start: number) => {
    setStarts((prev) => ({ ...prev, [stream]: start }))
    setPlanMessage(null)
  }

  const handleResolve = (
    stream: string,
    sequence: number,
    candidateId: string,
  ) => {
    setSelections((prev) => ({
      ...prev,
      [resolutionKey(stream, sequence)]: candidateId,
    }))
    setCopied(false)
    setPlanMessage(null)
  }

  const handleUnresolve = (stream: string, sequence: number) => {
    setSelections((prev) => {
      const next = { ...prev }
      delete next[resolutionKey(stream, sequence)]
      return next
    })
    setCopied(false)
    setPlanMessage(null)
  }

  const builds = useMemo(() => groupEvents(parsedEvents), [parsedEvents])
  const analyses = useMemo(
    () => analyzeAll(builds, starts, selections),
    [builds, starts, selections],
  )

  const summary = useMemo(() => {
    let conflicts = 0
    let unresolvedBlocking = 0
    let blockedStreams = 0
    let prefixCount = 0
    for (const a of analyses) {
      prefixCount += a.prefix.length
      for (const g of a.groups) if (g.isConflict) conflicts++
      if (a.blockedByGap || a.blockedByConflict) blockedStreams++
      if (a.blockingConflict !== null) unresolvedBlocking++
    }
    return {
      streams: analyses.length,
      conflicts,
      unresolvedBlocking,
      blockedStreams,
      prefixCount,
    }
  }, [analyses])

  const exportText = useMemo(
    () => (hasData ? buildExport(analyses, order) : ''),
    [analyses, order, hasData],
  )
  const exportRows = exportText ? exportText.trimEnd().split('\n').length : 0

  const triggerDownload = (content: string, filename: string, mime: string) => {
    const blob = new Blob([content], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  const handleDownload = () => {
    if (!exportText) return
    triggerDownload(exportText, 'confirmed-events.ndjson', 'application/x-ndjson')
  }

  const handleCopy = async () => {
    if (!exportText) return
    try {
      await navigator.clipboard.writeText(exportText)
      setCopied(true)
    } catch {
      // 剪贴板权限不可用时的兜底
      const ta = document.createElement('textarea')
      ta.value = exportText
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
      setCopied(true)
    }
  }

  const handleDownloadPlan = async () => {
    if (!hasData || planBusy) return
    setPlanBusy(true)
    try {
      const plan = await buildPlan(parsedEvents, starts, selections)
      triggerDownload(
        JSON.stringify(plan, null, 2),
        'repair-plan.json',
        'application/json',
      )
      setPlanMessage({
        kind: 'ok',
        text: `方案已下载（${plan.streams.length} 条流）；方案绑定当前合法事件的数据指纹，导入时会先校验。`,
      })
    } finally {
      setPlanBusy(false)
    }
  }

  const handleImportPlanClick = () => {
    fileInputRef.current?.click()
  }

  const handleImportPlanFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    // 允许再次选择同一个文件
    e.target.value = ''
    if (!file) return
    if (!hasData) {
      setPlanMessage({
        kind: 'error',
        text: '请先粘贴并解析与该方案对应的 NDJSON 事件数据，再导入方案。',
      })
      return
    }

    let text: string
    try {
      text = await file.text()
    } catch {
      setPlanMessage({ kind: 'error', text: '读取方案文件失败，请重试。' })
      return
    }

    setPlanBusy(true)
    try {
      const result = await validatePlanText(text, parsedEvents)
      if (!result.ok) {
        // 校验失败：整体拒绝，不改动任何当前状态
        setPlanMessage({ kind: 'error', text: result.message })
        return
      }
      // 全部校验通过：一次性应用起始序号与裁决状态
      setStarts(result.applied.starts)
      setSelections(result.applied.selections)
      setCopied(false)
      const resolved = result.plan.streams.reduce(
        (n, s) => n + s.resolutions.length,
        0,
      )
      setPlanMessage({
        kind: 'ok',
        text: `方案导入成功：已应用 ${result.plan.streams.length} 条流的起始序号与 ${resolved} 项冲突裁决，连续前缀已立即重算。`,
      })
    } finally {
      setPlanBusy(false)
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>离线事件序列修复台</h1>
        <p className="subtitle">
          NDJSON（每行 <code>stream / sequence / payload</code>）本地去重、冲突裁决与缺口修复 ·
          所有处理均在浏览器内完成，不上传任何数据
        </p>
      </header>

      <section className="panel input-panel">
        <div className="panel-head">
          <h2>1. 粘贴事件数据</h2>
          <div className="row-actions">
            <button type="button" className="btn" onClick={handleLoadSample}>
              载入示例
            </button>
            <button type="button" className="btn btn-ghost" onClick={handleClearAll}>
              清空
            </button>
          </div>
        </div>
        <textarea
          className="ndjson-input"
          spellCheck={false}
          placeholder={'{"stream":"orders","sequence":1,"payload":{...}}\n{"stream":"orders","sequence":2,...}'}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="parse-bar">
          <button type="button" className="btn btn-primary" onClick={handleParse}>
            解析并分析
          </button>
          {parseErrors.length > 0 && (
            <span className="error-summary">
              {parseErrors.length} 行解析失败（已跳过，见下方详情）
            </span>
          )}
        </div>
        {parseErrors.length > 0 && (
          <ul className="error-list">
            {parseErrors.map((e) => (
              <li key={e.line}>
                <strong>第 {e.line} 行</strong>：{e.message}
              </li>
            ))}
          </ul>
        )}
      </section>

      {hasData && (
        <>
          <section className="panel stats-panel">
            <div className="stat">
              <span className="stat-num">{summary.streams}</span>
              <span className="stat-label">流</span>
            </div>
            <div className="stat">
              <span className="stat-num">{summary.conflicts}</span>
              <span className="stat-label">冲突序号</span>
            </div>
            <div className="stat">
              <span className={`stat-num ${summary.unresolvedBlocking ? 'num-danger' : ''}`}>
                {summary.unresolvedBlocking}
              </span>
              <span className="stat-label">未裁决阻断</span>
            </div>
            <div className="stat">
              <span className={`stat-num ${summary.blockedStreams ? 'num-warn' : 'num-ok'}`}>
                {summary.blockedStreams}
              </span>
              <span className="stat-label">被阻断流</span>
            </div>
            <div className="stat">
              <span className="stat-num num-ok">{summary.prefixCount}</span>
              <span className="stat-label">可导出事件</span>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>2. 逐流检查缺口与冲突</h2>
              <p className="panel-hint">
                选择冲突版本或撤销选择、调整起始序号后，连续前缀会立即重新计算
              </p>
            </div>
            <div className="stream-list">
              {analyses.map((a) => (
                <StreamCard
                  key={a.name}
                  analysis={a}
                  selections={selections}
                  onResolve={handleResolve}
                  onUnresolve={handleUnresolve}
                  onStartChange={handleStartChange}
                />
              ))}
            </div>
          </section>

          <section className="panel plan-panel">
            <div className="panel-head">
              <h2>3. 修复方案导入 / 导出</h2>
              <p className="panel-hint">
                方案 JSON 含版本、数据指纹（合法事件多重集的 SHA-256）、各流起始序号与所选候选稳定标识；
                行重排不影响导入，但事件重复次数或内容变化会导致指纹失配
              </p>
            </div>
            <div className="plan-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleDownloadPlan}
                disabled={planBusy}
              >
                下载修复方案（JSON）
              </button>
              <button
                type="button"
                className="btn"
                onClick={handleImportPlanClick}
                disabled={planBusy}
              >
                从文件导入方案
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                className="plan-file-input"
                onChange={handleImportPlanFile}
              />
              <span className="plan-hint">
                导入前须已解析对应数据；校验任一项失败都会整体拒绝，当前状态不变
              </span>
            </div>
            {planMessage && (
              <p className={`plan-message plan-${planMessage.kind}`}>
                {planMessage.kind === 'ok' ? '✔ ' : '✖ '}
                {planMessage.text}
              </p>
            )}
          </section>

          <section className="panel export-panel">
            <div className="panel-head">
              <h2>4. 导出已确认连续事件</h2>
              <div className="export-controls">
                <label className="order-control">
                  排序
                  <select
                    value={order}
                    onChange={(e) => setOrder(e.target.value as ExportOrder)}
                  >
                    <option value="stream">按流名，再按序号</option>
                    <option value="sequence">按序号，再按流名</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleDownload}
                  disabled={exportRows === 0}
                >
                  下载 NDJSON
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={handleCopy}
                  disabled={exportRows === 0}
                >
                  {copied ? '已复制' : '复制'}
                </button>
              </div>
            </div>
            {exportRows === 0 ? (
              <p className="empty-line">没有可导出的已确认连续事件。</p>
            ) : (
              <>
                <p className="export-meta">共 {exportRows} 条，仅包含各流连续前缀内的事件</p>
                <pre className="export-preview">{exportText}</pre>
              </>
            )}
          </section>
        </>
      )}

      {!hasData && (
        <section className="panel empty-panel">
          <p>粘贴 NDJSON 后点击「解析并分析」，或先「载入示例」体验。</p>
          <ol className="rules">
            <li>同流同序号且载荷结构相同的重复项自动折叠。</li>
            <li>同流同序号但载荷结构不同 → 冲突，选择一个版本后才放行；可随时撤销。</li>
            <li>缺号或未裁决冲突会阻断该位置之后的全部事件。</li>
            <li>导出仅包含每条流从起始序号开始的已确认连续前缀。</li>
          </ol>
        </section>
      )}

      <footer className="app-footer">
        纯前端本地处理 · TypeScript + Vite + React · 无网络请求
      </footer>
    </div>
  )
}
