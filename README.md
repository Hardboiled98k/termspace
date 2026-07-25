# Termscape

Termscape 是一个面向 macOS 的 Electron 无限画布终端管理器，把终端、Agent、项目简报和浏览器放进同一张可缩放画布。

## 它解决什么问题

传统终端通常把会话叠在窗口和标签页里：会话一多，就要反复切换并记住“哪个 Agent 在跑、哪个正在等输入、哪个属于哪个项目”。Termscape 把每个终端变成可拖拽、缩放和连线的节点，并用画布位置、项目标签页和状态颜色保留空间关系。

Termscape 当前处于 **alpha** 阶段。已有功能可以本地使用，但发布、兼容性和异常恢复仍未达到稳定版标准。

## 核心能力

- **画布节点终端**：基于 React Flow、xterm.js 和 node-pty。终端节点支持拖拽、缩放、重命名、字号调整、复制粘贴、远距离 LOD 和布局/视口持久化；也可框选多个终端后自动排成集群。
- **Agent 状态发光**：Claude Code hooks 将运行中、需要用户处理和空闲状态上报到本机回环服务，节点边框、状态胶囊、缩略图和画布概览同步显示。上下文占用从 Claude transcript 的 usage 数据读取。
- **tmux 会话续存**：启用且本机存在 tmux 时，每个节点连接到独立的 `tb-<nodeId>` 会话。刷新、热更新、切换项目画布或退出应用只断开客户端；明确关闭节点才结束会话。没有 tmux 时自动降级为普通 shell。
- **项目标签页**：可选择本地项目文件夹，为每个项目保存独立画布；新终端以当前项目目录作为工作目录。
- **凭证管理**：可为 Claude、Codex、Gemini 或自定义命令保存环境变量包，并绑定到 Agent 预设或终端节点。凭证通过 Electron `safeStorage` 使用 macOS Keychain 加密，渲染进程只读取名称、供应商和变量名。
- **额度 HUD**：读取 `~/.claude/claude-usage.json`，显示 Claude 5 小时/周额度、重置倒计时，以及当前画布的 Agent 状态和上下文占用。数据文件不存在时不显示额度区块。
- **简报连线注入上下文**：每个项目可建立一份 Markdown 简报；从简报节点连线到终端后，内容会合并到该终端的 `TERMBOARD_CONTEXT_FILE`。内置“Claude ＋共享上下文”预设会通过 `--append-system-prompt` 注入该文件，其他终端可自行读取环境变量指向的文件。
- **`tb` 工具中枢**：Termscape 终端的 `PATH` 中会注入本地 `tb` 命令，可按需搜索/加载 `~/.claude/skills` 中的 Skill、列出画布 Agent、向其他终端派活，以及控制画布浏览器。服务只监听回环地址并使用会话令牌鉴权。
- **画布内浏览器节点**：基于 Electron `<webview>`，支持地址输入、前进、后退和刷新。Agent 也可通过 `tb browser` 打开或导航页面、读取可见文本、执行 JavaScript 和截图。

## 系统要求

- macOS（当前打包目标仅为 Apple Silicon / `arm64`）。
- Node.js 与 npm，用于本地开发和构建；仓库未声明固定 Node.js 版本。
- tmux 可选，但强烈建议安装。缺少 tmux 时终端仍可运行，但进程不会跨应用重载或退出续存。
- Claude Code 及其 hooks：只有在需要 Claude Agent 真实状态、上下文占用和简报自动注入时需要。Termscape 启动时会把托管 hook 合并到 `~/.claude/settings.json`，并保留已有 hook 条目。

## 开发与构建

先安装依赖：

```bash
npm install
```

常用命令：

```bash
npm run dev        # 启动 electron-vite 开发环境
npm run typecheck  # 运行 TypeScript 类型检查，不产出文件
npm run rebuild    # 按当前 Electron ABI 重编译 node-pty
npm run dist       # 构建未签名的 macOS arm64 DMG 到 dist/
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
- 生成的 macOS 应用未签名、未公证，不能视为正式发布包。
- 当前只配置了 macOS `arm64` 构建，不提供 Intel macOS、Windows 或 Linux 包。
- Agent 状态 hooks 目前只支持 Claude Code；Codex、Gemini 和普通 shell 节点不会获得同等的真实状态检测。
- 额度 HUD 当前只读取 Claude 数据，不提供 Codex、Gemini 或其他供应商额度。

## 许可

Termscape 以 [MIT License](LICENSE) 发布。第三方依赖及架构参考说明见 [NOTICE.md](NOTICE.md)。
