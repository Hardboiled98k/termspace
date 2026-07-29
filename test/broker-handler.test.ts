/**
 * 钉住 `tb db` / `tb ssh` 曾经绕过授权和任务账本的漏洞。
 *
 * 这里测的是可注入依赖的主进程 handler：拒绝授权或缺失 source 时绝不能触发
 * brokerRun；profile 换 id 后不能继承旧授权；并发保存不能丢更新或留下孤儿连接串；
 * SQL/ssh 内嵌的新密码不能进入授权详情和持久化账本摘要。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createBrokerMutations,
  handleBroker,
  classifyBrokerResult,
  extractPayloadSecrets,
  brokerRevision,
  type BrokerHandlerDeps
} from '../src/main/broker-handler.ts'
import { classifyDelegateResult } from '../src/main/delegate.ts'

const secret = 'postgres://admin:TOPSECRET@prod.example/app'

const makeDeps = () => {
  const calls = {
    authorize: [] as Array<{ source: string; target: string; detail: string }>,
    run: 0,
    ledger: [] as Array<{ event: 'start' | 'finish'; task?: string; target?: string; state?: string }>
  }
  const deps: BrokerHandlerDeps = {
    getSettings: async () => ({
      brokers: [
        { id: 'p1', name: 'prod', kind: 'postgres', readOnly: true },
        // 同名不同类型是合法配置 —— 授权 key 必须区分得开
        { id: 's1', name: 'prod', kind: 'ssh', readOnly: false }
      ]
    }),
    getBrokerTarget: async () => secret,
    authorize: async (source, target, _what, detail) => {
      calls.authorize.push({ source, target, detail })
      return true
    },
    run: async () => {
      calls.run += 1
      return { ok: true, output: 'ok' }
    },
    withLedger: async (meta, run) => {
      calls.ledger.push({ event: 'start', task: meta.task, target: meta.target })
      const result = await run()
      // 真实实现就是这么定状态的：没给 classify 就落到 delegate 那份
      calls.ledger.push({ event: 'finish', state: (meta.classify ?? classifyDelegateResult)(result) })
      return result
    },
    branchOfNode: () => 'feat/broker-gate'
  }
  return { deps, calls }
}

test('授权被拒时确实不会调用 brokerRun', async () => {
  const { deps, calls } = makeDeps()
  deps.authorize = async () => false

  const result = await handleBroker(deps, 'term-1', 'postgres', 'prod', 'select 1')

  assert.match(result, /^已拒绝：/)
  assert.equal(calls.run, 0)
})

test('**被拒的调用也要进账本**（拦下来这件事本身最该留痕）', async () => {
  /* `tb ask` 那条路的 withLedger 包在 delegate 外面，而 authorize 在 delegate 内部
     —— 所以它的拒绝是记账的。代理连接如果把 withLedger 放在授权之后，
     "agent 想动生产库、我拦了"就一个字都不会留下。 */
  const { deps, calls } = makeDeps()
  deps.authorize = async () => false

  await handleBroker(deps, 'term-1', 'postgres', 'prod', 'select 1')

  assert.deepEqual(calls.ledger.map((x) => x.event), ['start', 'finish'])
  assert.equal(calls.ledger[1]?.state, 'rejected')
})

test('**授权 key 必须带 kind**：db:prod 的授权不能白送给 ssh:prod', async () => {
  /* 两个连接都叫 prod（一个 postgres 一个 ssh）是合法配置。
     key 只用 name 的话，用户给 `tb db prod` 勾的"本次不再询问"
     会把 `tb ssh prod` 一起放行 —— 而那个是**可写**连接。 */
  const { deps, calls } = makeDeps()

  await handleBroker(deps, 'term-1', 'postgres', 'prod', 'select 1')
  await handleBroker(deps, 'term-1', 'ssh', 'prod', 'ls')

  const targets = calls.authorize.map((a) => a.target)
  assert.match(targets[0] ?? '', /^broker:postgres:prod#p1@[0-9a-f]{64}$/)
  assert.match(targets[1] ?? '', /^broker:ssh:prod#s1@[0-9a-f]{64}$/)
  assert.notEqual(targets[0], targets[1], '两种连接共用一个授权 key')
})

test('同名同类型连接换了 id 后必须使用不同授权 key', async () => {
  const { deps, calls } = makeDeps()
  let id = 'old-profile-id'
  deps.getSettings = async () => ({
    brokers: [{ id, name: 'prod', kind: 'postgres', readOnly: true }]
  })

  await handleBroker(deps, 'term-1', 'postgres', 'prod', 'select 1')
  id = 'new-profile-id'
  await handleBroker(deps, 'term-1', 'postgres', 'prod', 'delete from users')

  const targets = calls.authorize.map((a) => a.target)
  assert.match(targets[0] ?? '', /#old-profile-id@/)
  assert.match(targets[1] ?? '', /#new-profile-id@/)
  assert.notEqual(targets[0], targets[1], '新 profile 继承了旧 profile 的授权')
})

test('**失败的代理调用不能在账本里记成 done**', async () => {
  /* `classifyDelegateResult` 认的是 `派活失败` 前缀 —— 那是 delegate 的话术。
     代理连接说的是「执行失败：」，一个字都对不上，
     用默认分类会让所有连不上库/SQL 报错的调用都显示成成功。 */
  const { deps, calls } = makeDeps()
  deps.run = async () => ({ ok: false, error: 'connection refused' })

  const result = await handleBroker(deps, 'term-1', 'postgres', 'prod', 'select 1')

  assert.match(result, /^执行失败：/)
  assert.equal(calls.ledger[1]?.state, 'failed')
  assert.notEqual(
    classifyDelegateResult(result),
    'failed',
    '如果 delegate 那份也能认出来，这条用例就白写了 —— 说明不需要独立 classify'
  )
})

test('代理连接的分类函数三态都对', () => {
  assert.equal(classifyBrokerResult('已拒绝：xxx'), 'rejected')
  assert.equal(classifyBrokerResult('执行失败：connection refused'), 'failed')
  assert.equal(classifyBrokerResult('rows: 3'), 'done')
})

test('source 为空时直接拒绝且不会取连接串或调用 brokerRun', async () => {
  const { deps, calls } = makeDeps()
  let targetReads = 0
  deps.getBrokerTarget = async () => {
    targetReads += 1
    return secret
  }

  const result = await handleBroker(deps, '', 'postgres', 'prod', 'select 1')

  assert.match(result, /^已拒绝：/)
  assert.equal(targetReads, 0)
  assert.equal(calls.run, 0)
})

test('账本 task 摘要和授权详情都不含连接串', async () => {
  const { deps, calls } = makeDeps()
  const payload = `select '${secret}' as injected_secret, '${'x'.repeat(300)}'`

  await handleBroker(deps, 'term-1', 'postgres', 'prod', payload)

  assert.equal(calls.ledger[0]?.event, 'start')
  assert.ok((calls.ledger[0]?.task?.length ?? 0) <= 200)
  assert.ok(!calls.ledger[0]?.task?.includes(secret))
  assert.ok(!calls.authorize[0]?.detail.includes(secret))
})

test('并发保存两个代理连接时最终列表完整且连接串没有孤儿', async () => {
  let brokers: Array<{ id: string; name: string; kind: 'ssh' | 'postgres'; readOnly: boolean }> = []
  const targets = new Map<string, string>()
  let sequence = 0
  const mutations = createBrokerMutations({
    getSettings: async () => {
      await Promise.resolve()
      return { brokers: brokers.map((broker) => ({ ...broker })) }
    },
    setSettings: async (patch) => {
      await Promise.resolve()
      brokers = patch.brokers
    },
    setBrokerTarget: async (id, target) => {
      targets.set(id, target)
    },
    deleteBrokerTarget: async (id) => {
      targets.delete(id)
    },
    randomId: () => `broker-${++sequence}`
  })

  const results = await Promise.all([
    mutations.save({
      name: 'primary',
      kind: 'postgres',
      readOnly: true,
      target: 'postgres://primary-secret'
    }),
    mutations.save({
      name: 'backup',
      kind: 'ssh',
      readOnly: true,
      target: 'backup-password'
    })
  ])

  assert.ok(results.every((result) => result.ok))
  assert.deepEqual(
    brokers.map((broker) => broker.name).sort(),
    ['backup', 'primary']
  )
  assert.deepEqual(
    [...targets.keys()].sort(),
    brokers.map((broker) => broker.id).sort()
  )
})

test('各类改密语法的密码都不会进入授权详情或账本任务', async () => {
  const cases = [
    { kind: 'postgres', payload: "ALTER ROLE alice PASSWORD 'S3cret'", password: 'S3cret' },
    { kind: 'postgres', payload: 'ALTER ROLE alice PASSWORD "DoubleSecret"', password: 'DoubleSecret' },
    { kind: 'postgres', payload: "CREATE USER alice IDENTIFIED BY 'IdentSecret'", password: 'IdentSecret' },
    { kind: 'ssh', payload: 'tool --password=LongSecret status', password: 'LongSecret' },
    { kind: 'ssh', payload: 'tool -pShortSecret status', password: 'ShortSecret' }
  ] as const

  for (const row of cases) {
    const { deps, calls } = makeDeps()
    await handleBroker(deps, 'term-1', row.kind, 'prod', row.payload)

    assert.ok(!calls.authorize[0]?.detail.includes(row.password), `${row.payload} 泄露到授权详情`)
    assert.ok(!calls.ledger[0]?.task?.includes(row.password), `${row.payload} 泄露到账本任务`)
  }
})

test('授权通过后账本有 start 和 finish 两条且 brokerRun 只执行一次', async () => {
  const { deps, calls } = makeDeps()

  const result = await handleBroker(deps, 'term-1', 'postgres', 'prod', 'select 1')

  assert.equal(result, 'ok')
  assert.equal(calls.run, 1)
  assert.deepEqual(calls.ledger.map((x) => x.event), ['start', 'finish'])
})

test('broker 返回值里的连接串也会被隐去', async () => {
  const { deps } = makeDeps()
  deps.run = async () => ({ ok: true, output: `server replied for ${secret}` })

  const result = await handleBroker(deps, 'term-1', 'postgres', 'prod', 'select 1')

  assert.ok(!result.includes(secret))
  assert.match(result, /«已隐去»/)

  deps.run = async () => ({ ok: false, output: '', error: `psql: ${secret}` })
  const failed = await handleBroker(deps, 'term-1', 'postgres', 'prod', 'select 1')

  assert.ok(!failed.includes(secret))
  assert.match(failed, /«已隐去»/)
})

/* ── 第四条密码路径（codex 第三轮 P1）─────────────────────────────────
   只脱敏"起始摘要"挡不住：psql 会把出错的语句**原样回显**，
   于是 `执行失败：… ALTER ROLE alice PASSWORD 'x' …` 顺着返回值进任务账本，
   而账本是**落盘持久化**的。摘要 / 成功输出 / 失败输出必须走同一份 secrets。 */

const PW_CASES: Array<[string, string, string]> = [
  ['postgres', `ALTER ROLE alice PASSWORD 'LedgerSecret'`, 'LedgerSecret'],
  ['postgres', `ALTER ROLE alice PASSWORD E'EscapedSecret'`, 'EscapedSecret'],
  ['postgres', `ALTER ROLE alice PASSWORD $tag$DollarSecret$tag$`, 'DollarSecret'],
  // dollar tag **可以含数字**，上一版的字符集不接受 → 整条分支静默失配
  ['postgres', `ALTER ROLE alice PASSWORD $tag1$DigitTagSecret$tag1$`, 'DigitTagSecret'],
  ['postgres', `ALTER ROLE alice PASSWORD $$PlainDollarSecret$$`, 'PlainDollarSecret'],
  ['postgres', `CREATE USER bob IDENTIFIED BY "QuotedSecret"`, 'QuotedSecret'],
  ['ssh', `mysql --password=CliSecret1 -e 'select 1'`, 'CliSecret1'],
  ['ssh', `sshpass -p SshpassSecret ssh host`, 'SshpassSecret'],
  ['ssh', `tool --password SpacedSecret run`, 'SpacedSecret'],
  // 第五条路径（codex 第四轮）：环境变量前缀 + payload 里的连接串 userinfo
  ['ssh', `PGPASSWORD=FifthSecret psql -c 'select 1'`, 'FifthSecret'],
  ['ssh', `psql postgres://u:UriUserinfoSecret@h/db`, 'UriUserinfoSecret'],
  ['ssh', `mysql -pTightSecret -e 'x'`, 'TightSecret']
]

for (const [kind, payload, pw] of PW_CASES) {
  test(`**${kind}：${pw} 既不能进弹窗、也不能进账本**`, async () => {
    const { deps, calls } = makeDeps()
    deps.getSettings = async () => ({
      brokers: [{ id: 'p1', name: 'prod', kind: kind as 'postgres' | 'ssh', readOnly: false }]
    })
    // psql / shell 出错时会把整条命令回显出来
    deps.run = async () => ({ ok: false, output: '', error: `syntax error near: ${payload}` })

    const result = await handleBroker(deps, 'term-1', kind, 'prod', payload)

    assert.ok(!calls.authorize[0]?.detail.includes(pw), `密码进了授权弹窗：${calls.authorize[0]?.detail}`)
    assert.ok(!calls.ledger[0]?.task?.includes(pw), `密码进了账本摘要：${calls.ledger[0]?.task}`)
    assert.ok(!result.includes(pw), `密码进了返回值（→ 落盘的账本）：${result}`)
  })
}

test('执行拿到的仍是**原始** payload（脱敏只用于展示，改了就不是用户要跑的那条了）', async () => {
  const { deps } = makeDeps()
  let got = ''
  deps.run = async (_p, payload) => {
    got = payload
    return { ok: true, output: 'ok' }
  }
  const sql = `ALTER ROLE alice PASSWORD 'KeepMe123'`
  await handleBroker(deps, 'term-1', 'postgres', 'prod', sql)
  assert.equal(got, sql)
})

test('**同一个 id 改了 target 或 readOnly，授权 key 必须变**', async () => {
  /* 换完整 id 只挡住了"删了重建"。同一个 id 上把连接串改到别处、
     或把只读改成可写，authTarget 完全不变 ——
     用户当初为一个**只读的 staging** 勾的"本次不再询问"，
     会原样放行一个**可写的 prod**。（codex 第三轮 P1） */
  const { deps, calls } = makeDeps()
  let readOnly = true
  let conn = 'postgres://ro@staging/app'
  deps.getSettings = async () => ({ brokers: [{ id: 'same-id', name: 'prod', kind: 'postgres', readOnly }] })
  deps.getBrokerTarget = async () => conn

  await handleBroker(deps, 'term-1', 'postgres', 'prod', 'select 1')
  conn = 'postgres://root@prod.internal/app' // 同一个 id，连接串换了
  await handleBroker(deps, 'term-1', 'postgres', 'prod', 'select 1')
  readOnly = false // 同一个 id，从只读变可写
  await handleBroker(deps, 'term-1', 'postgres', 'prod', 'select 1')

  const t = calls.authorize.map((a) => a.target)
  assert.equal(new Set(t).size, 3, `三种安全语义共用了授权 key：${JSON.stringify(t)}`)
  for (const x of t) assert.ok(!x.includes('prod.internal') && !x.includes('root'), `连接串进了 key：${x}`)
})

test('**短密码也要抹**（明确标着 PASSWORD 的不设长度门槛）', async () => {
  /* 「太短会把正常输出切碎」那条判据只适用于**猜出来的**片段，
     不适用于语法上明确标着 PASSWORD 的 —— 用弱口令是用户的事，
     替他泄漏是我们的事。两个通道的区分见 secret-scrub.ts。 */
  const { deps, calls } = makeDeps()
  deps.run = async () => ({ ok: false, output: '', error: `err near: PASSWORD 'abc'` })
  const r = await handleBroker(deps, 'term-1', 'postgres', 'prod', `ALTER ROLE a PASSWORD 'abc'`)
  assert.ok(!r.includes(`'abc'`), `短密码漏了：${r}`)
  assert.ok(!calls.authorize[0]?.detail.includes(`'abc'`))
})

test('**不能脱敏过度**：`ssh -p 2222` 的端口号不是密码', () => {
  /* 通用地认裸 `-p X` 的话，`ssh -p 2222 host` 的端口会被当密码，
     然后输出里所有 `2222` 都被打码；`tool -p status` 更是把 status 抹掉。
     **脱敏过度和脱敏不足一样是 bug** —— 用户会看着一堆 «已隐去» 不知所云。
     所以裸 `-p X` 只在 sshpass 上认，MySQL 风格只认紧贴的 `-pSecret`。 */
  assert.deepEqual(extractPayloadSecrets('ssh', 'ssh -p 2222 host uptime'), [])
  assert.deepEqual(extractPayloadSecrets('ssh', 'tool -p status'), [])
  assert.deepEqual(extractPayloadSecrets('ssh', 'ssh -p 22 h'), [])
  // 但真的 sshpass / 紧贴式仍然要抓到
  assert.deepEqual(extractPayloadSecrets('ssh', 'sshpass -p 2222 ssh h'), ['2222'])
})

test('**授权指纹不能截断，也不能是可离线比对的裸哈希**', () => {
  /* 48 位截断约 2^24 次哈希就能构造碰撞：攻击者预生成两个 readOnly 相同、
     target 不同的碰撞对，用户授权第一个之后换成第二个即可复用旧 grant。
     而裸 sha256 又能对低熵 target（`postgres://localhost/app`）做**离线字典比对**
     反推原文。→ 进程内随机密钥的 HMAC，且不截断。 */
  const a = brokerRevision('postgres://u:p@h/db', true)
  assert.match(a, /^[0-9a-f]{64}$/, '不能截断')
  assert.notEqual(a, brokerRevision('postgres://u:p@h/db', false), 'readOnly 变了指纹必须变')
  assert.notEqual(a, brokerRevision('postgres://u:p@other/db', true), 'target 变了指纹必须变')
  assert.equal(a, brokerRevision('postgres://u:p@h/db', true), '同一进程内要稳定')
})

test('**ssh 连接上跑 SQL，密码同样不能进弹窗和落盘账本**', async () => {
  /* 这个洞能在 428 条全绿用例下存活，就是因为**所有 SQL 密码用例都跑在
     postgres kind 上** —— 而 `tb ssh prod "docker exec db psql -c \"ALTER ROLE …\""`
     是最普通不过的用法。明文密码于是进了保留 500 条的 tasks.jsonl。
     和上一轮已修的第五条路径是同一条理由（"ssh payload 里完全可能出现 SQL"），
     那两条提上来了、这条漏了。 */
  const { deps, calls } = makeDeps()
  deps.getSettings = async () => ({
    brokers: [{ id: 's1', name: 'prod', kind: 'ssh', readOnly: false }]
  })
  const pw = 'SshSqlSecret'
  const payload = `docker exec db psql -U postgres -c "ALTER ROLE app PASSWORD '${pw}'"`
  deps.run = async () => ({ ok: false, output: '', error: `remote error near: ${payload}` })

  const r = await handleBroker(deps, 'term-1', 'ssh', 'prod', payload)

  assert.ok(!calls.authorize[0]?.detail.includes(pw), `进了授权弹窗：${calls.authorize[0]?.detail}`)
  assert.ok(!calls.ledger[0]?.task?.includes(pw), `进了落盘账本：${calls.ledger[0]?.task}`)
  assert.ok(!r.includes(pw), `进了返回值：${r}`)
  // 同时确认提取器本身认得出来
  assert.ok(extractPayloadSecrets('ssh', payload).includes(pw))
})
