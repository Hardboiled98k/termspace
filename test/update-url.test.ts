/**
 * 更新源地址的校验。
 *
 * 钉一条：**明文 http 一律不收。** 更新包会被下载下来替换掉整个 app，
 * 走 http 的话路上任何人都能换掉它。Squirrel 那道签名校验是第二道防线，
 * 不该拿它当第一道。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeFeedUrl } from '../src/main/update-url.ts'

test('http 一律拒（哪怕是 localhost）', () => {
  assert.equal(sanitizeFeedUrl('http://updates.example.com/'), '')
  assert.equal(sanitizeFeedUrl('http://127.0.0.1:8080/'), '')
  assert.equal(sanitizeFeedUrl('HTTP://updates.example.com/'), '')
})

test('别的协议也拒 —— file:// 会让更新包来自本地任意路径', () => {
  for (const bad of ['file:///tmp/evil/', 'ftp://x/', 'javascript:alert(1)', 'data:text/plain,x']) {
    assert.equal(sanitizeFeedUrl(bad), '', `${bad} 必须拒`)
  }
})

test('空 / 非字符串 / 不是 URL → 空串（合法的"没配"状态）', () => {
  for (const v of ['', '   ', null, undefined, 42, {}, [], 'not a url']) {
    assert.equal(sanitizeFeedUrl(v), '')
  }
})

test('https 收下，并补上结尾斜杠', () => {
  // electron-updater 按目录拼 latest-mac.yml，少一个斜杠会去请求同级的
  // `termscapelatest-mac.yml`，报一个看不懂的 404
  assert.equal(sanitizeFeedUrl('https://x.dev/termscape'), 'https://x.dev/termscape/')
  assert.equal(sanitizeFeedUrl('https://x.dev/termscape/'), 'https://x.dev/termscape/')
  assert.equal(sanitizeFeedUrl('  https://x.dev/a/b  '), 'https://x.dev/a/b/')
})
