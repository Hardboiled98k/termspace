import { useEffect, useState } from 'react'

type Section = 'general' | 'terminal' | 'presets' | 'identities' | 'hooks'

const SECTIONS: { key: Section; label: string }[] = [
  { key: 'general', label: '通用' },
  { key: 'terminal', label: '终端' },
  { key: 'presets', label: 'Agent 预设' },
  { key: 'identities', label: '凭证' },
  { key: 'hooks', label: 'Hooks 与状态' }
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
  const [hooks, setHooks] = useState<{ installed: boolean; settingsPath: string } | null>(null)
  const [skills, setSkills] = useState<{ name: string; description: string }[]>([])

  useEffect(() => {
    void window.termscape.getSettings().then(setS)
    void window.termscape.hooksStatus().then(setHooks)
    void window.termscape.listSkills().then(setSkills)
  }, [])

  const patch = (p: Partial<AppSettings>): void => {
    setS((cur) => (cur ? { ...cur, ...p } : cur))
    void window.termscape.setSettings(p).then(setS)
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
              <p className="settings-note">
                Termscape 在本机回环端口跑一个 hook 服务，Claude Code 通过它上报运行状态
                （运行中 / 需要你 / 空闲）。配置已合并进 <code>{hooks?.settingsPath}</code>
                ，原文件备份为同名 <code>.termboard-backup</code>。
                托管脚本对非 Termscape 终端会立即退出，不影响你在别处正常使用 Claude Code。
              </p>
              <h3 className="settings-h">数据位置</h3>
              <p className="settings-note">
                画布布局、简报、预设、凭证密文均在
                <code> ~/Library/Application Support/termboard/</code>。
                凭证经系统 Keychain 加密，明文不落盘。
              </p>
            </>
          )}
        </main>
      </div>
    </div>
  )
}

export type { Section as SettingsSection }
