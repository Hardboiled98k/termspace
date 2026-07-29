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
  /** 已明确解析为密码的片段；即使不足 4 字符也必须抹掉 */
  passwords: string[]
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

/**
 * 查询参数里的**连接目标**类键。这些能改变"连到哪台机器、连成谁"，
 * 丢掉一个就可能连错库 —— 而连错库在可写 broker 上是会真写进去的。
 */
const TARGET_PARAM_ENV: Record<string, string> = {
  host: 'PGHOST',
  hostaddr: 'PGHOSTADDR',
  port: 'PGPORT',
  user: 'PGUSER',
  password: 'PGPASSWORD',
  dbname: 'PGDATABASE'
}

/**
 * 认不出来就必须拒绝的参数形状。
 *
 * 只挡"影响连到哪/连成谁/怎么认证"的那类 —— 剩下的（`application_name` 之类）
 * 丢了只是少个标签，不值得为此把合法连接串整个拒掉。
 */
const RISKY_UNKNOWN_PARAM = /^(host|hostaddr|port|user|password|dbname|passfile|service|require|channel_binding|krb|gss|ssl|sslmode|target_session_attrs|load_balance)/

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
      let closed = false
      while (i < s.length && s[i] !== "'") {
        if (s[i] === '\\') {
          i++
          if (i >= s.length) return null
        }
        val += s[i++]
      }
      if (s[i] === "'") {
        closed = true
        i++
      }
      if (!closed) return null
    } else {
      while (i < s.length && !/\s/.test(s[i]!)) {
        if (s[i] === '\\') {
          i++
          if (i >= s.length) return null
        }
        val += s[i++]
      }
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
  const passwords = new Set<string>()

  const put = (k: string, v: string | undefined): void => {
    if (v !== undefined && v !== '') env[k] = v
  }

  if (/^postgres(ql)?:\/\//i.test(t)) {
    /* URL 里的用户名/密码是**百分号编码**的，必须解码后再交给 libpq ——
       不解码的话带 `@` `/` `:` 的密码会静默认证失败，而报错只说 password authentication failed。 */
    const dec = (v: string): string | null => {
      try {
        return decodeURIComponent(v)
      } catch {
        return null
      }
    }

    const match = /^(?:postgres(?:ql)?):\/\/([^/?#]*)(\/[^?#]*)?(?:\?([^#]*))?$/i.exec(t)
    if (!match) return null
    let authority = match[1]!
    const path = match[2] ?? ''
    const query = match[3] ?? ''

    const at = authority.lastIndexOf('@')
    if (at >= 0) {
      const userinfo = authority.slice(0, at)
      authority = authority.slice(at + 1)
      const colon = userinfo.indexOf(':')
      const rawUser = colon < 0 ? userinfo : userinfo.slice(0, colon)
      const user = dec(rawUser)
      if (user === null) return null
      put('PGUSER', user)
      if (colon >= 0) {
        const rawPassword = userinfo.slice(colon + 1)
        const password = dec(rawPassword)
        if (password === null) return null
        put('PGPASSWORD', password)
        if (password) {
          secrets.add(password)
          passwords.add(password)
        }
        if (rawPassword) {
          secrets.add(rawPassword)
          passwords.add(rawPassword)
        }
      }
    }

    // WHATWG URL 不接受 libpq 合法的 `host1:5432,host2:5433`，所以 authority 要自己拆。
    const hostSpecs = authority ? authority.split(',') : []
    const hosts: string[] = []
    const ports: string[] = []
    for (const spec of hostSpecs) {
      if (!spec) return null
      let rawHost: string
      let port = ''
      if (spec.startsWith('[')) {
        const close = spec.indexOf(']')
        if (close < 0 || (spec.slice(close + 1) && !/^:\d+$/.test(spec.slice(close + 1)))) return null
        rawHost = spec.slice(1, close)
        port = spec.slice(close + 1).replace(/^:/, '')
      } else {
        const colon = spec.lastIndexOf(':')
        if (colon >= 0) {
          if (spec.indexOf(':') !== colon || !/^\d+$/.test(spec.slice(colon + 1))) return null
          rawHost = spec.slice(0, colon)
          port = spec.slice(colon + 1)
        } else {
          rawHost = spec
        }
      }
      const host = dec(rawHost)
      if (host === null || !host) return null
      hosts.push(host)
      ports.push(port)
    }
    put('PGHOST', hosts.join(','))
    if (ports.some(Boolean)) put('PGPORT', ports.join(','))
    const db = dec(path.replace(/^\//, ''))
    if (db === null) return null
    put('PGDATABASE', db)
    /* **查询参数里也能指定连接目标**，这是合法的 libpq URI：
         postgresql:///mydb?host=%2Fcustom%2Fsocket
       真 psql 实测确实会去连 `/custom/socket`。老实现只认 sslmode 那几个、
       把 `host=` 静默丢掉 → 我们连默认 socket，而**可写 broker 就会写错库**
       （那个库恰好同名时不会有任何报错）。
       所以连接目标类参数必须支持，且**认不出来的一律拒绝，绝不静默忽略**。 */
    for (const [k, v] of new URLSearchParams(query)) {
      const key = k.toLowerCase()
      const envKey = PARAM_ENV[key] ?? TARGET_PARAM_ENV[key]
      if (envKey) {
        put(envKey, v)
        if (key === 'password' && v) {
          secrets.add(v)
          passwords.add(v)
        }
        continue
      }
      // 影响"连到哪 / 连成谁"的参数认不出来 = fail closed
      if (RISKY_UNKNOWN_PARAM.test(key)) return null
    }
    return { env, secrets: [...secrets].filter(Boolean), passwords: [...passwords].filter(Boolean) }
  }

  if (t.includes('=')) {
    const kv = parseKeyValueConninfo(t)
    if (!kv) return null
    for (const [k, v] of Object.entries(kv)) {
      const envKey = KV_ENV[k]
      if (!envKey) continue
      put(envKey, v)
      if (k === 'password' && v) {
        secrets.add(v)
        passwords.add(v)
      }
    }
    // 至少要认出点什么，否则等于没解析
    return Object.keys(env).length
      ? { env, secrets: [...secrets].filter(Boolean), passwords: [...passwords].filter(Boolean) }
      : null
  }

  /* 光秃秃一个名字：这才是真正的 dbname（本机 socket + 当前用户）。
     只有这一种情况才该出现在 PGDATABASE 里。 */
  put('PGDATABASE', t)
  return { env, secrets: [...secrets].filter(Boolean), passwords: [...passwords].filter(Boolean) }
}

/**
 * 从输出里抹掉所有敏感片段。
 *
 * **必须逐片段抹，不能只抹整条连接串** —— psql 会把"数据库名"截断到 63 字节，
 * 截断后的串仍含完整密码，而整串精确替换匹配不上它。
 * 同时兜一道：任何形如 `://user:pw@` 的片段里的密码位一律打掉。
 */
export function scrubSecrets(text: string, secrets: string[], passwords: string[] = []): string {
  let out = text
  // 长的先替换，避免短片段先把长片段切碎
  const explicitPasswords = new Set(passwords.filter(Boolean))
  for (const s of [...new Set([...secrets, ...explicitPasswords])]
    .filter((s) => s.length >= 4 || explicitPasswords.has(s))
    .toSorted((a, b) => b.length - a.length)) {
    out = out.split(s).join('«已隐去»')
  }
  return out.replace(/(:\/\/[^:@\s/]*):[^@\s]+@/g, '$1:«已隐去»@')
}
