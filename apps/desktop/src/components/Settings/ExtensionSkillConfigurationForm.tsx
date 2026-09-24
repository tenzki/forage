import type {
  ExtensionJsonObject,
  ExtensionJsonValue,
  ExtensionSkillConfigurationField,
  ExtensionSkillConfigurationForm as ExtensionSkillConfigurationFormDefinition,
} from '@forage/agent-runtime'
import { SwitchFieldInput } from '../ui/SwitchFieldInput'

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

function FieldLabel({ field }: { field: ExtensionSkillConfigurationField }) {
  return <span className="extension-skill-label">
    {field.label}
    {!field.required && <>{' '}<span className="extension-skill-optional">Optional</span></>}
  </span>
}

function FieldHints({ description, error }: { description?: string; error?: string }) {
  return <>
    {description && <small className="extension-skill-hint">{description}</small>}
    {error && <small className="extension-skill-hint is-error">{error}</small>}
  </>
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
    if (field.type === 'boolean') return <div key={field.key} className="extension-skill-field is-wide">
      <SwitchFieldInput
        checked={value === true}
        onCheckedChange={(checked) => onChange(updateAt(configuration, fieldPath, checked))}
        label={field.label}
        switchAriaLabel={field.label}
        hint={field.description}
      />
      <FieldHints error={error} />
    </div>
    if (field.type === 'choice') return <label key={field.key} className="extension-skill-field">
      <FieldLabel field={field} />
      <select aria-label={field.label} value={typeof value === 'string' ? value : ''} onChange={(event) => onChange(updateAt(configuration, fieldPath, event.target.value || undefined))}>
        {!field.required && <option value="">Not set</option>}
        {field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      <FieldHints description={field.description} error={error} />
    </label>
    if (field.type === 'text' || field.type === 'multiline') {
      const control = field.type === 'multiline'
        ? <textarea aria-label={field.label} rows={3} value={typeof value === 'string' ? value : ''} maxLength={field.maxLength} onChange={(event) => onChange(updateAt(configuration, fieldPath, event.target.value))} />
        : <input aria-label={field.label} value={typeof value === 'string' ? value : ''} maxLength={field.maxLength} onChange={(event) => onChange(updateAt(configuration, fieldPath, event.target.value))} />
      return <label key={field.key} className={field.type === 'multiline' ? 'extension-skill-field is-wide' : 'extension-skill-field'}>
        <FieldLabel field={field} />
        {control}
        <FieldHints description={field.description} error={error} />
      </label>
    }
    if (field.type === 'number') return <label key={field.key} className="extension-skill-field">
      <FieldLabel field={field} />
      <input aria-label={field.label} type="number" value={typeof value === 'number' ? value : ''} min={field.minimum} max={field.maximum} step={field.integer ? 1 : 'any'} onChange={(event) => onChange(updateAt(configuration, fieldPath, event.target.value === '' ? undefined : event.target.valueAsNumber))} />
      <FieldHints description={field.description} error={error} />
    </label>
    if (field.type === 'object') return <fieldset key={field.key} className="extension-skill-group is-wide">
      <legend><FieldLabel field={field} /></legend>
      <FieldHints description={field.description} />
      <div className="extension-skill-fields">
        <Fields fields={field.fields} path={fieldPath} configuration={configuration} issues={issues} onChange={onChange} />
      </div>
      <FieldHints error={error} />
    </fieldset>
    if (field.type !== 'repeat') return null
    const items = Array.isArray(value) ? value : []
    return <fieldset key={field.key} className="extension-skill-group is-wide">
      <legend><FieldLabel field={field} /></legend>
      <FieldHints description={field.description} />
      <ol className="extension-skill-items">
        {items.map((_, index) => <li className="extension-skill-item" key={index}>
          <div className="extension-skill-item-header">
            <span>#{index + 1}</span>
            <button type="button" className="extension-skill-remove" aria-label={`Remove ${field.label}`} disabled={items.length <= (field.minimumItems ?? 0)} onClick={() => onChange(updateAt(configuration, [...fieldPath, index], undefined))}>Remove</button>
          </div>
          <div className="extension-skill-fields">
            <Fields fields={field.fields} path={[...fieldPath, index]} configuration={configuration} issues={issues} onChange={onChange} />
          </div>
        </li>)}
      </ol>
      <button type="button" className="settings-secondary extension-skill-add" aria-label={`Add ${field.label}`} disabled={items.length >= field.maximumItems} onClick={() => {
        const item: ExtensionJsonObject = {}
        applyDefaults(field.fields, item)
        onChange(updateAt(configuration, fieldPath, [...items, item]))
      }}>+ Add another</button>
      <FieldHints error={error} />
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
  return <div className="extension-skill-configuration extension-skill-fields" role="group" aria-label="Extension skill configuration">
    <Fields fields={form.fields} path={[]} configuration={configuration} issues={issues} onChange={emit} />
    {activeBranches.map((branch, index) => <Fields key={`${branch.when.field}:${String(branch.when.equals)}:${index}`} fields={branch.fields} path={[]} configuration={configuration} issues={issues} onChange={emit} />)}
  </div>
}
