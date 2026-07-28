# Third-Party Notices

Termspace 使用第三方开源软件。各项目的版权归其各自贡献者所有；下列许可证标识来自当前安装依赖的 `package.json`。完整依赖树和锁定版本见 `package-lock.json`。

## 运行时主要依赖

| 组件 | 当前安装版本 | 许可证 |
| --- | ---: | --- |
| Electron | 43.2.0 | MIT |
| React | 19.2.8 | MIT |
| React DOM | 19.2.8 | MIT |
| `@xyflow/react` | 12.11.2 | MIT |
| `@xterm/xterm` | 6.0.0 | MIT |
| `@xterm/addon-fit` | 0.11.0 | MIT |
| `@xterm/addon-webgl` | 0.19.0 | MIT |
| `node-pty` | 1.1.0 | MIT |

## 开发与构建主要依赖

| 组件 | 当前安装版本 | 许可证 |
| --- | ---: | --- |
| `electron-vite` | 5.0.0 | MIT |
| Vite | 7.3.6 | MIT |
| `@vitejs/plugin-react` | 5.2.0 | MIT |
| Tailwind CSS | 4.3.3 | MIT |
| `@tailwindcss/vite` | 4.3.3 | MIT |
| `@electron/rebuild` | 4.2.0 | MIT |
| `electron-builder` | 26.15.3 | MIT |
| TypeScript | 7.0.2 | Apache-2.0 |

本清单聚焦 Termspace 的直接主要依赖；这些依赖的传递依赖仍受各自许可证约束。分发二进制时应同时保留适用的第三方许可证文本。

## nodeterm 架构参考说明

Termspace 在持久化模型、tmux 会话生命周期和 Agent 状态上报等方面参考了 nodeterm 的架构思路。nodeterm 采用 BUSL-1.1 许可。

Termspace 未复制 nodeterm 的源代码，且本仓库不包含或分发 nodeterm 代码。上述说明仅用于披露设计调研来源，不表示 nodeterm 作者对 Termspace 的认可或背书。
