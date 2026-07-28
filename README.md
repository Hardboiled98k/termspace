# Termspace

Termspace 是一个面向 macOS 的 Electron 无限画布终端管理器，把终端、Agent、项目简报和浏览器放进同一张可缩放画布。

## 它解决什么问题

传统终端通常把会话叠在窗口和标签页里：会话一多，就要反复切换并记住“哪个 Agent 在跑、哪个正在等输入、哪个属于哪个项目”。Termspace 把每个终端变成可拖拽、缩放和连线的节点，并用画布位置、项目标签页和状态颜色保留空间关系。

Termspace 当前处于 **alpha** 阶段。已有功能可以本地使用，但发布、兼容性和异常恢复仍未达到稳定版标准。

## 核心能力

- **画布节点终端**：基于 React Flow、xterm.js 和 node-pty。终端节点支持拖拽、缩放、重命名、字号调整、复制粘贴、远距离 LOD 和布局/视口持久化；也可框选多个终端后自动排成集群。
- **Agent 状态发光**：Claude Code hooks 将运行中、需要用户处理和空闲状态上报到本机回环服务，节点边框、状态胶囊、缩略图和画布概览同步显示。上下文占用从 Claude transcript 的 usage 数据读取。
- **tmux 会话续存**：启用且本机存在 tmux 时，每个节点连接到独立的 `tb-<nodeId>` 会话。刷新、热更新、切换项目画布或退出应用只断开客户端；明确关闭节点才结束会话。没有 tmux 时自动降级为普通 shell。
- **项目标签页**：可选择本地项目文件夹，为每个项目保存独立画布；新终端以当前项目目录作为工作目录。
- **凭证管理**：可为 Claude、Codex、Gemini 或自定义命令保存环境变量包，并绑定到 Agent 预设或终端节点。凭证通过 Electron `safeStorage` 使用 macOS Keychain 加密，渲染进程只读取名称、供应商和变量名。
- **额度 HUD（按账号）**：归属单位是**账号**不是 provider —— 同时挂两个 Codex 订阅号加一把 API key 就是三块，每块带「N 个节点在用它」。三家都是实时查：Claude 走 OAuth usage 接口（token 从钥匙串取）、Codex 走 `codex app-server` 的 JSON-RPC、Copilot 走 GitHub 接口。「查不到」「未登录」「用了 0%」是三种不同的显示 —— 未登录你能自己修，查不到只能等。详见 `docs/QUOTA.md`。
- **简报连线注入上下文**：每个项目可建立一份 Markdown 简报；从简报节点连线到终端后，内容会合并到该终端的 `TERMBOARD_CONTEXT_FILE`。内置“Claude ＋共享上下文”预设会通过 `--append-system-prompt` 注入该文件，其他终端可自行读取环境变量指向的文件。
- **`tb` 工具中枢**：Termspace 终端的 `PATH` 中会注入本地 `tb` 命令，可按需搜索/加载 `~/.claude/skills` 中的 Skill、列出画布 Agent、向其他终端派活，以及控制画布浏览器。服务只监听回环地址并使用会话令牌鉴权。
- **跨机派活**：`tb ask <ssh别名>:<节点> <任务>` 把任务派到另一台机器上 Termspace 里的终端，做完把回答带回来。走你已经配好的免密 `ssh`，**不新开任何网络端口**（两边的服务照旧只绑回环）。双侧 opt-in：发起侧要把机器加进白名单并逐目标确认一次，接收侧要显式打开「接受跨机派活」。同一个任务十分钟内重发不会二次注入。
- **自动更新**：后台检测、后台下载，**下载完只提示，装不装你说了算** —— 终端里跑着你的活，自动重启会掐掉正在跑的那一轮 agent 对话。更新源填在设置里（只收 https），换源不用重新打包。
- **画布内浏览器节点**：基于 Electron `<webview>`，支持地址输入、前进、后退和刷新。Agent 也可通过 `tb browser` 打开或导航页面、读取可见文本、执行 JavaScript 和截图。
- **集群操作**：框选成组后自动网格排列；组级可群发命令、批量重启（保留身份/目录/启动命令）、折叠（会话保持存活）；组状态取组内最坏情况 `error > attention > running > idle`。
- **工具调用审批接到画布**：Claude 的 `PermissionRequest` hook 请求被主进程挂起，消息中心直接显示**它要做什么**（工具名 + 命令/路径摘要），批准/拒绝走结构化应答而不是往终端里发按键。超时（120 秒）自动回落到 Claude 自己的交互提示，不会卡住 agent。

## 授权模型（请先读这段）

跨节点动作（`tb ask` 派活、`tb browser` 驱动浏览器）遵循 **连线即授权**：画布上存在
`源终端 → 目标` 的连线才放行，否则弹窗让你当场批准；删掉连线即撤销授权。

必须说清楚边界：Termspace 的所有终端与应用本身跑在**同一个用户身份**下。任何同 UID 的进程
都可以直接 `tmux -L termboard send-keys` 驱动任意会话，绕过上述全部检查。因此这套机制的定位是
**产品护栏**——防止 agent 自作主张、让画布连线成为真实语义——**不是安全边界**。真正的隔离需要
不同 UID、容器或强制沙箱。

在此前提下仍然做了这些收口：派活只接受**当前活着**的 agent 会话（普通 shell 一律拒绝注入）、
目标必须处于可接单状态、同一目标并发派活互斥；浏览器除 `list` 外所有动作都要授权
（`text`/`shot` 同样能读走已登录页面的内容）；指名了不存在的浏览器节点直接报错而不是回退到别的节点。

## 系统要求

- macOS（当前打包目标仅为 Apple Silicon / `arm64`）。
- Node.js 与 npm，用于本地开发和构建；仓库未声明固定 Node.js 版本。
- tmux 可选，但强烈建议安装。缺少 tmux 时终端仍可运行，但进程不会跨应用重载或退出续存。
- Claude Code 及其 hooks：只有在需要 Claude Agent 真实状态、上下文占用、审批接管和简报自动注入时需要。**首次启动会先征得同意**才把托管 hook 合并进 `~/.claude/settings.json`（保留已有条目，原文件备份为 `.termboard-backup`），拒绝也能正常使用，只是节点状态不反映 agent 真实情况。设置 →「Hooks 与状态」里可随时卸载，同处有依赖体检，缺 tmux / Claude Code / cdx 时会明说缺什么、影响什么。

## 开发与构建

先安装依赖：

```bash
npm install
```

常用命令：

```bash
npm run dev        # 启动 electron-vite 开发环境
npm run typecheck  # 运行 TypeScript 类型检查，不产出文件
npm test           # 派活准入的 smoke test（Node 原生 type stripping，无测试框架依赖）
npm run rebuild    # 按当前 Electron ABI 重编译 node-pty
npm run dist       # 构建未签名的 macOS arm64 DMG 到 dist/
```

自检截图（不进交互也能确认启动链路正常）：

```bash
TERMBOARD_SHOT=/tmp/shot.png npm run dev   # 6 秒后截图并退出
```

升级 Electron 或遇到 `node-pty` ABI 不匹配时，先运行 `npm run rebuild`。

## 目录结构

```text
.
├── src/
│   ├── main/                 # Electron 主进程、PTY/tmux、hooks、凭证与工具中枢
│   ├── preload/              # contextBridge 与 IPC 接口
│   └── renderer/
│       └── src/              # React 画布、HUD、设置面板和各类节点
├── electron.vite.config.ts   # Electron/Vite 构建配置
├── electron-builder.yml      # macOS arm64 DMG 打包配置
├── package.json              # 脚本与直接依赖
├── PRD.md                    # 产品功能规格
├── DESIGN.md                 # 视觉与交互规范
└── CLAUDE.md                 # 开发约定与关键技术决策
```

## 已知限制

- 当前为 alpha，功能和本地数据格式仍可能变化。
- **生成的 macOS 应用未签名、未公证**，Gatekeeper 会拦下，只适合本机自用或定向测试，不能视为正式发布包。补签名需要 Apple Developer 账号，并在 `electron-builder.yml` 里把 `identity: null` 换成 Developer ID、开启 hardened runtime 后走 notarization。
- 上述「授权模型」是产品护栏而非安全边界，同 UID 进程可绕过。
- 当前只配置了 macOS `arm64` 构建，不提供 Intel macOS、Windows 或 Linux 包。
- Agent 状态 hooks 目前只支持 Claude Code；Codex、Gemini 和普通 shell 节点不会获得同等的真实状态检测。
- 额度只覆盖 Claude / Codex / Copilot 三家订阅。按量计费的用量、以及只有网页端入口的供应商（如 Cursor 个人订阅）查不了，`docs/QUOTA.md` 里逐条写了原因。

## 许可

Termspace 以 [MIT License](LICENSE) 发布。第三方依赖及架构参考说明见 [NOTICE.md](NOTICE.md)。
