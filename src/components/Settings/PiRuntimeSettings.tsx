import { useState } from 'react'
import {
  probeCodexRuntime,
  probePiRuntime,
  type PiRuntimeStatus,
} from '../../agent/piRpcClient'

function RuntimeResult({ label, status }: { label: string; status: PiRuntimeStatus | null }) {
  return (
    <div className="runtime-result">
      <strong>{status?.available ? `${label} is available` : status ? `${label} is unavailable` : `${label} not checked`}</strong>
      {status?.version && <code>{status.version}</code>}
      {status?.error && <small>{status.error}</small>}
    </div>
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
        Agent requests run in a restricted local Pi RPC process. Subscription image generation runs in an isolated,
        ephemeral Codex app-server process with external tools disabled and read-only sandboxing.
      </p>
      <div className="auth-card runtime-status" aria-live="polite">
        <RuntimeResult label="Pi" status={piStatus} />
        <RuntimeResult label="Codex" status={codexStatus} />
        <p className="settings-hint">
          Development requires Pi 0.84.2 or newer and Codex 0.148.0 or newer on PATH. Pinned production runtimes are not bundled yet.
        </p>
        <button className="settings-save" disabled={checking} onClick={() => void checkRuntimes()}>
          {checking ? 'Checking…' : 'Check agent runtimes'}
        </button>
      </div>
    </section>
  )
}
