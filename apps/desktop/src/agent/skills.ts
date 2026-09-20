import { DEFAULT_SKILLS } from './definitions'
import type { LegacySkillDefinition, LlmSkillDefinition } from '@forage/agent-runtime'

/** Backwards-compatible name used by the editor generation flow. */
export type Skill = LlmSkillDefinition | LegacySkillDefinition

/** Built-in defaults. Runtime menus use the persisted settings collection. */
export const SKILLS: Skill[] = DEFAULT_SKILLS

export function findSkill(label: string): Skill | undefined {
  return SKILLS.find((skill) => skill.label === label)
}
