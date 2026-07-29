/**
 * 代理连接（brokered profiles）—— **agent 用得到，但拿不到凭证**。
 *
 * 今天把凭证的文案改诚实了：identity 是环境变量注入的，那个终端里的 agent 读得到。
 * 这个模块是**真正解决**它的那条路：连接细节留在主进程，agent 只拿到一个
 * 窄操作能力（"在 prod-db 上跑这条只读 SQL"），而不是一把钥匙。
 *
 * ⚠️ **只对能 broker 的协议承诺，不泛化到任意 env key**（codex 特别提醒过）：
 * API key 作为环境变量注入时做不到知情/使用分离，那是协议本身的性质，
 * 不是实现努力一下就能绕开的。这里只做 ssh 和 postgres。
 *
 * 边界要如实说清楚（和授权模型那节同一个态度）：
 * 所有终端与 app 同 UID，能读 app 内存的进程本来就能拿到一切 ——
 * 这挡的是**agent 被提示词注入后顺手把 key 发出去**，
 * 不是挡一个已经拿到本机代码执行权的攻击者。
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { pgConnFromTarget, scrubSecrets } from './pg-conninfo.ts'

export type BrokerKind = 'ssh' | 'postgres'

export interface BrokerProfile {
  id: string
  name: string
  kind: BrokerKind
  /** ssh：alias 或 user@host；postgres：连接串（**只存在主进程**） */
  target: string
  /** 只读模式：postgres 拒绝写语句，ssh 拒绝非白名单命令 */
  readOnly: boolean
}

/**
 * 明确的写操作关键字。**只用来判"是不是写"，不是 SQL 解析器** ——
 * 真正的只读保证来自连接时的 `default_transaction_read_only`，
 * 这一层是提前把话说清楚（错误消息比"权限不足"有用得多）。
 */
const WRITE_SQL =
  /^\s*(insert|update|delete|drop|truncate|alter|create|grant|revoke|copy|vacuum|reindex|call|do|merge)\b/i

export function isWriteSql(sql: string): boolean {
  // 去掉前导注释再判：`-- x\nDELETE …` 不能因为第一行是注释就过关
  const stripped = sql.replace(/^(\s*(--[^\n]*|\/\*[\s\S]*?\*\/)\s*)+/, '')
  return WRITE_SQL.test(stripped)
}

/**
 * 多语句检测。`select 1; drop table x` —— 只看开头的判据会放过它。
 * **分号在字符串字面量里不算**，所以要先剥掉引号内的内容。
 */
export function hasMultipleStatements(sql: string): boolean {
  const noStrings = sql.replace(/'([^']|'')*'/g, "''").replace(/"([^"]|"")*"/g, '""')
  return noStrings.replace(/;\s*$/, '').includes(';')
}

export interface BrokerResult {
  ok: boolean
  output: string
  error?: string
}

/** ssh 只读模式下允许的命令。白名单式，认不出一律拒 —— 和 peer alias 是同一个道理 */
const SSH_READONLY = new Set([
  'ls',
  'cat',
  'tail',
  'head',
  'df',
  'du',
  'uptime',
  'free',
  'ps',
  'systemctl',
  'journalctl',
  'docker',
  'git'
])

export function sshCommandAllowed(cmd: string, readOnly: boolean): boolean {
  if (!readOnly) return true
  const first = cmd.trim().split(/\s+/)[0] ?? ''
  if (!SSH_READONLY.has(first)) return false
  /* **单个命令，不给管道和分隔符** —— 白名单挡住第一个词毫无意义，
     如果后面能跟 `; rm -rf /`。这些字符在只读探查里也用不上。 */
  return !/[;&|`$<>(){}]/.test(cmd) && !cmd.includes('\n')
}

export interface BrokerDeps {
  /** 找可执行文件（Finder 启动不继承登录 shell 的 PATH） */
  findBin?: (name: string) => string | null
}

/** 用户 options 在前，只读约束在后，确保后一个 `-c` 最终生效。 */
export function readonlyPgOptions(userOptions: string | undefined): string {
  return [userOptions, '-c default_transaction_read_only=on'].filter(Boolean).join(' ')
}

const defaultFind = (name: string): string | null =>
  [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`].find(existsSync) ??
  null

const run = (bin: string, args: string[], input?: string, timeout = 30_000): Promise<BrokerResult> =>
  new Promise((resolve) => {
    const child = execFile(
      bin,
      args,
      { timeout, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) =>
        resolve(
          err
            ? { ok: false, output: stdout ?? '', error: (stderr || err.message || '').slice(0, 2000) }
            : { ok: true, output: (stdout ?? '').slice(0, 100_000) }
        )
    )
    if (input !== undefined) {
      child.stdin?.end(input)
    }
  })

/**
 * 执行一次代理调用。
 *
 * **凭证不出这个函数**：ssh 走用户已有的配置（我们只传 alias），
 * postgres 的连接串走**环境变量**而不是 argv（`ps` 对同机所有用户可见）。
 */
export async function brokerRun(
  profile: BrokerProfile,
  payload: string,
  deps: BrokerDeps = {}
): Promise<BrokerResult> {
  const find = deps.findBin ?? defaultFind
  if (!payload.trim()) return { ok: false, output: '', error: '空请求' }
  if (payload.length > 8000) return { ok: false, output: '', error: '请求过长（上限 8000 字符）' }

  if (profile.kind === 'ssh') {
    if (!sshCommandAllowed(payload, profile.readOnly)) {
      return {
        ok: false,
        output: '',
        error: `只读连接不允许这条命令。允许的：${[...SSH_READONLY].join(' ')}（不含管道/分号）`
      }
    }
    const bin = find('ssh')
    if (!bin) return { ok: false, output: '', error: '本机没找到 ssh' }
    /* `--` 之后 ssh 不再解析选项。target 仍然要白名单（调用方负责），
       这里再挡一次形状：alias 里出现 `-o` 就是本机任意命令执行。 */
    if (profile.target.startsWith('-') || /[\s;&|`$]/.test(profile.target)) {
      return { ok: false, output: '', error: '连接目标不合法' }
    }
    return run(bin, ['-o', 'BatchMode=yes', profile.target, '--', payload])
  }

  // postgres
  if (profile.readOnly) {
    if (isWriteSql(payload)) {
      return { ok: false, output: '', error: '这是只读连接，拒绝写语句' }
    }
    if (hasMultipleStatements(payload)) {
      return { ok: false, output: '', error: '只读连接一次只允许一条语句（挡 `select 1; drop …`）' }
    }
  }
  const bin = find('psql')
  if (!bin) return { ok: false, output: '', error: '本机没找到 psql' }
  /* **连接串必须解析成逐字段的 PG* 变量**，绝不能整条塞进 `PGDATABASE`。
     实测（psql 17.5）：那样会连到本机 socket、把整条 URI 当数据库名，
     也就是**从来连不上用户配的服务器**；而且报错里带着连接串、
     还会被截断到 63 字节 —— 截断后仍含完整密码，"整串精确替换"的脱敏匹配不上。
     详见 pg-conninfo.ts 的文件头。 */
  const conn = pgConnFromTarget(profile.target)
  if (!conn) {
    return {
      ok: false,
      output: '',
      error: '连接串解析不了。支持 postgres://user:pw@host:port/db、key=value 形式，或光一个数据库名。'
    }
  }
  /* **连接串走环境变量，绝不进 argv** —— `ps -Ao args` 对同机所有用户可见，
     而连接串里通常带密码。SQL 走 stdin，同理（也避免超长 argv）。 */
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      [
        ...(profile.readOnly ? ['-v', 'ON_ERROR_STOP=1'] : []),
        '--no-psqlrc',
        '-P',
        'pager=off',
        '-f',
        '-'
      ],
      {
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
        env: {
          ...process.env,
          PGCONNECT_TIMEOUT: '10',
          // 逐字段（含 PGPASSWORD）。密码走 env 不走 argv —— `ps -Ao args` 同机所有用户可见
          ...conn.env,
          /* 只读**在服务端也再保一道**：上面的语句判据只是提前给个好错误，
             真正的保证是这个 —— 它让整个会话进只读事务。 */
          ...(profile.readOnly ? { PGOPTIONS: readonlyPgOptions(conn.env['PGOPTIONS']) } : {})
        }
      },
      (err, stdout, stderr) =>
        /* **结构化脱敏在这一层做**：psql 的报错会把密码以各种变形吐出来
           （截断的"数据库名"、`://user:pw@` 片段），上层那个"整串精确替换"挡不住。 */
        resolve(
          err
            ? {
                ok: false,
                output: scrubSecrets(stdout ?? '', conn.secrets, conn.passwords),
                error: scrubSecrets(
                  (stderr || err.message || '').slice(0, 2000),
                  conn.secrets,
                  conn.passwords
                )
              }
            : {
                ok: true,
                output: scrubSecrets((stdout ?? '').slice(0, 100_000), conn.secrets, conn.passwords)
              }
        )
    )
    child.stdin?.end(`${payload}\n`)
  })
}
