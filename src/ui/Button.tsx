import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Tooltip } from './Tooltip'

type Variant = 'ghost' | 'secondary' | 'primary'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
}

const variantClasses: Record<Variant, string> = {
  ghost:
    'text-text-secondary hover:bg-bg-elevated hover:text-text-primary active:bg-bg-input disabled:hover:bg-transparent disabled:hover:text-text-secondary',
  secondary:
    'border border-border text-text-primary hover:border-border-strong hover:bg-bg-elevated active:bg-bg-input',
  primary: 'bg-accent text-white font-medium hover:bg-accent-hover active:brightness-90',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', className = '', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={`inline-flex h-7 shrink-0 cursor-default items-center gap-1.5 rounded-[4px] px-2.5 text-[12px] transition-colors duration-[120ms] ease-out disabled:opacity-40 ${variantClasses[variant]} ${className}`}
      {...rest}
    />
  )
})

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  shortcut?: string
  active?: boolean
  children: ReactNode
  size?: 'default' | 'compact'
}

/** Icon-only toolbar button; active state = accent-quiet fill + accent icon. */
export function IconButton({
  label,
  shortcut,
  active = false,
  size = 'default',
  className = '',
  children,
  ...rest
}: IconButtonProps) {
  const px = size === 'compact' ? 'h-6 w-6' : 'h-7 w-7'
  return (
    <Tooltip label={label} shortcut={shortcut}>
      <button
        aria-label={label}
        aria-pressed={active || undefined}
        className={`inline-flex ${px} shrink-0 cursor-default items-center justify-center rounded-[4px] transition-colors duration-[120ms] ease-out active:scale-95 disabled:opacity-40 disabled:active:scale-100 ${
          active
            ? 'bg-accent-quiet text-accent'
            : 'text-text-secondary hover:bg-bg-elevated hover:text-text-primary active:bg-bg-input disabled:hover:bg-transparent'
        } ${className}`}
        {...rest}
      >
        {children}
      </button>
    </Tooltip>
  )
}
