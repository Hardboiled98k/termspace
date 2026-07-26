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

### 已接入
- **Claude 订阅** — `~/.claude/claude-usage.json`，由 Claude Code 渲染状态栏时的 tee 脚本写入。
  含 `_captured_at`。⚠️ **只在有 Claude 会话刷状态栏时更新**，否则冻在最后一次的值上，
  看起来跟实时数据一模一样 —— 必须校验新鲜度（已实现）。

### 下一步做（收益/成本比最高）
- **Codex 订阅** — `codex app-server --stdio` 走 JSON-RPC：`initialize` 握手后发
  `account/rate_limits/read`。返回 `rateLimits.primary/secondary`（`usedPercent`、
  `windowDurationMins`、`resetsAt`）与 `rateLimitsByLimitId`、`credits`。
  实测：冷启动到出结果 2.4s，稳态 ~2s，**不消耗任何推理额度**（就是一次账号查询）。
  **没有静默失败** —— 未登录明确返回 `-32600 codex account authentication required`。
  常驻一个 app-server 连接复用即可。
  另有 `account/usage/read` 给历史（lifetimeTokens / dailyUsageBuckets），天级更新，1 小时拉一次够了。
- **Codex 离线兜底** — `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` 里有额度快照。

### 再往后
- **GitHub Copilot** — `GET https://api.github.com/copilot_internal/user`（订阅额度）；
  个人 premium request 用量走 `/users/{u}/settings/billing/premium_request/usage`。
- **Gemini Code Assist** — `POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota`。
- **Windsurf** — `~/Library/Application Support/Windsurf/User/globalStorage/state.vscdb`（SQLite）。
- **按量 API** — 各家都有干净的余额端点：
  OpenRouter `GET /api/v1/credits` 与 `/api/v1/key`（还有 `/api/v1/activity` 出按天按模型明细）、
  DeepSeek `GET /user/balance`、Moonshot `GET /v1/users/me/balance`。
- **Anthropic API 用量** — Admin API `/v1/organizations/usage_report/messages`，
  但要 admin key，个人按量用户拿不到 → 对多数用户不可行。

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
