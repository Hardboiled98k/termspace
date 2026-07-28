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
  // `termspacelatest-mac.yml`，报一个看不懂的 404
  assert.equal(sanitizeFeedUrl('https://x.dev/termspace'), 'https://x.dev/termspace/')
  assert.equal(sanitizeFeedUrl('https://x.dev/termspace/'), 'https://x.dev/termspace/')
  assert.equal(sanitizeFeedUrl('  https://x.dev/a/b  '), 'https://x.dev/a/b/')
})

test('带凭证 / query / fragment 的地址一律拒 —— 要的是一个目录', () => {
  /* 原来只判协议，于是 https://x/feed?token=a 会被补成 ...?token=a/ ——
     斜杠加进了 query 而不是路径，拼出来的地址一定 404。
     而 user:pass@ 会被原样存进 settings.json 并显示在设置面板里。 */
  for (const bad of [
    'https://user:password@example.com/feed/',
    'https://user@example.com/feed/',
    'https://example.com/feed?token=secret',
    'https://example.com/feed#frag',
    'https://example.com/feed/?a=1'
  ]) {
    assert.equal(sanitizeFeedUrl(bad), '', `${bad} 必须拒`)
  }
})

test('补斜杠补在路径上，不是拼在 href 尾巴上', () => {
  const out = sanitizeFeedUrl('https://x.dev/a/b')
  assert.equal(out, 'https://x.dev/a/b/')
  assert.ok(!out.includes('?') && !out.includes('#'))
  // 根路径本来就有斜杠，不该变成 //
  assert.equal(sanitizeFeedUrl('https://x.dev'), 'https://x.dev/')
})
