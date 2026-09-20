import type {
  ExtensionJsonObject,
  ExtensionJsonValue,
  ExtensionSkillConfigurationField,
  ExtensionSkillConfigurationForm as ExtensionSkillConfigurationFormDefinition,
} from '@forage/agent-runtime'

export interface ConfigurationIssue {
  path: Array<string | number>
  message: string
}

export function configurationWithDefaults(
  form: ExtensionSkillConfigurationFormDefinition,
  current: ExtensionJsonObject = {},
): ExtensionJsonObject {
  const configuration = structuredClone(current)
  applyDefaults(form.fields, configuration)
  for (const branch of form.branches ?? []) {
    if (configuration[branch.when.field] === branch.when.equals) applyDefaults(branch.fields, configuration)
  }
  return configuration
}

function applyDefaults(fields: readonly ExtensionSkillConfigurationField[], target: ExtensionJsonObject): void {
  for (const field of fields) {
    if (target[field.key] !== undefined) continue
    if ('default' in field && field.default !== undefined) {
      target[field.key] = field.default
    } else if (field.type === 'boolean' && field.required) {
      target[field.key] = false
    } else if (field.type === 'choice' && field.required) {
      target[field.key] = field.options[0]?.value ?? ''
    } else if (field.type === 'object') {
      const nested: ExtensionJsonObject = {}
      applyDefaults(field.fields, nested)
      if (field.required || Object.keys(nested).length) target[field.key] = nested
    } else if (field.type === 'repeat' && (field.minimumItems ?? 0) > 0) {
      target[field.key] = Array.from({ length: field.minimumItems ?? 0 }, () => {
        const nested: ExtensionJsonObject = {}
        applyDefaults(field.fields, nested)
        return nested
      })
    }
  }
}

function valueAt(configuration: ExtensionJsonObject, path: readonly (string | number)[]): ExtensionJsonValue | undefined {
  let current: ExtensionJsonValue = configuration
  for (const segment of path) {
    if (typeof segment === 'number') {
      if (!Array.isArray(current)) return undefined
      current = current[segment]!
    } else {
      if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
      current = current[segment]
    }
  }
  return current
}

function updateAt(
  configuration: ExtensionJsonObject,
  path: readonly (string | number)[],
  value: ExtensionJsonValue | undefined,
): ExtensionJsonObject {
  const next = structuredClone(configuration)
  let current: ExtensionJsonObject | ExtensionJsonValue[] = next
  path.forEach((segment, index) => {
    const last = index === path.length - 1
    if (last) {
      if (value === undefined) {
        if (Array.isArray(current) && typeof segment === 'number') current.splice(segment, 1)
        else if (!Array.isArray(current) && typeof segment === 'string') delete current[segment]
      } else if (Array.isArray(current) && typeof segment === 'number') current[segment] = value
      else if (!Array.isArray(current) && typeof segment === 'string') current[segment] = value
      return
    }
    const following = path[index + 1]
    let child = Array.isArray(current) && typeof segment === 'number'
      ? current[segment]
      : !Array.isArray(current) && typeof segment === 'string'
        ? current[segment]
        : undefined
    if (!child || typeof child !== 'object') {
      child = typeof following === 'number' ? [] : {}
      if (Array.isArray(current) && typeof segment === 'number') current[segment] = child
      else if (!Array.isArray(current) && typeof segment === 'string') current[segment] = child
    }
    current = child as ExtensionJsonObject | ExtensionJsonValue[]
  })
  return next
}

function issueFor(issues: readonly ConfigurationIssue[], path: readonly (string | number)[]): string | undefined {
  return issues.find((issue) => issue.path.length === path.length
    && issue.path.every((segment, index) => segment === path[index]))?.message
}

function Fields({ fields, path, configuration, issues, onChange }: {
  fields: readonly ExtensionSkillConfigurationField[]
  path: Array<string | number>
  configuration: ExtensionJsonObject
  issues: readonly ConfigurationIssue[]
  onChange: (configuration: ExtensionJsonObject) => void
}) {
  return <>{fields.map((field) => {
    const fieldPath = [...path, field.key]
    const value = valueAt(configuration, fieldPath)
    const error = issueFor(issues, fieldPath)
    const hint = [field.description, error].filter(Boolean).join(' ')
    if (field.type === 'boolean') return <label key={field.key} className="extension-skill-field extension-skill-checkbox">
      <input type="checkbox" aria-label={field.label} checked={value === true} onChange={(event) => onChange(updateAt(configuration, fieldPath, event.target.checked))} />
      <span>{field.label}{field.required ? ' (required)' : ''}</span>
      {hint && <small className={error ? 'settings-error' : undefined}>{hint}</small>}
    </label>
    if (field.type === 'choice') return <label key={field.key} className="extension-skill-field">{field.label}{field.required ? ' (required)' : ''}
      <select aria-label={field.label} value={typeof value === 'string' ? value : ''} onChange={(event) => onChange(updateAt(configuration, fieldPath, event.target.value || undefined))}>
        {!field.required && <option value="">Not set</option>}
        {field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      {hint && <small className={error ? 'settings-error' : undefined}>{hint}</small>}
    </label>
    if (field.type === 'text' || field.type === 'multiline') {
      const control = field.type === 'multiline'
        ? <textarea aria-label={field.label} value={typeof value === 'string' ? value : ''} maxLength={field.maxLength} onChange={(event) => onChange(updateAt(configuration, fieldPath, event.target.value))} />
        : <input aria-label={field.label} value={typeof value === 'string' ? value : ''} maxLength={field.maxLength} onChange={(event) => onChange(updateAt(configuration, fieldPath, event.target.value))} />
      return <label key={field.key} className="extension-skill-field">{field.label}{field.required ? ' (required)' : ''}{control}
        {hint && <small className={error ? 'settings-error' : undefined}>{hint}</small>}
      </label>
    }
    if (field.type === 'number') return <label key={field.key} className="extension-skill-field">{field.label}{field.required ? ' (required)' : ''}
      <input aria-label={field.label} type="number" value={typeof value === 'number' ? value : ''} min={field.minimum} max={field.maximum} step={field.integer ? 1 : 'any'} onChange={(event) => onChange(updateAt(configuration, fieldPath, event.target.value === '' ? undefined : event.target.valueAsNumber))} />
      {hint && <small className={error ? 'settings-error' : undefined}>{hint}</small>}
    </label>
    if (field.type === 'object') return <fieldset key={field.key} className="agent-tool-list"><legend>{field.label}{field.required ? ' (required)' : ''}</legend>
      {field.description && <small>{field.description}</small>}
      <Fields fields={field.fields} path={fieldPath} configuration={configuration} issues={issues} onChange={onChange} />
      {error && <small className="settings-error">{error}</small>}
    </fieldset>
    if (field.type !== 'repeat') return null
    const items = Array.isArray(value) ? value : []
    return <fieldset key={field.key} className="agent-tool-list"><legend>{field.label}{field.required ? ' (required)' : ''}</legend>
      {field.description && <small>{field.description}</small>}
      {items.map((_, index) => <div className="extension-skill-repeat" key={index}>
        <Fields fields={field.fields} path={[...fieldPath, index]} configuration={configuration} issues={issues} onChange={onChange} />
        <button type="button" className="settings-secondary" disabled={items.length <= (field.minimumItems ?? 0)} onClick={() => onChange(updateAt(configuration, [...fieldPath, index], undefined))}>Remove {field.label}</button>
      </div>)}
      <button type="button" className="settings-secondary" disabled={items.length >= field.maximumItems} onClick={() => {
        const item: ExtensionJsonObject = {}
        applyDefaults(field.fields, item)
        onChange(updateAt(configuration, fieldPath, [...items, item]))
      }}>Add {field.label}</button>
      {error && <small className="settings-error">{error}</small>}
    </fieldset>
  })}</>
}

export function ExtensionSkillConfigurationForm({ form, configuration, issues = [], onChange }: {
  form: ExtensionSkillConfigurationFormDefinition
  configuration: ExtensionJsonObject
  issues?: readonly ConfigurationIssue[]
  onChange: (configuration: ExtensionJsonObject) => void
}) {
  const activeBranches = (form.branches ?? []).filter((branch) => configuration[branch.when.field] === branch.when.equals)
  const emit = (next: ExtensionJsonObject) => onChange(configurationWithDefaults(form, next))
  return <div className="extension-skill-configuration" role="group" aria-label="Extension skill configuration">
    <Fields fields={form.fields} path={[]} configuration={configuration} issues={issues} onChange={emit} />
    {activeBranches.map((branch, index) => <Fields key={`${branch.when.field}:${String(branch.when.equals)}:${index}`} fields={branch.fields} path={[]} configuration={configuration} issues={issues} onChange={emit} />)}
  </div>
}
