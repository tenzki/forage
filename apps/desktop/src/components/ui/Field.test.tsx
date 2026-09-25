import { useState } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { Field, Select } from './Field'

function ModelHarness() {
  const [value, setValue] = useState('mini')
  return (
    <Field label="Model">
      <Select value={value} onChange={(event) => setValue(event.target.value)}>
        <option value="mini">Mini</option>
        <option value="large">Large</option>
        <option value="retired" disabled>Retired</option>
      </Select>
    </Field>
  )
}

describe('Select', () => {
  it('opens a styled list instead of the native popup', () => {
    render(<ModelHarness />)
    const select = screen.getByLabelText<HTMLSelectElement>('Model')

    const opened = fireEvent.mouseDown(select)

    expect(opened).toBe(false)
    const list = screen.getByRole('listbox', { name: 'Model' })
    expect(list.className).toContain('t-dropdown')
    expect(within(list).getAllByRole('option').map((option) => option.textContent)).toEqual(['Mini', 'Large', 'Retired'])
    expect(within(list).getByRole('option', { name: 'Mini' }).getAttribute('aria-selected')).toBe('true')
  })

  it('chooses an option with the mouse through the select change event', async () => {
    const user = userEvent.setup()
    render(<ModelHarness />)
    const select = screen.getByLabelText<HTMLSelectElement>('Model')

    fireEvent.mouseDown(select)
    await user.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'Large' }))

    expect(select.value).toBe('large')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('moves through enabled options with the keyboard', () => {
    render(<ModelHarness />)
    const select = screen.getByLabelText<HTMLSelectElement>('Model')

    fireEvent.keyDown(select, { key: 'ArrowDown' })
    fireEvent.keyDown(select, { key: 'ArrowDown' })
    fireEvent.keyDown(select, { key: 'ArrowDown' })
    fireEvent.keyDown(select, { key: 'Enter' })

    expect(select.value).toBe('large')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('closes on Escape without changing the value', () => {
    render(<ModelHarness />)
    const select = screen.getByLabelText<HTMLSelectElement>('Model')

    fireEvent.keyDown(select, { key: ' ' })
    fireEvent.keyDown(select, { key: 'ArrowDown' })
    fireEvent.keyDown(select, { key: 'Escape' })

    expect(select.value).toBe('mini')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('still accepts a selection made on the select itself', async () => {
    const user = userEvent.setup()
    render(<ModelHarness />)

    const select = screen.getByLabelText<HTMLSelectElement>('Model')

    await user.selectOptions(select, 'Large')

    expect(select.value).toBe('large')
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})
