import { useStore } from '@xyflow/react'

/** 极远缩放阈值：低于此值节点退化成色块 + 恒定尺寸标签 */
export const FAR_ZOOM = 0.14

export function useZoom(): number {
  return useStore((s) => s.transform[2])
}

/**
 * 地图注记式标签：内部 ×(1/zoom)，再被画布 ×zoom → 屏幕尺寸恒定，
 * 缩到多小都读得清（节点本身此时只是个状态色块）。
 */
export function FarChip({
  zoom,
  dotClass,
  title,
  state,
  stateClass,
  extra
}: {
  zoom: number
  dotClass: string
  title: string
  state: string
  stateClass?: string
  extra?: string
}): React.JSX.Element {
  return (
    <div className="term-node-far">
      <div
        className="term-node-far-chip"
        style={{ transform: `translate(-50%, -50%) scale(${1 / zoom})` }}
      >
        <span className={`status-dot ${dotClass}`} />
        <span className="term-node-far-title">{title}</span>
        <span className={`term-node-far-state ${stateClass ?? ''}`}>{state}</span>
        {extra && <span className="term-node-far-ctx">{extra}</span>}
      </div>
    </div>
  )
}
