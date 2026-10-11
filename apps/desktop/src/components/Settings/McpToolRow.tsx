import { useId, useState } from 'react'
import type { McpTool } from '@forage/agent-runtime'
import { Button } from '../ui/Button'
import { Switch } from '../ui/Switch'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { mcpText } from './mcpPresentation'

export function McpToolRow({ tool, checked, disabled, onChange }: {
  tool: McpTool; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const descriptionId = useId()
  const name = mcpText(tool.name, 256)
  const description = mcpText(tool.description) || 'No description provided.'
  return <div className="mcp-tool-row">
    <div className="mcp-tool-preview">
      <Button className="mcp-tool-disclosure" size="sm" variant="ghost" aria-expanded={expanded} aria-controls={descriptionId} aria-label={`${expanded ? 'Collapse' : 'Expand'} ${name} description`} onClick={() => setExpanded(!expanded)}>{expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}</Button>
      <span className="mcp-tool-name truncate">{name}</span>
      <span className="mcp-tool-description truncate">{description.replace(/\s+/g, ' ')}</span>
      <Switch aria-label={`Enable ${name}`} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
    <div id={descriptionId} hidden={!expanded} className="bg-paper-raised px-4 py-3 text-xs text-ink-soft">
      <p className="whitespace-pre-wrap break-words">{description}</p>
      <p className="mt-2 break-all font-mono">{mcpText(tool.remoteName, 256)}</p>
    </div>
  </div>
}
