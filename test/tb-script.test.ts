/**
 * `tb` 脚本的语法与关键不变量。
 *
 * 这个脚本是**嵌在 TS 模板字符串里的一大段 POSIX sh**：TypeScript 不看它，
 * oxlint 不看它，改坏了要等某个 agent 在终端里跑 `tb ask` 才炸 ——
 * 而那时的报错是 `sh: syntax error`，和真正的改动隔着几十分钟。
 *
 * 所以这里直接从源码里把脚本抠出来跑 `sh -n`，外加钉两条会静默出错的性质：
 *
 * 1. **任务正文不能进 URL**。派活最常带长需求，中文一个字三字节 ——
 *    塞在 query 里会先撞上 Node 的 request target 上限，而那是在
 *    `TASK_MAX_BYTES` 那道业务闸**之前**；调用方只拿到空结果，
 *    agent 会把它当成"没人回答"。
 * 2. **curl 要带 `-f`**。不带的话 HTTP 400/403/413 都是退出码 0 + 空 stdout，
 *    对 agent 来说和"回答是空的"无法区分。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** 从 hooks.ts 里抠出 tb 脚本正文，并把 `${...}` 插值换成占位数字 */
function extractTbScript(): string {
  const src = readFileSync(new URL('../src/main/hooks.ts', import.meta.url), 'utf8')
  const anchor = src.indexOf('ask|delegate)')
  assert.ok(anchor > 0, '在 hooks.ts 里找不到 tb 脚本了 —— 这个测试的抽取方式要跟着改')
  const start = src.lastIndexOf('return `', anchor)
  const end = src.indexOf('\n`', anchor)
  assert.ok(start > 0 && end > start, 'tb 脚本的模板字符串边界没找到')
  return src
    .slice(start + 'return `'.length, end)
    .replace(/\$\{[^}]*\}/g, '30') // 模板插值 → 占位
    .replace(/\\`/g, '`')
    .replace(/\\\$/g, '$')
    .replace(/\\\\/g, '\\')
}

const script = extractTbScript()

test('tb 脚本能过 sh -n（语法错只会在 agent 跑它的时候才炸）', () => {
  const f = path.join(tmpdir(), `tb-syntax-${process.pid}.sh`)
  writeFileSync(f, script)
  try {
    execFileSync('/bin/sh', ['-n', f], { stdio: 'pipe' })
  } finally {
    unlinkSync(f)
  }
})

test('派活的任务正文走 POST body，不进 URL', () => {
  const ask = script.slice(script.indexOf('ask|delegate)'), script.indexOf('browser|web)'))
  assert.ok(/-X POST/.test(ask), 'tb ask 必须用 POST')
  assert.ok(/--data-binary @-/.test(ask), '正文要从 stdin 走 body')
  assert.ok(
    !/data-urlencode "task=/.test(ask),
    '任务正文回到 query 了 —— 长中文任务会在业务校验之前被 HTTP 层截断'
  )
})

test('派活的 curl 带 -f：HTTP 错误必须有非零退出码', () => {
  const ask = script.slice(script.indexOf('ask|delegate)'), script.indexOf('browser|web)'))
  assert.match(ask, /curl -sS -f/, '不带 -f 时 400/403/413 都是退出码 0 + 空输出')
})

test('脚本里不出现明文 token（只能从 endpoint 文件 source 进来）', () => {
  /* 这把 token 能伪造 SessionStart，而 SessionStart 在 delegate 的状态机里
     先于墓碑、无条件置活。脚本是 0700 但会被备份、被 cat、被贴进聊天。 */
  assert.ok(!/TERMBOARD_HOOK_TOKEN=[^"$]/.test(script), 'token 不能硬编码进脚本')
})
