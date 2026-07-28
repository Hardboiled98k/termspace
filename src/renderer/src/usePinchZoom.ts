import { useCallback, useRef } from 'react'
import { useReactFlow } from '@xyflow/react'

const MIN = 0.02
const MAX = 1.5

/**
 * 节点内容区（终端/浏览器/编辑器）会吞掉 wheel，pinch 缩放在节点上就失效了。
 * 这里手动实现「以光标为不动点」的画布缩放。
 *
 * 必须用**原生 non-passive** 监听：React 把 wheel 注册成 passive 委托监听，
 * 合成事件里的 preventDefault() 是空操作，挡不住 Chromium 自己的 ctrl+wheel 缩放。
 *
 * 返回一个 ref 回调，挂到内容区元素上即可（元素换掉/卸载时自动重挂、解绑）。
 * onOther 收非 pinch 的滚轮事件，交给调用方决定（比如 ⌥+滚轮 调字号）。
 *
 * **指针在节点内容上时，普通滚轮永远归内容，绝不平移画布。**
 * 曾经这里做过"滚动链"：终端还能回滚就归终端，滚到头了交给画布平移 ——
 * 听起来合理，实际是每天都在烦人的一个设计错误：新开的 shell 没有回滚历史，
 * `canUp`/`canDown` 立刻都是 false，于是**每一次滚动都在平移画布**，
 * 用户想滚的是终端里的内容。浏览器节点更彻底（压根没传 onOther），
 * 任何滚轮都在平移画布。
 *
 * 现在的判据简单到无需记忆：**指针在哪就滚哪**。
 * 要平移画布就把指针移到空白处 —— 那里本来就没有别的语义在竞争。
 */
export function usePinchZoom(
  /**
   * 非 pinch 的滚轮交给调用方。返回 true = 已消费并已自行 preventDefault；
   * 返回 false/undefined = 不管它，**让事件继续往下走给内容**（xterm / webview 等）。
   */
  onOther?: (e: WheelEvent) => boolean | void
): (el: HTMLElement | null) => void {
  const { getViewport, setViewport } = useReactFlow()
  const otherRef = useRef(onOther)
  otherRef.current = onOther
  const detach = useRef<() => void>(() => {})

  return useCallback(
    (el: HTMLElement | null): void => {
      detach.current()
      detach.current = () => {}
      if (!el) return

      const onWheel = (e: WheelEvent): void => {
        // macOS 触控板 pinch = ctrlKey + wheel
        if (e.ctrlKey) {
          e.preventDefault()
          e.stopPropagation()
          const vp = getViewport()
          const factor = Math.exp(-e.deltaY * 0.01) // 平滑缩放
          const next = Math.min(MAX, Math.max(MIN, vp.zoom * factor))
          if (next === vp.zoom) return
          // 光标屏幕坐标为不动点
          const fx = (e.clientX - vp.x) / vp.zoom
          const fy = (e.clientY - vp.y) / vp.zoom
          setViewport({ x: e.clientX - fx * next, y: e.clientY - fy * next, zoom: next })
          return
        }
        /* 调用方消费了就到此为止；没消费就**什么都不做** ——
           不 preventDefault、不 stopPropagation，让事件自然落到内容上
           （xterm 监听在子元素 .xterm 上，webview 由 guest 进程自己处理）。
           内容滚不动时就是没反应，这和原生应用一致，也比"突然整个画布飞走"好。 */
        otherRef.current?.(e)
      }

      el.addEventListener('wheel', onWheel, { passive: false, capture: true })
      detach.current = () => el.removeEventListener('wheel', onWheel, true)
    },
    [getViewport, setViewport]
  )
}
