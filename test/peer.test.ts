/**
 * 跨机派活的寻址与白名单。
 *
 * 这一层唯一的要求：**alias 是要进 ssh argv 的，别让它变成 ssh 的选项。**
 * `ssh -oProxyCommand=<任意命令> host` 会在**本机**执行那条命令 ——
 * 派活的调用方是 agent，agent 拿得到自由文本，于是这就是一条从
 * 「agent 写一个 target 字符串」到「本机任意命令执行」的完整链路。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parsePeerTarget,
  peerAllowed,
  sshArgs,
  decodePeerAsk,
  encodePeerAsk,
  PEER_TIMEOUTS,
  buildPeerHelper
} from '../src/main/peer.ts'

test('本机 target（不含冒号）返回 null，走原来的路', () => {
  assert.equal(parsePeerTarget('t-abc'), null)
  assert.equal(parsePeerTarget(''), null)
})

test('跨机 target 正常拆开', () => {
  assert.deepEqual(parsePeerTarget('mini:t-abc'), { alias: 'mini', nodeId: 't-abc' })
  assert.deepEqual(parsePeerTarget('mac-mini:b3'), { alias: 'mac-mini', nodeId: 'b3' })
})

test('以 - 开头的 alias 一律拒（它会被 ssh 当成选项）', () => {
  for (const bad of [
    '-oProxyCommand=touch /tmp/pwned:t-abc',
    '-E/tmp/x:t-abc',
    '--:t-abc'
  ]) {
    assert.equal(parsePeerTarget(bad), null, `${bad} 必须拒`)
  }
})

test('alias 里的 shell 元字符一律拒', () => {
  for (const bad of ['a;b:t1', 'a b:t1', 'a$(id):t1', 'a`id`:t1', "a'b:t1", 'a|b:t1']) {
    assert.equal(parsePeerTarget(bad), null, `${bad} 必须拒`)
  }
})

test('非法节点 id 拒（它会被拼进远端的 tmux 会话名和文件名）', () => {
  assert.equal(parsePeerTarget('mini:../../etc/passwd'), null)
  assert.equal(parsePeerTarget('mini:'), null)
  assert.equal(parsePeerTarget(`mini:${'x'.repeat(65)}`), null)
})

test('白名单之外的 alias 拒 —— 光有格式合法不够', () => {
  assert.equal(peerAllowed('mini', ['mini', 'nas']), true)
  assert.equal(peerAllowed('evil.example.com', ['mini']), false)
  assert.equal(peerAllowed('mini', []), false)
  // 白名单自己被写脏了也不能放行
  assert.equal(peerAllowed('-oProxyCommand=x', ['-oProxyCommand=x']), false)
})

test('ssh 参数里主机名在 -- 之后，且 BatchMode 开着', () => {
  const a = sshArgs('mini', '/path/tb-peer')
  const dashdash = a.indexOf('--')
  assert.ok(dashdash >= 0, '必须有 --')
  assert.ok(a.indexOf('mini') > dashdash, '主机名必须在 -- 之后')
  assert.ok(a.includes('BatchMode=yes'), '没配免密时要立刻失败，不能挂在密码提示上')
  // 任务正文不在 argv 里 —— ps 对同机所有用户可见
  assert.ok(!a.some((s) => s.includes('任务')), 'argv 里不该有任务正文')
})

test('helper 的 stdin 解析：形状不对一律拒', () => {
  assert.equal(decodePeerAsk('not json'), null)
  assert.equal(decodePeerAsk('null'), null)
  assert.equal(decodePeerAsk('[]'), null)
  assert.equal(decodePeerAsk('{}'), null)
  assert.equal(decodePeerAsk('{"target":"t1"}'), null, '没有任务')
  assert.equal(decodePeerAsk('{"target":"t1","task":"   "}'), null, '空白任务')
  assert.equal(decodePeerAsk('{"target":"../x","task":"go"}'), null, '非法节点 id')
})

test('helper 收下合法输入；source 只截断不校验（它只用于显示）', () => {
  const p = decodePeerAsk(encodePeerAsk({ source: 't-1', target: 't-2', task: '跑测试' }))
  assert.deepEqual(p, { source: 't-1', target: 't-2', task: '跑测试' })
  const long = decodePeerAsk(JSON.stringify({ source: 'x'.repeat(999), target: 't1', task: 'a' }))
  assert.equal(long?.source.length, 64)
})

test('超时必须外层长于内层 —— 反了就会"本机已放弃、远端刚注入"', () => {
  assert.ok(
    PEER_TIMEOUTS.sshMs > PEER_TIMEOUTS.remoteDelegateMs,
    'ssh 的等待必须比远端 delegate 长，否则那次派活的结果没人接得住'
  )
})

test('helper 脚本端到端：stdin 原样送达、token 在头里、任务不进 argv', async () => {
  /* 这段验的是真的 curl 调用，不是字符串匹配 —— helper 是生成的 sh 脚本，
     它的参数形状错了在单元测试里看不出来，只有真跑一次才知道。 */
  const { createServer } = await import('node:http')
  const { writeFile, chmod, mkdtemp } = await import('node:fs/promises')
  const { execFile } = await import('node:child_process')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')

  const got: { token?: string; body?: string } = {}
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      got.token = String(req.headers['x-termboard-peer'] ?? '')
      got.body = Buffer.concat(chunks).toString('utf8')
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('远端回话')
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const addr = srv.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0

  const dir = await mkdtemp(path.join(tmpdir(), 'ph-'))
  const helper = path.join(dir, 'tb-peer')
  await writeFile(helper, buildPeerHelper(port, 'TOK-123456789012'))
  await chmod(helper, 0o700)

  // 任务里塞 shell 元字符：走 stdin 就该原样送达，拼进命令行就会被解析
  const payload = encodePeerAsk({ source: 't-1', target: 't-2', task: '跑 `id` && echo $HOME' })
  const out = await new Promise<string>((resolve, reject) => {
    const c = execFile(helper, [], (err, stdout) => (err ? reject(err) : resolve(stdout)))
    c.stdin?.end(payload)
  })
  srv.close()

  assert.equal(out, '远端回话', 'helper 要把远端的回话原样吐出来')
  assert.equal(got.token, 'TOK-123456789012')
  assert.equal(got.body, payload, 'stdin 必须原样送达，一个字符都不能被 shell 动过')
  assert.deepEqual(decodePeerAsk(got.body ?? ''), {
    source: 't-1',
    target: 't-2',
    task: '跑 `id` && echo $HOME'
  })
})
