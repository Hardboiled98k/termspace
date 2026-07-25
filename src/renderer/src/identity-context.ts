import { createContext } from 'react'

/* App 加载 identity 元数据（无 env 值），节点经 context 读取做下拉 */
export const IdentityContext = createContext<IdentityMeta[]>([])

/**
 * tmux 是否真的可用（装了 + 设置里开着）。
 * 折叠集群会卸载子节点 → PTY 客户端被释放；只有存在 tmux 会话时进程才活得下来。
 * 没有 tmux 时折叠 = 直接杀掉里面跑的东西，所以要据此禁用折叠。
 */
export const TmuxContext = createContext<boolean>(false)
