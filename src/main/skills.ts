import { readFile, readdir } from 'fs/promises'
import { join } from 'path'

export interface Skill {
  name: string
  content: string
}

const SKILL_DIR = join(process.cwd(), 'skills')

export async function listSkills(): Promise<string[]> {
  try {
    const files = await readdir(SKILL_DIR)
    return files.filter(f => f.endsWith('.md') || f.endsWith('.txt')).map(f => f.replace(/\.(md|txt)$/, ''))
  } catch {
    return []
  }
}

export async function loadSkill(name: string): Promise<Skill | null> {
  const candidates = [
    join(SKILL_DIR, `${name}.md`),
    join(SKILL_DIR, `${name}.txt`)
  ]
  for (const p of candidates) {
    try {
      const content = await readFile(p, 'utf8')
      return { name, content }
    } catch {}
  }
  return null
}

export async function buildSkillSystem(base: string, skillName?: string): Promise<string> {
  if (!skillName) return base
  const skill = await loadSkill(skillName)
  if (!skill) return base
  return `${base}\n\n## Active Skill: ${skill.name}\n${skill.content}`
}
