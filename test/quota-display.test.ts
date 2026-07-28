/**
 * 钉的是“没有数字”被空进度槽/0% 冒充，以及未登录、官方不可查、采集失败
 * 被合并成同一句话的 bug。任一状态重新画条或三句退化为同文案，本文件都会红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  hasQuotaProgress,
  maskEmail,
  quotaUnavailableText,
  type QuotaDisplayInput
} from '../src/renderer/src/quota-display.ts'

const item = (
  state: QuotaDisplayInput['state'],
  quotaCapability: QuotaDisplayInput['quotaCapability']
): QuotaDisplayInput => ({ state, quotaCapability, windows: [] })

test('未登录、官方不可查、采集失败都不画进度条且文案各不相同', () => {
  const cases = [
    item('unconfigured', 'supported'),
    item('unavailable', 'officially_unavailable'),
    item('unavailable', 'collector_error')
  ]
  assert.deepEqual(cases.map(hasQuotaProgress), [false, false, false])
  const texts = cases.map(quotaUnavailableText)
  assert.equal(new Set(texts).size, 3)
  assert.match(texts[0], /未登录/)
  assert.match(texts[1], /无官方/)
  assert.match(texts[2], /无法确认/)
})

test('只有 ok 或 stale 且真有窗口时才画进度条', () => {
  assert.equal(hasQuotaProgress({ ...item('ok', 'supported'), windows: [{}] }), true)
  assert.equal(hasQuotaProgress({ ...item('stale', 'supported'), windows: [{}] }), true)
  assert.equal(hasQuotaProgress({ ...item('unavailable', 'collector_error'), windows: [{}] }), false)
})

test('账号邮箱默认脱敏', () => {
  assert.equal(maskEmail('alice@gmail.com'), 'a***@gmail.com')
})
