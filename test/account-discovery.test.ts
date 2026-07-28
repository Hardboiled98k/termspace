/**
 * 钉的是 CLI adapter 超时/命令失败被错误降级成“未登录”。
 * 失败必须是“无法确认”，否则用户会被引导去重复登录。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { discoverLowConfidenceAccounts, probeCursorStatus } from '../src/main/account-discovery.ts'

test('adapter 超时降级为无法确认，不是未登录', async () => {
  const result = await probeCursorStatus(
    '/tmp',
    async () => ({ error: true, stdout: '', stderr: 'timeout' }),
    '/fake/cursor-agent'
  )
  assert.equal(result?.state, 'unknown')
  assert.match(result?.detail ?? '', /无法确认/)
  assert.doesNotMatch(result?.detail ?? '', /未登录/)
})

test('Antigravity 和 Gemini 只声称检测到状态或配置，额度明确为官方不可查', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'termspace-discovery-'))
  await mkdir(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true })
  await writeFile(
    path.join(home, '.gemini', 'settings.json'),
    JSON.stringify({ security: { auth: { selectedType: 'oauth-personal' } } })
  )
  const found = await discoverLowConfidenceAccounts(home, new Set(['antigravity']), async () => ({
    error: true,
    stdout: '',
    stderr: ''
  }))
  const agy = found.find((a) => a.provider === 'antigravity')
  const gemini = found.find((a) => a.provider === 'gemini')
  assert.equal(agy?.presence.state, 'detected')
  assert.doesNotMatch(agy?.presence.detail ?? '', /已登录|Google AI Pro/)
  assert.equal(agy?.quotaCapability, 'officially_unavailable')
  assert.match(gemini?.presence.detail ?? '', /检测到配置/)
  assert.equal(gemini?.quotaCapability, 'officially_unavailable')
})
