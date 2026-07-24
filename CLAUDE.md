# TermBoard — 无限画布终端管理器

## 项目概述

终端不是叠 tab，是可拖拽节点铺在无限画布上（对标 nodeterm，从零自研，BUSL 无关）。
差异化方向：agent 状态发光边框（缩到全景看颜色分布即知哪个 agent 在等你）、太极协同可视化、中文市场。

- **当前阶段**: Day-1 POC — 验证 xterm 在缩放画布上的渲染可行性
- **技术栈**: Electron + electron-vite + React 19 + TS + Tailwind 4 + @xyflow/react 12 + @xterm/xterm 6 + node-pty
- **UI 规范**: 见 `DESIGN.md`（画布学 Figma、节点内部学 Warp、气质 Linear + 未来感 glow）

## 结构

```
src/
  main/index.ts        # Electron 主进程 + PTY 管理（spawn/write/resize/kill via IPC）
  preload/index.ts     # contextBridge 暴露 window.termboard
  renderer/src/
    App.tsx            # ReactFlow 画布 + 工具栏
    nodes/TerminalNode.tsx  # 终端节点（xterm + fit + webgl + LOD + ResizeObserver）
    styles.css         # 设计 token + 节点/工具栏样式
```

## 命令

```bash
npm run dev        # 开发模式
npm run typecheck  # tsc --noEmit
npm run rebuild    # node-pty 重编译（换 Electron 版本后必跑）
npm run dist       # 打包未签名 arm64 dmg → dist/TermBoard-*.dmg（118MB）
TERMBOARD_SHOT=/tmp/shot.png npm run dev  # 自检：6 秒后截图退出
TERMBOARD_PANEL=terminal npm run dev      # 自检：直接展开设置面板某分区
```

## 关键决策 / 坑

- **vite 锁 7.x**（electron-vite 5 不支持 vite 8）、**@vitejs/plugin-react 锁 5.x**（6 要 vite 8）
- **不用 React StrictMode** — dev 双跑 effect 会 spawn+kill pty 两次
- 终端区域必须 `nodrag nowheel` class，否则 React Flow 抢拖拽/滚轮
- LOD 阈值 zoom 0.35，占位层挂在 `.term-node-lod`
- **pty 已 tmux 续存**：socket `termboard`、会话 `tb-<nodeId>`、conf 在 userData（`destroy-unattached off` 是命根）。reload/HMR/app 退出=releasePty（会话活）；节点 ✕/换身份=destroyPty（kill-session）。调试残留：`tmux -L termboard ls / kill-server`
- deleteKeyCode=null：防误删节点杀 shell，删除走 ✕（已实现 destroy 语义）
- 启动状态推送必须走 renderer:ready 握手（首推早于订阅会竞态丢失）

## 路线图（详见 PRD.md）

1. ✅ POC：画布 + 双终端 + LOD + 状态 glow
2. ✅ M1：节点 CRUD（✕关闭/双击重命名/＋新增）、布局+视口 JSON 持久化
3. M2：hooks 真状态接入（**照 ARCHITECTURE-NOTES.md §3 设计**）+ context meter + 额度 HUD + 凭证管理
4. M3：集群（编组/群发/聚合状态）、多项目 tab
5. M4：tmux 续存（session 名约定已锁：socket `termboard` / `tb-<nodeId>`）、SSH 远程、打包

## 参考

- `ARCHITECTURE-NOTES.md` — nodeterm 架构调研提炼（持久化/tmux/状态系统），M2-M4 按此校准
- 参考仓库 `~/Desktop/code/_reference/nodeterm`（BUSL-1.1，只读思路，禁止抄代码）
