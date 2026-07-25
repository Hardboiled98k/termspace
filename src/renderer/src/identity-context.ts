import { createContext } from 'react'

/* App 加载 identity 元数据（无 env 值），节点经 context 读取做下拉 */
export const IdentityContext = createContext<IdentityMeta[]>([])

/**
 * tmux 是否真的可用（装了 + 设置里开着）。
 * 折叠集群会卸载子节点 → PTY 客户端被释放；只有存在 tmux 会话时进程才活得下来。
 * 没有 tmux 时折叠 = 直接杀掉里面跑的东西，所以要据此禁用折叠。
 */
export const TmuxContext = createContext<boolean>(false)

/**
 * 节点请求删除自己 —— 统一交给画布处理：确认弹窗、撤回记录、连带删连线与子节点
 * 都在一处。节点自己 deleteElements 会绕过这些（之前就是这么丢数据的）。
 */
export const RequestDeleteContext = createContext<(ids: string[], label: string) => void>(
  () => {}
)
