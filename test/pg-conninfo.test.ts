/**
 * 钉住 codex 对手方审查逮到的当日最严重一条：**`tb db` 从来连不上用户配的服务器，
 * 而且会把密码回显给 agent 和任务账本。**
 *
 * 老实现把整条连接串塞进 `PGDATABASE`，注释还写着「libpq 会把它当整条 conninfo 展开」。
 * 本机 psql 17.5 实测证伪：
 *
 *   PGDATABASE='postgresql://tbuser:FAKEPW@127.0.0.1:1/tbdb' psql -c 'select 1'
 *   → connection to server on socket "/tmp/.s.PGSQL.5432" failed:
 *     FATAL: database "postgresql://tbuser:FAKEPW@127.0.0.1:1/tbdb" does not exist
 *
 * 两个故障叠着：① 连的是**本机 socket**，不是配置的主机；
 * ② 报错里带完整密码，而且**会被截断到 63 字节**（NAMEDATALEN-1）——
 * 128 字符的 URI 截断后仍含完整密码，调用方"整串精确替换"的脱敏匹配不上它。
 *
 * 本文件还钉住三条后续边界：libpq 合法多主机 URI 不能被 WHATWG URL 拒绝；
 * broker 追加只读 PGOPTIONS 时不能吞掉用户 options；空用户名、短密码与畸形
 * key=value conninfo 都必须 fail closed 或可靠脱敏。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { pgConnFromTarget, parseKeyValueConninfo, scrubSecrets } from '../src/main/pg-conninfo.ts'
import { readonlyPgOptions } from '../src/main/broker.ts'

test('URI 拆成逐字段的 PG* 变量，**PGDATABASE 只放库名**', () => {
  const c = pgConnFromTarget('postgresql://alice:s3cret@db.example.com:6543/analytics')
  assert.ok(c)
  assert.equal(c.env['PGHOST'], 'db.example.com')
  assert.equal(c.env['PGPORT'], '6543')
  assert.equal(c.env['PGUSER'], 'alice')
  assert.equal(c.env['PGPASSWORD'], 's3cret')
  assert.equal(c.env['PGDATABASE'], 'analytics', 'PGDATABASE 里绝不能是整条连接串')
  assert.ok(!Object.values(c.env).some((v) => v.startsWith('postgres')), '任何字段都不该是整条 URI')
})

test('密码百分号编码要解开（不解开会静默认证失败，报错只说密码不对）', () => {
  const c = pgConnFromTarget('postgres://u:p%40ss%2Fword@h/db')
  assert.equal(c?.env['PGPASSWORD'], 'p@ss/word')
})

test('查询参数映射到 libpq 的环境变量', () => {
  const c = pgConnFromTarget('postgres://h/db?sslmode=require&application_name=tb')
  assert.equal(c?.env['PGSSLMODE'], 'require')
  assert.equal(c?.env['PGAPPNAME'], 'tb')
})

test('key=value 形式也认，带引号的值不被空格切断', () => {
  const kv = parseKeyValueConninfo("host=h port=5432 user=u password='pw with space' dbname=d")
  assert.deepEqual(kv, { host: 'h', port: '5432', user: 'u', password: 'pw with space', dbname: 'd' })
  const c = pgConnFromTarget("host=h user=u password='pw with space' dbname=d")
  assert.equal(c?.env['PGPASSWORD'], 'pw with space')
  assert.equal(c?.env['PGDATABASE'], 'd')
})

test('**光一个名字才是真的 dbname**（这是唯一该进 PGDATABASE 的情况）', () => {
  const c = pgConnFromTarget('mydb')
  assert.deepEqual(c?.env, { PGDATABASE: 'mydb' })
})

test('解析不了就返回 null，**绝不退回"当 dbname 试一下"**（那正是这个 bug）', () => {
  assert.equal(pgConnFromTarget(''), null)
  assert.equal(pgConnFromTarget('   '), null)
  assert.equal(pgConnFromTarget('postgres://['), null, '畸形 URI 不能静默降级')
})

test('合法的多主机 URI 会生成位置对应的 PGHOST 与 PGPORT 列表', () => {
  const c = pgConnFromTarget('postgresql://u:p@host1:5432,host2:5433/db')
  assert.ok(c, '不能把 libpq 合法的多主机 authority 当成畸形 URL')
  assert.equal(c.env['PGHOST'], 'host1,host2')
  assert.equal(c.env['PGPORT'], '5432,5433')
  assert.equal(c.env['PGDATABASE'], 'db')
})

test('只读 PGOPTIONS 追加在用户 options 后面且不覆盖用户设置', () => {
  const c = pgConnFromTarget('postgresql://h/db?options=-c%20x')
  assert.equal(c?.env['PGOPTIONS'], '-c x')
  assert.equal(readonlyPgOptions(c?.env['PGOPTIONS']), '-c x -c default_transaction_read_only=on')
})

test('空用户名 URI 的密码位仍会被兜底脱敏', () => {
  const safe = scrubSecrets('failed: postgresql://:abc@host/db', [])
  assert.equal(safe, 'failed: postgresql://:«已隐去»@host/db')
})

test('明确解析出的短密码不受普通短 secret 过滤规则影响', () => {
  const c = pgConnFromTarget('postgresql://u:abc@host/db')
  assert.ok(c)
  assert.equal(scrubSecrets('password=abc', c.secrets, c.passwords), 'password=«已隐去»')
})

test('key=value 引号未闭合或末尾反斜杠时拒绝解析', () => {
  assert.equal(parseKeyValueConninfo("host=h password='abc"), null)
  assert.equal(parseKeyValueConninfo('host=h password=abc\\'), null)
  assert.equal(parseKeyValueConninfo("host=h password='abc\\"), null)
})

test('**截断后的连接串里的密码也要抹掉**（整串精确替换匹配不上它）', () => {
  const uri = 'postgresql://production_readonly_user:S3cr3tPassw0rdVeryLong@db-primary.internal:5432/warehouse'
  const c = pgConnFromTarget(uri)
  assert.ok(c)
  // psql 实测就是这样截的：63 字节
  const truncated = `FATAL:  database "${uri.slice(0, 63)}" does not exist`
  assert.ok(truncated.includes('S3cr3tPassw0rdVeryLong'), '前提：截断后确实还带着密码')
  const safe = scrubSecrets(truncated, c.secrets)
  assert.ok(!safe.includes('S3cr3tPassw0rdVeryLong'), `密码漏了：${safe}`)
})

test('兜底：任何 `://user:pw@` 形状的密码位一律打掉', () => {
  const s = scrubSecrets('conn failed for postgres://bob:NeverSeenBefore@h/db', ['无关'])
  assert.ok(!s.includes('NeverSeenBefore'), s)
})

test('**太短的 secret 不参与替换**，否则会把正常输出切得满目疮痍', () => {
  /* 一个 1-3 字符的"密码"（或解析出来的空/短字段）如果参与全局替换，
     `select` 里的 `a`、表名里的 `id` 全会被打码，查询结果直接不可读。
     宁可这种极端弱口令不被脱敏 —— 它本来也挡不住任何人。 */
  assert.equal(scrubSecrets('rows: 3 abc def', ['abc', 'x']), 'rows: 3 abc def')
  // 4 字符及以上正常抹掉
  assert.equal(scrubSecrets('pw=abcd here', ['abcd']), 'pw=«已隐去» here')
})

test('长片段先替换，短片段不会把长片段切碎', () => {
  const s = scrubSecrets('token=SUPERSECRETVALUE', ['SECRET', 'SUPERSECRETVALUE'])
  assert.equal(s, 'token=«已隐去»')
})

// ── 真 psql：本机没装就跳过。假 psql 只能验形状，验不了 libpq 的行为 ──

const psql = ['/opt/homebrew/bin/psql', '/usr/local/bin/psql', '/usr/bin/psql'].find(existsSync)

test('**真 psql：连的是配置的主机，不是本机 socket**', { skip: !psql && '本机没装 psql' }, async () => {
  /* 端口 1 必然连不上 —— 判据是**它试图连哪里**：
     修复前是 `socket "/tmp/.s.PGSQL.5432"`，修复后必须是 127.0.0.1:1。 */
  const c = pgConnFromTarget('postgresql://tbuser:FAKEPW123@127.0.0.1:1/tbdb')
  assert.ok(c)
  const err = await new Promise<string>((resolve) => {
    execFile(
      psql!,
      ['--no-psqlrc', '-c', 'select 1'],
      { timeout: 15_000, env: { ...process.env, ...c.env, PGCONNECT_TIMEOUT: '3' } },
      (_e, _o, stderr) => resolve(String(stderr))
    )
  })
  assert.ok(!/\.s\.PGSQL\./.test(err), `还在连本机 socket：${err}`)
  assert.match(err, /127\.0\.0\.1/, `没连到配置的主机：${err}`)
  assert.ok(!err.includes('FAKEPW123'), `密码进了报错：${err}`)
})

test('真 psql：多主机 URI 尝试 TCP 目标而不是本机 socket', { skip: !psql && '本机没装 psql' }, async () => {
  const c = pgConnFromTarget('postgresql://u:p@127.0.0.1:1,127.0.0.1:2/db')
  assert.ok(c)
  const err = await new Promise<string>((resolve) => {
    execFile(
      psql!,
      ['--no-psqlrc', '-c', 'select 1'],
      { timeout: 15_000, env: { ...process.env, ...c.env, PGCONNECT_TIMEOUT: '3' } },
      (_e, _o, stderr) => resolve(String(stderr))
    )
  })
  assert.ok(!/\.s\.PGSQL\./.test(err), `还在连本机 socket：${err}`)
  assert.match(err, /127\.0\.0\.1.*port 1[\s\S]*127\.0\.0\.1.*port 2/, `没有依次尝试两个 TCP 目标：${err}`)
})

/* ── 查询参数里的连接目标（codex 第二轮 P0-2）───────────────────────────
   `postgresql:///mydb?host=%2Fcustom%2Fsocket` 是合法 libpq URI，
   真 psql 实测确实会去连 `/custom/socket`。老实现只认 sslmode 那几个、
   把 `host=` 静默丢掉 → 我们连默认 socket。**可写 broker 就会写错库**
   （目标机器上恰好有同名库时，一个报错都不会有）。 */

test('**查询参数里的 host 必须认**（丢掉它 = 连错机器还不报错）', () => {
  const c = pgConnFromTarget('postgresql:///mydb?host=%2Fcustom%2Fsocket')
  assert.equal(c?.env['PGHOST'], '/custom/socket', 'host 被静默丢掉了')
  assert.equal(c?.env['PGDATABASE'], 'mydb')
})

test('查询参数里的 user / password / port / dbname 同样要认，且密码进 secrets', () => {
  const c = pgConnFromTarget('postgres://h/x?user=alice&password=pw123456&port=6543&dbname=real')
  assert.equal(c?.env['PGUSER'], 'alice')
  assert.equal(c?.env['PGPASSWORD'], 'pw123456')
  assert.equal(c?.env['PGPORT'], '6543')
  assert.equal(c?.env['PGDATABASE'], 'real', '查询参数里的 dbname 覆盖路径里的')
  assert.ok(!scrubSecrets('err: pw123456', c!.secrets).includes('pw123456'), '密码没进脱敏名单')
})

test('**认不出的连接目标参数一律拒绝**，绝不静默忽略', () => {
  /* `service=` 会去读 pg_service.conf 里的一整套连接参数、
     `passfile=` 改认证来源 —— 忽略它们等于连到一个我们没预期的地方。
     而 application_name 这种丢了只是少个标签，不该为它拒掉合法连接串。 */
  assert.equal(pgConnFromTarget('postgres://h/db?service=prod'), null)
  assert.equal(pgConnFromTarget('postgres://h/db?passfile=/tmp/x'), null)
  assert.ok(pgConnFromTarget('postgres://h/db?application_name=tb'), '无害参数不该被拒')
})

test('**key=value 分支也要 fail-closed**（上一版只修了 URI 那条）', () => {
  /* 真 psql 17.5 对 `service=definitely_missing` 会直接报
     `definition of service "definitely_missing" not found` 拒绝连接，
     而我们静默忽略它照常连过去 = 可写 broker 连到 libpq 本来不会连的库。
     判据必须两条分支共用 —— 各写一份就是改一处漏一处。 */
  assert.equal(pgConnFromTarget('host=127.0.0.1 port=1 dbname=d service=nope'), null)
  assert.equal(pgConnFromTarget('host=h dbname=d passfile=/tmp/x'), null)
  // 混用：认识的参数在前也不能让它蒙混过关
  assert.equal(pgConnFromTarget('user=u password=pw123456 host=h service=nope'), null)
  // 无害的未映射键不该拒（否则合法连接串会被误杀）
  assert.ok(pgConnFromTarget('host=h dbname=d application_name=tb'))
})
