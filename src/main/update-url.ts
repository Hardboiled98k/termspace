/**
 * 更新源地址的校验。
 *
 * 单独成文件是为了能被 `node --test` 覆盖 —— settings-store.ts 依赖 electron。
 * 而这几行是**安全判据**，不是格式美化：
 *
 * 更新包会被下载下来**替换掉整个 app**。走明文 http 的话，路上任何人
 * （咖啡馆 Wi-Fi、运营商、被投毒的 DNS）都能把它换成自己的包。
 * macOS 上 Squirrel 还会校验签名同源，所以攻击者装不进去 ——
 * 但那是**第二道**防线，不该拿它当第一道。
 */

/** 空串 = 没配（合法状态，更新功能整个不工作） */
export function sanitizeFeedUrl(v: unknown): string {
  if (typeof v !== 'string') return ''
  const t = v.trim()
  if (!t) return ''
  let u: URL
  try {
    u = new URL(t)
  } catch {
    return ''
  }
  // **只收 https**。见文件头
  if (u.protocol !== 'https:') return ''
  /* 结尾要有斜杠：electron-updater 是按目录拼 `latest-mac.yml` 的，
     少一个斜杠会去请求同级的 `xxxlatest-mac.yml`，报一个看不懂的 404。 */
  return u.href.endsWith('/') ? u.href : `${u.href}/`
}
