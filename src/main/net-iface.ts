/**
 * 绑定地址探测。
 *
 * 远程 API 要让手机连上，就不能只绑 127.0.0.1。但**绝不能绑 0.0.0.0** ——
 * 这个进程能 spawn pty、读写文件、持有模型凭证，监听在咖啡厅 Wi-Fi 上等于交出整台机器。
 *
 * 折中：只绑 Tailscale 那一张网卡。tailnet 是 WireGuard + 设备认证的私有网络，
 * 不是公网；绑上去之后，物理同网段的陌生设备（酒店/机场 Wi-Fi）根本看不到这个端口。
 */
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

/** Tailscale 用 CGNAT 段 100.64.0.0/10 给设备发地址 */
function isCgnat(ip: string): boolean {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\./)
  if (!m) return false
  return Number(m[1]) === 100 && Number(m[2]) >= 64 && Number(m[2]) <= 127
}

/**
 * 找出所有**长得像 Tailscale** 的本机 IPv4。
 *
 * 三条判据缺一不可，只用网段是不够的 —— 这是评审查出的 P0：
 * 100.64.0.0/10 是**共享** CGNAT 段，不是 Tailscale 专用。酒店 / 校园 / 运营商网络
 * 通过 DHCP 直接给物理网卡发 100.71.x.x 是常见配置，只判网段就会把一个能 spawn pty、
 * 持有模型凭证的服务绑到公共 Wi-Fi 网卡上，而且界面还会说"只有你自己的设备看得见"。
 * 更糟的是 Object.values(os.networkInterfaces()) 里 en0 排在 utun7 前面，物理网卡是
 * 稳定抢先，不是偶发。
 *
 * 另外两条判据（本机实测）：
 *   utun7（Tailscale）= /32 + 全零 MAC —— tun 口没有链路层地址，三平台都发 /32
 *   en0（物理）       = /24 + 真 MAC
 *   utun99（别的 VPN）= /30 + 全零 MAC
 * 接口名不能用：macOS 上 utunN 的 N 每次启动都变，Linux 叫 tailscale0，Windows 又不同。
 */
export function tailscaleCandidates(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string[] {
  const out: string[] = []
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      if (!isCgnat(a.address)) continue
      if (a.netmask !== '255.255.255.255') continue // 物理网卡拿到的 DHCP 地址不会是 /32
      if (a.mac && a.mac !== '00:00:00:00:00:00') continue // tun 口没有 MAC
      out.push(a.address)
    }
  }
  return out
}

/**
 * 问 tailscaled 要它自己的地址。
 *
 * 只用来在多个候选里**挑一个**，不用来放宽判据 —— 返回值仍要过 CGNAT 检查、
 * 且必须真的挂在某张网卡上才会被采用。CLI 不存在（App Store 版只有 GUI）或没登录时
 * 返回 null，退回上面的启发式。
 */
function tailscaleFromCli(): string | null {
  const bins = [
    '/usr/local/bin/tailscale',
    '/opt/homebrew/bin/tailscale',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/usr/bin/tailscale'
  ]
  for (const bin of bins) {
    if (!existsSync(bin)) continue
    try {
      const out = execFileSync(bin, ['ip', '-4'], { timeout: 2000, encoding: 'utf8' })
      const ip = out.trim().split('\n')[0]?.trim() ?? ''
      if (isCgnat(ip)) return ip
    } catch {
      // 没登录 / 守护进程没起 / 超时 —— 交给启发式
    }
  }
  return null
}

/** Tailscale 给本机的 IPv4，没有则 null */
export function tailscaleIPv4(): string | null {
  const candidates = tailscaleCandidates(os.networkInterfaces())
  if (!candidates.length) return null
  const cli = tailscaleFromCli()
  /* 有多张 tun 网卡时（比如同时跑 Cloudflare WARP，它也发 CGNAT /32），
     以 tailscaled 自报的为准；但只在它确实出现在网卡列表里时才采信。 */
  if (cli && candidates.includes(cli)) return cli
  return candidates[0]
}

export type BindMode = 'loopback' | 'tailscale'

export interface BindChoice {
  host: string
  /** 请求的模式没成，退回了 loopback —— 界面要如实说，别让用户以为手机能连 */
  fellBack: boolean
}

export function resolveBind(mode: BindMode): BindChoice {
  if (mode !== 'tailscale') return { host: '127.0.0.1', fellBack: false }
  const ip = tailscaleIPv4()
  // Tailscale 没开/没登录时 IP 不存在。此时**必须**退回回环，
  // 绝不能"退而求其次"绑 0.0.0.0 或 en0 —— 那是把口开到当前 Wi-Fi 上
  return ip ? { host: ip, fellBack: false } : { host: '127.0.0.1', fellBack: true }
}

/**
 * Host 头白名单：挡 DNS rebinding。
 *
 * 攻击者可以把自己域名解析到 100.x.y.z:7333，诱导用户浏览器发同源请求。
 * 写操作都要 Bearer token（攻击页拿不到），所以危害有限；但这条检查很便宜，
 * 顺手把整类问题掐掉，也顺带挡住把服务当开放代理探测的扫描。
 */
export function hostAllowed(header: string | undefined, bound: string): boolean {
  if (!header) return false
  const host = header
    .replace(/:\d+$/, '') // 去端口
    .replace(/^\[|\]$/g, '') // IPv6 字面量的方括号
    .replace(/\.$/, '') // FQDN 尾点：Tailscale 自报的 DNSName 就带一个
    .toLowerCase()
  if (host === bound) return true
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return true
  // MagicDNS：<machine>.<tailnet>.ts.net。只认这个后缀，不认任意域名
  if (host.endsWith('.ts.net')) return true
  return false
}
