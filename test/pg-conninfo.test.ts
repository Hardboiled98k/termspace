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
 * **上一版为什么没抓到**：两边的用例都用**假 psql** 只断言了环境变量的形状。
 * 测的是"我以为 libpq 怎么工作"，不是行为。所以这里有真 psql 的用例（本机没装就跳过）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { pgConnFromTarget, parseKeyValueConninfo, scrubSecrets } from '../src/main/pg-conninfo.ts'

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
