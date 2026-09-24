import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ExtensionJsonObject, ExtensionSkillConfigurationForm as Form } from '@forage/agent-runtime'
import {
  configurationWithDefaults,
  configurationWithoutUndeclaredFields,
  ExtensionSkillConfigurationForm,
} from './ExtensionSkillConfigurationForm'

const form: Form = {
  fields: [
    { key: 'title', label: 'Title', type: 'text', required: true, default: 'Notes' },
    { key: 'detail', label: 'Detail', type: 'multiline' },
    { key: 'limit', label: 'Limit', type: 'number', integer: true, minimum: 1, maximum: 5, default: 2 },
    { key: 'advanced', label: 'Advanced', type: 'boolean', default: false },
    { key: 'metadata', label: 'Metadata', type: 'object', fields: [{ key: 'tag', label: 'Tag', type: 'text', default: 'todo' }] },
    { key: 'rules', label: 'Rule', type: 'repeat', minimumItems: 1, maximumItems: 2, fields: [{ key: 'pattern', label: 'Pattern', type: 'text', default: 'one' }] },
  ],
  branches: [{
    when: { field: 'advanced', equals: true },
    fields: [{ key: 'style', label: 'Style', type: 'choice', required: true, options: [{ value: 'short', label: 'Short' }, { value: 'long', label: 'Long' }] }],
  }],
}

function Harness() {
  const [configuration, setConfiguration] = useState<ExtensionJsonObject>(() => configurationWithDefaults(form))
  return <>
    <ExtensionSkillConfigurationForm form={form} configuration={configuration} onChange={setConfiguration} />
    <output>{JSON.stringify(configuration)}</output>
  </>
}

describe('generic extension skill configuration form', () => {
  it('renders declared primitives, nested objects, bounded repeated groups, and conditional branches', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Notes')
    expect((screen.getByLabelText('Limit') as HTMLInputElement).value).toBe('2')
    expect((screen.getByLabelText('Tag') as HTMLInputElement).value).toBe('todo')
    expect(screen.getAllByLabelText('Pattern')).toHaveLength(1)
    expect(screen.queryByLabelText('Style')).toBeNull()

    await user.click(screen.getByLabelText('Advanced'))
    expect((screen.getByLabelText('Style') as HTMLSelectElement).value).toBe('short')
    await user.click(screen.getByRole('button', { name: 'Add Rule' }))
    expect(screen.getAllByLabelText('Pattern')).toHaveLength(2)
    expect((screen.getByRole('button', { name: 'Add Rule' }) as HTMLButtonElement).disabled).toBe(true)
    await user.click(screen.getAllByRole('button', { name: 'Remove Rule' })[0]!)
    expect(screen.getAllByLabelText('Pattern')).toHaveLength(1)
    expect(screen.getByText(/"advanced":true/)).toBeTruthy()
  })

  it('drops values for fields the executor no longer declares while keeping hidden branch values', () => {
    expect(configurationWithoutUndeclaredFields(form, {
      title: 'Notes',
      ordering: 'descending',
      metadata: { tag: 'todo', retired: true },
      rules: [{ pattern: 'one', id: 'old' }],
      style: 'long',
    })).toEqual({
      title: 'Notes',
      metadata: { tag: 'todo' },
      rules: [{ pattern: 'one' }],
      style: 'long',
    })
  })
})
