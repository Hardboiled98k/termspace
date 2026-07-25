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
 * onOther 收非 pinch 的滚轮事件，交给调用方决定（比如 ⌥+滚轮 调字号、普通滚轮留给终端回滚）。
 */
export function usePinchZoom(
  onOther?: (e: WheelEvent) => void
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
        otherRef.current?.(e)
      }

      el.addEventListener('wheel', onWheel, { passive: false, capture: true })
      detach.current = () => el.removeEventListener('wheel', onWheel, true)
    },
    [getViewport, setViewport]
  )
}
