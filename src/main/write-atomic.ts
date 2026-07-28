/**
 * 原子写 + **权限在创建那一刻就给**。
 *
 * 两条判据合在一个函数里，因为它们各自都被独立踩过：
 *
 * 1. **原子**：tmp + rename。裸 writeFile 写一半被杀 = 文件截断，
 *    而这些文件（hook 配置、token 表）截断后往往被当成"没有"而不是"坏了"。
 * 2. **权限**：`writeFile` 用默认权限（umask 022 → **0644**）创建，
 *    rename 之后到 chmod 之前那个文件是**全局可读**的。窗口只有几毫秒，
 *    但监听目录事件就能守到 —— `bin/tb-peer` 的正文里带着完整 peer token，
 *    远程 token 表能直接拿来打回环 API。不能靠"太短了没事"。
 *
 * 单独成文件是因为 remote-tokens.ts 也要用它，而它必须能被 `node --test` 跑到
 * （只依赖 fs，不碰 electron）—— hooks.ts 里那份进不来。
 */
import { writeFile, chmod, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

export async function writeAtomic(file: string, content: string, mode?: number): Promise<void> {
  // 临时文件名带随机后缀：两个写者若撞在一起，固定名会互相覆盖或 rename ENOENT
  const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`
  await writeFile(tmp, content, mode === undefined ? undefined : { mode })
  /* writeFile 的 mode 会被 umask 掩掉（0600 遇到更严的 umask 会更小 —— 那是
     往收紧方向，可以接受）。反过来若临时文件**已存在**，writeFile 完全不改它的
     权限，所以还要显式 chmod 一次兜底。 */
  if (mode !== undefined) await chmod(tmp, mode)
  await rename(tmp, file)
}
