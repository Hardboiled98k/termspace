/**
 * 只缓存"壳"（HTML/JS/CSS/图标），/api/* 一律直连。
 * 缓存 API 响应会让手机上显示的 agent 状态是过期的 —— 那比看不到更危险。
 */
const CACHE = 'termscape-shell-v1'
const SHELL = ['/', '/index.html', '/app.js', '/style.css', '/icon.svg', '/icon-180.png', '/icon-512.png', '/manifest.webmanifest']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)))
  self.skipWaiting()
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      // claim 也要挂进等待链，否则可能在旧缓存清完前就接管
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET') return
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/')) return // 数据永不缓存

  // 壳走 network-first：电脑上改了页面立刻生效，离线时回落缓存
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        /* 只缓存成功响应。421（Host 白名单）/404 也写进去的话，
           一次抽风就能把一段错误 JSON 钉成离线首页，之后怎么刷都是它。 */
        if (res.ok) {
          const copy = res.clone()
          // 写缓存挂进 waitUntil，别让 SW 在写完前被回收
          e.waitUntil(caches.open(CACHE).then((c) => c.put(e.request, copy)))
        }
        return res
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/index.html')))
  )
})
