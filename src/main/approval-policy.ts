/**
 * 工具调用审批的**确定性规则引擎**。
 *
 * 为什么是纯代码而不是 LLM —— 两轮独立评估（codex ultra + 五视角红队）给出同一结论：
 * 「LLM 这种概率判断器根本不配做访问控制」。判对 100 次省 100 次点击，判错 1 次
 * `rm -rf` 已经执行完了，收益与风险量级完全不对称。所以：
 *
 *   规则引擎只输出 REQUIRE_HUMAN / DENY 两态，**AUTO_ALLOW 清单为空**。
 *   LLM 将来只负责把请求翻译成人话，不进决策路径。
 *
 * 尤其不要试图给 Bash 建白名单。已核实的反例：
 *   - `git status` 走 core.fsmonitor
 *   - `git diff`   走 .gitattributes 的 diff.external
 *   - `git log`    走 core.pager
 * 三条「只读 git」在恶意仓库里全是任意代码执行，命令行本身完全干净，
 * 元字符检查一条都拦不住。`npm test` 直接执行 package.json 脚本体。
 */

export type Decision = 'require_human' | 'deny'

export interface PolicyVerdict {
  decision: Decision
  /** 命中的规则 id，进审计日志 */
  rule: string
  /** 给人看的一句话理由 */
  reason: string
}

/** 命中即拒的模式。写得宽一点没关系 —— 拒绝只是转人工，不是阻断 */
const HARD_DENY: { id: string; re: RegExp; why: string }[] = [
  { id: 'privilege', re: /\b(sudo|doas|su)\b/, why: '提权' },
  {
    id: 'system-config',
    re: /\b(security|launchctl|crontab|csrutil|systemsetup|nvram)\b|defaults\s+write/,
    why: '改系统配置或钥匙串'
  },
  {
    // rm 的 -rf 可以写成 -fr / -r -f / --recursive --force，顺序和拆分都不固定，
    // 所以只判「rm 且带了 r 或 f 类标志」，宁可宽
    id: 'destructive-fs',
    re: /\brm\s+[^|;&\n]*-[a-zA-Z-]*[rf]|\brm\s+--(recursive|force)|\bmkfs|\bshred\b|\bdd\b[^|]*\bof=/,
    why: '不可逆的删除或磁盘写入'
  },
  {
    id: 'perm-change',
    re: /\bchmod\s+(-R|[0-7]{3,4}\s+\/)|\bchown\s+-R/,
    why: '批量改权限或属主'
  },
  {
    id: 'pipe-to-shell',
    re: /(curl|wget)[^|;]*\|\s*(sudo\s+)?(ba)?sh|(curl|wget)[^;]*\s-o\s/,
    why: '把网络内容直接喂给 shell 执行'
  },
  { id: 'obfuscated', re: /base64\s+(-d|--decode)|\beval\b|\bxxd\s+-r/, why: '解码后执行，内容不可审计' },
  { id: 'remote-shell', re: /\b(nc|ncat|netcat|ssh|scp|rsync)\b/, why: '出网或远程执行' },
  {
    id: 'git-destructive',
    re: /git\s+(-c\s|push\s+[^|]*--force|reset\s+--hard|clean\s+-[a-z]*f|filter-branch)/,
    why: '破坏性 Git 操作或用 -c 临时改配置（可借此执行任意代码）'
  },
  {
    /* 路径可能出现在 JSON 里（前面是 `/` 或 `"`），也可能是命令行参数（前面是空格）。
       之前只认引号和空格，`"/Users/x/proj/.env"` 这种最常见的形态反而漏了。 */
    id: 'protected-path',
    re: /[\s"'=/](\.(git|claude|ssh|aws|gnupg)\/|\.env(\.|"|'|$|\s)|\.zshrc|\.bashrc|\.profile|\.envrc|\.netrc|Makefile)|\.github\/workflows\//,
    why: '写入配置、凭证或会被自动执行的文件'
  }
]

/**
 * 文件编辑类工具：它们的 content / new_string 是**要写进去的数据**，不是要执行的命令。
 * 拿命令形规则去扫正文，等于「写一段提到 sudo 的 markdown」= 提权告警。
 */
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'StrReplace'])
const CONTENT_FIELDS = ['content', 'new_string', 'old_string', 'new_str', 'old_str', 'edits']

/**
 * 从 tool_input 里把所有可能承载命令/路径的字段抽出来一起看。
 *
 * 默认整份 JSON 串起来：危险内容藏在哪个字段都拦得住，只看 command/file_path
 * 会被没预料到的字段绕过。**唯一的例外**是上面那批文件编辑工具的正文字段 ——
 * 那不是命令面。这笔账要这么算：漏判一次只是少一条提示（默认本来就是转人工，
 * 自动放行清单是空的，什么都没被放过）；而误报一次是在腐蚀唯一有牙齿的那个状态，
 * 天天见的告警会被训练成肌肉记忆，真危险那次照样一键批准。
 * 注意 file_path 不在剔除清单里，所以「写 .env」依然会被 protected-path 拦下。
 */
function surfaceOf(toolName: string, input: unknown): string {
  if (input == null) return ''
  if (typeof input === 'string') return input
  try {
    if (FILE_TOOLS.has(toolName) && typeof input === 'object') {
      const rest: Record<string, unknown> = { ...(input as Record<string, unknown>) }
      for (const k of CONTENT_FIELDS) delete rest[k]
      return JSON.stringify(rest)
    }
    return JSON.stringify(input)
  } catch {
    return String(input)
  }
}

export interface PolicyInput {
  toolName: string
  /** **完整**的 tool_input，不能传截断摘要 */
  rawInput: unknown
  cwd: string
  /** 用户已登记的项目根目录，用于判断 cwd 是否在管辖范围内 */
  knownRoots: string[]
  /** Claude 的 permission_mode；非 default 说明用户已放宽，我们不再自作主张 */
  permissionMode?: string
}

/**
 * 判定一次工具调用。
 * 注意返回值里**没有 allow** —— 这是设计，不是没写完。
 */
export function evaluate(inp: PolicyInput): PolicyVerdict {
  const surface = surfaceOf(inp.toolName, inp.rawInput)

  for (const r of HARD_DENY) {
    if (r.re.test(surface)) {
      return { decision: 'deny', rule: r.id, reason: `${r.why}（命中规则 ${r.id}）` }
    }
  }

  // 解析不出内容 → 转人工，绝不因为"看起来没事"就放过
  if (!surface) {
    return { decision: 'require_human', rule: 'empty-input', reason: '读不出调用内容' }
  }
  if (inp.permissionMode && inp.permissionMode !== 'default') {
    return {
      decision: 'require_human',
      rule: 'permission-mode',
      reason: `会话权限模式是 ${inp.permissionMode}，不做任何自动判断`
    }
  }
  // 前缀比较必须带分隔符，否则 /proj-evil 会被当成 /proj 里面
  const inRoot = (root: string): boolean =>
    inp.cwd === root || inp.cwd.startsWith(root.endsWith('/') ? root : `${root}/`)
  if (inp.cwd && inp.knownRoots.length && !inp.knownRoots.some(inRoot)) {
    return {
      decision: 'require_human',
      rule: 'cwd-outside',
      reason: `工作目录 ${inp.cwd} 不在已登记的项目范围内`
    }
  }

  return {
    decision: 'require_human',
    rule: 'default',
    reason: '默认转人工 —— 自动放行清单是空的，这是设计'
  }
}

/** 给人看的风险摘要（管家的"翻译"职责可以由 LLM 增强，但结论仍来自上面的规则） */
export function explain(v: PolicyVerdict): string {
  return v.decision === 'deny' ? `建议拒绝：${v.reason}` : `需要你决定：${v.reason}`
}
