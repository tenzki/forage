import { useState } from 'react'
import {
  probeCodexRuntime,
  probePiRuntime,
  type PiRuntimeStatus,
} from '../../agent/piSdkClient'

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
        Agent requests run in a local Node.js SDK sidecar with the Pi agent loop.
        Subscription image generation runs in an isolated, ephemeral Codex
        app-server process with external tools disabled and read-only sandboxing.
      </p>
      <div className="auth-card runtime-status" aria-live="polite">
        <RuntimeResult label="Node.js" status={piStatus} />
        <RuntimeResult label="Codex" status={codexStatus} />
        <p className="settings-hint">
          Development requires Node.js 18+ and Codex 0.148.0+ on PATH.
          The sidecar runs via tsx with its own npm dependencies in src-tauri/resources/pi/sidecar/.
        </p>
        <button className="settings-save" disabled={checking} onClick={() => void checkRuntimes()}>
          {checking ? 'Checking…' : 'Check agent runtimes'}
        </button>
      </div>
    </section>
  )
}