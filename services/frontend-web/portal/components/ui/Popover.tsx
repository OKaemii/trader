'use client'
// Thin dark-themed wrapper over @radix-ui/react-popover.
//
// Click-to-open, click-outside/Escape-to-close floating panel. This is the substrate
// for the learning-layer <Explain> toggletip (Task 5): a <button> trigger + content
// carrying a metric's value + interpretation band. Add `role="status"` on the content
// at that call site so screen readers announce it on open.
//
//   <Popover>
//     <PopoverTrigger aria-label="Explain Sharpe">ⓘ</PopoverTrigger>
//     <PopoverContent>…</PopoverContent>
//   </Popover>
import * as RadixPopover from '@radix-ui/react-popover'
import { forwardRef } from 'react'
import { cn } from './cn'

export const Popover = RadixPopover.Root
export const PopoverTrigger = RadixPopover.Trigger
export const PopoverAnchor = RadixPopover.Anchor
export const PopoverClose = RadixPopover.Close
export const PopoverPortal = RadixPopover.Portal

export const PopoverContent = forwardRef<
  React.ComponentRef<typeof RadixPopover.Content>,
  React.ComponentPropsWithoutRef<typeof RadixPopover.Content>
>(function PopoverContent({ className, align = 'center', sideOffset = 6, ...props }, ref) {
  return (
    <RadixPopover.Portal>
      <RadixPopover.Content
        ref={ref}
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'z-50 max-w-xs rounded border border-gray-700 bg-gray-950 p-3 text-sm text-gray-200 shadow-lg',
          'focus:outline-none',
          className,
        )}
        {...props}
      >
        {props.children}
        <RadixPopover.Arrow className="fill-gray-700" />
      </RadixPopover.Content>
    </RadixPopover.Portal>
  )
})
