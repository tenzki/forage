import { DEFAULT_SKILLS, type SkillDefinition } from './definitions'

/** Backwards-compatible name used by the editor generation flow. */
export type Skill = SkillDefinition

/** Built-in defaults. Runtime menus use the persisted settings collection. */
export const SKILLS: Skill[] = DEFAULT_SKILLS

export function findSkill(label: string): Skill | undefined {
  return SKILLS.find((skill) => skill.label === label)
}
