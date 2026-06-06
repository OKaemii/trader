'use client'
// Thin dark-themed wrapper over @radix-ui/react-tooltip.
//
// Usage (provider mounts once near the app root — see app/(authed)/layout.tsx):
//   <Tooltip content="Return per unit of risk">
//     <button>Sharpe</button>
//   </Tooltip>
//
// Or compose the primitives directly for full control:
//   <TooltipRoot><TooltipTrigger asChild>…</TooltipTrigger>
//     <TooltipContent>…</TooltipContent></TooltipRoot>
//
// Tooltips are for terse, hover/focus one-liners. Rich, click-to-pin content with a
// value + interpretation band belongs in the Popover-based <Explain> toggletip (Task 5).
import * as RadixTooltip from '@radix-ui/react-tooltip'
import { forwardRef, type ReactNode } from 'react'
import { cn } from './cn'

export const TooltipProvider = RadixTooltip.Provider
export const TooltipRoot = RadixTooltip.Root
export const TooltipTrigger = RadixTooltip.Trigger
export const TooltipPortal = RadixTooltip.Portal

export const TooltipContent = forwardRef<
  React.ComponentRef<typeof RadixTooltip.Content>,
  React.ComponentPropsWithoutRef<typeof RadixTooltip.Content>
>(function TooltipContent({ className, sideOffset = 6, ...props }, ref) {
  return (
    <RadixTooltip.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'z-50 max-w-xs rounded border border-gray-700 bg-gray-950 px-2.5 py-1.5 text-xs text-gray-200 shadow-lg',
        'data-[state=delayed-open]:animate-in data-[state=closed]:animate-out',
        className,
      )}
      {...props}
    >
      {props.children}
      <RadixTooltip.Arrow className="fill-gray-700" />
    </RadixTooltip.Content>
  )
})

/** Convenience: terse hover/focus tooltip wrapping a single trigger element. */
export function Tooltip({
  content,
  children,
  side = 'top',
  delayDuration = 200,
}: {
  content: ReactNode
  children: ReactNode
  side?: RadixTooltip.TooltipContentProps['side']
  delayDuration?: number
}) {
  return (
    <RadixTooltip.Root delayDuration={delayDuration}>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <TooltipContent side={side}>{content}</TooltipContent>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  )
}
