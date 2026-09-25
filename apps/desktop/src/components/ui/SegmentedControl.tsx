import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ForwardedRef,
  type ReactElement,
} from 'react'
import { cn } from './cn'

export type SegmentedOption<Value extends string> = Readonly<{
  value: Value
  label: string
}>

export type SegmentedControlProps<Value extends string> = Readonly<{
  value: Value
  options: readonly SegmentedOption<Value>[]
  onValueChange: (value: Value) => void
  ariaLabel: string
}> & Omit<ComponentPropsWithoutRef<'div'>, 'onChange'>

// Adapted from OpenSourceUI's SegmentedToggleButton (MIT), with controlled state.
export const SegmentedControl = forwardRef(function SegmentedControl<Value extends string>({
  value,
  options,
  onValueChange,
  ariaLabel,
  className,
  ...props
}: SegmentedControlProps<Value>, ref: ForwardedRef<HTMLDivElement>) {
  const activeIndex = Math.max(0, options.findIndex((option) => option.value === value))
  const count = Math.max(options.length, 1)

  return (
    <div
      ref={ref}
      role="group"
      aria-label={ariaLabel}
      data-slot="segmented-control"
      className={cn(
        'relative inline-grid w-fit gap-0.5 rounded-md bg-neutral-100 p-[3px] font-sans text-xs font-normal',
        className,
      )}
      style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}
      {...props}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-[3px] bottom-[3px] left-[3px] rounded-sm bg-white shadow-[0_1px_2px_rgba(32,61,50,0.1)] transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
        style={{
          width: `calc((100% - ${6 + (count - 1) * 2}px) / ${count})`,
          transform: `translateX(calc(${activeIndex * 100}% + ${activeIndex * 2}px))`,
        }}
      />
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onValueChange(option.value)}
            className={cn(
              'relative z-1 min-w-14 cursor-pointer rounded-sm px-3 py-[5px] text-center whitespace-nowrap outline-none transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-neutral-900',
              active ? 'text-neutral-900' : 'text-neutral-500 hover:text-neutral-900',
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}) as <Value extends string>(props: SegmentedControlProps<Value> & { ref?: ForwardedRef<HTMLDivElement> }) => ReactElement
