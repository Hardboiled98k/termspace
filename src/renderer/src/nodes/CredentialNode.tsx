import { useContext, useEffect, useState } from 'react'
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'
import { IdentityContext } from '../identity-context'
import { useZoom, FAR_ZOOM, FarChip } from './FarChip'

/**
 * 凭证节点 —— 账号在画布上的实体。
 *
 * 为什么值得占一个节点：额度的归属单位是**账号**（见 docs/QUOTA.md），
 * 而"哪个终端在用哪个号"以前只能一个个点开节点头部的下拉去看。
 * 拉一条线过去就能看见，是这张画布本来就在做的事（连线即语义）。
 *
 * 三件事必须在节点上说清楚，否则会造出个坑：
 * 1. **连线 ≠ 自动登录**。CODEX_HOME / CLAUDE_CONFIG_DIR 只负责隔离，
 *    指向新目录时那个号是空的，第一次仍要在终端里跑 `codex login`。
 *    所以这里显示登录态 —— 未登录直接写"去终端里跑 codex login"。
 * 2. **换凭证会杀掉会话重开**（identityId 变更即 destroy + respawn），
 *    所以连线动作在 App 那边会先确认，不是拉一下就默默重启用户的活。
 * 3. **绝不显示 env 值**。渲染层本来就只拿得到 envKeys，这里也只列键名。
 */
export type CredentialNodeType = Node<
  { identityId?: string; title?: string },
  'credential'
>

const STATE_TEXT: Record<string, string> = {
  in: '已登录',
  out: '未登录',
  unknown: '登录态未知'
}

export function CredentialNode({ id, data, selected }: NodeProps<CredentialNodeType>): React.JSX.Element {
  const identities = useContext(IdentityContext)
  const zoom = useZoom()
  const me = identities.find((i) => i.id === data.identityId)
  const [login, setLogin] = useState<{ state: string; detail: string; home?: string } | null>(null)

  useEffect(() => {
    if (!data.identityId) return
    let alive = true
    const pull = (): void => {
      void window.termspace.identityLoginStatus(data.identityId as string).then((s) => {
        if (alive) setLogin(s)
      })
    }
    pull()
    // 登录态变化很慢（人去登一次），60s 一拍足够；codex login status 是只读、不花额度
    const t = setInterval(pull, 60_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [data.identityId])

  const name = me?.name ?? '（凭证已删除）'
  const state = login?.state ?? 'unknown'

  if (zoom < FAR_ZOOM) {
    return (
      <>
        <FarChip
          zoom={zoom}
          dotClass={state === 'in' ? 'running' : state === 'out' ? 'attention' : 'idle'}
          title={name}
          state={STATE_TEXT[state]}
        />
        <Handle type="source" position={Position.Right} />
      </>
    )
  }

  return (
    <div className={`cred-node${selected ? ' selected' : ''}`} data-login={state}>
      <div className="cred-head">
        <span className={`identity-provider ${me?.provider ?? 'custom'}`}>
          {me?.provider ?? '?'}
        </span>
        <span className="cred-name" title={name}>
          {name}
        </span>
      </div>
      <div className="cred-login" title={login?.detail}>
        <span className={`status-dot ${state === 'in' ? 'running' : state === 'out' ? 'attention' : 'idle'}`} />
        {STATE_TEXT[state]}
      </div>
      {login?.home && (
        <div className="cred-home" title={login.home}>
          {login.home.replace(/^\/Users\/[^/]+/, '~')}
        </div>
      )}
      {me && me.envKeys.length > 0 && (
        /* 只列键名。值在主进程里加密存着，渲染层根本拿不到 —— 别改成显示值 */
        <div className="cred-keys">{me.envKeys.join(' · ')}</div>
      )}
      {state === 'out' && (
        /* 按 provider 说该跑哪条命令。写死 codex 的话，claude 凭证上会显示
           一条在那个终端里根本不存在的命令 */
        <div className="cred-hint">
          {me?.provider === 'claude'
            ? '在连着的终端里跑一次 claude 并登录'
            : `在连着的终端里跑一次 ${me?.provider ?? 'codex'} login`}
        </div>
      )}
      {!data.identityId && <div className="cred-hint">右键选一个凭证</div>}
      {/* 只出不进：凭证是被终端用的，不接受任何入边 */}
      <Handle type="source" position={Position.Right} id={`${id}-out`} />
    </div>
  )
}
