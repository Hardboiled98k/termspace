/**
 * 远程写入的两个开关。
 *
 * `remote-viewer.test.ts` 故意把两个开关都设成恒 true（那是它自己的目的：
 * 证明 viewer 被挡住靠的是**身份**不是开关）。代价是全项目没有第二处把开关构造成
 * false —— 于是 `remote.ts` 文件头声明的三条判据一条都没有网：
 *
 *   ① 默认只读，写入要显式开
 *   ② **读 body 是异步的**，客户端可以在开关还开着时把请求头发出来、把 body 拖住，
 *      等用户关掉之后再补完 —— 所以落笔前必须**再查一次**
 *   ③ 安全开关只能往收紧的方向失败
 *
 * 实测过：把 remote.ts 里那两句"重查"整行删掉，166 条用例全绿。
 * 这个文件就是补那张网。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startRemoteApi, type RemoteApi } from '../src/main/remote.ts'
import { ensureOwnerToken } from '../src/main/remote-tokens.ts'

let api: RemoteApi
let tok = ''
let base = ''

/** 开关的下一次返回值。用闭包模拟"用户在请求进行中把开关关了" */
let inputSwitch: () => boolean = () => true
let approveSwitch: () => boolean = () => true
let writes: string[] = []
let decided: boolean[] = []

before(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rs-'))
  const tokenFile = path.join(dir, 'remote-token')
  tok = (await ensureOwnerToken(tokenFile)).find((t) => t.role === 'owner')!.token
  api = await startRemoteApi({
    tokenFile,
    port: 0,
    host: '127.0.0.1',
    staticDir: dir,
    allowInput: () => inputSwitch(),
    allowApprove: () => approveSwitch(),
    getBoard: () => ({ projects: [], nodes: [], edges: [] }),
    listApprovals: () => [],
    decideApproval: () => {
      decided.push(true)
      return true
    },
    peek: async () => '',
    writeInput: (_id, text) => {
      writes.push(text)
      return true
    }
  })
  base = `http://127.0.0.1:${api.port}`
})

after(() => api?.dispose())

const post = async (p: string, body: string): Promise<number> => {
  const r = await fetch(`${base}${p}`, {
    method: 'POST',
    body,
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }
  })
  await r.text()
  return r.status
}

test('开关关着时写不进终端（owner 也不行）', async () => {
  writes = []
  inputSwitch = () => false
  assert.equal(await post('/api/terminal/t1/input', '{"text":"x"}'), 403)
  assert.deepEqual(writes, [], '开关关着却调了 writeInput')
})

test('**读 body 期间开关被关掉 → 必须拒**（慢 body 攻击跨过开关关闭的那一刻）', async () => {
  /* 客户端完全可以在开关还开着时发头、拖住 body，等用户关掉之后再补完。
     只在读 body **之前**查一次的话，这道门形同虚设。 */
  writes = []
  let n = 0
  inputSwitch = () => ++n === 1 // 第一次查 true（放行进 readBody），之后 false
  assert.equal(await post('/api/terminal/t1/input', '{"text":"rm -rf /"}'), 403)
  assert.deepEqual(writes, [], `落笔前没有重查开关：${JSON.stringify(writes)}`)
})

test('开关开着时正常写入', async () => {
  writes = []
  inputSwitch = () => true
  assert.equal(await post('/api/terminal/t1/input', '{"text":"ls"}'), 200)
  assert.deepEqual(writes, ['ls'])
})

test('审批开关：关着时批不了', async () => {
  decided = []
  approveSwitch = () => false
  assert.equal(await post('/api/approvals/a1', '{"allow":true}'), 403)
  assert.deepEqual(decided, [], '开关关着却调了 decideApproval')
})

test('审批开关：读 body 期间被关掉 → 必须拒', async () => {
  decided = []
  let n = 0
  approveSwitch = () => ++n === 1
  assert.equal(await post('/api/approvals/a1', '{"allow":true}'), 403)
  assert.deepEqual(decided, [], '落笔前没有重查开关')
})

test('超长输入拒收 —— 整段会被一次写进 pty', async () => {
  writes = []
  inputSwitch = () => true
  const huge = JSON.stringify({ text: 'x'.repeat(5000) }) // INPUT_LIMIT = 4096
  assert.equal(await post('/api/terminal/t1/input', huge), 400)
  assert.deepEqual(writes, [])
})

test('非法节点 id 拒收 —— 它会被拼进 tmux 会话名和文件名', async () => {
  writes = []
  inputSwitch = () => true
  const r = await fetch(`${base}/api/terminal/..%2Fetc/input`, {
    method: 'POST',
    body: '{"text":"x"}',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }
  })
  await r.text()
  assert.ok(r.status >= 400, `非法 id 却返回 ${r.status}`)
  assert.deepEqual(writes, [])
})
