import { useId, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '../ui/Button'
import { Switch } from '../ui/Switch'

export function AgentToolChoice({ name, source, description, unavailableReason, checked, disabled, onChange }: {
  name: string; source?: string; description: string; unavailableReason?: string
  checked: boolean; disabled: boolean; onChange: (checked: boolean) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const descriptionId = useId()
  const availabilityId = useId()
  return <div className="settings-agent-tool">
    <div className="settings-agent-tool-row">
      <Button className="settings-agent-tool-name" variant="ghost" disabled={!description.trim()} aria-expanded={expanded} aria-controls={descriptionId} aria-label={`${expanded ? 'Collapse' : 'Expand'} ${name} description`} onClick={() => setExpanded(!expanded)}>
        {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}{name}
      </Button>
      {source && <span className="settings-agent-tool-source">{source}</span>}
      <Switch aria-label={name} aria-describedby={unavailableReason ? availabilityId : undefined} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
    {unavailableReason && <p id={availabilityId} className="settings-hint settings-agent-tool-unavailable">Unavailable: {unavailableReason}</p>}
    <p id={descriptionId} hidden={!expanded} className="settings-agent-tool-description">{description}</p>
  </div>
}
