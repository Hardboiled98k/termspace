# Termscape 设计规范

**定位**: 无限画布终端管理器。**视觉基准: Apple**（2026-07-24 用户定调）— macOS 原生质感 + apple-design-skill token 体系。画布交互仍学 Figma/tldraw。

**Apple 化要点**: 系统灰阶深色（#1C1C1E 卡片 / #131315 终端，不用蓝黑）、系统色 dark 变体做状态语义、0.5px 发丝线边框、窗口 vibrancy 毛玻璃 + 面板 backdrop-blur、胶囊按钮/状态 chip、SF 字体（UI: -apple-system，终端: ui-monospace）、字距 -0.01em、多层阴影（贴地+环境光）。

## 核心原则

1. **glow 只给语义** — 发光边框仅表达 agent/进程状态，静止节点保持 Linear 级克制。十个节点全发光 = 视觉噪音。
2. **缩到全景不读字** — 状态靠颜色分布传达（minimap 同色系）。
3. **未来感 ≠ 赛博朋克堆料** — 深色层级 + 微妙 glow + 等宽字体，不上粒子/扫描线。

## 设计 Token（与 styles.css `:root` 同步）

| Token | 值 | 用途 |
|-------|-----|------|
| `--tb-bg` | `#0F0F10` | vibrancy 兜底底色（body 透明透毛玻璃） |
| `--tb-panel` | `#1C1C1E` | 节点卡片 · systemGray6 dark |
| `--tb-panel-glass` | `rgba(28,28,30,0.72)` | 工具栏/minimap 玻璃面板（+blur 24 saturate 180%） |
| `--tb-terminal` | `#131315` | 终端内部 |
| `--tb-hairline` | `rgba(255,255,255,0.09)` | 0.5px 发丝线边框 |
| `--tb-text` | `#F5F5F7` | 主文字 |
| `--tb-muted` | `#98989F` | 次级文字 · secondaryLabel dark |
| `--tb-blue` | `#0A84FF` | RUNNING 呼吸 glow · systemBlue dark |
| `--tb-orange` | `#FF9F0A` | NEEDS YOU · systemOrange dark |
| `--tb-red` / `--tb-green` | `#FF453A` / `#30D158` | 错误 / 成功 |
| `--tb-idle` | `#48484A` | 静止状态点 |
| `--tb-radius` | `12px` | 卡片圆角；按钮/chip 用胶囊 `980px` |
| UI 字体 | -apple-system (SF Pro), PingFang SC | 字距 -0.01em |
| 等宽字体 | ui-monospace (SF Mono) → Menlo | 终端/数字 |

## 状态语义

| 状态 | 视觉 |
|------|------|
| running | 蓝边框 + 3.6s 呼吸 glow + 头部「运行中」蓝 chip |
| attention (needs-you) | 橙边框 + 静态 glow + 「需要你」橙 chip |
| idle | 无 glow，灰 chip |
| exited/error | 红状态点 + 灰化内容 |

## 动效级别：中等

- 节点入场：spring scale 0.96→1（Motion，后续加）
- 状态切换：300ms ease 边框/glow 过渡
- 画布缩放：React Flow 默认
- 禁止：WebGL 粒子、无语义装饰动画

## 交互约定（Figma 系）

- 滚轮/双指 = 平移画布；pinch / ⌘+滚轮 = 缩放
- 节点 header 拖拽移动；终端区域 `nodrag nowheel`（保文本选择 + 滚回滚）
- zoom < 0.35 → LOD 占位（大标题 + 状态点）
- 选中才显 resize 手柄
