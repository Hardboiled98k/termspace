import { createHmac, randomBytes } from 'node:crypto'
import { scrub } from './secret-scrub.ts'
import type { BrokerProfile, BrokerResult } from './broker'

/**
 * 连接的安全语义指纹。**连接串本身绝不能进 key** —— key 会进弹窗文案、
 * 进任务账本、进日志。取 sha256 前 12 位：够区分改动，又反推不出原文。
 */
/* **进程内随机密钥。** grant 本来就只活在当前运行期（内存 Set，重启即失效），
   所以指纹没有跨进程稳定的必要 —— 而用随机密钥能顺带挡掉两件事：
   ① 48 位截断的构造碰撞（约 2^24 次哈希就能找到一对，攻击者可以预生成
      两个 readOnly 相同、target 不同的碰撞对，用户授权第一个之后换成第二个）；
   ② 对低熵 target（比如 `postgres://localhost/app`）做**离线字典比对**反推原文。 */
const REVISION_KEY = randomBytes(32)

export function brokerRevision(target: string, readOnly: boolean): string {
  // 不截断：指纹是给机器比对的，长一点没有任何代价
  return createHmac('sha256', REVISION_KEY).update(`${readOnly ? 'ro' : 'rw'}\u0000${target}`).digest('hex')
}

interface BrokerSettings {
  brokers: Array<Omit<BrokerProfile, 'target'>>
}

export interface BrokerMutationDeps {
  getSettings: () => Promise<BrokerSettings>
  setSettings: (patch: BrokerSettings) => Promise<unknown>
  setBrokerTarget: (id: string, target: string) => Promise<void>
  deleteBrokerTarget: (id: string) => Promise<void>
  randomId: () => string
}

export interface BrokerSaveInput {
  id?: string
  name: string
  kind: 'ssh' | 'postgres'
  readOnly?: boolean
  target?: string
}

type LedgerState = 'done' | 'failed' | 'timeout' | 'rejected'

interface LedgerMeta {
  source: string
  target: string
  task: string
  branch?: string
  classify?: (text: string) => LedgerState
}

export interface BrokerHandlerDeps {
  getSettings: () => Promise<BrokerSettings>
  getBrokerTarget: (id: string) => Promise<string | null>
  authorize: (source: string, target: string, what: string, detail: string) => Promise<boolean>
  run: (profile: BrokerProfile, payload: string) => Promise<BrokerResult>
  withLedger: (meta: LedgerMeta, run: () => Promise<string>) => Promise<string>
  branchOfNode: (source: string) => string | undefined
}

const redact = (text: string, secret: string): string =>
  secret ? text.split(secret).join('«已隐去»') : text

/**
 * 从 payload 里把**密码字面量**抠出来。
 *
 * 为什么要单独抠一份、而不是只对摘要做正则替换：
 * 密码不止出现在"我们发出去的那条语句"里 —— psql 会把出错的语句**原样回显**，
 * 于是 `执行失败：… ALTER ROLE alice PASSWORD 'x' …` 顺着返回值进了任务账本，
 * 而账本是**落盘持久化**的。只脱敏摘要挡不住这条。
 * （codex 第三轮 P1：这是第四条没走统一出口的密码路径。）
 *
 * 抠出来之后，摘要 / 成功输出 / 失败输出 / 账本结果**全部走同一份 secrets**。
 */
export function extractPayloadSecrets(kind: string, payload: string): string[] {
  const out = new Set<string>()
  /* **不设长度门槛。** 上一版丢掉了 <4 字符的 —— 但这里抠出来的东西
     **已经确定是密码**，`PASSWORD 'abc'` 也得抹。
     "太短会把正常输出切碎"那条判据只适用于**猜出来的**片段，
     不适用于语法上明确标着 PASSWORD 的。区分在 secret-scrub.ts 的两个通道。 */
  const add = (v?: string): void => {
    const t = v?.trim()
    if (t) out.add(t)
  }

  /* 连接串风格的 userinfo 密码。**任何 kind 都要查** ——
     ssh payload 里完全可能出现 `psql postgres://u:pw@h/db`（第五条路径之一）。 */
  for (const m of payload.matchAll(/:\/\/[^:@\s/]*:([^@\s]+)@/g)) add(m[1])

  /* `PGPASSWORD=x` / `MYSQL_PWD=x` 这类**环境变量前缀**。
     codex 第四轮点名的第五条路径：ssh payload 里 `PGPASSWORD=FifthSecret psql …`
     此前完全不识别。 */
  for (const m of payload.matchAll(
    /\b(?:PGPASSWORD|MYSQL_PWD|PGSSLPASSWORD|ANSIBLE_PASSWORD|SSHPASS)=(?:"([^"]*)"|'([^']*)'|(\S+))/g
  )) {
    add(m[1] ?? m[2] ?? m[3])
  }

  /* **SQL 改密语句任何 kind 都要查。**
     上一版把它关在 `if (kind === 'postgres')` 里 —— 而 agent 在 ssh 连接上跑 SQL
     是最普通不过的事：

       tb ssh prod "docker exec db psql -c \"ALTER ROLE app PASSWORD 'x'\""

     明文密码于是进了授权弹窗、进了**落盘保留 500 条**的 tasks.jsonl。
     这和上一轮已修的第五条路径（URI userinfo / `PGPASSWORD=` 前缀）
     是**同一条理由**："ssh payload 里完全可能出现 SQL" —— 那两条提上来了，这条漏了。 */
    /* 三种合法写法：普通引号、`E'…'`（转义字符串，**反斜杠可以转义引号**）、
       `$tag$…$tag$`（dollar-quoting，**tag 可以含数字**）。
       上一版的字符集不接受数字 tag，E-string 里的 `\'` 也会让正则提前结束。 */
    /* 捕获组编号必须和反向引用对齐：1=E'…' 2='…' 3="…" 4=dollar tag 5=dollar 内容，
       所以闭合是 `\4` 不是 `\5`。加了组之后忘改编号 → 整条 dollar-quoting 分支
       **静默匹配不上**（实测抠出来是空数组），而 typecheck 和别的用例都不会响。 */
    for (const m of payload.matchAll(
      /\b(?:PASSWORD|IDENTIFIED\s+BY)\s+(?:E'((?:\\.|''|[^'\\])*)'|'((?:[^']|'')*)'|"([^"]*)"|\$([A-Za-z_][A-Za-z0-9_]*|)\$([\s\S]*?)\$\4\$)/gi
    )) {
      add(m[1] ?? m[2] ?? m[3] ?? m[5])
    }

  if (kind === 'ssh') {
    /* `--password=x` 和 `--password x` 都认。
       ⚠️ **裸 `-p X` 只在 `sshpass` 上认**（codex 第四轮 P2 实测）：
       通用地认的话，`ssh -p 2222 host` 的**端口号**会被当密码，
       然后输出里所有 `2222` 都被打码；`tool -p status` 更是把 `status` 抹掉。
       脱敏过度和脱敏不足一样是 bug。
       MySQL 风格只认**紧贴**的 `-pSecret`（那是它的真实语法）。 */
    for (const m of payload.matchAll(
      /--password[=\s]+(?:"([^"]*)"|'([^']*)'|(\S+))/g
    )) {
      add(m[1] ?? m[2] ?? m[3])
    }
    for (const m of payload.matchAll(/\bsshpass\s+-p\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g)) {
      add(m[1] ?? m[2] ?? m[3])
    }
    for (const m of payload.matchAll(/(?:^|\s)-p(?:"([^"]*)"|'([^']*)'|([^\s-]\S*))/g)) {
      // 紧贴式（MySQL）：`-psecret`。`-p 22` 这种带空格的不在这条里
      add(m[1] ?? m[2] ?? m[3])
    }
  }
  return [...out]
}

/** 抹掉 payload 里抠出来的密码。**引擎在 `secret-scrub.ts`（全项目唯一一份）** */
export function scrubAll(text: string, passwords: string[]): string {
  // 走 passwords 通道：这些**已经确定是密码**，`abc` 这种也必须抹，不设长度门槛
  return scrub(text, { passwords })
}

/**
 * 只生成授权弹窗和任务账本使用的摘要；执行器仍收到**未经修改的原始 payload**。
 * 除完整连接串外，还要遮住 SQL 改密语句和 ssh 常见的命令行密码参数。
 */
export function summarizeBrokerPayload(kind: string, payload: string, target: string): string {
  return scrubAll(redact(payload, target), extractPayloadSecrets(kind, payload))
}

/**
 * broker 元数据和连接串分处两个存储，必须把它们的整段读改写放进同一条队列。
 * 否则并发保存会各自从旧列表计算 next，后写者覆盖前写者。
 */
export function createBrokerMutations(deps: BrokerMutationDeps): {
  save: (input: BrokerSaveInput) => Promise<
    { ok: true; brokers: BrokerSettings['brokers'] } | { ok: false; error: string }
  >
  delete: (id: string) => Promise<{ ok: true; brokers: BrokerSettings['brokers'] }>
} {
  let mutationChain: Promise<unknown> = Promise.resolve()
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = mutationChain.then(fn, fn)
    mutationChain = next.catch(() => undefined)
    return next
  }

  return {
    save: (input) =>
      serialize(async () => {
        const id = input.id || deps.randomId()
        const st = await deps.getSettings()
        if (
          st.brokers.some(
            (broker) =>
              broker.id !== id && broker.kind === input.kind && broker.name === input.name
          )
        ) {
          return { ok: false as const, error: '已有同名同类型的连接，先删掉那个' }
        }
        const existed = st.brokers.some((broker) => broker.id === id)
        const next = [
          ...st.brokers.filter((broker) => broker.id !== id),
          {
            id,
            name: input.name,
            kind: input.kind,
            readOnly: input.readOnly !== false
          }
        ]
        let targetWritten = false
        try {
          if (typeof input.target === 'string' && input.target) {
            await deps.setBrokerTarget(id, input.target)
            targetWritten = true
          }
          await deps.setSettings({ brokers: next })
          const keep = new Set(next.map((broker) => broker.id))
          await Promise.all(
            st.brokers
              .filter((broker) => !keep.has(broker.id))
              .map((broker) => deps.deleteBrokerTarget(broker.id))
          )
          return { ok: true as const, brokers: next }
        } catch (err) {
          if (targetWritten && !existed) await deps.deleteBrokerTarget(id).catch(() => undefined)
          return { ok: false as const, error: String((err as Error)?.message ?? err) }
        }
      }),
    delete: (id) =>
      serialize(async () => {
        const st = await deps.getSettings()
        const next = st.brokers.filter((broker) => broker.id !== id)
        await deps.setSettings({ brokers: next })
        await deps.deleteBrokerTarget(id)
        return { ok: true as const, brokers: next }
      })
  }
}

const DENIED = '已拒绝：'
const FAILED = '执行失败：'

/**
 * 代理连接结果 → 账本状态。
 *
 * **必须自带这一份**：`classifyDelegateResult` 认的是 `派活被拒` / `派活失败` 前缀，
 * 那是 delegate 的话术。这里的「执行失败：」「已拒绝：」一个都匹配不上，
 * 用默认分类会把**所有失败的代理调用都记成 done** —— 账本的失败优先排序
 * 对 `tb db` / `tb ssh` 整条链路静默失效。
 */
export function classifyBrokerResult(text: string): LedgerState {
  if (text.startsWith(DENIED)) return 'rejected'
  if (text.startsWith(FAILED)) return 'failed'
  return 'done'
}

/**
 * `tb db` / `tb ssh` 的主进程落点。
 *
 * 凭证先在主进程闭包内取出，再做最后一次授权；授权和 `run` 调用之间没有 await，
 * 避免授权后状态漂移，也避免为同一次操作连续弹两次窗。
 *
 * **记账从授权之前就开始**（与 `tb ask` 那条路一致：它的 withLedger 也包住了
 * delegate 内部的 authorize）。被拒的调用同样要留痕 —— "agent 想动生产库、我拦了"
 * 恰恰是这本账最该记的一条。
 */
export async function handleBroker(
  deps: BrokerHandlerDeps,
  source: string,
  kind: string,
  name: string,
  payload: string
): Promise<string> {
  /* 授权 key 必须带 kind。`db` 和 `ssh` 各有一个都叫 `prod` 的连接是完全合法的
     （`find` 就是按 name + kind 两个条件匹配的），key 只用 name 的话，
     用户给 `tb db prod` 点的那次「本次运行内不再询问」会把 `tb ssh prod` 一起放行。 */
  const profileLabel = `broker:${kind}:${name}`

  if (!source) {
    // 拿不到调用方就没法授权 —— fail-closed，且**在读连接串之前**就返回
    return `${DENIED}调用方节点未知，未获授权使用 ${profileLabel}。`
  }

  const cfg = await deps.getSettings()
  const prof = cfg.brokers.find((b) => b.name === name && b.kind === kind)
  if (!prof) {
    const avail = cfg.brokers.filter((b) => b.kind === kind).map((b) => b.name)
    return `没有名为「${name}」的${kind}连接。${avail.length ? `可用：${avail.join('、')}` : '去设置 → 代理连接里加一个。'}`
  }
  /* **用完整 id，不截前缀**。8 个十六进制字符只有 32 bit —— 随机 UUID 撞的概率虽低，
     但设置里的 id 并不强制是 UUID，可以**确定性地构造**一个同前缀的。
     撞上的后果是旧 grant 跳过授权弹窗、而连接串按新的完整 id 去取
     = 授权被转移给了另一条连接。授权 key 是给机器比对的，没有截短的理由。 */
  /* **授权 key 必须钉住"授权时看到的那个连接的安全语义"**，不只是它的 id。
     换完整 id 只挡住了"删了重建"；同一个 id 上把 target 改到别处、
     或把 readOnly 从 true 改成 false，authTarget 完全不变 ——
     用户当初为一个**只读的 staging** 勾的"本次不再询问"，
     会原样放行一个**可写的 prod**。（codex 第三轮 P1。）
     指纹只用**不泄密**的成分：readOnly 是布尔，target 只取它的 sha256 前 12 位。 */
  const target = await deps.getBrokerTarget(prof.id)
  if (!target) return `连接「${name}」还没配连接串（设置 → 代理连接）`
  // 指纹要连接串本身，所以必须在取到它之后才算得出来
  const authTarget = `${profileLabel}#${prof.id}@${brokerRevision(target, prof.readOnly)}`

  const safePayload = summarizeBrokerPayload(kind, payload, target)

  return deps.withLedger(
    {
      source,
      target: authTarget,
      task: safePayload.slice(0, 200),
      branch: deps.branchOfNode(source),
      classify: classifyBrokerResult
    },
    async () => {
      const ok = await deps.authorize(
        source,
        authTarget,
        '使用代理连接',
        `类型：${kind}\n连接名：${name}\n模式：${prof.readOnly ? '只读' : '可写'}\n将执行：${safePayload.slice(0, 300)}`
      )
      if (!ok) return `${DENIED}${source} 未获授权使用 ${authTarget}。`

      const r = await deps.run({ ...prof, kind: prof.kind, target }, payload)
      /* **返回值也要过同一份 secrets**：psql 会把出错的语句原样回显，
         `执行失败：… PASSWORD 'x' …` 会顺着这里进**落盘的**任务账本。 */
      const payloadSecrets = extractPayloadSecrets(kind, payload)
      if (!r.ok) return `${FAILED}${scrubAll(redact(r.error ?? '未知错误', target), payloadSecrets)}`
      return scrubAll(redact(r.output || '（无输出）', target), payloadSecrets)
    }
  )
}
