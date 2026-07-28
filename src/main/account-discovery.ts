/**
 * 本机账号的低侵入发现器。
 *
 * 只读固定路径和官方 status 命令；不遍历 home、不读 token、不碰浏览器 Cookie、
 * identities.bin/brokers.bin/peer-token/nodetokens。命令不存在、超时或输出变形都
 * 是 unknown（无法确认），绝不能冒充“未登录”。
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseClaudeAuth, type LoginStatus } from './login-status.ts'
import type { AccountPresence } from './quota/types.ts'

export interface DiscoveredAccount {
  accountId: string
  provider: string
  name: string
  quotaCapability: 'officially_unavailable'
  presence: AccountPresence
  email?: string
  plan?: string
}

const findBin = (home: string, names: string[]): string | null => {
  for (const name of names) {
    const found = [
      path.join(home, '.npm-global/bin', name),
      path.join(home, '.local/bin', name),
      path.join('/opt/homebrew/bin', name),
      path.join('/usr/local/bin', name),
      path.join('/usr/bin', name)
    ].find(existsSync)
    if (found) return found
  }
  return null
}

type Runner = (
  file: string,
  args: string[],
  options: { timeout: number; env?: NodeJS.ProcessEnv }
) => Promise<{ error: boolean; stdout: string; stderr: string }>

const run: Runner = (file, args, options) =>
  new Promise((resolve) => {
    execFile(file, args, options, (err, stdout, stderr) =>
      resolve({ error: !!err, stdout, stderr })
    )
  })

export async function probeClaudeAccount(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  runner: Runner = run
): Promise<LoginStatus> {
  const bin = findBin(home, ['claude'])
  if (!bin) return { state: 'unknown', detail: '无法确认：本机没找到 claude' }
  const r = await runner(bin, ['auth', 'status', '--json'], { timeout: 8000, env })
  if (r.error && !r.stdout.trim()) {
    return { state: 'unknown', detail: '无法确认：命令失败或超时' }
  }
  return parseClaudeAuth(r.stdout || r.stderr)
}

export async function probeCursorStatus(
  home: string,
  runner: Runner = run,
  binOverride?: string
): Promise<AccountPresence | null> {
  const bin = binOverride ?? findBin(home, ['cursor-agent'])
  if (!bin) return null
  const r = await runner(bin, ['status'], { timeout: 5000 })
  if (r.error) return { state: 'unknown', detail: '无法确认：cursor-agent status 失败或超时', discovered: true }
  const text = `${r.stdout}\n${r.stderr}`.trim()
  if (/\b(not logged in|logged out|unauthenticated)\b/i.test(text)) {
    return { state: 'not_logged_in', detail: '未登录 —— 运行 cursor-agent login', discovered: true }
  }
  if (/\b(logged in|authenticated|signed in)\b/i.test(text)) {
    return { state: 'verified', detail: 'cursor-agent status 已验证登录', discovered: true }
  }
  return { state: 'unknown', detail: '无法确认：cursor-agent status 输出格式变化', discovered: true }
}

export async function discoverLowConfidenceAccounts(
  home: string,
  runningProviders: ReadonlySet<string>,
  runner: Runner = run
): Promise<DiscoveredAccount[]> {
  const found: DiscoveredAccount[] = []
  const geminiDir = path.join(home, '.gemini')
  const antigravityDir = path.join(geminiDir, 'antigravity-cli')

  if (runningProviders.has('antigravity') && existsSync(antigravityDir)) {
    found.push({
      accountId: 'system:antigravity',
      provider: 'antigravity',
      name: '系统登录',
      quotaCapability: 'officially_unavailable',
      presence: { state: 'detected', detail: '正在使用 · 检测到 Antigravity 状态', discovered: true }
    })
  }

  const settingsFile = path.join(geminiDir, 'settings.json')
  if (existsSync(settingsFile)) {
    let selectedType = ''
    try {
      const settings = JSON.parse(await readFile(settingsFile, 'utf8')) as {
        security?: { auth?: { selectedType?: unknown } }
      }
      if (typeof settings.security?.auth?.selectedType === 'string') {
        selectedType = settings.security.auth.selectedType
      }
    } catch {
      // 文件存在仍是发现信号；内容损坏不能被说成未登录。
    }
    found.push({
      accountId: 'system:gemini',
      provider: 'gemini',
      name: '系统配置',
      quotaCapability: 'officially_unavailable',
      presence: {
        state: 'detected',
        detail: selectedType ? `检测到配置 · ${selectedType}` : '检测到配置',
        discovered: true
      }
    })
  }

  const cursor = await probeCursorStatus(home, runner)
  if (cursor) {
    found.push({
      accountId: 'system:cursor',
      provider: 'cursor',
      name: '系统登录',
      quotaCapability: 'officially_unavailable',
      presence: cursor
    })
  }
  return found
}
