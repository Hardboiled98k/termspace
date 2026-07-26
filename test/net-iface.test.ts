/**
 * 绑定地址判定的回归测试。
 * 这段判错 = 把一个能 spawn pty、持有模型凭证的服务开到错误的网卡上，
 * 所以「绝不返回非 Tailscale 地址」这条必须钉死。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import { tailscaleCandidates, resolveBind, hostAllowed } from '../src/main/net-iface.ts'

/** 默认造出来的是「tun 口」形态：/32 + 全零 MAC */
const v4 = (
  address: string,
  internal = false,
  netmask = '255.255.255.255',
  mac = '00:00:00:00:00:00'
): os.NetworkInterfaceInfo =>
  ({ address, family: 'IPv4', internal, netmask, mac, cidr: null }) as unknown as os.NetworkInterfaceInfo

/** 物理网卡：真实掩码 + 真实 MAC */
const phys = (address: string, netmask = '255.255.255.0'): os.NetworkInterfaceInfo =>
  v4(address, false, netmask, '02:00:00:00:00:01')

const pickTailscale = (ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string | null =>
  tailscaleCandidates(ifaces)[0] ?? null

/* 本机实测的真实形态：Tailscale 在 utun7，另一个 VPN 也占了个 utun。
   按接口名匹配会认错，所以判据必须是网段。 */
const REAL = {
  lo0: [v4('127.0.0.1', true, '255.0.0.0')],
  en0: [phys('192.0.2.10')],
  utun7: [v4('100.101.102.103')],
  utun99: [v4('172.19.0.1', false, '255.255.255.252')]
}

test('从真实网卡里挑出 Tailscale 地址（而不是同为 utun 的另一个 VPN）', () => {
  assert.equal(pickTailscale(REAL), '100.101.102.103')
})

test('没有 Tailscale 时返回 null —— 绝不"退而求其次"给个局域网地址', () => {
  assert.equal(pickTailscale({ lo0: [v4('127.0.0.1', true)], en0: [phys('192.0.2.10')] }), null)
})

/* 评审查出的 P0：100.64.0.0/10 是共享 CGNAT 段，不是 Tailscale 专用。
   酒店/校园/运营商网络会直接给物理网卡发这个段的地址；只判网段就会把服务
   绑到公共 Wi-Fi 网卡上，而且界面还显示"只有你自己的设备看得见"。
   而 Object.values 的遍历顺序里 en0 稳定排在 utun7 前面 —— 物理网卡是必然抢先。 */
test('物理网卡拿到 CGNAT 地址（酒店/运营商 DHCP）绝不能被当成 Tailscale', () => {
  assert.equal(pickTailscale({ en0: [phys('100.71.3.42', '255.255.240.0')] }), null)
  // 就算它排在真 Tailscale 前面，也只能挑到真的那张
  assert.equal(
    pickTailscale({ en0: [phys('100.71.3.42', '255.255.240.0')], utun7: [v4('100.101.102.103')] }),
    '100.101.102.103'
  )
})

test('CGNAT + /32 但带真实 MAC 的也不算（只有 tun 口没有链路层地址）', () => {
  assert.equal(pickTailscale({ en5: [phys('100.100.1.1', '255.255.255.255')] }), null)
})

test('CGNAT 边界：100.64.x 与 100.127.x 算，100.63/100.128 不算', () => {
  assert.equal(pickTailscale({ a: [v4('100.64.0.1')] }), '100.64.0.1')
  assert.equal(pickTailscale({ a: [v4('100.127.255.254')] }), '100.127.255.254')
  assert.equal(pickTailscale({ a: [v4('100.63.0.1')] }), null)
  assert.equal(pickTailscale({ a: [v4('100.128.0.1')] }), null)
  // 100.x 但不在 CGNAT 段的公网地址不能误判
  assert.equal(pickTailscale({ a: [v4('100.1.2.3')] }), null)
})

test('internal 网卡不参与（回环别名不能当成 Tailscale）', () => {
  assert.equal(pickTailscale({ lo0: [v4('100.64.0.1', true)] }), null)
})

test('loopback 模式永远绑 127.0.0.1', () => {
  assert.deepEqual(resolveBind('loopback'), { host: '127.0.0.1', fellBack: false })
})

test('resolveBind 的返回值只可能是回环或 CGNAT，永远不是 0.0.0.0', () => {
  const r = resolveBind('tailscale')
  assert.notEqual(r.host, '0.0.0.0')
  assert.ok(r.host === '127.0.0.1' || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(r.host))
  // 没绑上 Tailscale 时必须如实报告，否则界面会骗用户"手机能连"
  assert.equal(r.fellBack, r.host === '127.0.0.1')
})

test('Host 白名单挡住 DNS rebinding', () => {
  const bound = '100.101.102.103'
  assert.equal(hostAllowed('evil.com', bound), false)
  assert.equal(hostAllowed('100.101.102.103.nip.io', bound), false)
  // 后缀必须是 .ts.net，不能被 "xxx.ts.net.evil.com" 骗过
  assert.equal(hostAllowed('mac.tailnet.ts.net.evil.com', bound), false)
  assert.equal(hostAllowed(undefined, bound), false)
})

test('Host 白名单放行本机、绑定地址与 MagicDNS', () => {
  const bound = '100.101.102.103'
  assert.equal(hostAllowed('100.101.102.103:7333', bound), true)
  assert.equal(hostAllowed('localhost:7333', bound), true)
  assert.equal(hostAllowed('127.0.0.1', bound), true)
  assert.equal(hostAllowed('[::1]:7333', bound), true)
  assert.equal(hostAllowed('MacBook-Pro.tailc73b33.TS.NET:7333', bound), true)
  // Tailscale 自报的 DNSName 带尾点（macbook-pro.tail781715.ts.net.），客户端可能原样发出
  assert.equal(hostAllowed('macbook-pro.tail781715.ts.net.', bound), true)
  assert.equal(hostAllowed('macbook-pro.tail781715.ts.net.:7333', bound), true)
})
