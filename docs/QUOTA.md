# 额度与用量：信息架构 + 各家接入路径

> 2026-07-26。各 provider 的路径是**本机实测**得出的（跑过命令、读过文件、对过官方文档），
> 不是凭印象写的。标了 `未验证` 的才是推断。

## 一、归属单位是「账号」，不是 provider，也不是节点

用户会遇到三种情况，它们**不是三种额度**，而是同一个东西的三个侧面：

| 用户视角 | 实际是什么 | 额度归谁 |
|---------|-----------|---------|
| 1. 在终端里用的 | 某个节点绑了某个凭证 | 消耗的是**那个账号**的额度，节点本身没有额度 |
| 2. 系统里配置的 | 没绑凭证的节点用的默认登录态（`~/.codex`、`~/.claude`） | 一个特殊账号：**系统默认** |
| 3. API 调用的 | 一把 key | 也是一个账号，只是计费模型从「百分比」变成「余额/花费」 |

所以 HUD **按账号分组**。同时有两个 codex 订阅 + 一把 codex API key 时长这样：

```
账号额度
  Codex · 工作号      订阅  ▓▓▓░░ 42%  4h12m   ● 2 节点
  Codex · 个人号      订阅  ▓░░░░  8%  4h55m   ○ 0 节点
  Codex · API key     按量  $12.40 本月         ● 1 节点
  Claude · 系统默认   订阅  ▓▓░░░ 18%  3h20m   ○ 0 节点   ⚠ 12 分钟前的快照
```

四条设计决定，每条都对应一个现在会出错的地方：

1. **一账号一行，不是一 provider 一行。** 现在的 HUD 是 provider 维度，
   两个 codex 订阅会被混成一个数 —— 直接是错的。
2. **「N 节点」这一列把「终端里用的」和「账号」连起来。**
   `0 节点却仍在消耗` 就是"画布之外也在用这个号"，这正是用户会困惑的情形
   （现象：画布上一个 Claude 终端都没有，HUD 却有数）。
3. **订阅和按量不能长一样。** 订阅是百分比 + 重置倒计时；按量没有"满格"这个概念，
   给它画进度条是骗人的，只显示金额。
4. **新鲜度按账号各自标。** 采集方式不同新鲜度就不同：本地文件可能是几小时前的快照，
   app-server 是实时打后端。混在一起标一个时间必然误导。

## 二、统一数据模型

```ts
type Billing =
  | { kind: 'subscription'; pools: { label: string; usedPercent: number; resetsAt: number }[] }
  | { kind: 'metered'; currency: string; spent?: number; balance?: number; period?: string }

interface AccountQuota {
  /** 凭证 id；系统默认用 'system:<provider>' */
  accountId: string
  provider: 'claude' | 'codex' | 'gemini' | 'copilot' | 'openrouter' | string
  /** 用户起的名字，或「系统默认」 */
  name: string
  billing: Billing
  /** 快照时刻（unix 秒）。**必须有** —— 没有新鲜度就分不清"额度没变"和"采集挂了" */
  capturedAt: number
  /** 采集失败时的原因。空 = 正常。UI 上「查不到」和「用了 0%」必须是两种东西 */
  error?: string
}
```

## 三、各家的接入路径（本机实测）

### 已接入（三家，均实机验过）

| Provider | 入口 | 凭证 | 实测 |
|---|---|---|---|
| Claude 订阅 | `GET https://api.anthropic.com/api/oauth/usage` | 钥匙串 `Claude Code-credentials` 里的 OAuth token，必须走 `execFile('/usr/bin/security')` | `limits[]`（session / weekly_all / weekly_scoped）+ `spend` |
| Codex 订阅 | `codex app-server --stdio` 的 `account/rateLimits/read`（邮箱走 `account/read`） | `$CODEX_HOME` 里的登录态 | `rateLimits.primary/secondary` + `rateLimitsByLimitId` + `credits`；~3.4s |
| GitHub Copilot | `GET https://api.github.com/copilot_internal/user` | `gh auth token` | `quota_snapshots`（chat / completions / premium_interactions） |

这三条**都是各家 CLI 的 `/usage`、`/status` 背后走的同一条路**（codex 已核对其
`slash_dispatch.rs`）。两家**都没有非交互的额度命令** —— `codex login status` 只报登录态，
`claude` 也没有等价子命令（穷举过 `--help`）。所以 API 是唯一的程序化路径。

⚠️ Claude 那条是 **Claude Code 客户端自用的内部端点，不是公开文档化的 API**。
界面上的来源标注必须这么写，别写"官方 API"（会让人以为有稳定性承诺）。

### 兜底与降级
- **Claude 本机快照** `~/.claude/claude-usage.json` —— 用户自己的 statusline tee 脚本产物，
  **不是官方文件**，换机就没有。只在主路径失败时用，且一律标 `stale`
  （实测能和真值差 30 多个百分点）。
- **Codex 的 rollout jsonl** —— 同理，是**上一次会话落盘的历史值**，codex 一停就冻住。
  实测 `quota2.sh` 因为读它，在真值 0% 时报了 8%（那是 10 小时前的数）。**不采用。**

### 下一步（按收益排，来源：codex 2026-07-27 的调研）
1. **GLM Coding Plan** `GET https://open.bigmodel.cn/api/monitor/usage/quota/limit`
   （国际站 `api.z.ai`）—— 官方插件源码公开，注意 Authorization **不加 `Bearer`**。
2. **OpenRouter** `GET /api/v1/key`（单 key 的 limit/remaining/reset）；
   全账户 credits 要 Management Key 走 `/api/v1/credits`。
3. **DeepSeek** `GET https://api.deepseek.com/user/balance` —— 正式文档化，最干净。
4. **Kimi**：订阅走 `GET https://api.kimi.com/coding/v1/usages`（仅官方 CLI 源码公开，
   **契约未正式文档化，接的话必须标记并强容错**）；API 钱包走 Moonshot `/v1/users/me/balance`。
5. **组织版 opt-in**：Cursor Teams Admin API、Windsurf Enterprise
   `GetTeamCreditBalance`、Qoder Teams、Augment Enterprise analytics。

### 明确不做（查证后的结论，别再来回试）

| 目标 | 为什么不做 |
|---|---|
| Cursor 个人 Pro/Ultra | **只有网页控制台**。Admin API 仅 Teams/Business |
| Windsurf 个人 | 同上；本机 `state.vscdb`（SQLite）是**内部实现细节，禁止采用** —— 撬客户端私有存储既脆又越界 |
| Gemini Code Assist 个人 | `v1internal:retrieveUserQuota` 虽存在于 CLI 源码，但**官方条款不允许第三方复刻**。组织侧只能用 Cloud Monitoring，而且给的是历史用量不是剩余额度 |
| Amazon Q 个人 | Pro 管理员的 S3 CSV 是**次日 usage-only**，不是 remaining quota |
| Trae / Zed / JetBrains AI / Continue / aider | 没有公开 API/CLI，一律显示「不支持程序化查询」，**不碰网页 cookie** |
| Anthropic / OpenAI API 用量 | 要 org admin key，个人按量用户拿不到；且都**没有公开的余额端点**，最多显示本月花费 |

### 明确不做（调研后否掉，别再重复踩）
- **Cursor 个人订阅** — 只有网页端点，要浏览器 session cookie。团队版才有官方 API。
- **ChatGPT 订阅的"公开 REST API"** — 不存在。`chatgpt.com/backend-api/*` 是客户端私有协议，
  手撸会在某次 codex 更新后无预警 404，且 access_token 过期后变成静默 401 —— 正是最怕的失败形态。
  订阅额度**只有** `codex app-server` 这一条正当路径。
- **Anthropic 响应头 `anthropic-ratelimit-*`** — 只出现在直连 API 的响应上，
  订阅态的 Claude Code 不走那条路，抓不到。
- **`~/.claude.json` 的 `cachedUsageUtilization`** — 字段与官方 API 同构，但实测陈旧 19 小时，
  且 `resets_at` 已是过去时间。可做兜底，但必须校验 `fetchedAtMs` 且 clamp 负倒计时。
- **`claude` CLI 查额度的命令** — 穷举过 `--help`，不存在这样的命令。

## 四、静默失败的防线

每个采集器失败时 UI 必须能区分这三种：

| 状态 | 显示 | 绝不能显示成 |
|------|------|-------------|
| 采集器没配 / provider 没装 | 这一行根本不出现 | 0% |
| 采集失败（未登录、网络、格式变了） | 灰掉 + 写明原因 | 0% 或上一次的值 |
| 快照过期 | 数值 + 「N 分钟前」 | 当成实时值 |

「查不到」和「用了 0%」在界面上必须是两个东西。这个项目已经栽过两次静默失败。
