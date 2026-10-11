import { Button } from '../ui/Button'

export function SettingsBackLink({ label, onBack, disabled }: { label: string; onBack: () => void; disabled?: boolean }) {
  return <Button variant="ghost" className="settings-back-link" aria-label={`Back to ${label}`} disabled={disabled} onClick={onBack}><span aria-hidden="true">←</span>{label}</Button>
}
