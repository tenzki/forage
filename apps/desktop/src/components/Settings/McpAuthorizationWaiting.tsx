import { useEffect, useRef, useState } from 'react'
import type { McpOAuthProgress } from '@forage/agent-runtime'
import { copyMcpAuthorizationLink, openMcpAuthorizationBrowser } from '../../agent/mcpOAuthClient'
import { Button } from '../ui/Button'
import { LoaderCircle } from 'lucide-react'

export function McpAuthorizationWaiting({ progress, onCancel }: { progress: McpOAuthProgress; onCancel: () => void }) {
  const panel = useRef<HTMLDivElement>(null)
  const [feedback, setFeedback] = useState('')
  useEffect(() => { panel.current?.focus() }, [])
  const recover = async (copy: boolean) => {
    try { await (copy ? copyMcpAuthorizationLink() : openMcpAuthorizationBrowser()); setFeedback(copy ? 'Sign-in link copied.' : 'Browser opened.') }
    catch { setFeedback(copy ? 'Could not copy the link. Check clipboard permissions.' : 'Could not open the browser. Copy the sign-in link instead.') }
  }
  return <div ref={panel} tabIndex={-1} className="settings-block mcp-authorization-state" role="group" aria-label="Browser sign-in">
    <h3 className="flex items-center gap-2"><LoaderCircle size={16} aria-hidden="true" />{progress.phase === 'waiting' ? 'Waiting for browser sign-in' : progress.phase === 'discovering' ? 'Discovering server tools…' : progress.phase === 'exchanging' ? 'Completing sign-in…' : 'Checking browser sign-in support…'}</h3>
    <p className="settings-hint" role="status">{progress.phase === 'waiting' ? 'Forage is waiting for you to return. This request expires after five minutes.' : 'Keep this screen open while Forage connects.'}</p>
    <div className="settings-actions">{progress.phase === 'waiting' && <><Button onClick={() => void recover(false)}>Open browser again</Button><Button onClick={() => void recover(true)}>Copy sign-in link</Button></>}<Button onClick={onCancel}>Cancel sign-in</Button></div>
    {feedback && <p className="settings-hint" role="status">{feedback}</p>}
    <p className="settings-hint">Signing in does not grant tool or agent access. You will review access next.</p>
  </div>
}
