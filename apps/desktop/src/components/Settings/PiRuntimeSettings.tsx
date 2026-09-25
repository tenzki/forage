import { useState } from 'react'
import { Activity } from 'lucide-react'
import {
  probeCodexRuntime,
  probePiRuntime,
  type PiRuntimeStatus,
} from '../../agent/piSdkClient'
import { Button } from '../ui/Button'
import { ResultRow } from '../ui/ResultRow'

function RuntimeResult({ label, status, checking }: { label: string; status: PiRuntimeStatus | null; checking: boolean }) {
  if (checking) return <ResultRow state="pending" title={`Checking ${label}…`} />
  if (!status) return <ResultRow state="unchecked" title={`${label} not checked`} />
  return (
    <ResultRow
      state={status.available ? 'ok' : 'error'}
      title={status.available ? `${label} is available` : `${label} is unavailable`}
      detail={status.version}
      error={status.error}
    />
  )
}

export function PiRuntimeSettings() {
  const [piStatus, setPiStatus] = useState<PiRuntimeStatus | null>(null)
  const [codexStatus, setCodexStatus] = useState<PiRuntimeStatus | null>(null)
  const [checking, setChecking] = useState(false)

  async function checkRuntimes() {
    setChecking(true)
    try {
      const [pi, codex] = await Promise.all([probePiRuntime(), probeCodexRuntime()])
      setPiStatus(pi)
      setCodexStatus(codex)
    } finally {
      setChecking(false)
    }
  }

  return (
    <section className="settings-section">
      <h2>Agent runtimes</h2>
      <p className="settings-hint">
        Agent requests run in a local Node.js SDK sidecar with the Pi agent loop.
        Subscription image generation runs in an isolated, ephemeral Codex
        app-server process with external tools disabled and read-only sandboxing.
      </p>
      <div className="flex flex-col gap-3.5 rounded-[10px] border border-rule-soft bg-paper px-[18px] pt-2 pb-[18px]" aria-live="polite">
        <div className="flex flex-col">
          <RuntimeResult label="Node.js" status={piStatus} checking={checking} />
          <RuntimeResult label="Codex" status={codexStatus} checking={checking} />
        </div>
        <p className="m-0 text-xs leading-[1.45] text-moss">
          Development requires Node.js 18+ and Codex 0.148.0+ on PATH.
          The sidecar runs via tsx with its own package dependencies in src-tauri/resources/pi/sidecar/.
        </p>
        <Button variant="primary" icon={<Activity aria-hidden="true" />} className="self-start" disabled={checking} onClick={() => void checkRuntimes()}>
          {checking ? 'Checking…' : 'Check agent runtimes'}
        </Button>
      </div>
    </section>
  )
}
