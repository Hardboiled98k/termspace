/**
 * F8 工具中枢 · skill 索引（纯代码检索，不调模型）
 * 扫描 skill 目录 → 解析 frontmatter → 关键词/子串打分检索。
 * 全画布 agent 共用同一份库，通过 tb / MCP 渐进式披露：
 *   L0 常驻只有一行路由提示 → L1 search 出名字+描述 → L2 load 才给全文
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export interface SkillMeta {
  name: string
  description: string
  file: string
  source: string // 来源目录（便于设置面板显示）
}

const MAX_SKILL_BYTES = 200_000
const CACHE_TTL = 30_000

let cache: { at: number; list: SkillMeta[] } | null = null

function parseFrontmatter(text: string): { name?: string; description?: string } {
  if (!text.startsWith('---')) return {}
  const end = text.indexOf('\n---', 3)
  if (end < 0) return {}
  const out: Record<string, string> = {}
  for (const line of text.slice(3, end).split('\n')) {
    const m = line.match(/^([a-zA-Z_-]+):\s*(.*)$/)
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
  return { name: out['name'], description: out['description'] }
}

/** 一个目录下形如 <dir>/<skill>/SKILL.md 的布局 */
async function scanDir(dir: string): Promise<SkillMeta[]> {
  if (!existsSync(dir)) return []
  const out: SkillMeta[] = []
  let entries: string[] = []
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  for (const e of entries) {
    if (e.startsWith('.')) continue
    const file = path.join(dir, e, 'SKILL.md')
    if (!existsSync(file)) continue
    try {
      const s = await stat(file)
      if (s.size > MAX_SKILL_BYTES) continue
      const text = await readFile(file, 'utf8')
      const fm = parseFrontmatter(text)
      out.push({
        name: fm.name || e,
        description: (fm.description || '').slice(0, 300),
        file,
        source: dir
      })
    } catch {
      // 单个 skill 读失败不影响整体
    }
  }
  return out
}

export async function listSkills(extraDirs: string[] = []): Promise<SkillMeta[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL) return cache.list
  const dirs = [path.join(os.homedir(), '.claude', 'skills'), ...extraDirs]
  const all: SkillMeta[] = []
  const seen = new Set<string>()
  for (const d of dirs) {
    for (const s of await scanDir(d)) {
      if (seen.has(s.name)) continue // 先来的目录优先
      seen.add(s.name)
      all.push(s)
    }
  }
  all.sort((a, b) => a.name.localeCompare(b.name))
  cache = { at: Date.now(), list: all }
  return all
}

function tokenize(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[\s,，、/|]+/)
    .filter((t) => t.length > 0)
}

/** 打分：名字命中 > 描述命中；支持中文子串（无需分词器） */
export function scoreSkill(s: SkillMeta, tokens: string[]): number {
  const name = s.name.toLowerCase()
  const desc = s.description.toLowerCase()
  let score = 0
  for (const t of tokens) {
    if (name === t) score += 10
    else if (name.includes(t)) score += 5
    if (desc.includes(t)) score += 2
    // 中文按字命中（描述里常是整句）
    if (t.length >= 2) {
      for (const ch of t) {
        if (/[一-龥]/.test(ch) && desc.includes(ch)) score += 0.2
      }
    }
  }
  return score
}

export async function searchSkills(
  query: string,
  extraDirs: string[] = [],
  limit = 8
): Promise<SkillMeta[]> {
  const all = await listSkills(extraDirs)
  const tokens = tokenize(query)
  if (!tokens.length) return all.slice(0, limit)
  return all
    .map((s) => ({ s, score: scoreSkill(s, tokens) }))
    .filter((x) => x.score > 0)
    .toSorted((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.s)
}

export async function loadSkill(name: string, extraDirs: string[] = []): Promise<string | null> {
  const all = await listSkills(extraDirs)
  const hit =
    all.find((s) => s.name === name) ||
    all.find((s) => s.name.toLowerCase() === name.toLowerCase())
  if (!hit) return null
  try {
    return await readFile(hit.file, 'utf8')
  } catch {
    return null
  }
}

export function invalidateSkillCache(): void {
  cache = null
}
