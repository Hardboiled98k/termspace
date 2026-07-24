import { memo, useEffect, useRef, useState } from 'react'
import {
  Handle,
  NodeResizer,
  Position,
  useReactFlow,
  type Node,
  type NodeProps
} from '@xyflow/react'
import { FarChip, FAR_ZOOM, useZoom } from './FarChip'

/* 画布内浏览器：agent 要测网页时优先在这里开，实时可见不用切应用 */
export type BrowserNodeT = Node<{ url: string; title?: string }, 'browser'>

// <webview> 是 Electron 自定义元素，React 无内置类型 → 用 any 包一层
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Webview = 'webview' as any

// 每个浏览器节点把自己的 webview 注册到全局表，供 tb browser 驱动
type WvExtra = WebviewEl & {
  executeJavaScript: (code: string) => Promise<unknown>
  capturePage: () => Promise<{ toDataURL: () => string }>
  loadURL: (url: string) => Promise<void>
}
export const browserViews = new Map<string, WvExtra>()

function normalizeUrl(input: string): string {
  const t = input.trim()
  if (!t) return 'about:blank'
  if (/^https?:\/\//i.test(t) || t === 'about:blank') return t
  // 像域名就补 https，否则当搜索
  if (/^[\w-]+(\.[\w-]+)+/.test(t)) return `https://${t}`
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`
}

// webview 是 Electron 自定义元素，React 类型里没有，宽松声明
type WebviewEl = HTMLElement & {
  src: string
  canGoBack: () => boolean
  canGoForward: () => boolean
  goBack: () => void
  goForward: () => void
  reload: () => void
  getURL: () => string
  getTitle: () => string
}

function BrowserNodeImpl({ id, data, selected }: NodeProps<BrowserNodeT>): React.JSX.Element {
  const { deleteElements, updateNodeData } = useReactFlow()
  const zoom = useZoom()
  const wvRef = useRef<WebviewEl | null>(null)
  const [addr, setAddr] = useState(data.url || 'about:blank')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const wv = wvRef.current
    if (!wv) return
    browserViews.set(id, wv as WvExtra)
    const onStart = (): void => setLoading(true)
    const onStop = (): void => {
      setLoading(false)
      const u = wv.getURL()
      setAddr(u)
      if (u !== data.url) updateNodeData(id, { url: u, title: wv.getTitle() })
    }
    wv.addEventListener('did-start-loading', onStart)
    wv.addEventListener('did-stop-loading', onStop)
    return () => {
      browserViews.delete(id)
      wv.removeEventListener('did-start-loading', onStart)
      wv.removeEventListener('did-stop-loading', onStop)
    }
  }, [id, data.url, updateNodeData])

  const go = (raw: string): void => {
    const u = normalizeUrl(raw)
    setAddr(u)
    if (wvRef.current) wvRef.current.src = u
    updateNodeData(id, { url: u })
  }

  if (zoom < FAR_ZOOM) {
    return (
      <div className="browser-node far far-context">
        <FarChip zoom={zoom} dotClass="context" title={data.title || '浏览器'} state="web" />
      </div>
    )
  }

  return (
    <div className={`browser-node${selected ? ' selected' : ''}`}>
      <NodeResizer
        minWidth={360}
        minHeight={260}
        isVisible
        handleStyle={{ opacity: 0, width: 16, height: 16, border: 'none' }}
        lineStyle={{ opacity: 0, borderWidth: 8 }}
      />
      <Handle type="target" position={Position.Left} className="tb-handle in" />
      <div className="browser-bar">
        <button className="browser-nav" title="后退" onClick={() => wvRef.current?.goBack()}>
          ‹
        </button>
        <button className="browser-nav" title="前进" onClick={() => wvRef.current?.goForward()}>
          ›
        </button>
        <button className="browser-nav" title="刷新" onClick={() => wvRef.current?.reload()}>
          ⟳
        </button>
        <input
          className="browser-addr nodrag"
          value={addr}
          onChange={(e) => setAddr(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go(e.currentTarget.value)
          }}
          placeholder="输入网址或搜索…"
          spellCheck={false}
        />
        <span className={`browser-dot${loading ? ' loading' : ''}`} />
        <button
          className="term-node-close nodrag"
          title="关闭浏览器节点"
          onClick={(e) => {
            e.stopPropagation()
            void deleteElements({ nodes: [{ id }] })
          }}
        >
          ✕
        </button>
      </div>
      <div className="browser-body nodrag nowheel">
        <Webview
          ref={wvRef}
          src={data.url || 'about:blank'}
          style={{ width: '100%', height: '100%' }}
        />
      </div>
    </div>
  )
}

export default memo(BrowserNodeImpl)
