import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ComboboxFieldInput } from './ComboboxFieldInput'
import { SearchInput } from './SearchInput'
import { SegmentedControl } from './SegmentedControl'
import { SwitchFieldInput } from './SwitchFieldInput'
import { SystemAlertBanner } from './SystemAlertBanner'

describe('OpenSourceUI adaptations', () => {
  it('keeps search controlled and returns focus after clearing', async () => {
    const user = userEvent.setup()

    function SearchHarness() {
      const [value, setValue] = useState('notes')
      return <SearchInput value={value} onValueChange={setValue} onClear={() => setValue('')} aria-label="Search notes" />
    }

    render(<SearchHarness />)
    await user.click(screen.getByRole('button', { name: 'Clear search' }))

    const input = screen.getByRole<HTMLInputElement>('searchbox', { name: 'Search notes' })
    expect(input.value).toBe('')
    expect(document.activeElement).toBe(input)
    expect(input.autocomplete).toBe('off')
    expect(input.getAttribute('autocorrect')).toBe('off')
    expect(input.getAttribute('autocapitalize')).toBe('off')
    expect(input.getAttribute('spellcheck')).toBe('false')
  })

  it('exposes controlled segmented state', async () => {
    const user = userEvent.setup()

    function SegmentedHarness() {
      const [value, setValue] = useState<'local' | 'server'>('local')
      return (
        <SegmentedControl
          ariaLabel="Compute"
          value={value}
          options={[
            { value: 'local', label: 'Local' },
            { value: 'server', label: 'Server' },
          ]}
          onValueChange={setValue}
        />
      )
    }

    render(<SegmentedHarness />)
    await user.click(screen.getByRole('button', { name: 'Server' }))
    expect(screen.getByRole('button', { name: 'Server' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('keeps switch fields compatible with native checkbox behavior', async () => {
    const user = userEvent.setup()

    function SwitchHarness() {
      const [checked, setChecked] = useState(false)
      return <SwitchFieldInput label="Web search" checked={checked} onCheckedChange={setChecked} />
    }

    render(<SwitchHarness />)
    const checkbox = screen.getByRole<HTMLInputElement>('checkbox', { name: 'Web search' })
    await user.click(checkbox)
    expect(checkbox.checked).toBe(true)
  })

  it('picks a combobox option from the keyboard and clears the query when used as an add picker', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(
      <ComboboxFieldInput
        label="Add skill"
        clearOnSelect
        value=""
        options={[{ value: 'research', label: '/research' }, { value: 'transcribe', label: '/transcribe' }]}
        onValueChange={onValueChange}
      />,
    )

    const input = screen.getByRole<HTMLInputElement>('combobox', { name: 'Add skill' })
    await user.type(input, 'trans')
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['/transcribe'])
    await user.keyboard('{Enter}')

    expect(onValueChange).toHaveBeenCalledWith('transcribe')
    expect(input.value).toBe('')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('delegates alert dismissal to application state', async () => {
    const user = userEvent.setup()
    const onDismiss = vi.fn()
    render(<SystemAlertBanner title="Agent error" description="Something failed" onDismiss={onDismiss} />)
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})
