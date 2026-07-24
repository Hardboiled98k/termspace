import { createContext } from 'react'

/* App 加载 identity 元数据（无 env 值），节点经 context 读取做下拉 */
export const IdentityContext = createContext<IdentityMeta[]>([])
