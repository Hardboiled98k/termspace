import { useCallback } from 'react'
import { useReactFlow } from '@xyflow/react'

const MIN = 0.02
const MAX = 1.5

/**
 * 节点内容区（终端/浏览器/编辑器）会吞掉 wheel，导致 pinch 缩放在节点上失效。
 * 这个 handler 手动实现「以光标为不动点」的画布缩放，不依赖事件冒泡到 pane。
 * 返回的函数挂在节点内容区的 onWheel 上（capture 阶段更稳）。
 */
export function usePinchZoom(): (e: React.WheelEvent) => boolean {
  const { getViewport, setViewport } = useReactFlow()
  return useCallback(
    (e: React.WheelEvent): boolean => {
      // macOS 触控板 pinch = ctrlKey+wheel；不是 pinch 就不处理（留给内容滚动）
      if (!e.ctrlKey) return false
      e.preventDefault()
      e.stopPropagation()
      const vp = getViewport()
      const factor = Math.exp(-e.deltaY * 0.01) // 平滑缩放
      const next = Math.min(MAX, Math.max(MIN, vp.zoom * factor))
      if (next === vp.zoom) return true
      // 光标屏幕坐标（相对画布容器）为不动点
      const sx = e.clientX
      const sy = e.clientY
      const fx = (sx - vp.x) / vp.zoom
      const fy = (sy - vp.y) / vp.zoom
      setViewport({ x: sx - fx * next, y: sy - fy * next, zoom: next })
      return true
    },
    [getViewport, setViewport]
  )
}
