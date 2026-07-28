/**
 * PostgreSQL 连接串 → 逐字段的 `PG*` 环境变量。
 *
 * ## 为什么不能直接把连接串塞进 `PGDATABASE`
 *
 * 老实现这么干了，注释还写着「dbname 以 URI 前缀开头时 libpq 会把它当整条 conninfo 展开」。
 * **实测（psql 17.5）证伪**：
 *
 * ```
 * PGDATABASE='postgresql://tbuser:FAKEPW@127.0.0.1:1/tbdb' psql -c 'select 1'
 * → connection to server on socket "/tmp/.s.PGSQL.5432" failed:
 *   FATAL: database "postgresql://tbuser:FAKEPW@127.0.0.1:1/tbdb" does not exist
 * ```
 *
 * 也就是说 `tb db` **从来就连不上用户配的服务器**，而是连本机 socket、
 * 把整条 URI 当成数据库名。conninfo 的展开只发生在
 * `PQconnectdb` / `PQconnectdbParams(expand_dbname=1)` 那条路上
 * （psql 的 `-d` 参数），环境变量兜底不走那里。
 *
 * ## 而且它会泄密码
 *
 * 报错里带着那个"数据库名"，也就是完整连接串。更糟的是**会被截断到 63 字节**
 * （NAMEDATALEN-1），实测 128 字符的 URI 截断后**仍然含着完整密码**，
 * 而调用方的脱敏是"整串精确替换" —— 匹配不上截断版，密码于是进了返回给 agent 的文本
 * 和任务账本。
 *
 * ## 所以：解析出来分字段传，并且**结构化脱敏**
 *
 * 密码单独走 `PGPASSWORD`（env 不是 argv —— `ps -Ao args` 同机所有用户可见）。
 * `secrets` 返回所有需要从输出里抹掉的片段，调用方逐个替换，
 * 不再依赖"整条连接串会原样出现"这个不成立的前提。
 *
 * 解析不出来就**返回 null**（调用方报错），绝不退回"当成 dbname 试一下" ——
 * 那正好是现在这个 bug。
 */

export interface PgConn {
  /** 传给子进程的 PG* 变量 */
  env: Record<string, string>
  /** 必须从任何输出里抹掉的片段（密码、以及原始连接串本身） */
  secrets: string[]
}

/** URI 查询参数 → 对应的 libpq 环境变量。只放常用且无歧义的 */
const PARAM_ENV: Record<string, string> = {
  sslmode: 'PGSSLMODE',
  sslrootcert: 'PGSSLROOTCERT',
  sslcert: 'PGSSLCERT',
  sslkey: 'PGSSLKEY',
  application_name: 'PGAPPNAME',
  connect_timeout: 'PGCONNECT_TIMEOUT',
  options: 'PGOPTIONS',
  target_session_attrs: 'PGTARGETSESSIONATTRS'
}

/** `key=value key='v with space'` 形式的 conninfo 拆成键值对 */
export function parseKeyValueConninfo(s: string): Record<string, string> | null {
  const out: Record<string, string> = {}
  let i = 0
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i]!)) i++
    if (i >= s.length) break
    const eq = s.indexOf('=', i)
    if (eq < 0) return null
    const key = s.slice(i, eq).trim().toLowerCase()
    if (!/^[a-z_][a-z0-9_]*$/.test(key)) return null
    i = eq + 1
    while (i < s.length && /\s/.test(s[i]!)) i++
    let val = ''
    if (s[i] === "'") {
      i++
      while (i < s.length && s[i] !== "'") {
        if (s[i] === '\\') i++
        val += s[i++]
      }
      i++ // 收尾引号
    } else {
      while (i < s.length && !/\s/.test(s[i]!)) val += s[i++]
    }
    out[key] = val
  }
  return Object.keys(out).length ? out : null
}

const KV_ENV: Record<string, string> = {
  host: 'PGHOST',
  hostaddr: 'PGHOSTADDR',
  port: 'PGPORT',
  user: 'PGUSER',
  password: 'PGPASSWORD',
  dbname: 'PGDATABASE',
  ...PARAM_ENV
}

export function pgConnFromTarget(target: string): PgConn | null {
  const t = target.trim()
  if (!t) return null
  const env: Record<string, string> = {}
  const secrets = new Set<string>([t])

  const put = (k: string, v: string | undefined): void => {
    if (v !== undefined && v !== '') env[k] = v
  }

  if (/^postgres(ql)?:\/\//i.test(t)) {
    let u: URL
    try {
      u = new URL(t)
    } catch {
      return null
    }
    /* URL 里的用户名/密码是**百分号编码**的，必须解码后再交给 libpq ——
       不解码的话带 `@` `/` `:` 的密码会静默认证失败，而报错只说 password authentication failed。 */
    const dec = (v: string): string => {
      try {
        return decodeURIComponent(v)
      } catch {
        return v
      }
    }
    put('PGUSER', dec(u.username))
    if (u.password) {
      const pw = dec(u.password)
      put('PGPASSWORD', pw)
      secrets.add(pw)
      secrets.add(u.password) // 编码前后两种形态都要能抹掉
    }
    // 主机可以是 unix socket 目录（百分号编码），也可以是逗号分隔的多主机
    put('PGHOST', dec(u.hostname))
    put('PGPORT', u.port)
    const db = dec(u.pathname.replace(/^\//, ''))
    put('PGDATABASE', db)
    for (const [k, v] of u.searchParams) {
      const envKey = PARAM_ENV[k.toLowerCase()]
      if (envKey) put(envKey, v)
    }
    return { env, secrets: [...secrets].filter(Boolean) }
  }

  if (t.includes('=')) {
    const kv = parseKeyValueConninfo(t)
    if (!kv) return null
    for (const [k, v] of Object.entries(kv)) {
      const envKey = KV_ENV[k]
      if (!envKey) continue
      put(envKey, v)
      if (k === 'password' && v) secrets.add(v)
    }
    // 至少要认出点什么，否则等于没解析
    return Object.keys(env).length ? { env, secrets: [...secrets].filter(Boolean) } : null
  }

  /* 光秃秃一个名字：这才是真正的 dbname（本机 socket + 当前用户）。
     只有这一种情况才该出现在 PGDATABASE 里。 */
  put('PGDATABASE', t)
  return { env, secrets: [...secrets].filter(Boolean) }
}

/**
 * 从输出里抹掉所有敏感片段。
 *
 * **必须逐片段抹，不能只抹整条连接串** —— psql 会把"数据库名"截断到 63 字节，
 * 截断后的串仍含完整密码，而整串精确替换匹配不上它。
 * 同时兜一道：任何形如 `://user:pw@` 的片段里的密码位一律打掉。
 */
export function scrubSecrets(text: string, secrets: string[]): string {
  let out = text
  // 长的先替换，避免短片段先把长片段切碎
  for (const s of [...secrets].filter((s) => s.length >= 4).toSorted((a, b) => b.length - a.length)) {
    out = out.split(s).join('«已隐去»')
  }
  return out.replace(/(:\/\/[^:@\s/]+):[^@\s]+@/g, '$1:«已隐去»@')
}
