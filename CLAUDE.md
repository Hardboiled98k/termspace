# Termscape — 无限画布终端管理器

## 项目概述

终端不是叠 tab，是可拖拽节点铺在无限画布上（对标 nodeterm，从零自研，BUSL 无关）。
差异化方向：agent 状态发光边框（缩到全景看颜色分布即知哪个 agent 在等你）、太极协同可视化、中文市场。

- **当前阶段**: alpha（功能密度高，F1-F8 各有纵向切片；发布工程未就绪，不可外发）
- **技术栈**: Electron + electron-vite + React 19 + TS + Tailwind 4 + @xyflow/react 12 + @xterm/xterm 6 + node-pty
- **UI 规范**: 见 `DESIGN.md`（画布学 Figma、节点内部学 Warp、气质 Linear + 未来感 glow）

### 命名（2026-07-25 由 TermBoard 改为 Termscape）

改名只覆盖**品牌面**：appId `dev.termscape.app`、productName、窗口/页面标题、`window.termscape` bridge、文档。

以下 `termboard` 字面量**故意保留，不要"顺手统一"**——它们指向磁盘上已存在的数据或运行中的会话，改了就断：

| 保留项 | 改了会怎样 |
|--------|-----------|
| userData 目录 `~/Library/Application Support/termboard/` | 工作区/简报/凭证/预设全部孤儿化；活 tmux 会话里 `tb` 命令的 PATH 失效 |
| tmux socket `termboard` + 会话前缀 `tb-` | 所有续存中的会话瞬间变孤儿 |
| `TERMBOARD_*` 环境变量 | 已写进 `~/.claude/settings.json` 的 hook 命令与运行中会话的 env，改了 hook 全断 |
| `tb` 命令名、`.termboard-backup` 备份后缀、`x-termboard-token` 头 | 同上，都是已落地的外部契约 |

真要统一得配一次性迁移（重命名目录 + 重建 hook 配置 + 重建全部会话），目前不值。

## 结构

```
src/
  main/index.ts        # Electron 主进程 + PTY 管理（spawn/write/resize/kill via IPC）
  main/remote.ts       # 远程 API + 手机端静态托管（白名单，无路径拼接）
  main/net-iface.ts    # 绑定地址探测（回环 / Tailscale）+ Host 头白名单
  main/approval-policy.ts  # 审批规则引擎（纯代码，只出 require_human / deny）
  preload/index.ts     # contextBridge 暴露 window.termboard
  renderer/src/
    App.tsx            # ReactFlow 画布 + 工具栏
    nodes/TerminalNode.tsx  # 终端节点（xterm + fit + webgl + LOD + ResizeObserver）
    styles.css         # 设计 token + 节点/工具栏样式
mobile/                # 手机端 PWA：纯静态、无框架、无打包器，主进程按白名单直发
  index.html app.js style.css sw.js manifest.webmanifest icon.svg
```

## 命令

```bash
npm run dev        # 开发模式
npm run typecheck  # tsc --noEmit
npm test           # 派活准入 smoke test（Node 原生 type stripping，无框架依赖）
npm run rebuild    # node-pty 重编译（换 Electron 版本后必跑）
npm run dist       # 未签名 arm64 dmg（本机自用，随时可打）
npm run dist:signed  # 签名 + 公证正式包（需下面四个环境变量）
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
- **workspace 落盘必须原子**：tmp+rename + `.bak` + 损坏隔离。裸 writeFile 写一半被杀 =
  JSON 截断 → load 当成首次启动 → 画布归零，且随后 reap 把所有 tmux 会话当孤儿杀光
- **删节点必须连带删连线**：连线是授权图，节点 id 又复用（`nextIdFrom` 取 max+1），
  悬空连线 = 新节点白捡旧节点的授权
- **pinch 缩放要用原生 non-passive wheel 监听**：React 的 wheel 是 passive 委托，
  合成事件里 `preventDefault()` 是空操作
- **`<webview>` 远缩时不能卸载**：摘出 DOM = 浏览器会话销毁 + 注册表留死引用。
  学 TerminalNode：保持挂载 + `visibility:hidden`
- **派活是最危险的一段**：注入 = 替用户敲回车。只接受当前活着的 agent 会话
  （靠 session_id 挡 SessionEnd 之后的迟到事件），状态判定 fail-closed，改动后跑 `npm test`

## 手机端（2026-07-26）

`mobile/` 是纯静态页，由主进程的远程 API 用**固定白名单表**直发（`STATIC` in `remote.ts`），
不拼路径 → 从根上没有目录穿越。打包时靠 `electron-builder.yml` 的 `files: mobile/**/*`
收进 asar，运行时 `path.join(app.getAppPath(), 'mobile')` 读得到（已实测签名包）。

- **绑定只有两个选项：回环 / Tailscale 网卡。永远不要加 0.0.0.0。**
- **只判 CGNAT 网段是不够的（差点酿成 P0）**：100.64.0.0/10 是**共享**段，酒店/校园/
  运营商 DHCP 会直接把 100.71.x.x 发给物理网卡，而 `os.networkInterfaces()` 里 en0
  稳定排在 utun 前面 → 服务被绑到公共 Wi-Fi 上，界面还写着"只有你自己的设备看得见"。
  判据必须是 **CGNAT + /32 掩码 + 全零 MAC**（tun 口的形态），再用 `tailscale ip -4`
  在多张 tun 网卡时消歧。接口名不能用（utunN 的 N 每次变）
- Tailscale 没起来时**退回回环**并在设置里如实标「没找到」，绝不退到 en0
- **`http://100.x.x.x:7333` 不是浏览器的安全上下文** → `navigator.serviceWorker` 直接不存在。
  离线壳 / 安卓安装拿不到；iOS「添加到主屏幕」不受影响。要完整 PWA 得 Tailscale 后台开
  HTTPS 证书 + `tailscale serve --bg 7333`（那条路还更安全：本进程可以只绑回环）
- **手机端画布用「地图针」模型**：坐标跟缩放、节点尺寸不跟。照搬桌面的整体 scale 在
  390px 屏上缩放比会掉到 0.05，节点变成看不见的点 —— 画布的全部价值就是扫一眼看颜色
- 轮询而不是 SSE：`EventSource` 设不了 `Authorization` 头，硬用就得把 token 塞 query string
- 轮询回来要**比对签名再决定重不重建 DOM**：无脑重建会把用户的平移/缩放和「二次确认」
  的上膛态一起清掉
- 远程写操作只有两类（写终端 / 批准工具调用），各自独立开关，**没有 spawn/kill/destroy 路由**
- **脱敏只能有一个出口**：`approval-dto.ts` 的 `toPublicApproval()`。审批记录有两条外发路径
  （实时 publish / 快照 listApprovals），各写一份脱敏就漏了一条 —— 完整 `tool_input`
  曾因此进了 renderer 并从 `/api/events` 出网。逐字段构造，不是 spread-then-delete
- **开关要在 await 之后再查一遍**：读 body 是异步的，客户端可以在开关还开着时发头、
  拖住 body，等用户关掉之后再补完。落笔前必须重查
- **安全开关只能往收紧的方向失败**：关掉开关要**先**改内存再落盘。等落盘成功才生效的话，
  写盘一失败界面显示"只读"、实际 gate 仍是 true
- **手机端任何 await 之后都不能再读全局 `currentId`**：慢网下 A 的迟到响应会画到 B 上，
  用户看着 A 的问题、答案发进 B。目标 id 必须在发请求那一刻钉住并显式传下去

## 打包签名（已就绪，2026-07-26）

证书 `Developer ID Application: Nanjing Lonely Island Network Technology Co., Ltd. (85V88J2F3F)`
已装进登录钥匙串，有效期至 2031-07。公证走 App Store Connect API 密钥。

```bash
export APPLE_API_KEY=~/.appstoreconnect/private_keys/AuthKey_APPLE_KEY_ID.p8
export APPLE_API_KEY_ID=APPLE_KEY_ID
export APPLE_API_ISSUER=APPLE_ISSUER_ID
export APPLE_TEAM_ID=85V88J2F3F
npm run dist:signed
```

坑：
- **hardened runtime 必须配 entitlements**（`build/entitlements.mac.plist`），
  放行 V8 的 JIT 和 node-pty，否则签完能过公证但**一启动就崩**
- electron-builder 26 的 `notarize` 只收布尔值，teamId 走环境变量（写成对象直接 schema 报错）
- DMG 要单独 `notarytool submit` + `stapler staple`，electron-builder 只公证 .app
- 验收三连：`codesign --verify --deep --strict` / `spctl --assess --type execute`
  （要看到 `source=Notarized Developer ID`）/ `stapler validate`

## 授权模型（同 UID 前提，务必如实描述）

跨节点动作（`tb ask` / `tb browser`）走「连线即授权」+ 弹窗兜底。但所有终端与 app 同 UID，
任何进程都能 `tmux -L termboard send-keys` 直接驱动会话绕过全部检查 —— 所以这是**产品护栏
不是安全边界**。写文档、写注释、答用户都要这么说，别把它说成安全机制。

## 路线图（真实状态见 PRD.md「优先级排序」，那张表已重校）

M1–M6 与 F1–F8 均有可用实现；签名公证与手机端已完成。明确未做的是 **MCP 形态**
（F7/F8 现在走 `tb` + 回环 HTTP）、**非 Claude provider 的真状态与额度**、**记忆系统统筹**、
**手机端的完整 PWA / 后台推送**（受安全上下文与 Web Push 限制，见上）。

## 参考

- `ARCHITECTURE-NOTES.md` — nodeterm 架构调研提炼（持久化/tmux/状态系统），M2-M4 按此校准
- 参考仓库 `~/Desktop/code/_reference/nodeterm`（BUSL-1.1，只读思路，禁止抄代码）
