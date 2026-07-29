/**
 * 更新源的同源代理。
 *
 * **为什么必须有这一层**：页面在 `termspace.app`，更新源在 `updates.termspace.app`
 * —— 跨子域就是跨源，而 R2 桶没有 `Access-Control-Allow-Origin` 头
 * （实测：响应里只有 content-type）。浏览器直接 fetch 会被拦，
 * 于是"版本号从 feed 实时读"这个设计整个失效。
 *
 * 三种修法里选了这个：
 * - 给桶开 CORS → 要动发布用的桶，且等于向所有站点开放，没必要
 * - 把版本号写进页面 → **一定会有某次发版忘记改**，用户下到旧包还不知道
 * - 同源代理 → 服务端取，没有跨源问题，还能自己定缓存
 */
export async function onRequest() {
  const upstream = 'https://updates.termspace.app/latest-mac.yml'
  try {
    const r = await fetch(upstream, { cf: { cacheTtl: 300, cacheEverything: true } })
    if (!r.ok) throw new Error(`upstream ${r.status}`)
    return new Response(await r.text(), {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        // 5 分钟 —— 发版后用户最多晚 5 分钟看到新版本，够了
        'cache-control': 'public, max-age=300'
      }
    })
  } catch (e) {
    /* **取不到就如实报错**，绝不返回一个兜底的旧版本号 ——
       页面那边会显示"暂时取不到"并给出更新源地址，比下到过期的包好。 */
    return new Response(`upstream unavailable: ${e}`, { status: 502 })
  }
}
