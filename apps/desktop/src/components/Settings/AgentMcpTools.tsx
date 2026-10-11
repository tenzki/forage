import { useState } from 'react'
import { mcpConnectionAvailable, type McpConnection } from '@forage/agent-runtime'
import { useSettingsStore } from '../../store/settingsStore'
import { Button } from '../ui/Button'
import { SwitchFieldInput } from '../ui/SwitchFieldInput'
import { useSettingsNavigation } from './settingsNavigation'
import { AgentToolChoice } from './AgentToolChoice'
import { mcpText } from './mcpPresentation'
import { ChevronRight } from 'lucide-react'

export const mcpReviewIdentity = (connection: McpConnection) => JSON.stringify({ id: connection.id, enabled: connection.enabled, error: connection.error, authorizationStatus: connection.authorizationStatus, authorizationRevision: connection.authorizationRevision, tools: connection.tools.map((tool) => [tool.id, tool.remoteName]) })

export function AgentMcpTools({ connections, selected, onChange, onReview }: {
  connections: McpConnection[]; selected: string[]; onChange: (ids: string[]) => void
  onReview: (connection: McpConnection) => void
}) {
  const enabled = useSettingsStore((state) => state.enabledToolIds)
  const navigation = useSettingsNavigation()
  const [review, setReview] = useState<{ id: string; identity: string; ids: string[] } | null>(null)
  const connection = connections.find((entry) => entry.id === review?.id)
  const changed = !!review && (!connection || mcpReviewIdentity(connection) !== review.identity)
  return <section className="settings-block settings-agent-mcp" aria-label="MCP server access">
    {!connections.length && <p className="settings-hint">No available MCP servers. Saved missing references are retained below.</p>}
    {connections.map((entry) => {
      const ids = entry.tools.map((tool) => tool.id)
      const count = selected.filter((id) => ids.includes(id)).length
      const choose = () => setReview({ id: entry.id, identity: mcpReviewIdentity(entry), ids: selected.filter((id) => ids.includes(id) && enabled.includes(id)) })
      return <SwitchFieldInput key={entry.id} className="settings-agent-server" label={entry.name} hint={`MCP server · ${count} of ${ids.length} tools selected`} checked={count > 0} disabled={!mcpConnectionAvailable(entry) && !count} onCheckedChange={(checked) => checked ? choose() : onChange(selected.filter((id) => !ids.includes(id)))}
        actionsPosition="before" actions={<Button icon={<ChevronRight aria-hidden="true" />} aria-label={`Choose tools for ${entry.name}`} disabled={!mcpConnectionAvailable(entry)} onClick={choose}>Choose tools</Button>}
      />
    })}
    {review && <div role="group" aria-label={`Choose tools for ${connection?.name ?? 'unavailable server'}`} className="custom-tool-form">
      <p>Only explicitly selected, globally reviewed tools can be used. New tools are never selected automatically.</p>
      {changed && <p role="alert">This server changed during review. Cancel and reopen Choose tools to review its current definitions.</p>}
      {connection?.tools.map((tool) => <AgentToolChoice key={tool.id} name={mcpText(tool.name, 256)} description={mcpText(tool.description)} unavailableReason={!enabled.includes(tool.id) ? 'Globally disabled. Review this tool in MCP servers first.' : undefined} checked={review.ids.includes(tool.id)} disabled={changed || !enabled.includes(tool.id)} onChange={(checked) => setReview({ ...review, ids: checked ? [...review.ids, tool.id] : review.ids.filter((id) => id !== tool.id) })} />)}
      <Button disabled={changed || !connection || !review.ids.length} onClick={() => {
        if (!connection || changed) return
        const ids = connection.tools.map((tool) => tool.id)
        onReview(connection)
        onChange([...selected.filter((id) => !ids.includes(id)), ...review.ids])
        setReview(null)
      }}>Use selected tools</Button><Button onClick={() => setReview(null)}>Cancel tool review</Button>
    </div>}
    {navigation && <Button variant="ghost" className="settings-text-link" onClick={() => navigation.select('mcp')}>Manage MCP servers →</Button>}
  </section>
}
