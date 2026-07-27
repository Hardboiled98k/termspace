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
- **删节点必须连带删连线**：连线是授权图，悬空连线 = 新节点白捡旧节点的授权
- **节点 id 不可复用**（`board-serde.ts` 的 `newNodeId`，形如 `t-7k3f9a`）。
  老实现是 `max+1`，删掉 `t7` 再建一个还叫 `t7` —— 而 nodeId 同时是 **tmux 会话名
  `tb-<id>`、scrollback 文件名、上下文文件名、hook token 文件名、pty 表的键、授权图的键**，
  一复用这六条链路一起串台。代码里为此写过四处补偿逻辑，前提都是"复用发生在删除之后"。
  ⚠️ **老工作区里的 `t1`/`b3` 还在**，那四处补偿要留着；改 id 格式时必须同步核对
  `src/main/index.ts` 的 `NODE_ID_RE`（两处必须一致，不一致 = 终端静默起不来）
  和 `tmux.ts` 的 `sessionName` 字符替换（被替换 = 两个 id 撞同一个会话）
- **pinch 缩放要用原生 non-passive wheel 监听**：React 的 wheel 是 passive 委托，
  合成事件里 `preventDefault()` 是空操作
- **WebGL context 上限已实测，不用再猜**：`TERMBOARD_WEBGL_STRESS=20 npm run dev`
  → 20 个终端里 16 个拿到 context、4 个直接走 DOM renderer；再打爆 → 16 次 contextlost
  → 全部落回 DOM 且**字还在**。这条路不用改。
  ⚠️ 复测时**必须等满 6 秒**：addon 收到 `webglcontextlost` 后会先等 3 秒看 context
  自己恢不恢复，之后才 fire `onContextLoss`。窗口短于 3s 会量出"降级失效"的假结论
- **`term.loadAddon()` 抛错后要显式 `dispose()`**：AddonManager 是 `_addons.push()`
  之后才 `activate()`，激活失败的 addon 仍留在列表里，`term.dispose()` 时还会被再调一次
- **ResizeObserver 里尺寸为 0 时不能 fit**：会把 cols/rows 算成 1×1 并真发给 pty，
  shell 照着重排一遍输出。元素 `display:none` / 折叠 / 未布局都会走到这条路
- **LOD 的账记在 GPU 上，不在 renderer 上**（`TERMBOARD_LOD_BENCH=16 npm run dev`）：
  16 个终端持续输出时，缩到 LOD 让 **GPU 6.1% → 1.1%**，而 **renderer 1.8% → 1.6% 几乎不动**
  —— `visibility:hidden` 省掉了合成绘制，但 xterm 照常解析和渲染。
  codex 建议做 WebGL lease pool（只给可见+活跃的 N 个上 WebGL），**先不做**：
  16 个终端满负荷才 2% renderer，没有要解决的问题。真到卡了再按这个数复量
- **`<webview>` 远缩时不能卸载**：摘出 DOM = 浏览器会话销毁 + 注册表留死引用。
  学 TerminalNode：保持挂载 + `visibility:hidden`
- **派活是最危险的一段**：注入 = 替用户敲回车。只接受当前活着的 agent 会话
  （靠 session_id 挡 SessionEnd 之后的迟到事件），状态判定 fail-closed，改动后跑 `npm test`
- **任务正文必须过 `sanitizeTask` 才能落笔**（在 delegate 里收口，所有调用方共用）。
  所有闸都在 `writeToPty` **之前**查，而载荷在 write **之后**起作用 —— 顺序天生错开：
  `\x03`/`\x04`/`\x1a` 是 agent TUI 的退出键，agent 一退，队列里剩下的字节就由
  重新拿回终端的 shell 读走。这不是提权（调用方本来就有 shell 权限），
  挡的是**上游 agent 被提示词注入**后，把「给一个有审批闸的 agent 发提示词」
  降级成「在目标终端裸跑 shell 命令」—— 而控制字符在授权弹窗里根本不可见
- **完成判定要认 transcript 文件有没有换**：换了 = 换了会话，这个 Stop 不是本轮的。
  老写法在文件变了时把偏移**归零**再读整份 —— 于是目标中途退出重开、新会话随便
  产生一个 Stop，就会**把新会话的回答当成本轮结果返回**。
  ⚠️ 判据用 path 不用 epoch：`SessionEnd` 自己也推进 epoch，而"答完就退出"
  是完全正常的一轮，判 epoch 会误杀合法答案
- **检查和落笔之间只要还有 await，就得在落笔那一刻再查一遍**：授权复查在
  前台探测和 stat **之前**，这两步各一个 await，足够 agent 退出 —— 那时 pane 里是
  光秃秃的 shell，`writeToPty` 就是直接执行命令。同类的还有 remote.ts 的"读 body
  是异步的，开关要在 await 之后重查"。
  `DelegateDeps.finalGate` 就是为此存在（跨机那条链路的开关在这里再查一次）；
  **`finalGate` 到 `writeToPty` 之间不许再出现任何 await**
- **敏感文件的权限必须在创建那一刻就给**，不能"先写完再 chmod"：`writeFile` 用默认
  权限（umask 022 → 0644），rename 之后到 chmod 之前那个文件是**全局可读**的。
  `bin/tb-peer` 的正文里带着完整 peer token、`nodetokens/*` 能伪造 SessionStart
  （而 SessionStart 在 delegate 的状态机里先于墓碑、无条件置活）。
  窗口只有几毫秒，但监听目录事件就能守到
- **必须有单实例锁**（`app.requestSingleInstanceLock`）：dev 和打包版共用同一个
  userData（有意为之，换目录会让所有 tmux 会话变孤儿），同时开两个就会 workspace.json
  互相整份覆盖、reap 把对方的会话当孤儿杀光、hook/远程端口抢不到。
  用 `app.exit()` 不用 `app.quit()` —— quit 要等 will-quit，这中间 whenReady
  会先建出第二个窗口，而窗口一挂载就开始读 workspace 并起防抖保存

## 同机多订阅账号（2026-07-26）

同一条 `codex` / `claude` 命令，两个终端节点登两个不同的订阅号 —— 靠 identity env 包：

| CLI | 隔离开关 | 实测 |
|-----|---------|------|
| codex | `CODEX_HOME` | 换目录后 `codex login status` → `Not logged in` |
| claude | `CLAUDE_CONFIG_DIR` | 换目录后 `claude -p` → `Not logged in · Please run /login` |

流程：凭证面板点模板 → 保存 → 节点凭证下拉里选 → 在那个终端跑一次 `codex login`。

三个坑，都已在代码里处理，改动前先看：

- **`KEY=`（空值）语义是删掉这个变量**，不是设成空串。用户 shell 里 export 的
  `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` 会被 app 继承，CLI 优先走按量计费 ——
  订阅号白开且账单不吭声。真 unset 用 `/usr/bin/env -u`（tmux 的 `-e KEY=` 只给空串，实测）
- **tmux server 长寿共享，没给 `-e` 的变量继承 server 启动时的环境**。所以转发范围
  必须是「identity 显式声明的键 ∪ provider 前缀」，**不能只按前缀猜** ——
  `OPENAI_*` 一度不在前缀表里，identity 里配 `OPENAI_API_KEY` 开着 tmux 就静默不生效
- **env 值不过 shell**，`~/` 和 `$HOME/` 要自己展开，否则 codex 会真建一个叫 `~` 的目录
- identity env **不许覆盖 `TERMBOARD_*`**（会让该节点的状态/派活哑掉）；若它改写了 `PATH`，
  要把 `tb` 的目录重新顶回最前

## 额度采集（2026-07-27）

`src/main/quota/` —— **一个账号一个采集器**，全局单例拉一次广播给所有节点（额度是账号级的，
绝不每节点各拉）。5 分钟一轮。完整调研见 `docs/QUOTA.md` 与 `docs/QUOTA-PLAN.md`。

- **Claude**：`GET https://api.anthropic.com/api/oauth/usage`，token 从钥匙串取。
  必须 `execFile('/usr/bin/security')` —— 那条记录的 ACL 信任的是 security 这个二进制本身，
  走 keytar 之类的原生绑定会弹授权框。**拿不到 token 就绝不发请求**：匿名请求返回的是
  429 + `retry-after: 1460`（IP 级封 24 分钟），不是 401。也不做 refresh_token（会和
  Claude Code 抢写钥匙串）
- **Codex**：`codex app-server --stdio` 的 JSON-RPC `account/rateLimits/read`。
  三个坑：① 二进制在 `~/.npm-global/bin`，Electron 从 Finder 启动不继承登录 shell 的 PATH，
  必须走绝对路径否则把"装了的用户"显示成"未安装"；② `initialize` 的 params 形状错了
  服务端**静默退出**，一行错都不报；③ 未登录时该方法会**静默挂 25s**，必须硬超时
- **窗口语义只能从 `windowDurationMins` 推，绝不按数组位置认 5h/周**。实测本机 codex
  账号只有 10080min（周）一个窗口、`secondary` 是 null —— 按位置认会凭空多出一行 5h
- `~/.claude/claude-usage.json` 是用户自己的 statusline tee 脚本产物，**不是官方文件**，
  换机就没有 → 只做最后兜底，且一律标 stale（实测能和真值差 30 多个百分点）
- **采集期间来的 `setAccounts` 不能丢**：一轮采集要几秒（codex 未登录时硬超时 25s），
  用户正好在这段时间改了凭证的隔离目录，那次刷新会被 `if (running) return` 吃掉；
  而正在跑的那轮用的是**旧账号列表**（`Promise.all` 的入参在 await 之前就求值完了），
  它结束时还会把新配置的显示盖回去。要 pending 补跑
- **计费方式只有一个判据：`identity-env.ts` 的 `billingKind`** —— 最终生效的环境里
  有没有 API key。登录态和额度**必须共用它**：曾经一个用"有 key 且没隔离目录"、
  另一个用"有隔离目录"，于是两样都配的凭证会去查那个目录，把里面**另一个订阅号**的
  "已登录 + 还剩 70%"显示在这个凭证名下，而每次调用都在出账单。
  看 `probeEnv` 不看 identity 自己的 `set`：用户 shell 里 export 的 key 会被继承，
  那也真的会生效；identity 用 `KEY=` 删掉的则已经不在里面了
- state 分五档。**「查不到」「未登录」「用了 0%」必须是三种东西** —— 未登录能自己修
  （去跑一次 login），查不到只能等。所以 `unconfigured` 只藏"自动探测的系统号且没人在用"，
  **用户自建的凭证即使未登录也必须占位**，否则那个号在界面上就是凭空消失
- **窗口标签从小到大判**：老写法第一条是 `mins >= 10000 → '周'`，于是 43200（月）也成了"周"。
  和 `quota2.sh` 把周窗口标成 5h 是同一类错
- **别信 `~/scripts/quota2.sh` 的数**：它读的是 session jsonl / statusline 快照，都是
  **上一次落盘的历史值**，进程一停就冻住。实测真值 0% 时它报 8%（10 小时前的数）。
  Termscape 走实时 API，以 app 里的为准
- codex 的 `credits.balance` 是**余额字符串**（可能是 `"$766.76"`），不是上限；
  `Number()` 直接吃会得到 NaN。`QuotaSpend` 的 `usedMinor` 和 `remainingMinor` 是两个
  方向相反的数，缺哪个留 undefined，**绝不拿 0 顶上**
- 每个采集器都要 `windows.length ? 'ok' : 'unknown-shape'`；Hub 的 `setAccounts` 要比
  **指纹**（含 name / env）而不是 accountId —— 换了 `CODEX_HOME` 而 id 不变时会继续显示旧号

## 凭证节点（2026-07-26）

账号在画布上的实体。`credential` 节点 → 终端的连线 = 该终端用这个账号。
三条约束是设计的一部分，别当成可以放宽的细节：

- **连线优先，节点头部的下拉被锁掉**（`data.credBound`）。同一件事两个入口必然打架
- **拉线会杀会话重开**（identityId 变更即 destroy + respawn），所以拉线前弹确认。
  拉一根线是很轻的手势，后果却是重启用户正在跑的活
- **连线 ≠ 自动登录**。`CODEX_HOME` / `CLAUDE_CONFIG_DIR` 只负责隔离，
  指向新目录时那个号是空的，第一次仍要在终端里跑一次 `codex login`。
  所以节点上显示登录态：codex 用 `codex login status` 真查（只读、~1s、不花额度）；
  **Claude 没有等价命令**（穷举过 `--help`），如实报 unknown，别猜
- 节点上**只列 envKeys 不列值**。渲染层本来就拿不到值，别改成能拿到
- 一个终端只能有一个凭证：连新线时先摘掉旧的凭证连线

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

**自用出包走 `npm run dist:local`**（签名但跳过公证）：
- Apple 的公证队列**说慢就慢**，实测排过 40 分钟还是 `In Progress`，而
  electron-builder 等不到就报一条**空错误**（`Failed with unexpected result:` 后面什么都没有）。
  看到它别急着查代码，先 `xcrun notarytool history` 看真实状态
- 公证是给**别人下载**用的：quarantine 属性只有浏览器/AirDrop 会加，
  本机构建出来的包和 `scp` 传过去的包都没有，直接 `cp` 到 `/Applications` 就能跑。
  `spctl --assess` 会报 `rejected`，那是预期的，不代表装不上

坑：
- **hardened runtime 必须配 entitlements**（`build/entitlements.mac.plist`），
  放行 V8 的 JIT 和 node-pty，否则签完能过公证但**一启动就崩**
- electron-builder 26 的 `notarize` 只收布尔值，teamId 走环境变量（写成对象直接 schema 报错）
- DMG 要单独 `notarytool submit` + `stapler staple`，electron-builder 只公证 .app
- 验收三连：`codesign --verify --deep --strict` / `spctl --assess --type execute`
  （要看到 `source=Notarized Developer ID`）/ `stapler validate`

## 跨机派活（2026-07-27）

`tb ask <ssh别名>:<节点> <任务>` —— 走用户已有的免密 ssh，**不新增任何网络暴露面**
（两边 hook server 照旧只绑 127.0.0.1，ssh 隧道进来的源地址本身就是回环）。
评审全文见 `docs/peer-review-codex.md`。

- **不要改成给 `remote.ts` 加 `/api/delegate`**（这是最初的方案，被否了）：字面上不是
  exec，安全语义上是 RCE-by-proxy —— 往一个有 Bash 权限的 agent 里注入提示词。
  ssh 那条路上，能连进来的人本来就有完整 shell 权限，没有新增能力
- **alias 白名单是安全判据不是配置便利**：alias 原样进 `ssh` 的 argv，
  `-oProxyCommand=…` 这种"机器名"会在**本机**执行任意命令。格式校验（`peer.ts`
  的 `isPeerAlias`）+ 白名单两道，settings 读盘时也滤一次 —— 判据必须共用同一个，
  各写一份正则改一处漏一处
- **对端授权不走 `authorizeLink`**：那个函数比对画布连线 `boardLinks`，而 peer 不是
  画布上的节点，比对永远不成立 —— 只会弹一个远端没人看的窗，还留下匹配不上的幽灵 grant。
  跨机的判据是设置里的开关，且要在 `authorize` 回调里再查一遍（注入前最后一个可控点）
- **helper 留在被派活那一侧**：hook 端口每次启动都变、token 只在本机文件里，
  对面既拿不到也不该拿。跨机链路上只传任务本身
- **任务正文走 stdin，绝不进 argv** —— `ps` 对同机所有用户可见
- **helper 路径要用双引号**：macOS 的 userData 路径含空格（`Application Support`），
  不引的话对端 shell 会拆成三个参数；用双引号而非单引号是因为 `$HOME` 要在对端展开
- **超时必须逐层严格递增**：240（远端 delegate）< 270（helper curl）< 300（ssh）
  < 320（tb 的 curl）。持平就等于"内层刚注入完、外层已经放弃" —— 曾经 helper 和 ssh
  都是 260s 正是这样。而且 delegate **返回之前还要干活**（1.5s 轮询 + 1.2s 等落盘
  + 读整个 transcript），helper 只多几秒的话正常完成的派活会被自己人掐断。
  用例要断言**整条阶梯**递增，只断言最外 > 最内看不出持平
- **不自动重试**：注入不可撤回，重试就是往对面 agent 里注两遍。断线只能理解成 detach。
  人工重发也挡得住 —— 远端有张十分钟的幂等表，键**从内容派生**
  （`peerRequestId`；随机 id 在重试时是另一个值，等于没有幂等）。
  ⚠️ 拼串式哈希有歧义（`"a"+sep+"b c"` 撞 `"a b"+sep+"c"`），用 `JSON.stringify`；
  **别用裸 NUL 当分隔符** —— 无歧义但源码里完全不可见，一次复制粘贴就变回空格。
  被拒的派活要 `abandon` 登记，否则开关打开后同一个任务十分钟内都派不出去
- task 有 32 KiB 上限（**按字节** —— 中文一个字三字节）：整段会被一次 `writeToPty`
  打进 pty，靠 1 MiB 的 HTTP body 兜是不够的
- **已端到端实测通过**（两个方向都跑过）：普通 shell 被拒且什么都没执行、
  真 agent 会话 7 秒返回答案、重发同一任务挡住并回上次结果、开关关掉时拒绝、
  乱 token 403、40KB 任务 400。**从 ssh 起对端的 GUI app 用 `open -a`** ——
  `launchctl asuser` 要 root，会报 `Could not switch to audit session`

## 自动更新（2026-07-27）

`src/main/updater.ts`，electron-updater + Squirrel.Mac。后台检测 → 后台下载 →
提示 → **用户点了才装**。

- **不自动装是刻意的**：终端里跑着用户的活，自动重启会把正在跑的那一轮 agent
  对话掐掉（tmux 会话本身能续存，对话不能）。`autoInstallOnAppQuit` 也要关 ——
  默认那个会在退出时静默替换掉 app，用户下次打开发现版本变了且没人问过他
- **mac target 必须有 zip**：Squirrel 只认 zip，dmg 是给人手动装的。
  少了它能查到新版本但下载不下来
- **更新源只收 https**（`update-url.ts`，有独立用例）：更新包下下来是要替换掉
  整个 app 的，明文 http 意味着路上任何人都能换掉它。Squirrel 的签名同源校验
  是第二道防线，不该拿它当第一道
- **feed URL 在设置里，不焊进打包配置**：`electron-builder.yml` 里那个是占位，
  运行期 `setFeedURL` 覆盖 —— 换发布源不用重新打包。每次 check 都要重设一遍
  （autoUpdater 是单例，feed 只在 setFeedURL 时更新）
- **必须有 publish 配置**（哪怕是占位）：没有的话 electron-builder 不生成
  `app-update.yml`，electron-updater 一启动就找不到配置文件
- dev 下整个降级成 no-op（没有 `app-update.yml`，否则直接抛）
- `update:install` 只认主窗口的调用 —— 装 = 重启 app
- 发布流程：`npm run dist:signed` → 把 `latest-mac.yml` 和 `*.zip`
  （dmg 可选，给人手动下）传到那个 HTTPS 目录

**这条链路到底保证了什么**（注释里别写含糊的话，codex 逐条纠过）：

| | |
|---|---|
| Squirrel.Mac 的签名校验 | 只保证候选包满足**当前 app 签名导出的 designated requirement**。**不**保证来自官方目录、yml 为真、版本更新、过了公证、私钥没泄漏 |
| `latest-mac.yml` 的 sha512 | **下载完整性**，不是发布者认证 —— 控制了发布目录就能给恶意包算一个匹配的 |
| https | 只保证"连上了你填的那台服务器"，不保证那台服务器可信 |

所以信任根是**发布目录的控制权**，代码签名是最后一道而不是第一道。
feed URL 做成用户可改的是有代价的（能被诱导改源），现在靠 UI 上的显著警告 +
显示当前生效域名兜着；等有了正式发布渠道应当焊死官方源。

- `allowDowngrade = false` 要**显式写**：默认就是它，但签名不提供版本单调性，
  防降级全靠这一层，将来启用 prerelease / channel 时很容易无意改掉
- `checking` / `downloading` 期间要拒绝新一轮 check：electron-updater 的 check
  promise 在**自动下载完成之前**就 resolve，此时再 check 会让两轮事件交错。
  **例行检查还要额外挡住 `available` / `ready`**：包已下好等安装时，一次失败的检查会把
  phase 冲成 `error`，而 install 有 `phase !== 'ready'` 门禁 —— 用户从此装不了那个
  已经在磁盘上的包，只能重启 app
- 版本号要单独存，**不能从展示状态反推**：第一次 `download-progress` 之后
  phase 已是 `downloading`，再按 `phase === 'available'` 取就只剩空串
- macOS 上 `quitAndInstall` 的两个参数**不按 BaseUpdater 语义解释**（MacUpdater 重写了它）
- `publishAutoUpdate: true` 是"生成更新元数据"，**不是**"自动上传"

## 授权模型（同 UID 前提，务必如实描述）

跨节点动作（`tb ask` / `tb browser`）走「连线即授权」+ 弹窗兜底。但所有终端与 app 同 UID，
任何进程都能 `tmux -L termboard send-keys` 直接驱动会话绕过全部检查 —— 所以这是**产品护栏
不是安全边界**。写文档、写注释、答用户都要这么说，别把它说成安全机制。

## 路线图（真实状态见 PRD.md「优先级排序」，那张表已重校）

M1–M6 与 F1–F8 均有可用实现；签名公证、手机端、三家额度采集、崩溃日志、工作区导出导入
均已完成。明确未做的：

| 未做 | 为什么 |
|------|--------|
| **MCP 形态** | F7/F8 现在走 `tb` + 回环 HTTP，够用 |
| `tb agents` 列远端节点 | 目标 id 现在得去对面画布上看。逐台 ssh 查会拖慢默认命令，等真觉得烦了再做 `tb agents <peer>` |
| **CI / x64 包** | 仓库还没有 remote。等真要发了再配，现在纯投机 |
| **手机端完整 PWA / 后台推送** | 受安全上下文与 Web Push 限制（见上） |
| **手机端按设备可撤销 token** | 单用户单机时轮换那把 token 就是撤销，够了 |
| **记忆系统统筹** | 还没想清形态 |
| 非订阅 provider 的额度 | 可查的清单与不可查的原因见 `docs/QUOTA.md` |

## 参考

- `ARCHITECTURE-NOTES.md` — nodeterm 架构调研提炼（持久化/tmux/状态系统），M2-M4 按此校准
- 参考仓库 `~/Desktop/code/_reference/nodeterm`（BUSL-1.1，只读思路，禁止抄代码）
