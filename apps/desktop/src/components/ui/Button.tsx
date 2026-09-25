import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { cn } from './cn'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'agent' | 'add'
export type ButtonSize = 'md' | 'sm'

export type ButtonProps = ComponentPropsWithoutRef<'button'> & {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Leading icon, usually a lucide icon element. Sized by the button. */
  icon?: ReactNode
}

const BASE = 'inline-flex shrink-0 cursor-pointer items-center justify-center whitespace-nowrap font-sans font-normal leading-none outline-none transition-[background-color,border-color,color,opacity] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet disabled:cursor-default disabled:opacity-45'

const SIZES: Record<ButtonSize, string> = {
  md: 'min-h-[31px] rounded-md text-[13px]',
  sm: 'min-h-[24px] gap-1.5 rounded-sm px-2.5 py-[5px] text-xs [&_svg]:size-3',
}

// Medium buttons vary their spacing by variant (`Button/Ghost` and `Button/Add` are tighter).
const MEDIUM_SPACING: Record<ButtonVariant, string> = {
  primary: 'gap-2 px-3.5 py-2 [&_svg]:size-[15px]',
  secondary: 'gap-2 px-3.5 py-2 [&_svg]:size-[15px]',
  danger: 'gap-2 px-3.5 py-2 [&_svg]:size-[15px]',
  agent: 'gap-2 px-3.5 py-2 [&_svg]:size-[15px]',
  ghost: 'gap-1.5 px-3 py-2 [&_svg]:size-[15px]',
  add: 'gap-1.5 px-3 py-[7px] [&_svg]:size-3.5',
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'border border-ink bg-ink text-paper hover:enabled:border-neutral-800 hover:enabled:bg-neutral-800',
  secondary: 'border border-rule bg-paper-raised text-ink hover:enabled:border-neutral-400 hover:enabled:bg-paper-sunk',
  ghost: 'border border-transparent bg-transparent text-ink-soft hover:enabled:bg-paper-sunk hover:enabled:text-ink [&_svg]:text-moss',
  danger: 'border border-clay-soft bg-clay-soft text-clay hover:enabled:border-red-50 hover:enabled:bg-[#eed3c7]',
  agent: 'border border-violet bg-violet text-white hover:enabled:border-forage-600 hover:enabled:bg-forage-600',
  add: 'border border-rule bg-transparent text-ink-soft hover:enabled:bg-paper-sunk hover:enabled:text-ink [&_svg]:text-moss',
}

// Small danger is a quiet text action in the design (`Button/Small Danger`).
const SMALL_DANGER = 'border border-transparent bg-transparent text-clay hover:enabled:bg-clay-soft'

/** Text buttons from docs/desktop.pen (`Button/*`). */
export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  type = 'button',
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      data-slot="button"
      data-variant={variant}
      className={cn(
        BASE,
        SIZES[size],
        size === 'md' && MEDIUM_SPACING[variant],
        size === 'sm' && variant === 'danger' ? SMALL_DANGER : VARIANTS[variant],
        className,
      )}
      {...props}
    >
      {icon}
      {children}
    </button>
  )
}
