/*
 * 官网共享脚本：版本读取 / 架构判断 / 导航高亮 / 滚动渐显。
 *
 * **页面里一处都不写死版本号** —— 写死的话一定会有某次发版忘记改，
 * 用户下到旧包还不知道。全部从更新源实时读。
 */

document.documentElement.classList.remove('no-js')

/* ── 导航当前页 ─────────────────────────────────────────────── */
;(function markNav() {
  // 归一化成 `/`、`/features/` 这种形状，好和 href 直接比
  const here = location.pathname.replace(/index\.html$/, '')
  for (const a of document.querySelectorAll('.nav a.link')) {
    const href = a.getAttribute('href') || ''
    if (href !== '/' && here.startsWith(href)) a.setAttribute('aria-current', 'page')
  }
})()

/* ── 滚动渐显 ───────────────────────────────────────────────── */
;(function reveal() {
  const els = document.querySelectorAll('.rise')
  if (!els.length) return
  /* IntersectionObserver 认不出来就**直接全显示** —— 渐显是增强，
     不能让不支持它的浏览器看到一个空白页 */
  if (!('IntersectionObserver' in window)) {
    for (const el of els) el.classList.add('in')
    return
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        e.target.classList.add('in')
        io.unobserve(e.target)
      }
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.05 }
  )
  for (const el of els) io.observe(el)
})()

/* ── 更新源 ─────────────────────────────────────────────────── */

const CDN = 'https://updates.termspace.app/'

/**
 * 这台机器是 Apple Silicon 还是 Intel。**判不出就返回 null** —— 交给用户自己选。
 * 下错架构是最常见的下载失败点，「替用户猜错」比「多问一句」糟得多。
 */
function detectArch() {
  const d = navigator.userAgentData
  if (d && typeof d.architecture === 'string') return d.architecture.includes('arm') ? 'arm64' : 'x64'
  /* userAgent 认不出 Mac 的芯片（Safari 和 Chrome 都报 Intel），
     退到 WebGL 渲染器名 —— 那里面有 "Apple M1/M2/…" */
  try {
    const gl = document.createElement('canvas').getContext('webgl')
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info')
    const r = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : ''
    if (/apple\s*m\d/i.test(r)) return 'arm64'
    if (/intel|radeon/i.test(r)) return 'x64'
  } catch (_) {
    /* 隐私模式可能禁 WebGL —— 判不出就往下走 */
  }
  return null
}

/**
 * 取 latest-mac.yml 并解析。走 `/api/feed` 同源代理：
 * R2 桶没有 CORS 头（实测），页面直接 fetch 会被浏览器拦。
 */
async function loadFeed() {
  const r = await fetch('/api/feed', { cache: 'no-store' })
  if (!r.ok) throw new Error('HTTP ' + r.status)
  const yml = await r.text()
  const version = (yml.match(/^version:\s*(.+)$/m) || [])[1]
  const dmgs = [...yml.matchAll(/url:\s*(\S+\.dmg)/g)].map((m) => m[1])
  const date = (yml.match(/^releaseDate:\s*'?([\d-]{10})/m) || [])[1]
  if (!version || !dmgs.length) throw new Error('feed 形状变了')
  return {
    version: version.trim(),
    date,
    arm: dmgs.find((u) => /arm64/.test(u)),
    x64: dmgs.find((u) => !/arm64/.test(u))
  }
}

/**
 * 接上下载按钮。`opts.btn` / `opts.alt` / `opts.meta` 都是可选的元素 id。
 * 页面上没有的就不管，同一份逻辑首页和下载页共用 —— 两份实现改一处漏一处。
 */
function wireDownload(opts) {
  const btn = document.getElementById(opts.btn)
  const alt = opts.alt ? document.getElementById(opts.alt) : null
  const meta = opts.meta ? document.getElementById(opts.meta) : null
  const foot = document.getElementById('ver-foot')

  loadFeed()
    .then((f) => {
      const a = detectArch()
      const link = (u, t) => '<a href="' + CDN + u + '" download>' + t + '</a>'
      const set = (u, label) => {
        if (!btn) return
        btn.href = CDN + u
        btn.textContent = label
        btn.setAttribute('download', '')
      }

      if (a === 'arm64' && f.arm) {
        set(f.arm, '下载 for macOS · Apple 芯片')
        if (alt && f.x64) alt.innerHTML = '用 Intel Mac？' + link(f.x64, '下载 Intel 版')
      } else if (a === 'x64' && f.x64) {
        set(f.x64, '下载 for macOS · Intel')
        if (alt && f.arm) alt.innerHTML = '用 Apple 芯片？' + link(f.arm, '下载 Apple 芯片版')
      } else {
        set(f.arm || f.x64, '下载 for macOS')
        if (alt) {
          alt.innerHTML = [f.arm && link(f.arm, 'Apple 芯片'), f.x64 && link(f.x64, 'Intel')]
            .filter(Boolean)
            .join(' · ')
        }
      }
      if (meta) meta.textContent = 'v' + f.version + ' · macOS 12+ · 已公证'
      if (foot) foot.textContent = 'v' + f.version
      document.dispatchEvent(new CustomEvent('feed', { detail: f }))
    })
    .catch(() => {
      /* 取不到就**如实说**并给出更新源地址，绝不显示一个写死的旧版本号假装正常 —— 那会让用户下到过期的包 */
      if (btn) {
        btn.textContent = '暂时取不到下载地址'
        btn.setAttribute('aria-disabled', 'true')
        btn.href = CDN + 'latest-mac.yml'
      }
      if (alt) alt.innerHTML = '直接看 <a href="' + CDN + 'latest-mac.yml">更新源</a>'
      if (meta) meta.textContent = ''
    })
}

window.Termspace = { CDN, detectArch, loadFeed, wireDownload }
