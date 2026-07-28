import { memo, useCallback, useEffect, useRef, useState } from 'react'
import {
  Handle,
  NodeResizer,
  Position,
  useReactFlow,
  type Node,
  type NodeProps
} from '@xyflow/react'
import { FarChip, FAR_ZOOM, useZoom } from './FarChip'
import { usePinchZoom } from '../usePinchZoom'

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
  setZoomFactor?: (n: number) => void
}

function BrowserNodeImpl({ id, data, selected }: NodeProps<BrowserNodeT>): React.JSX.Element {
  const { deleteElements, updateNodeData } = useReactFlow()
  const zoom = useZoom()
  const wvRef = useRef<WebviewEl | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const roRef = useRef<ResizeObserver | null>(null)
  const pinchZoom = usePinchZoom()
  const [addr, setAddr] = useState(data.url || 'about:blank')
  const [loading, setLoading] = useState(false)

  /* 按节点宽度把页面缩到"像一个缩小的浏览器窗口"。
     不做这件事的话 webview 恒定 100% 渲染 —— 节点只有 800px 宽，
     桌面站按 1280 设计，结果就是**字巨大且只看得到左上角一块**。
     参照宽度取 1280（主流桌面断点），节点越宽缩放越接近 1。
     下限 0.4：再小字就没法读了，那时候本来也该放大节点或用 LOD 远景。 */
  const REF_WIDTH = 1280
  /* dom-ready 之后仍然失败 = 真出问题了，**不能继续当成"还没准备好"吞掉** ——
     那样用户只会看到一个恒定 100% 的页面，没有任何线索说明自适应没生效。 */
  const wvReady = useRef(false)
  const applyZoom = useCallback((w: number): void => {
    const wv = wvRef.current
    if (!wv || w <= 0) return
    const z = Math.min(1, Math.max(0.4, w / REF_WIDTH))
    /* setZoomFactor 在 dom-ready 之前调会抛。webview 还没准备好就跳过，
       下面 dom-ready 事件里会补一次 —— 这是 <webview> 的老毛病，
       不兜住的话首次加载的页面永远是 100%。 */
    try {
      if (typeof wv.setZoomFactor !== 'function') {
        if (wvReady.current) console.warn(`[BrowserNode] webview 没有 setZoomFactor，缩放自适应失效`)
        return
      }
      wv.setZoomFactor(z)
    } catch (err) {
      if (wvReady.current) console.warn(`[BrowserNode] setZoomFactor 失败：`, err)
      // dom-ready 之前抛是预期的，那时 wvReady 还是 false —— 静默等 onReady 补
    }
  }, [])

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
    /* dom-ready 之前 setZoomFactor 会抛，所以这里补一次 ——
       否则首次加载出来的页面永远是 100%，只有手动 resize 一下才对。 */
    const onReady = (): void => {
      wvReady.current = true
      applyZoom(bodyRef.current?.clientWidth ?? 0)
    }
    wv.addEventListener('did-start-loading', onStart)
    wv.addEventListener('did-stop-loading', onStop)
    wv.addEventListener('dom-ready', onReady)
    return () => {
      browserViews.delete(id)
      wv.removeEventListener('did-start-loading', onStart)
      wv.removeEventListener('did-stop-loading', onStop)
      wv.removeEventListener('dom-ready', onReady)
    }
  }, [id, data.url, updateNodeData, applyZoom])

  /* 节点尺寸变化就重算。用 ResizeObserver 而不是 NodeProps 的 width ——
     后者在拖拽 resize 过程中不一定每帧都更新，而 webview 缩放要跟手。 */
  const setBody = useCallback(
    (el: HTMLDivElement | null): void => {
      pinchZoom(el)
      bodyRef.current = el
      roRef.current?.disconnect()
      roRef.current = null
      if (!el) return
      applyZoom(el.clientWidth)
      const ro = new ResizeObserver((entries) => {
        const w = entries[0]?.contentRect.width ?? 0
        /* 宽度为 0 时不要缩放：元素折叠/未布局时算出来是下限 0.4，
           等它重新展开就停在一个莫名其妙的缩放上（和 TerminalNode 里
           "尺寸为 0 时不能 fit" 是同一类坑）。 */
        if (w > 0) applyZoom(w)
      })
      ro.observe(el)
      roRef.current = ro
    },
    [pinchZoom, applyZoom]
  )

  const go = (raw: string): void => {
    const u = normalizeUrl(raw)
    setAddr(u)
    if (wvRef.current) wvRef.current.src = u
    updateNodeData(id, { url: u })
  }

  // 远缩时**绝不能**把 <webview> 从 DOM 摘掉：那等于销毁浏览器会话（页面、登录态、
  // 滚动位置全没），而且 browserViews 会留着一个已失效的引用，拉回来也不会重新注册。
  // 学 TerminalNode：整棵树保持挂载，只是藏起来，另外叠一个远景色块。
  const far = zoom < FAR_ZOOM

  return (
    <div className={`browser-node${selected ? ' selected' : ''}${far ? ' far far-context' : ''}`}>
      {far && <FarChip zoom={zoom} dotClass="context" title={data.title || '浏览器'} state="web" />}
      <NodeResizer
        minWidth={360}
        minHeight={260}
        isVisible={!far}
        handleStyle={{ opacity: 0, width: 16, height: 16, border: 'none' }}
        lineStyle={{ opacity: 0, borderWidth: 8 }}
      />
      <Handle type="target" position={Position.Left} className="tb-handle in" />
      {/* 边的语义方向恒为「终端 → 浏览器」（终端驱动浏览器）。右侧的 source
          是给反向拖拽用的 —— onConnect 里那段 swap 会 normalize 回来。
          以前没有它，那段 swap 同样永远执行不到。 */}
      <Handle type="source" position={Position.Right} className="tb-handle out" />
      {/* 用 visibility 而不是 display:none —— 后者会改变 webview 高度，
          跨 LOD 阈值时触发页面 reflow */}
      <div className="browser-bar" style={{ visibility: far ? 'hidden' : 'visible' }}>
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
      <div
        className="browser-body nodrag nowheel"
        ref={setBody}
        style={{ visibility: far ? 'hidden' : 'visible' }}
      >
        {/* **partition 必须给，而且必须一节点一个**。不给的话所有浏览器节点共用
            app 默认 session —— Cookie、localStorage、登录态全是一份。而"连线即授权"
            是**按节点**发的：agent 拿到自己那个节点的授权后，只要导航到你在另一个
            节点登录过的站，就直接继承了你的登录态，授权边界形同虚设。
            主进程的 will-attach-webview 会校验这个值的形状，不合规就落到一次性 session
            （见 index.ts）—— 那边才是真正的执法点，这里只是提供 id。
            代价：不同节点的登录态不再互通，删掉节点那份 profile 就成孤儿（暂不清理）。 */}
        <Webview
          ref={wvRef}
          src={data.url || 'about:blank'}
          partition={`persist:tbwv-${id}`}
          style={{ width: '100%', height: '100%' }}
        />
      </div>
    </div>
  )
}

export default memo(BrowserNodeImpl)
