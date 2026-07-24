# 交接快照（2026-07-25，切换模型前）

## 状态

git 20 commits，`npm run typecheck` 干净。六大功能核心闭环 + 连线 v1。
读这三份进入状态：`CLAUDE.md`（结构/坑）、`PRD.md`（功能与排期）、`ARCHITECTURE-NOTES.md`（nodeterm 调研提炼）。

## 已完成

| 模块 | 说明 |
|------|------|
| 画布 | 无限（minZoom 0.02）、三级 LOD（正常/大标题/地图注记色块）、minimap 自动隐藏 |
| 终端 | tmux 续存（socket `termboard`/`tb-<id>`，release vs destroy 语义）、字号 ⌥滚轮+右键、Apple 深色 UI |
| 状态 | Claude hooks 真状态管线（loopback HTTP + endpoint 文件 + 四件套兜底）→ glow/胶囊 |
| 用量 | context meter（tail transcript）+ 额度 HUD（claude-usage.json，可折叠、多供应商结构就绪） |
| 凭证 | safeStorage Keychain，多身份，节点级切换 |
| 预设 | agent 节点预设（claude/codex/gemini/自定义 + 绑 identity） |
| 集群 | 框选成组 + 自动网格排列 + 聚合状态 |
| worker | cxcc-subagent(franke_skills MIT) 引擎，卡片显示/收结果/杀/回复 |
| 连线 | 简报→终端=按连线注入上下文（每简报一文件，可并联）；终端→终端=派活通道（已可画，执行端待 F8） |
| 交互 | 右键菜单（空白/节点）、图标工具栏、选中发光边框 |

## 下一步（按用户反馈优先级）

1. **F8 工具中枢 MCP**（架构级，PRD 有完整设计）— 一个 MCP 暴露 4-6 个元工具，三级渐进式披露 skill，常驻 ~400 token
2. **终端→终端派活执行端** — `delegate(target, task)` → pty.write 注入 → hooks Stop 感知完成 → tail transcript 取结果回传（基础设施已就绪）
3. **项目标签页 + cwd**（用户 #2/#6）— 一个标签 = 一个画布 + 一个工作目录，新终端继承；解决"终端只能在 ~ 起"的硬伤
4. **设置面板**（用户 #9）— 默认 shell/字号/tmux 开关/hooks 管理/skill 库管理/额度源
5. 上下文概念重命名为「项目简报」+ 节点级角色 instructions（用户 #5 的第二层）
6. 收尾：F1 群发命令、cold-restore scrollback、打包签名公证

## 调试备忘

```bash
npm run dev                              # 开发
TERMBOARD_SHOT=/tmp/x.png npm run dev    # 6 秒自检截图后退出
tmux -L termboard ls / kill-server       # 会话残留
~/Library/Application Support/termboard/ # workspace.json / contexts/ / identities.bin / hook-endpoint.env
```

坑：vite 锁 7.x、plugin-react 锁 5.x、不用 StrictMode、启动推送必须走 `renderer:ready` 握手。
用户 `~/.claude/settings.json` 已被合并 9 条 hook（备份 `.termboard-backup`，对非 TermBoard 终端 no-op）。
