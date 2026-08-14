// Built-in skills (AGNT-05). v1 ships a hardcoded array — no config UI (AGNT-04
// is deferred to v2). A skill is just a slash trigger + a system prompt.

export interface Skill {
  id: string
  /** Slash trigger, e.g. "research" → user types /research. */
  label: string
  description: string
  systemPrompt: string
}

export const SKILLS: Skill[] = [
  {
    id: 'research',
    label: 'research',
    description: 'Investigate a topic and structure findings as notes',
    systemPrompt:
      'You are a research assistant inside an outliner. Investigate the topic ' +
      'the user gives, using the surrounding outline as context. Reply with ' +
      'concise, well-structured findings as short bullet-style lines (one idea ' +
      'per line, no markdown bullet characters). Use web_search when available ' +
      'for current or externally verifiable facts, then use web_fetch to verify ' +
      'promising sources when needed. Include source URLs. Be specific and factual.',
  },
  {
    id: 'brainstorm',
    label: 'brainstorm',
    description: 'Generate ideas and options for the current note',
    systemPrompt:
      'You are a brainstorming partner inside an outliner. Given the topic and ' +
      'the surrounding outline as context, produce a varied set of ideas or ' +
      'options. One idea per line, concise, no markdown bullet characters.',
  },
  {
    id: 'ask',
    label: 'ask',
    description: 'Ask the agent a question about this branch',
    systemPrompt:
      'You are a helpful assistant inside an outliner. Answer the user\'s ' +
      'question, using the surrounding outline as context. Be concise and direct.',
  },
]

export function findSkill(label: string): Skill | undefined {
  return SKILLS.find((s) => s.label === label)
}
