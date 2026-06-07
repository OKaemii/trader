'use client'
// Right-anchored slide-over modelled on Dialog.tsx — same @radix-ui/react-dialog
// Root/Portal/Overlay (so we inherit the focus trap, Escape-to-close, and
// screen-reader labelling), but the content is pinned to the right edge and runs
// full height instead of being a centered modal. Used by ResearchDrawer for the
// universal in-context symbol overlay; deep links still go to the full route.
//
//   <Drawer open={open} onOpenChange={setOpen}>
//     <DrawerContent>
//       <DrawerTitle>AAPL</DrawerTitle>
//       …panels…
//     </DrawerContent>
//   </Drawer>
import * as RadixDialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { forwardRef } from 'react'
import { cn } from './cn'

export const Drawer = RadixDialog.Root
export const DrawerTrigger = RadixDialog.Trigger
export const DrawerClose = RadixDialog.Close
export const DrawerPortal = RadixDialog.Portal

export const DrawerOverlay = forwardRef<
  React.ComponentRef<typeof RadixDialog.Overlay>,
  React.ComponentPropsWithoutRef<typeof RadixDialog.Overlay>
>(function DrawerOverlay({ className, ...props }, ref) {
  return (
    <RadixDialog.Overlay
      ref={ref}
      className={cn('fixed inset-0 z-50 bg-black/70 backdrop-blur-sm', className)}
      {...props}
    />
  )
})

export const DrawerContent = forwardRef<
  React.ComponentRef<typeof RadixDialog.Content>,
  React.ComponentPropsWithoutRef<typeof RadixDialog.Content> & { showClose?: boolean }
>(function DrawerContent({ className, children, showClose = true, ...props }, ref) {
  return (
    <RadixDialog.Portal>
      <DrawerOverlay />
      <RadixDialog.Content
        ref={ref}
        className={cn(
          // Full width on mobile, a fixed right column (max-w-xl) on desktop — pinned
          // to the right edge and full height, scrollable when the body overflows.
          'fixed inset-y-0 right-0 z-50 w-full max-w-xl overflow-y-auto',
          'border-l border-gray-800 bg-gray-950 p-6 text-gray-200 shadow-2xl',
          'focus:outline-none',
          className,
        )}
        {...props}
      >
        {children}
        {showClose && (
          <RadixDialog.Close
            aria-label="Close"
            className="absolute right-4 top-4 text-gray-500 transition-colors hover:text-gray-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500"
          >
            <X className="h-4 w-4" />
          </RadixDialog.Close>
        )}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  )
})

export const DrawerTitle = forwardRef<
  React.ComponentRef<typeof RadixDialog.Title>,
  React.ComponentPropsWithoutRef<typeof RadixDialog.Title>
>(function DrawerTitle({ className, ...props }, ref) {
  return (
    <RadixDialog.Title
      ref={ref}
      className={cn('text-base font-semibold text-white', className)}
      {...props}
    />
  )
})

export const DrawerDescription = forwardRef<
  React.ComponentRef<typeof RadixDialog.Description>,
  React.ComponentPropsWithoutRef<typeof RadixDialog.Description>
>(function DrawerDescription({ className, ...props }, ref) {
  return (
    <RadixDialog.Description
      ref={ref}
      className={cn('mt-2 text-sm text-gray-400', className)}
      {...props}
    />
  )
})
