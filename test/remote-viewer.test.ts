/**
 * 只读分享的角色门控。
 *
 * 钉的是一条关键性质：**viewer 被挡住靠的是身份，不是那两个全局开关。**
 * 开关是"我允许远程输入"，角色是"这个人本来就不该能输入" —— 两件事。
 * 混在一起的话，用户为了自己手机方便打开开关，就等于把写权限一起给了
 * 拿着分享链接的人。所以下面每个用例都**故意把两个开关都打开**。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startRemoteApi, type RemoteApi } from '../src/main/remote.ts'
import { ensureOwnerToken, issueToken } from '../src/main/remote-tokens.ts'

const SECRET_PATH = '/Users/somebody/Desktop/secret-project'
const SECRET_TEXT = '终端里的机密 sk-DO-NOT-LEAK'

let api: RemoteApi
let ownerTok = ''
let viewerTok = ''
let base = ''

before(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rv-'))
  const tokenFile = path.join(dir, 'remote-token')
  ownerTok = (await ensureOwnerToken(tokenFile)).find((t) => t.role === 'owner')!.token
  viewerTok = (await issueToken(tokenFile, 'viewer', '测试')).issued.token
  api = await startRemoteApi({
    tokenFile,
    port: 0,
    host: '127.0.0.1',
    staticDir: dir,
    // **故意全开**：viewer 仍然必须被挡住
    allowInput: () => true,
    allowApprove: () => true,
    getBoard: () => ({
      projects: [{ id: 'p1', name: '项目', cwd: SECRET_PATH }],
      activeProjectId: 'p1',
      nodes: [{ id: 't-abc', type: 'terminal', title: 'zsh', status: 'attention', x: 1, y: 2 }],
      edges: []
    }),
    listApprovals: () => [{ id: 'a1', toolName: 'Bash', summary: `rm -rf ${SECRET_PATH}` }],
    decideApproval: () => true,
    peek: async () => SECRET_TEXT,
    writeInput: () => true
  })
  base = `http://127.0.0.1:${api.port}`
})

after(() => api?.dispose())

const call = async (
  tok: string,
  p: string,
  opts: { method?: string; body?: string } = {}
): Promise<{ status: number; body: string }> => {
  const r = await fetch(`${base}${p}`, {
    method: opts.method ?? 'GET',
    body: opts.body,
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }
  })
  return { status: r.status, body: await r.text() }
}

test('viewer 拿不到绝对路径（会暴露用户名和目录结构）', async () => {
  const r = await call(viewerTok, '/api/board')
  assert.equal(r.status, 200)
  assert.ok(!r.body.includes(SECRET_PATH), `画布里漏了绝对路径：${r.body}`)
  assert.ok(!r.body.includes('/Users/'), '任何绝对路径都不该出现')
  // 但该看到的还在：这个产品的卖点就是"看一眼谁在等你"
  assert.ok(r.body.includes('attention'), '状态必须能看到，否则分享没有意义')
})

test('viewer 拿不到审批清单（摘要里有命令和文件名）', async () => {
  const r = await call(viewerTok, '/api/board')
  assert.ok(!r.body.includes('rm -rf'), `审批摘要漏出去了：${r.body}`)
  const list = await call(viewerTok, '/api/approvals')
  assert.ok(!list.body.includes('rm -rf'))
})

test('viewer 看不到终端内容 —— 屏幕上有路径、邮箱、粘贴进去的 token', async () => {
  const r = await call(viewerTok, '/api/terminal/t-abc')
  assert.equal(r.status, 403)
  assert.ok(!r.body.includes('sk-DO-NOT-LEAK'))
})

test('viewer 写不了终端（开关开着也不行）', async () => {
  const r = await call(viewerTok, '/api/terminal/t-abc/input', {
    method: 'POST',
    body: JSON.stringify({ text: 'rm -rf /' })
  })
  assert.equal(r.status, 403)
})

test('viewer 批不了工具调用（开关开着也不行）', async () => {
  const r = await call(viewerTok, '/api/approvals/a1', {
    method: 'POST',
    body: JSON.stringify({ allow: true })
  })
  assert.equal(r.status, 403)
})

test('viewer 那份画布里 allowInput/allowApprove 一律 false', async () => {
  // 手机端据此决定要不要画输入框。报 true 会让人对着一个必然 403 的按钮打字
  const body = JSON.parse((await call(viewerTok, '/api/board')).body) as {
    allowInput: boolean
    allowApprove: boolean
    role: string
  }
  assert.equal(body.allowInput, false)
  assert.equal(body.allowApprove, false)
  assert.equal(body.role, 'viewer')
})

test('owner 不受影响：该看的都看得到、该写的都写得了', async () => {
  const board = await call(ownerTok, '/api/board')
  assert.ok(board.body.includes(SECRET_PATH), 'owner 是自己，路径照给')
  assert.ok(board.body.includes('rm -rf'), 'owner 要处理审批')
  assert.equal((await call(ownerTok, '/api/terminal/t-abc')).status, 200)
  assert.equal(
    (await call(ownerTok, '/api/terminal/t-abc/input', { method: 'POST', body: '{"text":"x"}' }))
      .status,
    200
  )
})

test('认不出的 token 一律 401', async () => {
  assert.equal((await call('x'.repeat(64), '/api/board')).status, 401)
  assert.equal((await call('', '/api/board')).status, 401)
})

test('viewer 拿不到实时推送 —— push 推的是未脱敏的完整快照', async () => {
  /* 快照那三条路径都做了脱敏，SSE 曾经没有。同一份数据两个出口、只守住一个 ——
     项目里出过一次（toPublicApproval 只写在两条外发路径中的一条），这里是高一层重演。
     手机端本来就是轮询（EventSource 设不了 Authorization 头），viewer 不需要这条。 */
  const r = await fetch(`${base}/api/events`, {
    headers: { authorization: `Bearer ${viewerTok}` }
  })
  assert.equal(r.status, 403)
  await r.text()
})

test('owner 的 SSE 照常可用，且能收到推送', async () => {
  const ctl = new AbortController()
  const r = await fetch(`${base}/api/events`, {
    headers: { authorization: `Bearer ${ownerTok}` },
    signal: ctl.signal
  })
  assert.equal(r.status, 200)
  const reader = r.body!.getReader()
  const first = await reader.read() // hello
  assert.ok(new TextDecoder().decode(first.value).includes('hello'))

  api.push('board', { projects: [{ cwd: SECRET_PATH }] })
  const pushed = await reader.read()
  assert.ok(
    new TextDecoder().decode(pushed.value).includes(SECRET_PATH),
    'owner 是自己，推送不脱敏'
  )
  ctl.abort()
})
