import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoke } from '@tauri-apps/api/core'
import type { ExtensionCatalog, ExtensionConfiguration, ExtensionManagementResponse } from '@forage/agent-runtime'
import { ExtensionsSettings } from './ExtensionsSettings'
import { useExtensionStore } from '../../store/extensionStore'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))
vi.mock('@tauri-apps/plugin-opener', () => ({ revealItemInDir: vi.fn(async () => undefined) }))

const manifest = {
  manifestVersion: 1 as const,
  id: 'dev.example.weather',
  name: 'Weather Tools',
  version: '1.0.0',
  description: 'Reads a configured weather service.',
  entry: './dist/index.js',
  apiVersion: '1' as const,
  contributes: {
    tools: [{ id: 'weather_lookup', name: 'Weather lookup', description: 'Look up weather.' }],
    hooks: ['run:start' as const],
    settings: [
      { key: 'region', label: 'Region', type: 'select' as const, required: true, options: [{ value: 'eu', label: 'Europe' }] },
      { key: 'token', label: 'API token', type: 'secret' as const, required: true },
    ],
  },
}

function catalog(status: 'needs_review' | 'needs_configuration' | 'ready' = 'needs_review'): ExtensionCatalog {
  return {
    version: 1,
    revision: 'a'.repeat(64),
    entries: [{
      source: { kind: 'local', installationId: 'weather-install', requestedPath: '/extensions/weather', canonicalPath: '/extensions/weather' },
      manifest,
      inspection: manifest,
      provenance: {
        installationId: 'weather-install', extensionId: manifest.id, sourceKind: 'local', sourceRevision: 'revision-1', entryDigest: 'b'.repeat(64),
      },
      status,
      tools: manifest.contributes.tools.map((tool) => ({ ...tool, available: status === 'ready', globallyAuthorized: false, diagnostics: [] })),
      diagnostics: status === 'needs_configuration' ? [{ code: 'missing_required_setting', severity: 'warning', message: 'Required settings are missing.' }] : [],
    }],
  }
}

const configuration: ExtensionConfiguration = {
  version: 1,
  revision: 2,
  sources: [{
    installationId: 'weather-install', source: { kind: 'local', path: '/extensions/weather' }, enabled: true,
    trust: { accepted: true, extensionId: manifest.id }, settings: {}, secretReferences: {},
  }],
}
type InstallPreview = NonNullable<Extract<ExtensionManagementResponse, { ok: true }>['preview']>

beforeEach(() => {
  vi.clearAllMocks()
  useExtensionStore.setState({
    catalog: catalog(), configuration, extensionsDirectory: '/extensions', isLoaded: true, isLoading: false,
    busyInstallationId: null, error: null,
    refresh: vi.fn(async () => undefined), installLocal: vi.fn(async () => undefined),
    previewInstall: vi.fn(async () => ({
      previewId: 'preview-weather',
      requestedSource: { kind: 'local', path: '/extensions/new-weather' },
      entry: {
        ...catalog().entries[0],
        source: { kind: 'local', installationId: 'preview-weather', requestedPath: '/extensions/new-weather', canonicalPath: '/extensions/new-weather' },
        provenance: { ...catalog().entries[0].provenance!, installationId: 'preview-weather' },
      },
    }) as InstallPreview),
    install: vi.fn(async () => undefined),
    enable: vi.fn(async () => undefined), disable: vi.fn(async () => undefined), reload: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined), configure: vi.fn(async () => undefined),
  })
})

describe('Extensions settings', () => {
  it('shows manifest-only inventory, detail provenance, trust warning, and tool navigation', async () => {
    const user = userEvent.setup()
    const onConfigureTools = vi.fn()
    render(<ExtensionsSettings onConfigureTools={onConfigureTools} />)

    expect(screen.getByText(/does not execute code or contact package registries/i)).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Needs attention' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /Weather Tools/ }))
    expect(screen.getByText('dev.example.weather')).toBeTruthy()
    expect(screen.getByText(/Trusted local code/)).toBeTruthy()
    expect(screen.getByText('revision-1')).toBeTruthy()
    expect(screen.getByText(/Weather lookup/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Configure tools' }))
    expect(onConfigureTools).toHaveBeenCalledOnce()
  })

  it('requires a second click before trusting and enabling a source', async () => {
    const user = userEvent.setup()
    const enable = vi.mocked(useExtensionStore.getState().enable)
    render(<ExtensionsSettings onConfigureTools={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /Weather Tools/ }))
    await user.click(screen.getByRole('button', { name: 'Review & enable' }))
    expect(enable).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Trust and enable' }))
    expect(enable).toHaveBeenCalledWith('weather-install')
  })

  it('stores secret plaintext only in the native vault and sends references through management', async () => {
    const user = userEvent.setup()
    const configure = vi.mocked(useExtensionStore.getState().configure)
    useExtensionStore.setState({ catalog: catalog('needs_configuration') })
    render(<ExtensionsSettings onConfigureTools={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /Weather Tools/ }))
    await user.selectOptions(screen.getByLabelText('Region (required)'), 'eu')
    await user.type(screen.getByLabelText('API token (required)'), 'secret-value')
    await user.click(screen.getByRole('button', { name: 'Save configuration' }))

    const reference = 'forage-extension/weather-install/token'
    expect(invoke).toHaveBeenCalledWith('local_credential_store', { reference, secret: 'secret-value' })
    expect(configure).toHaveBeenCalledWith('weather-install', { region: 'eu' }, { token: reference })
    expect(JSON.stringify(configure.mock.calls)).not.toContain('secret-value')
  })

  it('previews source identity and contributions before registration', async () => {
    const user = userEvent.setup()
    const previewInstall = vi.mocked(useExtensionStore.getState().previewInstall)
    const install = vi.mocked(useExtensionStore.getState().install)
    render(<ExtensionsSettings onConfigureTools={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'Install' }))
    await user.type(screen.getByLabelText('Directory path'), '/extensions/new-weather')
    await user.click(screen.getByRole('button', { name: 'Preview source' }))
    expect(previewInstall).toHaveBeenCalledWith({ kind: 'local', path: '/extensions/new-weather' })
    expect(await screen.findByText(/Installing only records this source/i)).toBeTruthy()
    expect(screen.getByText(/1 tool\(s\), 1 hook\(s\), 2 setting\(s\)/)).toBeTruthy()
    expect(install).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Register source' }))
    expect(install).toHaveBeenCalledWith(
      { kind: 'local', path: '/extensions/new-weather' },
      'preview-weather',
    )
  })
})
