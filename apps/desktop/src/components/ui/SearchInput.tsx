import {
  forwardRef,
  useCallback,
  useId,
  useRef,
  type ChangeEvent,
  type ComponentPropsWithoutRef,
} from 'react'
import { Search, X } from 'lucide-react'
import { cn } from './cn'

export type SearchInputProps = Readonly<{
  containerClassName?: string
  shortcutHint?: string
  onValueChange?: (value: string, event: ChangeEvent<HTMLInputElement>) => void
  onClear?: () => void
}> & Omit<ComponentPropsWithoutRef<'input'>, 'type' | 'onChange'>

// Adapted from OpenSourceUI's SearchInput (MIT) for controlled Forage search.
export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput({
  className,
  containerClassName,
  id,
  value = '',
  shortcutHint,
  onValueChange,
  onClear,
  disabled,
  autoComplete = 'off',
  autoCorrect = 'off',
  autoCapitalize = 'off',
  spellCheck = false,
  ...props
}, ref) {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const localRef = useRef<HTMLInputElement | null>(null)
  const current = String(value)

  const setRefs = useCallback((node: HTMLInputElement | null) => {
    localRef.current = node
    if (typeof ref === 'function') ref(node)
    else if (ref) ref.current = node
  }, [ref])

  function clear() {
    onClear?.()
    localRef.current?.focus()
  }

  return (
    <div data-slot="search-input" className={cn('relative w-full font-sans', containerClassName)}>
      <Search
        size={17}
        strokeWidth={1.8}
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-neutral-400"
      />
      <input
        ref={setRefs}
        id={inputId}
        type="search"
        disabled={disabled}
        value={current}
        autoComplete={autoComplete}
        autoCorrect={autoCorrect}
        autoCapitalize={autoCapitalize}
        spellCheck={spellCheck}
        onChange={(event) => onValueChange?.(event.target.value, event)}
        className={cn(
          'h-11 w-full rounded-xl border border-neutral-200 bg-white py-2 pr-22 pl-10 text-sm text-neutral-900 outline-none transition-[border-color,box-shadow] duration-200 placeholder:text-neutral-400 focus:border-neutral-900 focus:shadow-[0_0_0_3px_rgba(23,23,23,0.06)] disabled:cursor-not-allowed disabled:bg-neutral-50 disabled:text-neutral-400 [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden',
          className,
        )}
        {...props}
      />
      <span className="absolute top-1/2 right-2.5 flex -translate-y-1/2 items-center gap-1.5">
        {current && !disabled ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={clear}
            className="flex size-6 cursor-pointer items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-neutral-900"
          >
            <X size={14} strokeWidth={2} aria-hidden="true" />
          </button>
        ) : null}
        {shortcutHint ? (
          <kbd className="rounded-md border border-neutral-200 bg-neutral-50 px-1.5 py-0.5 font-mono text-[10px] text-neutral-500 shadow-xs">
            {shortcutHint}
          </kbd>
        ) : null}
      </span>
    </div>
  )
})

SearchInput.displayName = 'SearchInput'
