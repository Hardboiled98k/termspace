/**
 * 钉住账号存在、登录态和额度能力的展示合同。
 *
 * 「查不到」「未登录」「用了 0%」是三种不同的东西：
 * 未登录能自己修（去跑一次 login），查不到只能等；只有拿到 ok/stale
 * 观测时才允许出现进度条，绝不能用空槽或 0% 冒充未知。
 */
export interface QuotaDisplayInput {
  state: 'ok' | 'stale' | 'unconfigured' | 'unavailable' | 'unknown-shape'
  quotaCapability:
    | 'supported'
    | 'officially_unavailable'
    | 'web_only'
    | 'admin_only'
    | 'blocked_by_policy'
    | 'collector_error'
  windows: unknown[]
}

export function hasQuotaProgress(a: QuotaDisplayInput): boolean {
  return (a.state === 'ok' || a.state === 'stale') && a.windows.length > 0
}

export function quotaUnavailableText(a: QuotaDisplayInput): string {
  if (a.state === 'unconfigured') return '未登录 —— 在用这个账号的终端里运行一次登录命令'
  if (a.quotaCapability === 'officially_unavailable') return '无官方程序化查询接口'
  if (a.quotaCapability === 'web_only') return '仅可在官方网页查看'
  if (a.quotaCapability === 'admin_only') return '仅管理员可查询'
  if (a.quotaCapability === 'blocked_by_policy') return '出于安全策略不读取额度'
  if (a.quotaCapability === 'collector_error' || a.state === 'unavailable') return '无法确认 —— 本次查询失败'
  if (a.state === 'unknown-shape') return '无法确认 —— 返回格式已变化'
  return '暂无数据'
}

/* 脱敏实现在 `src/shared/mask.ts` —— 主进程也要用同一份。
   这里只 re-export，**别在这里再写一份** */
export { maskEmail } from '../../shared/mask.ts'
