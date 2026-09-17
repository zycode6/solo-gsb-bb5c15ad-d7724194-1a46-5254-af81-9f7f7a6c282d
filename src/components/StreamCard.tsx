import type { StreamAnalysis } from '../types'
import { resolutionKey } from '../lib/model'
import { prettyJson } from '../lib/compare'

interface StreamCardProps {
  analysis: StreamAnalysis
  selections: Readonly<Record<string, string>>
  onResolve: (stream: string, sequence: number, candidateId: string) => void
  onUnresolve: (stream: string, sequence: number) => void
  onStartChange: (stream: string, start: number) => void
}

function linesLabel(lines: number[]): string {
  if (lines.length <= 4) return lines.join(', ')
  return `${lines.slice(0, 4).join(', ')} 等 ${lines.length} 行`
}

const statusBadge = (a: StreamAnalysis): { text: string; cls: string } => {
  if (a.blockedByConflict) return { text: '冲突阻断', cls: 'badge-danger' }
  if (a.blockedByGap) return { text: '缺号阻断', cls: 'badge-warn' }
  return { text: '连续无阻断', cls: 'badge-ok' }
}

export function StreamCard({
  analysis: a,
  selections,
  onResolve,
  onUnresolve,
  onStartChange,
}: StreamCardProps) {
  const badge = statusBadge(a)
  const conflictGroups = a.groups.filter((g) => g.isConflict)

  const chosenIdFor = (sequence: number): string | null => {
    const id = selections[resolutionKey(a.name, sequence)]
    return id ?? null
  }

  return (
    <section className="stream-card">
      <header className="stream-head">
        <div className="stream-title">
          <h3>{a.name}</h3>
          <span className={`badge ${badge.cls}`}>{badge.text}</span>
        </div>
        <div className="stream-meta">
          <label>
            起始序号
            <input
              type="number"
              className="start-input"
              value={a.start}
              step={1}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (Number.isSafeInteger(v)) onStartChange(a.name, v)
              }}
            />
          </label>
          <span className="meta-item">观测序号 {a.minObserved}–{a.maxObserved}</span>
          <span className="meta-item">输入 {a.totalEvents} 条</span>
          <span className="meta-item">已确认前缀 {a.prefix.length} 条</span>
        </div>
      </header>

      {a.gaps.length > 0 && (
        <div className="block gaps-block">
          <h4>缺口（缺号）</h4>
          <div className="gap-list">
            {a.gaps.map((g) => (
              <span
                key={g}
                className={`gap-chip ${a.blockingGap === g ? 'gap-chip-hot' : ''}`}
                title={
                  a.blockingGap === g
                    ? '该缺号阻断其后所有事件'
                    : '位于阻断点之后'
                }
              >
                #{g}
                {a.blockingGap === g ? ' ⛔' : ''}
              </span>
            ))}
          </div>
        </div>
      )}

      {conflictGroups.length > 0 && (
        <div className="block conflict-block">
          <h4>
            冲突候选
            <span className="block-hint">载荷结构不同，选择一个版本以放行；可撤销</span>
          </h4>
          <div className="conflict-list">
            {conflictGroups.map((g) => {
              const chosenId = chosenIdFor(g.sequence)
              const isHot = a.blockingConflict === g.sequence
              return (
                <div
                  key={g.sequence}
                  className={`conflict-group ${isHot ? 'conflict-hot' : ''} ${
                    chosenId ? 'conflict-resolved' : ''
                  }`}
                >
                  <div className="conflict-seq">
                    序号 #{g.sequence}
                    {isHot && <span className="hot-tag">阻断中 · 未裁决</span>}
                    {chosenId && !isHot && (
                      <span className="resolved-tag">已裁决</span>
                    )}
                    <span className="line-hint">输入行：{linesLabel(g.allLines)}</span>
                  </div>
                  <div className="candidate-grid">
                    {g.candidates.map((c, idx) => {
                      const selected = chosenId === c.id
                      return (
                        <div
                          key={c.id}
                          className={`candidate ${selected ? 'candidate-selected' : ''}`}
                        >
                          <div className="candidate-bar">
                            <label className="candidate-pick">
                              <input
                                type="radio"
                                name={`choice-${a.name}-${g.sequence}`}
                                checked={selected}
                                onChange={() =>
                                  onResolve(a.name, g.sequence, c.id)
                                }
                              />
                              版本 {String.fromCharCode(65 + idx)}
                            </label>
                            <span
                              className="dup-count"
                              title="结构完全相同的重复观测"
                            >
                              ×{c.lines.length}
                            </span>
                            <span className="line-hint">行 {linesLabel(c.lines)}</span>
                          </div>
                          <pre className="payload">{prettyJson(c.payload)}</pre>
                        </div>
                      )
                    })}
                  </div>
                  {chosenId && (
                    <button
                      type="button"
                      className="btn-text"
                      onClick={() => onUnresolve(a.name, g.sequence)}
                    >
                      撤销选择（重新标为未裁决）
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div className="block prefix-block">
        <h4>
          当前连续前缀
          <span className="block-hint">
            从 {a.start} 起连续且无未裁决冲突，共 {a.prefix.length} 条；下一期待序号 #{a.nextExpected}
          </span>
        </h4>
        {a.prefix.length === 0 ? (
          <p className="empty-line">尚无已确认事件</p>
        ) : (
          <div className="prefix-table-wrap">
            <table className="prefix-table">
              <thead>
                <tr>
                  <th className="col-seq">序号</th>
                  <th>载荷</th>
                  <th className="col-lines">来源行</th>
                </tr>
              </thead>
              <tbody>
                {a.prefix.map((ev) => (
                  <tr key={ev.sequence}>
                    <td className="col-seq">{ev.sequence}</td>
                    <td>
                      <pre className="payload payload-inline">
                        {prettyJson(ev.payload)}
                      </pre>
                    </td>
                    <td className="col-lines">
                      {linesLabel(ev.lines)}
                      {ev.lines.length > 1 && <em className="folded">（重复已折叠）</em>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  )
}
