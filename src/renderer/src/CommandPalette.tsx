import { useEffect, useMemo, useRef, useState } from 'react'
import { buildPaletteItems, filterItems, type PaletteNode, type PaletteProject } from './palette'

/**
 * Cmd+K 全局检索。判据全在 `palette.ts`，这里只管交互。
 *
 * 三条交互约束：
 * - **Esc 一定关得掉**，且不冒泡到画布（画布上 Esc 有别的含义）
 * - 列表用 ↑↓ 走，选中项要 `scrollIntoView` —— 否则搜到第 20 条时看不见光标在哪
 * - 打开时**全选**输入框里的旧查询：连按两次 Cmd+K 的意图通常是"重新搜"，
 *   而不是"在上次的词后面接着打"
 */
export function CommandPalette({
  open,
  nodes,
  projects,
  liveAgents,
  onClose,
  onPick
}: {
  open: boolean
  nodes: PaletteNode[]
  projects: PaletteProject[]
  liveAgents: Record<string, string>
  onClose: () => void
  onPick: (kind: 'node' | 'project', id: string) => void
}): React.JSX.Element | null {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const items = useMemo(
    () => filterItems(buildPaletteItems(nodes, projects, liveAgents), q),
    [nodes, projects, liveAgents, q]
  )

  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
    inputRef.current?.select()
    setSel(0)
  }, [open])

  // 查询变了 → 选中回到第一条，否则光标会停在一个已经被过滤掉的位置
  useEffect(() => setSel(0), [q])

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-sel="1"]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [sel, items.length])

  if (!open) return null

  const pick = (i: number): void => {
    const it = items[i]
    if (!it) return
    onPick(it.kind, it.id)
    onClose()
  }

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          value={q}
          placeholder="搜节点 / 项目：标题、id、provider、目录、分支、状态"
          spellCheck={false}
          onChange={(e) => setQ(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              onClose()
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setSel((s) => Math.min(items.length - 1, s + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setSel((s) => Math.max(0, s - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              pick(sel)
            }
          }}
        />
        <div className="palette-list" ref={listRef}>
          {items.length === 0 && <div className="palette-empty">没有匹配的节点或项目</div>}
          {items.slice(0, 60).map((it, i) => (
            <div
              key={`${it.kind}:${it.id}`}
              className={`palette-row${i === sel ? ' sel' : ''}`}
              data-sel={i === sel ? '1' : '0'}
              onMouseEnter={() => setSel(i)}
              onClick={() => pick(i)}
            >
              <span className={`status-dot ${it.status ?? (it.kind === 'project' ? 'context' : 'idle')}`} />
              <span className="palette-title">{it.title}</span>
              <span className="palette-detail">{it.detail}</span>
            </div>
          ))}
        </div>
        <div className="palette-foot">↑↓ 选择 · ⏎ 跳过去 · Esc 关闭</div>
      </div>
    </div>
  )
}
