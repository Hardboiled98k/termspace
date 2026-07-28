export interface ProcessRow {
  pid: number
  ppid: number
  command: string
}

export interface ProcessLink {
  pid: number
  ppid: number
}

export function parseProcessLinks(stdout: string): ProcessLink[] {
  return stdout
    .split('\n')
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s*$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]) }))
}

export function descendantPids(rootPid: number, links: ProcessLink[]): number[] {
  const pending = [rootPid]
  const seen = new Set<number>()
  while (pending.length) {
    const parent = pending.pop()!
    if (seen.has(parent)) continue
    seen.add(parent)
    for (const link of links) if (link.ppid === parent) pending.push(link.pid)
  }
  seen.delete(rootPid)
  return [...seen]
}

export function parseProcessTable(stdout: string): ProcessRow[] {
  return stdout
    .split('\n')
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }))
}

/** 只匹配可执行文件/脚本路径，不扫描参数正文，避免把 prompt 里的 provider 名误判成进程。 */
export function providerFromProcessCommand(command: string): string | null {
  const head = command.trim().split(/\s+/, 2)
  const executable = head[0]?.split('/').at(-1)?.toLowerCase() ?? ''
  const script = (head[1] ?? '').toLowerCase()
  const candidates = `${executable} ${script}`
  if (/(^|[/_-])cursor-agent(?:$|[\s./_-])/.test(candidates)) return 'cursor'
  if (/(^|[/_-])antigravity(?:-cli)?(?:$|[\s./_-])|(^|[/_-])agy(?:$|[\s./_-])/.test(candidates)) return 'antigravity'
  if (/(^|[/_-])gemini(?:$|[\s./_-])/.test(candidates)) return 'gemini'
  if (/(^|[/_-])claude(?:$|[\s./_-])/.test(candidates)) return 'claude'
  if (/(^|[/_-])codex(?:$|[\s./_-])/.test(candidates)) return 'codex'
  return null
}

export function descendantProvider(rootPid: number, rows: ProcessRow[]): string | null {
  const pending = [rootPid]
  const seen = new Set<number>()
  let found: string | null = null
  while (pending.length) {
    const parent = pending.pop()!
    if (seen.has(parent)) continue
    seen.add(parent)
    for (const row of rows) {
      if (row.ppid !== parent) continue
      pending.push(row.pid)
      found = providerFromProcessCommand(row.command) ?? found
    }
  }
  return found
}
