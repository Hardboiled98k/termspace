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

  useEffect(() => {
    void window.termboard.getSettings().then(setS)
    void window.termboard.hooksStatus().then(setHooks)
  }, [])

  const patch = (p: Partial<AppSettings>): void => {
    setS((cur) => (cur ? { ...cur, ...p } : cur))
    void window.termboard.setSettings(p).then(setS)
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
              <h3 className="settings-h">Skill 库（F8 工具中枢）</h3>
              <p className="settings-note">
                将在这里管理供全部 agent 共用的 skill 目录，通过单个 MCP
                渐进式披露，避免把规则塞满每个 agent 的上下文。当前版本尚未启用。
              </p>
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
                TermBoard 在本机回环端口跑一个 hook 服务，Claude Code 通过它上报运行状态
                （运行中 / 需要你 / 空闲）。配置已合并进 <code>{hooks?.settingsPath}</code>
                ，原文件备份为同名 <code>.termboard-backup</code>。
                托管脚本对非 TermBoard 终端会立即退出，不影响你在别处正常使用 Claude Code。
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
