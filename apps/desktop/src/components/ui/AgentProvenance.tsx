import { Sparkles } from 'lucide-react'
import { cn } from './cn'

/** Violet "AGENT · SKILL" label from docs/desktop.pen (`Agent Provenance`). */
export function AgentProvenance({ skill, className }: { skill?: string; className?: string }) {
  return (
    <span data-slot="agent-provenance" className={cn('inline-flex items-center gap-1.5 font-mono text-[10px] leading-3 tracking-[0.05em] whitespace-pre text-violet uppercase', className)}>
      <Sparkles size={12} aria-hidden="true" />
      <span>{skill ? `Agent  ·  ${skill}` : 'Agent'}</span>
    </span>
  )
}
