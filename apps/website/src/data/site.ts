export const site = {
  name: 'Forage',
  title: 'Forage — Your second brain. Powered with AI.',
  description: 'A personal outliner with AI for macOS. Gather notes, research, and ideas in one connected outline, and build your own understanding.',
  repository: 'https://github.com/tenzki/forage',
  download: 'https://github.com/tenzki/forage/releases',
  documentation: 'https://github.com/tenzki/forage#readme',
  extensionDocs: 'https://github.com/tenzki/forage/blob/main/docs/extensions.md',
} as const

export const workflow = [
  { title: 'Gather what you need.', description: 'Capture notes and questions. Ask AI to research a topic and bring useful information into your outline.' },
  { title: 'Work through the ideas.', description: 'Break concepts into smaller pieces, connect related notes, and put what you’re learning into your own words.' },
  { title: 'Find your next idea.', description: 'Use AI to summarize, compare, and explore possibilities. Keep questioning, refining, and developing ideas of your own.' },
] as const

interface SkillExample { command: string; title: string; description: string; instructions: string }
export const skills: readonly SkillExample[] = [
  { command: '/research', title: 'Go deep on a question.', description: 'Find reliable sources, compare perspectives, and turn the useful parts into linked notes.', instructions: 'Cite your sources. Separate facts from open questions.' },
  { command: '/dogfood', title: 'Put an idea to the test.', description: 'Review your product notes from a user’s point of view. Surface friction, gaps, and things to try.', instructions: 'Start with the first-use journey. Rank the rough edges.' },
  { command: '/roast-me', title: 'Invite a sharper opinion.', description: 'Challenge the ideas in this branch with a candid critique that helps you make them stronger.', instructions: 'Be funny, be specific, and end with three ways to improve.' },
]

export interface Extension {
  name: string
  label: string
  description: string
  capabilities: readonly { title: string; description: string }[]
  usage: string
}

// Add new entries here. Cards flow into the responsive extension collection.
export const extensions: readonly Extension[] = [{
  name: 'Jev',
  label: 'System One',
  description: 'Compare ideas, classify notes, score options, and filter by meaning—with Jev through the System One extension.',
  capabilities: [
    { title: 'Compare', description: 'Weigh options in your outline.' },
    { title: 'Score', description: 'Apply criteria you define.' },
    { title: 'Organize', description: 'Classify and filter by meaning.' },
  ],
  usage: 'Choose System One when creating a skill, then set the question and criteria. The results become part of your outline.',
}, {
  name: 'Image Generation',
  label: 'OpenAI',
  description: 'Give an idea a visual form. Generate images right in your outline, alongside the notes and questions that inspired them.',
  capabilities: [
    { title: 'Explore', description: 'Try a visual direction for an idea.' },
    { title: 'Illustrate', description: 'Create an image from your own brief.' },
    { title: 'Keep', description: 'Save the result with your notes.' },
  ],
  usage: 'Enable the extension, connect your Codex login or an OpenAI API key, and create a command such as /image to use it in your outline.',
}]

export const ownership = [
  { icon: 'device', title: 'Rooted on your device.', description: 'Your outline lives locally. Read, write, and organize your notes without a connection.' },
  { icon: 'sparkles', title: 'AI on your terms.', description: 'Bring your own supported AI account or API key. Choose the agents and tools you want to use.' },
  { icon: 'branch', title: 'An outline you can shape.', description: 'Nest thoughts, link related concepts, and return to the questions that matter. Your second brain grows as your understanding does.' },
] as const

export const footerLinks = [
  { title: 'Product', links: [{ label: 'How it works', href: '#how-it-works' }, { label: 'Agents & skills', href: '#skills' }, { label: 'Extensions', href: '#extensions' }, { label: 'Get Forage', href: site.download }] },
  { title: 'Resources', links: [{ label: 'Documentation', href: site.documentation }, { label: 'Source code', href: site.repository }, { label: 'Release notes', href: site.download }] },
] as const
