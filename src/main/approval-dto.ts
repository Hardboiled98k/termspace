/**
 * 审批记录的两种形态与**唯一**的脱敏出口。
 *
 * 单独成文件是为了可测：hooks.ts 依赖 electron，跑不进 `node --test`，
 * 而"完整 tool_input 不能出主进程"这条不变量恰恰是最需要回归网兜住的。
 */

/** 给 UI / 远程端看的脱敏审批卡片 —— 摘要是截断的，**不可用于安全判定** */
export interface PendingApproval {
  id: string
  nodeId: string
  toolName: string
  /** tool_input 的单行摘要，够用户判断该不该批；已截断，见 PendingApprovalFull */
  summary: string
  toolUseId: string
  createdAt: number
  /** 判定用的关键上下文（做规则引擎时要绑它，不能只绑 toolUseId —— 官方不保证该字段存在） */
  sessionId: string
  cwd: string
  /** 完整 tool_input 的 sha256，用于"批准的确实是当时看到的那一个" */
  inputHash: string
}

/**
 * 主进程内部保留的完整记录。
 * **摘要截断到 300 字，危险内容可以藏在截断之后** —— 任何自动放行的规则判定
 * 必须读这里的 rawInput，绝不能拿 summary 去匹配。
 */
export interface PendingApprovalFull extends PendingApproval {
  rawInput: unknown
  /** 会话的 permission_mode。非 default 说明用户已自行放宽，规则引擎不再自作主张 */
  permissionMode: string
}

/**
 * **唯一**的脱敏出口。任何要离开主进程的审批记录都必须过这里。
 *
 * 逐字段构造，而不是 `{...rec, rawInput: undefined}` 之流：将来给
 * PendingApprovalFull 加字段时，默认是**不**外泄，得显式加进来才会出去。
 *
 * 为什么要抽出来：之前脱敏只做在 listApprovals 里，而实时推送走的是另一条
 * （publish → onApprovals），它直接吐了完整 rec —— 完整 tool_input（可能含
 * 文件正文、命令、密钥）就这么进了 renderer，还从 /api/events 出了网。
 * 两条路径各写一份脱敏，迟早漏一条。
 */
export function toPublicApproval(rec: PendingApprovalFull): PendingApproval {
  return {
    id: rec.id,
    nodeId: rec.nodeId,
    toolName: rec.toolName,
    summary: rec.summary,
    toolUseId: rec.toolUseId,
    createdAt: rec.createdAt,
    sessionId: rec.sessionId,
    cwd: rec.cwd,
    inputHash: rec.inputHash
  }
}
