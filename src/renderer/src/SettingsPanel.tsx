import { useEffect, useMemo, useState } from 'react'
import qrcode from 'qrcode-generator'

type Section = 'general' | 'terminal' | 'presets' | 'identities' | 'hooks' | 'remote'

/**
 * 配对二维码。手机扫一下就带着 token 进去了 —— 32 位十六进制 token 手打一次
 * 就足以让人放弃这个功能。
 *
 * 自己画 SVG 而不是用库的 createSvgTag()：那个返回 HTML 字符串，
 * 要 dangerouslySetInnerHTML 才能塞进 React，为了一张二维码不值当开那个口子。
 */
function PairQR({ url }: { url: string }): React.JSX.Element | null {
  const path = useMemo(() => {
    if (!url) return null
    // 纠错级 M：链接不长，M 足够；再高只会让码变密、更难扫
    const qr = qrcode(0, 'M')
    qr.addData(url)
    qr.make()
    const n = qr.getModuleCount()
    let d = ''
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) d += `M${c},${r}h1v1h-1z`
      }
    }
    return { d, n }
  }, [url])
  if (!path) return null
  // 留 2 格静区，不然某些扫码器识别不了
  const q = 2
  return (
    <svg
      className="settings-qr"
      viewBox={`${-q} ${-q} ${path.n + q * 2} ${path.n + q * 2}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="配对二维码"
    >
      <rect x={-q} y={-q} width={path.n + q * 2} height={path.n + q * 2} fill="#fff" />
      <path d={path.d} fill="#000" />
    </svg>
  )
}

const SECTIONS: { key: Section; label: string }[] = [
  { key: 'general', label: '通用' },
  { key: 'terminal', label: '终端' },
  { key: 'presets', label: 'Agent 预设' },
  { key: 'identities', label: '凭证' },
  { key: 'hooks', label: 'Hooks 与状态' },
  { key: 'remote', label: '远程访问' }
]

export function SettingsPanel({
  initial,
  onClose,
  renderPresets,
  renderIdentities
}: {
  initial: Section
  onClose: () => void
  renderPresets: () => React.JSX.Element
  renderIdentities: () => React.JSX.Element
}): React.JSX.Element {
  const [section, setSection] = useState<Section>(initial)
  const [s, setS] = useState<AppSettings | null>(null)
  const [hooks, setHooks] = useState<{
    installed: boolean
    settingsPath: string
    consent: 'ask' | 'on' | 'off'
  } | null>(null)
  const [skills, setSkills] = useState<{ name: string; description: string }[]>([])
  const [doctor, setDoctor] = useState<
    { key: string; label: string; ok: boolean; detail: string; hint: string }[]
  >([])
  /** 设置落盘失败的原因。静默失败 = 用户以为改好了，其实没有 */
  const [saveErr, setSaveErr] = useState('')
  const [remote, setRemote] = useState<Awaited<
    ReturnType<typeof window.termscape.remoteStatus>
  > | null>(null)

  useEffect(() => {
    void window.termscape.getSettings().then(setS)
    void window.termscape.hooksStatus().then(setHooks)
    void window.termscape.listSkills().then(setSkills)
    void window.termscape.doctor().then(setDoctor)
    void window.termscape.remoteStatus().then(setRemote)
  }, [])

  const patch = (p: Partial<AppSettings>): void => {
    const before = s
    setS((cur) => (cur ? { ...cur, ...p } : cur)) // 乐观更新，控件不卡手
    void window.termscape.setSettings(p).then(setS, (e) => {
      // 失败必须回滚：勾选框停在新状态、实际没生效，是最难查的一类"看着好了"
      setS(before)
      setSaveErr(String((e as { message?: string })?.message ?? e))
    })
  }

  return (
    <div className="identity-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <aside className="settings-nav">
          <div className="settings-nav-title">设置</div>
          {SECTIONS.map((x) => (
            <button
              key={x.key}
              className={`settings-nav-item${section === x.key ? ' active' : ''}`}
              onClick={() => setSection(x.key)}
            >
              {x.label}
            </button>
          ))}
        </aside>
        <main className="settings-body">
          {saveErr && (
            <p className="settings-note settings-err">
              设置没能保存：<code>{saveErr}</code>　刚才那一项已回滚，磁盘/权限修好后再试。
            </p>
          )}
          <button className="term-node-close settings-close" onClick={onClose}>
            ✕
          </button>

          {section === 'general' && s && (
            <>
              <h3 className="settings-h">通用</h3>
              <label className="settings-row">
                <span>新终端默认字号</span>
                <input
                  type="number"
                  min={8}
                  max={24}
                  value={s.defaultFontSize}
                  onChange={(e) => patch({ defaultFontSize: Number(e.currentTarget.value) })}
                />
              </label>
              <p className="settings-note">
                单个终端可用 ⌥+滚轮 或右键菜单单独调整，不影响此默认值。
              </p>
              <h3 className="settings-h">工具中枢 · Skill 库（{skills.length}）</h3>
              <p className="settings-note">
                画布上每个终端都自带 <code>tb</code> 命令：agent 跑 <code>tb skills 关键词</code>{' '}
                搜工具、<code>tb load 名称</code> 取全文、<code>tb agents</code> 看同伴。
                常驻上下文里只有一句路由提示（约 60 token），工具全文按需拉取——
                不用把 skill 规则塞满每个 agent。默认扫描 <code>~/.claude/skills</code>。
              </p>
              <div className="skill-list">
                {skills.slice(0, 40).map((sk) => (
                  <div key={sk.name} className="skill-row">
                    <span className="skill-name">{sk.name}</span>
                    <span className="skill-desc">{sk.description}</span>
                  </div>
                ))}
                {skills.length === 0 && (
                  <div className="identity-empty">
                    ~/.claude/skills 下没扫到 skill（需 &lt;skill&gt;/SKILL.md 结构）
                  </div>
                )}
              </div>
            </>
          )}

          {section === 'terminal' && s && (
            <>
              <h3 className="settings-h">终端</h3>
              <label className="settings-row">
                <span>默认 Shell</span>
                <input
                  placeholder="留空 = 跟随 $SHELL"
                  value={s.defaultShell}
                  onChange={(e) => patch({ defaultShell: e.currentTarget.value })}
                />
              </label>
              <label className="settings-row">
                <span>tmux 会话续存</span>
                <input
                  type="checkbox"
                  checked={s.tmuxEnabled}
                  onChange={(e) => patch({ tmuxEnabled: e.currentTarget.checked })}
                />
              </label>
              <p className="settings-note">
                开启后终端在 app 重启、reload 后自动接回原会话，跑着的进程不断；关闭 ✕
                节点才真正结束。关掉此项则退回普通 shell（无续存）。改动对新建/重开的终端生效。
              </p>
              <label className="settings-row">
                <span>回滚行数</span>
                <input
                  type="number"
                  min={500}
                  max={100000}
                  step={1000}
                  value={s.scrollback}
                  onChange={(e) => patch({ scrollback: Number(e.currentTarget.value) })}
                />
              </label>
            </>
          )}

          {section === 'presets' && renderPresets()}
          {section === 'identities' && renderIdentities()}

          {section === 'hooks' && (
            <>
              <h3 className="settings-h">Agent 状态 Hooks</h3>
              <div className="settings-row">
                <span>状态服务</span>
                <span className={`status-chip ${hooks?.installed ? 'running' : 'attention'}`}>
                  {hooks?.installed ? '运行中' : '未启动'}
                </span>
              </div>
              <div className="settings-row">
                <span>写入 ~/.claude/settings.json</span>
                <span className={`status-chip ${hooks?.consent === 'on' ? 'running' : 'idle'}`}>
                  {hooks?.consent === 'on' ? '已授权' : hooks?.consent === 'off' ? '未授权' : '未询问'}
                </span>
                {hooks?.consent === 'on' && (
                  <button
                    className="group-act"
                    title="从 ~/.claude/settings.json 摘掉 Termscape 的 hook 条目"
                    onClick={() => {
                      void window.termscape.uninstallHooks().then(() => {
                        void window.termscape.hooksStatus().then(setHooks)
                      })
                    }}
                  >
                    卸载
                  </button>
                )}
              </div>
              <p className="settings-note">
                Termscape 在本机回环端口跑一个 hook 服务，Claude Code 通过它上报运行状态
                （运行中 / 需要你 / 空闲），工具调用审批也走这条通道回到画布上。配置合并进{' '}
                <code>{hooks?.settingsPath}</code>，原文件首次备份为同名{' '}
                <code>.termboard-backup</code>。
                托管脚本对非 Termscape 终端会立即退出，不影响你在别处正常使用 Claude Code。
                卸载后需重启应用才会完全停止上报。
              </p>

              <h3 className="settings-h">依赖体检</h3>
              {doctor.map((d) => (
                <div className="settings-row" key={d.key}>
                  <span>{d.label}</span>
                  <span className={`status-chip ${d.ok ? 'running' : 'attention'}`}>
                    {d.ok ? '正常' : '缺失'}
                  </span>
                  <span className="settings-doctor-detail" title={d.hint}>
                    {d.ok ? d.detail : d.hint}
                  </span>
                </div>
              ))}

              <h3 className="settings-h">数据位置</h3>
              <p className="settings-note">
                画布布局、简报、预设、凭证密文均在
                <code> ~/Library/Application Support/termboard/</code>。
                凭证经系统 Keychain 加密，明文不落盘。
              </p>
            </>
          )}

          {section === 'remote' && s && (
            <>
              <h3 className="settings-h">远程访问</h3>
              <label className="settings-row">
                <span>开启远程 API</span>
                <input
                  type="checkbox"
                  checked={s.remoteEnabled}
                  onChange={(e) => patch({ remoteEnabled: e.currentTarget.checked })}
                />
                <span className={`status-chip ${remote?.running ? 'running' : 'idle'}`}>
                  {remote?.running ? '运行中' : '未启动'}
                </span>
              </label>
              {/* 开着却没起来必须给原因：只有一个"未启动"的话，端口被占的人无从下手 */}
              {!remote?.running && s.remoteEnabled && remote?.error && (
                <p className="settings-note settings-err">
                  启动失败：<code>{remote.error}</code>
                  {remote.error.includes('EADDRINUSE') &&
                    `　端口 ${remote.port} 被别的程序占了，换一个再重启。`}
                </p>
              )}
              <p className="settings-note">
                开启后手机 / 其他电脑可以看画布、看终端输出、处理审批。改动需重启应用生效。
              </p>

              <label className="settings-row">
                <span>允许远程写入终端</span>
                <input
                  type="checkbox"
                  checked={s.remoteAllowInput}
                  onChange={(e) => patch({ remoteAllowInput: e.currentTarget.checked })}
                />
                <span className={`status-chip ${s.remoteAllowInput ? 'attention' : 'idle'}`}>
                  {s.remoteAllowInput ? '可写入' : '只读'}
                </span>
              </label>
              <p className="settings-note">
                关闭时远程端只能看和审批，不能往终端敲字。写入等于把 shell 交出去，按需再开。
                这一项改完立刻生效。
              </p>

              <label className="settings-row">
                <span>允许远程批准工具调用</span>
                <input
                  type="checkbox"
                  checked={s.remoteAllowApprove}
                  onChange={(e) => patch({ remoteAllowApprove: e.currentTarget.checked })}
                />
                <span className={`status-chip ${s.remoteAllowApprove ? 'attention' : 'idle'}`}>
                  {s.remoteAllowApprove ? '可批准' : '不可批准'}
                </span>
              </label>
              <p className="settings-note">
                和"写入终端"分开控制：批准一次工具调用（可能是 rm -rf / git push --force）
                比敲一行字危险得多。关闭时远程端只能看审批内容，决定权留在这台机器上。
              </p>

              <label className="settings-row">
                <span>端口</span>
                <input
                  type="number"
                  min={1024}
                  max={65535}
                  value={s.remotePort}
                  onChange={(e) => patch({ remotePort: Number(e.currentTarget.value) })}
                />
              </label>

              <label className="settings-row">
                <span>监听网卡</span>
                <select
                  value={s.remoteBind}
                  onChange={(e) =>
                    patch({ remoteBind: e.currentTarget.value as AppSettings['remoteBind'] })
                  }
                >
                  <option value="loopback">仅本机（127.0.0.1）</option>
                  <option value="tailscale">Tailscale 网卡（手机可连）</option>
                </select>
                {remote?.fellBack && <span className="status-chip error">没找到 Tailscale</span>}
              </label>
              <p className="settings-note">
                只有这两个选项，<b>没有 0.0.0.0</b>：这个进程能开终端、读写文件、持有你的
                模型凭证，监听到公共 Wi-Fi 上等于把整台机器交出去。tailnet 是 WireGuard +
                设备认证的私有网络，绑它等于只让你自己的设备看得见这个端口。
                选了 Tailscale 却显示"没找到"，就是 Tailscale 没登录/没启动，
                此时会安全退回仅本机，不会偷偷开到别的网卡上。改动需重启应用生效。
              </p>

              {remote?.running && (
                <>
                  <div className="settings-row">
                    <span>地址</span>
                    <code className="settings-doctor-detail">
                      http://{remote.bind}:{remote.port}
                    </code>
                  </div>
                  <div className="settings-row">
                    <span>配对 token</span>
                    <code
                      className="settings-doctor-detail"
                      title="删除 userData/remote-token 可重新生成"
                    >
                      {remote.token}
                    </code>
                  </div>
                  <div className="settings-qr-row">
                    <PairQR url={remote.pairUrl} />
                    <div>
                      <p className="settings-note">
                        手机扫这个码直接进手机端页面，token 自动带上。
                        {remote.bind === '127.0.0.1' && (
                          <>
                            <br />
                            <b>当前只绑了本机，手机扫了也连不上</b> —— 上面「监听网卡」
                            改成 Tailscale 再重启。
                          </>
                        )}
                      </p>
                      <button
                        className="settings-btn"
                        onClick={() => void navigator.clipboard.writeText(remote.pairUrl)}
                      >
                        复制配对链接
                      </button>
                    </div>
                  </div>
                </>
              )}

              <h3 className="settings-h">怎么从外面连</h3>
              <p className="settings-note">
                装 <code>Tailscale</code>（WireGuard + 设备认证），手机加入同一个 tailnet，
                上面「监听网卡」选 Tailscale，重启后扫码即可。走蜂窝网也一样能连。
                <br />
                手机端页面就是这台机器发的（<code>/</code> 路由），API 请求头带
                <code> Authorization: Bearer &lt;token&gt;</code>。
                怀疑 token 泄露就删掉 <code>userData/remote-token</code> 重启，会重新生成，
                旧手机随即失效。
                <br />
                注意 tailnet 里被共享进来的其他人的设备也能打到这个端口 —— 真要隔离，
                在 Tailscale 后台用 ACL 限制到你自己的设备。
              </p>

              <h3 className="settings-h">想要完整 PWA（离线壳 / 安卓可安装）</h3>
              <p className="settings-note">
                直连 <code>http://100.x.x.x:7333</code> 不是浏览器认的「安全上下文」，
                Service Worker 根本不存在 —— 所以离线壳和安卓的「安装应用」拿不到。
                <b>iOS 的「添加到主屏幕」不受影响</b>，现在就能用。
                <br />
                要完整 PWA：Tailscale 后台打开 HTTPS 证书，然后跑{' '}
                <code>tailscale serve --bg {remote?.port ?? s.remotePort}</code>，
                改用 <code>https://&lt;机器名&gt;.ts.net</code> 访问。
                这条路还更安全 —— 此时「监听网卡」可以留在<b>仅本机</b>，
                由 Tailscale 从 tailnet 转发到回环，本进程一个对外端口都不开。
              </p>
            </>
          )}
        </main>
      </div>
    </div>
  )
}

export type { Section as SettingsSection }
