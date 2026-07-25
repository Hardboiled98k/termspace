/**
 * 远程 API（阶段 0）—— 给手机/其他电脑当客户端用的只读接口。
 *
 * 安全底线，改这个文件前先读一遍：
 * - **只绑 127.0.0.1**。穿透交给 Tailscale 这类设备级 VPN，绝不自己监听公网口。
 *   这个进程能 spawn pty、读写文件、持有 Claude 凭证，暴露到公网等于交出整台机器。
 * - **独立 token**，和 hook/tb 那套分开，可单独撤销。
 * - **默认只读**：写入终端要 settings.remoteAllowInput 显式打开。
 * - 这里**不提供**任何 spawn / kill / destroy / 执行任意命令的路由。
 */
import http from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

export interface RemoteDeps {
  /** userData 下的 token 文件路径 */
  tokenFile: string
  port: number
  allowInput: () => boolean
  /** 远程能否批准工具调用。和 allowInput 分开：批准一次 rm -rf 比敲一行字危险得多 */
  allowApprove: () => boolean
  /** 画布快照（由 renderer 上报，主进程缓存） */
  getBoard: () => unknown
  listApprovals: () => unknown[]
  decideApproval: (id: string, allow: boolean) => boolean
  /** 抓某终端当前屏文本 */
  peek: (nodeId: string, lines: number) => Promise<string>
  /** 往终端写入（受 allowInput 门控） */
  writeInput: (nodeId: string, text: string) => boolean
}

export interface RemoteApi {
  port: number
  token: string
  /** 状态/审批有变化时推给所有 SSE 客户端 */
  push: (event: string, data: unknown) => void
  dispose: () => void
}

const NODE_ID = /^[A-Za-z0-9_-]{1,64}$/
const INPUT_LIMIT = 4096
const MAX_CLIENTS = 8

/** token 持久化：换设备/怀疑泄露时删掉这个文件即可重新生成 */
async function loadOrCreateToken(file: string): Promise<string> {
  if (existsSync(file)) {
    try {
      const t = (await readFile(file, 'utf8')).trim()
      if (t.length >= 16) return t
    } catch {
      // 读不出来就重建
    }
  }
  const t = randomUUID().replace(/-/g, '')
  await writeFile(file, t)
  await chmod(file, 0o600)
  return t
}

export async function startRemoteApi(deps: RemoteDeps): Promise<RemoteApi> {
  const token = await loadOrCreateToken(deps.tokenFile)
  const tokenBuf = Buffer.from(token)
  const clients = new Set<http.ServerResponse>()

  const authed = (req: http.IncomingMessage): boolean => {
    const raw = String(req.headers['authorization'] ?? '')
    const given = Buffer.from(raw.replace(/^Bearer\s+/i, ''))
    return given.length === tokenBuf.length && timingSafeEqual(given, tokenBuf)
  }

  const json = (res: http.ServerResponse, code: number, body: unknown): void => {
    const s = JSON.stringify(body)
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    })
    res.end(s)
  }

  const readBody = (req: http.IncomingMessage): Promise<unknown> =>
    new Promise((resolve) => {
      let size = 0
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => {
        size += c.length
        if (size > INPUT_LIMIT * 2) req.destroy()
        else chunks.push(c)
      })
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
        } catch {
          resolve({})
        }
      })
      req.on('error', () => resolve({}))
    })

  const server = http.createServer((req, res) => {
    void (async (): Promise<void> => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname

      // 健康检查不需要 token（只回一个固定标识，不泄露任何状态）
      if (path === '/api/ping') return json(res, 200, { ok: true, app: 'termscape' })
      if (!authed(req)) return json(res, 401, { error: 'unauthorized' })

      // ── 画布快照 ──
      if (path === '/api/board' && req.method === 'GET') {
        return json(res, 200, {
          board: deps.getBoard(),
          approvals: deps.listApprovals(),
          allowInput: deps.allowInput()
        })
      }

      // ── 状态推送（SSE）──
      if (path === '/api/events' && req.method === 'GET') {
        if (clients.size >= MAX_CLIENTS) return json(res, 429, { error: 'too many clients' })
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive'
        })
        res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`)
        clients.add(res)
        // 心跳：中间设备会掐掉静默连接
        const beat = setInterval(() => res.write(': beat\n\n'), 25_000)
        res.on('close', () => {
          clearInterval(beat)
          clients.delete(res)
        })
        return
      }

      // ── 审批 ──
      if (path === '/api/approvals' && req.method === 'GET') {
        return json(res, 200, { approvals: deps.listApprovals() })
      }
      const decide = path.match(/^\/api\/approvals\/([A-Za-z0-9-]{1,64})$/)
      if (decide && req.method === 'POST') {
        /* 必须单独门控。此前只查 token 就放行，而写入终端反倒要开关——语义是倒挂的：
           批准一次工具调用（可能是 rm -rf / git push --force）比敲一行字危险得多。 */
        if (!deps.allowApprove()) {
          return json(res, 403, { error: '远程审批未开启（设置 → 远程访问）' })
        }
        const body = (await readBody(req)) as { allow?: unknown }
        const hit = deps.decideApproval(decide[1], body.allow === true)
        return json(res, hit ? 200 : 409, hit ? { ok: true } : { error: '该审批已失效' })
      }

      // ── 终端当前屏文本（只读）──
      const peek = path.match(/^\/api\/terminal\/([A-Za-z0-9_-]{1,64})$/)
      if (peek && req.method === 'GET') {
        const lines = Math.min(200, Math.max(1, Number(url.searchParams.get('lines')) || 40))
        return json(res, 200, { nodeId: peek[1], text: await deps.peek(peek[1], lines) })
      }

      // ── 写入终端（默认关闭）──
      const input = path.match(/^\/api\/terminal\/([A-Za-z0-9_-]{1,64})\/input$/)
      if (input && req.method === 'POST') {
        if (!deps.allowInput()) {
          return json(res, 403, { error: '远程输入未开启（设置 → 远程访问）' })
        }
        const body = (await readBody(req)) as { text?: unknown }
        const text = typeof body.text === 'string' ? body.text : ''
        if (!text || text.length > INPUT_LIMIT) return json(res, 400, { error: '内容不合法' })
        if (!NODE_ID.test(input[1])) return json(res, 400, { error: '非法节点 id' })
        const ok = deps.writeInput(input[1], text)
        return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: '终端不存在' })
      }

      return json(res, 404, { error: 'not found' })
    })().catch(() => json(res, 500, { error: 'internal' }))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // 只绑回环。要远程访问请走 Tailscale 之类的设备级 VPN，不要改成 0.0.0.0
    server.listen(deps.port, '127.0.0.1', resolve)
  })
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : deps.port

  return {
    port,
    token,
    push: (event, data) => {
      const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
      for (const c of clients) {
        try {
          c.write(payload)
        } catch {
          clients.delete(c)
        }
      }
    },
    dispose: () => {
      for (const c of clients) {
        try {
          c.end()
        } catch {
          // 已断开
        }
      }
      clients.clear()
      server.close()
    }
  }
}
