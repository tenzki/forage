import { useEffect, useState } from 'react'
import { applicationVersion } from '../../applicationMetadata'
import { useSettingsStore } from '../../store/settingsStore'
import type { DevicePreferences } from '../../store/settingsMigration'
import { Button } from '../ui/Button'
import { Select } from '../ui/Field'
import { SwitchFieldInput } from '../ui/SwitchFieldInput'
import { SegmentedControl } from '../ui/SegmentedControl'
import { useOnboardingStore } from '../../onboarding/progress'

export function GeneralSettings({ onDiagnostics, onboarding }: { onDiagnostics: () => void; onboarding?: { available: boolean; onStart: () => void } }) {
  const progress = useOnboardingStore(state => state.progress)
  const setupError = useOnboardingStore(state => state.error)
  const preferences = useSettingsStore((state) => state.devicePreferences)
  const save = useSettingsStore((state) => state.setDevicePreferences)
  const error = useSettingsStore((state) => state.preferenceError)
  const loaded = useSettingsStore((state) => state.isLoaded)
  const [version, setVersion] = useState('Loading…')
  useEffect(() => {
    let active = true
    void applicationVersion().then((value) => { if (active) setVersion(value) }).catch(() => { if (active) setVersion('Unavailable in this runtime') })
    return () => { active = false }
  }, [])
  return <section className="settings-section general-settings" aria-labelledby="general-heading">
    <div className="settings-page-heading"><h2 id="general-heading">General</h2><p className="settings-hint">Make Forage feel at home.</p></div>
    {onboarding && <section className="settings-block" aria-labelledby="setup-heading"><h3 id="setup-heading">Getting started</h3><p className="settings-hint">{onboarding.available ? 'Write a first note, connect AI, and choose optional extensions and tools.' : 'Guided setup is available in local mode. Your server connection is kept as configured.'}</p><Button className="self-start" disabled={!onboarding.available || !loaded} onClick={onboarding.onStart}>{progress?.status === 'paused' || progress?.status === 'in-progress' ? 'Resume setup' : 'Start setup'}</Button>{setupError && <p className="settings-error" role="alert">{setupError}</p>}</section>}
    <section className="settings-block" aria-labelledby="appearance-heading">
      <h3 id="appearance-heading">Appearance</h3>
      <div className="settings-row-list">
        <div className="settings-preference-row"><div><p>Theme</p><p className="settings-hint">Choose how Forage looks on this device.</p></div><fieldset disabled={!loaded}><SegmentedControl ariaLabel="Theme" value={preferences.theme} options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} onValueChange={(theme) => void save({ theme })} /></fieldset></div>
        <div className="settings-preference-row"><div><label htmlFor="settings-font">Outline font</label><p className="settings-hint">The typeface used in your outline.</p></div><div className="settings-font-control"><Select id="settings-font" disabled={!loaded} value={preferences.outlineFont} onChange={(event) => void save({ outlineFont: event.target.value as DevicePreferences['outlineFont'] })}>{[['default', 'Default'], ['system', 'System'], ['serif', 'Serif'], ['mono', 'Monospace']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></div></div>
        <div className="settings-preference-row"><div><label htmlFor="settings-font-size">Outline font size</label><p className="settings-hint">Keep your outline comfortable to read.</p></div><div className="settings-size-control"><Select id="settings-font-size" disabled={!loaded} value={preferences.outlineFontSize} onChange={(event) => void save({ outlineFontSize: event.target.value === 'default' ? 'default' : Number(event.target.value) as DevicePreferences['outlineFontSize'] })}><option value="default">Default</option>{[12, 14, 16, 18, 20, 24].map((size) => <option key={size} value={size}>{size} px</option>)}</Select></div></div>
      </div>
      <div className="appearance-preview" aria-label="Outline appearance preview"><p className="settings-eyebrow">Preview</p><ul><li>A little room to think<ul><li>Gather ideas as they come</li><li>Turn the good ones into something<ul><li>One outline, many possibilities</li></ul></li></ul></li></ul></div>
    </section>
    <section className="settings-block" aria-labelledby="accessibility-heading"><h3 id="accessibility-heading">Accessibility</h3><SwitchFieldInput label="Follow system motion preference" hint="Reduce nonessential animation when your system requests it." checked={preferences.followSystemMotion} disabled={!loaded} onCheckedChange={(checked) => void save({ followSystemMotion: checked })} /></section>
    <p className="settings-hint">Changes are saved automatically.</p>
    {error && <div role="alert"><p>{error}</p><Button onClick={() => void save(preferences)}>Retry saving appearance</Button></div>}
    <section className="settings-block settings-divider" aria-labelledby="support-heading"><h3 id="support-heading">Support</h3><Button className="self-start" onClick={onDiagnostics}>Diagnostics</Button><p className="settings-hint">Forage · Version {version}</p></section>
  </section>
}
