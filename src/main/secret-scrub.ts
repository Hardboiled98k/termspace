/**
 * 脱敏引擎 —— **全项目唯一一份**。
 *
 * 之前有两份几乎一样的实现（`pg-conninfo.scrubSecrets` 和 `broker-handler.scrubAll`），
 * 而且**已经漂移了**：前者支持"明确密码不设长度门槛"和 URI userinfo 兜底，后者不支持。
 * 这个仓库对同一件事留两个出口已经栽过三次（审批记录的 `tool_input`、邮箱脱敏、
 * 连接串解析的两条分支），判据早就写死在 CLAUDE.md 里：**脱敏只能有一个出口。**
 *
 * 分工：**这里只管"怎么抹"，各领域只管"抹什么"。**
 * SQL / shell / conninfo 三种提取器留在各自模块，它们的语法差别很大、
 * 合并只会得到一个谁都看不懂的巨型正则。
 *
 * 两类 secret 必须分开，这是本文件存在的核心理由：
 *
 * | | 长度门槛 | 为什么 |
 * |---|---|---|
 * | `secrets` 普通片段 | **≥4 字符** | 解析出来的空/短字段参与全局替换会把正常输出切碎：一个 1 字符的"密码"会把 `select` 里的每个字母都打码，查询结果直接不可读 |
 * | `passwords` 明确密码 | **不设门槛** | 已经确定是密码的东西，`abc` 也得抹。用弱口令是用户的事，替他泄漏是我们的事 |
 */

const MASK = '«已隐去»'

/** 普通片段参与全局替换的最短长度。比它短就跳过（见文件头的表） */
export const MIN_GENERIC_SECRET = 4

export interface ScrubInput {
  /** 一般敏感片段（整条连接串之类）。太短的会被跳过 */
  secrets?: readonly string[]
  /** **已确定是密码**的片段。不论多短都抹 */
  passwords?: readonly string[]
}

/**
 * 把所有 secret 从文本里抹掉。
 *
 * **长的先替换** —— 否则短片段会把长片段切碎，剩下的残段反而漏出去。
 * 最后再兜一道 `://user:pw@` 形状：外部工具（psql / ssh）的报错会把连接串
 * 变形回显，逐字替换匹配不上那些变形。
 */
export function scrub(text: string, input: ScrubInput): string {
  const parts = [
    ...(input.passwords ?? []).filter((s) => s.length > 0),
    ...(input.secrets ?? []).filter((s) => s.length >= MIN_GENERIC_SECRET)
  ]
  let out = text
  for (const s of [...new Set(parts)].toSorted((a, b) => b.length - a.length)) {
    out = out.split(s).join(MASK)
  }
  /* 用户名可以为空（`postgresql://:pw@h/db` 是合法的），所以那一段用 `*` 不用 `+` ——
     写成 `+` 的话空用户名的 URI 整个匹配不上，密码原样漏出去。 */
  return out.replace(/(:\/\/[^:@\s/]*):[^@\s]+@/g, `$1:${MASK}@`)
}
