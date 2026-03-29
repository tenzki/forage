import { describe, it, expect } from 'vitest'
import { SKILLS, filterSkills, shouldAllowSlash, parseSlashInput } from './SlashCommand'

describe('SKILLS registry', () => {
  it('contains ask, research, brainstorm entries', () => {
    const names = SKILLS.map((s) => s.name)
    expect(names).toContain('ask')
    expect(names).toContain('research')
    expect(names).toContain('brainstorm')
  })

  it('each skill has id, name, description, outputMode', () => {
    for (const skill of SKILLS) {
      expect(skill.id).toBeTruthy()
      expect(skill.name).toBeTruthy()
      expect(skill.description).toBeTruthy()
      expect(['children', 'replace']).toContain(skill.outputMode)
    }
  })
})

describe('filterSkills', () => {
  it('returns only research skill for query "res"', () => {
    const results = filterSkills('res')
    expect(results).toHaveLength(1)
    expect(results[0].name).toBe('research')
  })

  it('returns all skills for empty query', () => {
    const results = filterSkills('')
    expect(results).toHaveLength(SKILLS.length)
  })

  it('returns ask skill for query "as"', () => {
    const results = filterSkills('as')
    expect(results).toHaveLength(1)
    expect(results[0].name).toBe('ask')
  })

  it('returns brainstorm for query "brain"', () => {
    const results = filterSkills('brain')
    expect(results).toHaveLength(1)
    expect(results[0].name).toBe('brainstorm')
  })
})

describe('shouldAllowSlash', () => {
  it('returns false when preceded by colon (URL context)', () => {
    // Simulate "https:/" — the char before '/' is ':'
    expect(shouldAllowSlash(':')).toBe(false)
  })

  it('returns true when preceded by space', () => {
    expect(shouldAllowSlash(' ')).toBe(true)
  })

  it('returns true when at start of line (null/empty preceding char)', () => {
    expect(shouldAllowSlash(null)).toBe(true)
    expect(shouldAllowSlash('')).toBe(true)
  })

  it('returns true when preceded by other characters', () => {
    expect(shouldAllowSlash('a')).toBe(true)
    expect(shouldAllowSlash('.')).toBe(true)
  })
})

describe('parseSlashInput', () => {
  it('parses skill name and args from full slash input', () => {
    const result = parseSlashInput('/research quantum computing')
    expect(result.skillName).toBe('research')
    expect(result.args).toBe('quantum computing')
  })

  it('returns empty args when no args provided', () => {
    const result = parseSlashInput('/ask')
    expect(result.skillName).toBe('ask')
    expect(result.args).toBe('')
  })

  it('handles slash prefix stripping correctly', () => {
    const result = parseSlashInput('/brainstorm startup ideas for 2026')
    expect(result.skillName).toBe('brainstorm')
    expect(result.args).toBe('startup ideas for 2026')
  })

  it('handles input without slash prefix', () => {
    const result = parseSlashInput('research quantum')
    expect(result.skillName).toBe('research')
    expect(result.args).toBe('quantum')
  })
})
