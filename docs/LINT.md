# Lint

```bash
npm run lint
```

用 **oxlint**（Rust 单二进制），不是 eslint —— 这个项目用的是 **TypeScript 7**，
而 `typescript-eslint` 的 peer 依赖还卡在 5.x，装不上（`ERESOLVE`）。
oxlint 自带 TS/TSX 解析，不依赖 TS 版本，也不碰格式（没有 formatter，
所以不会跟现有的无分号风格打架）。

## 关掉的两条规则，以及为什么

**关规则要有理由，不然就是在弱化检查**（见 `~/.claude/rules/guardrails.md`）。
这两条都不是"懒得改"，而是**照它改会引入 bug 或改坏有意的设计**：

### `no-useless-spread`

它建议把 `for (const x of [...someSet])` 改成 `for (const x of someSet)`。
本项目里命中的 5 处**全部是边迭代边删同一个集合**：

| 位置 | 循环体里干的事 |
|------|---------------|
| `index.ts` 撤销失效授权 | `grants.delete(g)` |
| `index.ts` 删节点时清授权 | `grants.delete(g)` |
| `index.ts` 退出时释放 pty | `releasePty(id)` 会改 `ptys` |
| `hooks.ts` 丢弃某节点的审批 | `settle(id)` 会 `pending.delete(id)` |

去掉那层 spread = 在迭代过程中修改被迭代的集合，行为未定义、会漏掉元素。
**这条规则在这个代码库里的建议是有害的**，所以整条关掉而不是逐处加豁免注释
（5 处都是同一个模式，逐处加注释只会让人以为是特例）。

### `no-control-regex`

命中两处，都是**有意在处理控制字符**：

- `delegate.ts` 的 `sanitizeTask` —— 剔除 C0 与 DEL。这是安全修复本身：
  任务正文里的 `\x03`/`\x04`/`\x1a` 是 agent TUI 的退出键，
  不剔掉就能让载荷在落笔之后把 agent 踢掉、剩余字节由 shell 执行。
- `index.ts` 的 ANSI 转义清理 —— `\x1b[...m` 那套，给 UI 显示纯文本用。

一个"检查正则里有没有控制字符"的规则，对一个**专门用来匹配控制字符**的正则
只能是误报。

## 现状

`npm run lint` 应当零输出。新增告警要么修，要么在这里写明为什么关 ——
**不要静默加 `oxlint-disable`**。
